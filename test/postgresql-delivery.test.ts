import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_EXECUTION_POLICY } from "../src/execution-policy.js";
import {
  InvalidOutboxClaimError,
  LostOutboxLeaseError,
  PostgreSqlOutboxDispatcher,
} from "../src/postgresql/delivery.js";
import { createEventEnvelope } from "../src/postgresql/envelope.js";
import type {
  PostgreSqlClientLike,
  PostgreSqlPoolLike,
  PostgreSqlQueryResult,
} from "../src/postgresql/runtime.js";
import type { PostgreSqlStorageIr } from "../src/postgresql/storage-ir.js";
import type { ExecutionPolicy } from "../src/service-configuration.js";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000002";
const LEASE_TOKEN = "10000000-0000-4000-8000-000000000003";
const OLD_LEASE_TOKEN = "10000000-0000-4000-8000-000000000004";

type Response = PostgreSqlQueryResult<Record<string, unknown>>;

class QueueClient implements PostgreSqlClientLike {
  readonly queries: { readonly sql: string; readonly values: unknown[] }[] = [];
  readonly #responses: Response[];
  released = false;

  constructor(responses: Response[]) {
    this.#responses = [...responses];
  }

  async query<Row extends object = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<PostgreSqlQueryResult<Row>> {
    this.queries.push({ sql, values });
    const response = this.#responses.shift();
    if (!response) throw new Error(`Unexpected query: ${sql}`);
    return response as PostgreSqlQueryResult<Row>;
  }

  release(): void {
    this.released = true;
  }

  assertComplete(): void {
    assert.equal(this.#responses.length, 0);
  }
}

const response = (
  rows: readonly Record<string, unknown>[] = [],
  rowCount = rows.length,
): Response => ({ rows, rowCount });

const storage: PostgreSqlStorageIr = {
  schema: "vane.postgresql-storage-ir",
  version: 1,
  provider: { name: "postgresql", minimumVersion: 16, namespace: "vane" },
  tables: [
    {
      semanticId: "vane.infrastructure.failures",
      module: null,
      name: "__vane_failures",
      technical: true,
      columns: [],
      constraints: [],
      indexes: [],
    },
    {
      semanticId: "vane.infrastructure.outbox",
      module: null,
      name: "__vane_outbox",
      technical: true,
      columns: [],
      constraints: [],
      indexes: [],
    },
  ],
};

const envelope = createEventEnvelope({
  eventId: EVENT_ID,
  eventIdentity: "Order.Update",
  occurredAt: "2026-08-31T15:00:00.000Z",
  payload: { quantity: 5 },
});

describe("PostgreSQL outbox delivery", () => {
  it("rejects a missing failure queue before claiming work", () => {
    assert.throws(
      () =>
        new PostgreSqlOutboxDispatcher(
          {
            connect: async () => {
              throw new Error("must not connect");
            },
          },
          {
            ...storage,
            tables: storage.tables.filter(
              (t) => t.semanticId !== "vane.infrastructure.failures",
            ),
          },
        ),
      /failure queue/,
    );
  });
  it("claims due work with SKIP LOCKED and a fenced lease", async () => {
    const client = new QueueClient([
      response(),
      response([
        {
          message_id: MESSAGE_ID,
          event_id: EVENT_ID,
          lease_token: LEASE_TOKEN,
          lease_until: "2026-08-31T15:01:00.000Z",
          attempt_count: "2",
          payload: envelope,
        },
      ]),
      response(),
    ]);
    const pool: PostgreSqlPoolLike = { connect: async () => client };
    const dispatcher = new PostgreSqlOutboxDispatcher(pool, storage);

    const claims = await dispatcher.claim({
      workerId: "worker-1",
      limit: 10,
      leaseMilliseconds: 60_000,
    });

    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.attempt, 2);
    assert.equal(claims[0]?.envelope.fingerprint, envelope.fingerprint);
    const claimQuery = client.queries[1];
    assert.match(claimQuery?.sql ?? "", /FOR UPDATE SKIP LOCKED/);
    assert.match(
      claimQuery?.sql ?? "",
      /lease_until IS NULL OR lease_until <=/,
    );
    assert.match(claimQuery?.sql ?? "", /transaction_timestamp\(\)/);
    assert.equal(claimQuery?.values[1], "worker-1");
    assert.equal(client.queries[0]?.sql, "BEGIN");
    assert.equal(client.queries[2]?.sql, "COMMIT");
    assert.equal(client.released, true);
    client.assertComplete();
  });

  it("acknowledges only the worker and token that own the lease", async () => {
    const client = new QueueClient([response([], 1)]);
    const dispatcher = new PostgreSqlOutboxDispatcher(
      { connect: async () => client },
      storage,
    );

    await dispatcher.acknowledge({
      messageId: MESSAGE_ID,
      workerId: "worker-1",
      leaseToken: LEASE_TOKEN,
      publishedAt: "2026-08-31T15:00:05.000Z",
    });

    assert.match(client.queries[0]?.sql ?? "", /lease_owner = \$2/);
    assert.match(client.queries[0]?.sql ?? "", /lease_token = \$3/);
    assert.match(client.queries[0]?.sql ?? "", /published_at IS NULL/);
    client.assertComplete();
  });

  it("rejects a stale acknowledgement instead of confirming another lease", async () => {
    const client = new QueueClient([response([], 0)]);
    const dispatcher = new PostgreSqlOutboxDispatcher(
      { connect: async () => client },
      storage,
    );

    await assert.rejects(
      dispatcher.acknowledge({
        messageId: MESSAGE_ID,
        workerId: "old-worker",
        leaseToken: OLD_LEASE_TOKEN,
        publishedAt: "2026-08-31T15:00:05.000Z",
      }),
      LostOutboxLeaseError,
    );
    client.assertComplete();
  });

  it("reschedules failures without exposing multiline error details", async () => {
    const client = new QueueClient([response([], 1)]);
    const dispatcher = new PostgreSqlOutboxDispatcher(
      { connect: async () => client },
      storage,
    );

    await dispatcher.reschedule({
      messageId: MESSAGE_ID,
      workerId: "worker-1",
      leaseToken: LEASE_TOKEN,
      availableAt: "2026-08-31T15:01:00.000Z",
      error: "connection\nfailed\ttemporarily",
    });

    assert.match(client.queries[0]?.sql ?? "", /status = 'pending'/);
    assert.equal(client.queries[0]?.values[4], "connection failed temporarily");
    client.assertComplete();
  });
});

it("rejects malformed outbox policies before connecting or publishing", async () => {
  let connections = 0;
  let publications = 0;
  const dispatcher = new PostgreSqlOutboxDispatcher(
    {
      connect: async () => {
        connections++;
        throw new Error("unexpected connection");
      },
    },
    storage,
  );
  const base = DEFAULT_EXECUTION_POLICY;
  const invalid: unknown[] = [
    null,
    {},
    { ...base, timeoutMs: 0 },
    { ...base, timeoutMs: Number.POSITIVE_INFINITY },
    { ...base, idempotency: "optional" },
    { ...base, deduplication: "memory" },
    { ...base, retry: null },
    ...[
      { attempts: 0 },
      { attempts: 1.5 },
      { backoff: "random" },
      { delayMs: Number.NaN },
      { delayMs: -1 },
      { maxDelayMs: 2147483648 },
      { delayMs: 5, maxDelayMs: 4 },
    ].map((retry) => ({ ...base, retry: { ...base.retry, ...retry } })),
  ];
  for (const policy of invalid)
    await assert.rejects(
      dispatcher.dispatch({
        workerId: "worker",
        limit: 1,
        leaseMilliseconds: 100,
        policy: policy as ExecutionPolicy,
        publisher: {
          publish: async () => {
            publications++;
          },
        },
        retryAt: () => new Date().toISOString(),
      }),
      InvalidOutboxClaimError,
    );
  assert.equal(connections, 0);
  assert.equal(publications, 0);
});

it("keeps the admitted outbox policy stable across caller mutation", async () => {
  const dispatcher = new PostgreSqlOutboxDispatcher(
    {
      connect: async () => {
        throw new Error("must not connect");
      },
    },
    storage,
  );
  const policy = {
    ...DEFAULT_EXECUTION_POLICY,
    retry: { ...DEFAULT_EXECUTION_POLICY.retry, attempts: 2 },
  };
  dispatcher.claim = async () => {
    policy.retry.attempts = 0;
    policy.retry.delayMs = Number.NaN;
    return [
      {
        messageId: MESSAGE_ID,
        eventId: EVENT_ID,
        leaseToken: LEASE_TOKEN,
        leaseUntil: "2026-08-31T15:01:00Z",
        attempt: 1,
        envelope,
      },
    ];
  };
  let rescheduled = false;
  dispatcher.reschedule = async (request) => {
    assert.ok(Number.isFinite(Date.parse(request.availableAt)));
    rescheduled = true;
  };
  const report = await dispatcher.dispatch({
    workerId: "worker",
    limit: 1,
    leaseMilliseconds: 100,
    policy,
    publisher: {
      publish: async () => {
        throw new Error("unavailable");
      },
    },
    retryAt: () => {
      throw new Error("must use captured policy");
    },
  });
  assert.equal(report.rescheduled, 1);
  assert.equal(rescheduled, true);
});
