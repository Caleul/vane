import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventEnvelope } from "../src/postgresql/envelope.js";
import {
  EventIdCollisionError,
  type PostgreSqlClientLike,
  PostgreSqlEventRuntime,
  type PostgreSqlPoolLike,
  type PostgreSqlQueryResult,
} from "../src/postgresql/runtime.js";
import type {
  PostgreSqlColumn,
  PostgreSqlStorageIr,
  PostgreSqlTable,
} from "../src/postgresql/storage-ir.js";
import type {
  SemanticEntity,
  SemanticEntityEvent,
} from "../src/semantic-ir.js";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const CORRELATION_ID = "10000000-0000-4000-8000-000000000002";
const CAUSATION_ID = "10000000-0000-4000-8000-000000000003";
const SAGA_ID = "10000000-0000-4000-8000-000000000004";

type ScriptStep =
  | PostgreSqlQueryResult<Record<string, unknown>>
  | Error
  | ((
      sql: string,
      values: unknown[],
    ) => PostgreSqlQueryResult<Record<string, unknown>>);

class ScriptedClient implements PostgreSqlClientLike {
  readonly queries: { readonly sql: string; readonly values: unknown[] }[] = [];
  released = false;
  readonly #steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    this.#steps = [...steps];
  }

  async query<Row extends object = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<PostgreSqlQueryResult<Row>> {
    this.queries.push({ sql, values });
    const step = this.#steps.shift();
    if (!step) throw new Error(`Unexpected query: ${sql}`);
    if (step instanceof Error) throw step;
    const result = typeof step === "function" ? step(sql, values) : step;
    return result as PostgreSqlQueryResult<Row>;
  }

  release(): void {
    this.released = true;
  }

  assertComplete(): void {
    assert.equal(this.#steps.length, 0);
  }
}

const ok = (
  rows: readonly Record<string, unknown>[] = [],
  rowCount = rows.length,
): PostgreSqlQueryResult<Record<string, unknown>> => ({ rows, rowCount });

function poolFor(client: ScriptedClient): PostgreSqlPoolLike {
  return { connect: async () => client };
}

const column = (
  semanticId: string,
  name: string,
  type: PostgreSqlColumn["type"],
  technical = false,
): PostgreSqlColumn => ({
  semanticId,
  name,
  type,
  nullable: false,
  defaultSql: null,
  generated: null,
  technical,
});

const ownerTable: PostgreSqlTable = {
  semanticId: "Sales.Order",
  module: "Sales",
  name: "sales__order",
  technical: false,
  columns: [
    column("Sales.Order.id", "id", "uuid"),
    column("Sales.Order.quantity", "quantity", "bigint"),
    column("Sales.Order.__vane_revision", "__vane_revision", "bigint", true),
    column(
      "Sales.Order.__vane_updated_at",
      "__vane_updated_at",
      "timestamptz",
      true,
    ),
  ],
  constraints: [
    {
      semanticId: "Sales.Order.rule.PositiveQuantity",
      name: "ck_sales_order_positive_quantity",
      kind: "check",
      columns: ["quantity"],
      expression: '"quantity" > 0',
      references: null,
    },
  ],
  indexes: [],
};

const technicalTable = (semanticId: string, name: string): PostgreSqlTable => ({
  semanticId,
  module: null,
  name,
  technical: true,
  columns: [],
  constraints: [],
  indexes: [],
});

const storage: PostgreSqlStorageIr = {
  schema: "vane.postgresql-storage-ir",
  version: 1,
  provider: { name: "postgresql", minimumVersion: 16, namespace: "vane" },
  tables: [
    ownerTable,
    technicalTable("vane.infrastructure.mailbox", "__vane_mailbox"),
    technicalTable("vane.infrastructure.outbox", "__vane_outbox"),
  ],
};

const event: SemanticEntityEvent = {
  identity: "Order.Update",
  name: "Update",
  owner: { kind: "entity", entity: "Order" },
  persistence: { target: "owner", required: true },
  input: [
    { name: "id", type: "uuid", optional: false },
    { name: "quantity", type: "integer", optional: false },
  ],
  operation: {
    kind: "update",
    identity: { kind: "input", input: "id" },
    values: [
      {
        column: "quantity",
        value: { kind: "input", input: "quantity" },
      },
    ],
  },
  publicResult: {
    success: "viewOnly",
    fail: { code: "stable", message: "safe", correlationId: true },
  },
};

const entity: SemanticEntity = {
  name: "Order",
  identityColumn: "id",
  columns: [],
  rules: [],
  events: [event],
};

function envelope(quantity = 5) {
  return createEventEnvelope({
    eventId: EVENT_ID,
    eventIdentity: "Order.Update",
    correlationId: CORRELATION_ID,
    causationId: CAUSATION_ID,
    sagaId: SAGA_ID,
    occurredAt: "2026-08-31T15:00:00.000Z",
    payload: { id: "10000000-0000-4000-8000-000000000001", quantity },
  });
}

describe("PostgreSQL Entity Event runtime", () => {
  it("atomically claims, physically updates revision, appends outbox and completes mailbox", async () => {
    const client = new ScriptedClient([
      ok(),
      ok([{ event_id: EVENT_ID }]),
      ok(),
      (sql, values) => {
        assert.match(sql, /UPDATE "vane"\."sales__order" SET/);
        assert.match(sql, /"__vane_revision" = "__vane_revision" \+ 1/);
        assert.match(sql, /RETURNING "__vane_revision" AS revision/);
        assert.deepEqual(values, ["10000000-0000-4000-8000-000000000001", 5]);
        return ok([{ revision: "8" }]);
      },
      (sql, values) => {
        assert.match(sql, /INSERT INTO "vane"\."__vane_outbox"/);
        assert.deepEqual(values.slice(0, 4), [
          EVENT_ID,
          EVENT_ID,
          envelope().fingerprint,
          "Order.Update",
        ]);
        assert.deepEqual(values.slice(5, 8), [
          CORRELATION_ID,
          CAUSATION_ID,
          SAGA_ID,
        ]);
        return ok([], 1);
      },
      (sql, values) => {
        assert.match(sql, /SET status = \$2, result = \$3::jsonb/);
        assert.equal(values[1], "success");
        return ok([], 1);
      },
      ok(),
      ok(),
    ]);
    const runtime = new PostgreSqlEventRuntime(poolFor(client), storage);

    const result = await runtime.execute({
      module: "Sales",
      entity,
      event,
      envelope: envelope(),
    });

    assert.deepEqual(result, {
      kind: "success",
      eventId: EVENT_ID,
      revision: "8",
    });
    assert.equal(client.queries[0]?.sql, "BEGIN");
    assert.equal(client.queries.at(-1)?.sql, "COMMIT");
    assert.equal(client.released, true);
    client.assertComplete();
  });

  it("turns constraint errors into a deduplicated safe fail using a savepoint", async () => {
    const violation = new Error("sensitive database detail") as Error & {
      code: string;
      constraint: string;
    };
    violation.code = "23514";
    violation.constraint = "ck_sales_order_positive_quantity";
    const client = new ScriptedClient([
      ok(),
      ok([{ event_id: EVENT_ID }]),
      ok(),
      violation,
      ok(),
      (sql, values) => {
        assert.match(sql, /UPDATE "vane"\."__vane_mailbox"/);
        assert.equal(values[1], "fail");
        assert.doesNotMatch(String(values[2]), /sensitive database detail/);
        return ok([], 1);
      },
      ok(),
      ok(),
    ]);
    const runtime = new PostgreSqlEventRuntime(poolFor(client), storage);

    const result = await runtime.execute({
      module: "Sales",
      entity,
      event,
      envelope: envelope(),
    });

    assert.equal(result.kind, "fail");
    if (result.kind !== "fail") return;
    assert.equal(result.fail.code, "VANE_EVENT_RULE_VIOLATION");
    assert.equal(result.fail.correlationId, CORRELATION_ID);
    assert.ok(
      client.queries.some(
        ({ sql }) => sql === "ROLLBACK TO SAVEPOINT vane_owner_mutation",
      ),
    );
    assert.equal(
      client.queries.some(({ sql }) => sql.includes("__vane_outbox")),
      false,
    );
    client.assertComplete();
  });

  it("records invalid typed input as a terminal fail without mutation or outbox", async () => {
    const eventWithJson: SemanticEntityEvent = {
      ...event,
      input: [
        ...event.input,
        { name: "metadata", type: "json", optional: false },
      ],
    };
    const entityWithJson: SemanticEntity = {
      ...entity,
      events: [eventWithJson],
    };
    const invalidEnvelope = createEventEnvelope({
      eventId: EVENT_ID,
      eventIdentity: "Order.Update",
      correlationId: CORRELATION_ID,
      occurredAt: "2026-08-31T15:00:00.000Z",
      payload: {
        id: "10000000-0000-4000-8000-000000000001",
        quantity: 5,
        metadata: {
          "bad\0key": "value",
          nested: String.fromCharCode(0xd800),
        },
      },
    });
    const client = new ScriptedClient([
      ok(),
      ok([{ event_id: EVENT_ID }]),
      ok(),
      ok(),
      (sql, values) => {
        assert.match(sql, /UPDATE "vane"\."__vane_mailbox"/);
        assert.equal(values[1], "fail");
        assert.match(String(values[2]), /VANE_EVENT_INPUT_INVALID/);
        return ok([], 1);
      },
      ok(),
      ok(),
    ]);
    const runtime = new PostgreSqlEventRuntime(poolFor(client), storage);

    const result = await runtime.execute({
      module: "Sales",
      entity: entityWithJson,
      event: eventWithJson,
      envelope: invalidEnvelope,
    });

    assert.equal(result.kind, "fail");
    if (result.kind === "fail")
      assert.equal(result.fail.code, "VANE_EVENT_INPUT_INVALID");
    assert.equal(
      client.queries.some(({ sql }) => sql.includes("sales__order")),
      false,
    );
    assert.equal(
      client.queries.some(({ sql }) => sql.includes("__vane_outbox")),
      false,
    );
    assert.doesNotMatch(client.queries[1]?.sql ?? "", /::jsonb/);
    client.assertComplete();
  });

  it("accepts low Gregorian years and leap dates in typed input", async () => {
    const temporalEvent: SemanticEntityEvent = {
      ...event,
      input: [
        ...event.input,
        { name: "due", type: "date", optional: false },
        { name: "occurredAt", type: "datetime", optional: false },
      ],
    };
    const temporalEntity: SemanticEntity = {
      ...entity,
      events: [temporalEvent],
    };
    const violation = new Error("expected test constraint") as Error & {
      code: string;
      constraint: string;
    };
    violation.code = "23514";
    violation.constraint = "ck_sales_order_positive_quantity";
    const client = new ScriptedClient([
      ok(),
      ok([{ event_id: EVENT_ID }]),
      ok(),
      violation,
      ok(),
      ok([], 1),
      ok(),
      ok(),
    ]);
    const runtime = new PostgreSqlEventRuntime(poolFor(client), storage);
    const occurrence = createEventEnvelope({
      eventId: EVENT_ID,
      eventIdentity: "Order.Update",
      correlationId: CORRELATION_ID,
      occurredAt: "2026-08-31T15:00:00.000Z",
      payload: {
        id: EVENT_ID,
        quantity: 5,
        due: "0099-02-28",
        occurredAt: "0096-02-29T00:00:00Z",
      },
    });

    const result = await runtime.execute({
      module: "Sales",
      entity: temporalEntity,
      event: temporalEvent,
      envelope: occurrence,
    });

    assert.equal(result.kind, "fail");
    if (result.kind === "fail")
      assert.equal(result.fail.code, "VANE_EVENT_RULE_VIOLATION");
    assert.ok(
      client.queries.some(
        ({ sql }) => sql === "ROLLBACK TO SAVEPOINT vane_owner_mutation",
      ),
    );
    client.assertComplete();
  });

  it("returns the stored result without repeating an effect", async () => {
    const stored = {
      kind: "success",
      eventId: EVENT_ID,
      revision: "8",
    };
    const client = new ScriptedClient([
      ok(),
      ok([], 0),
      ok([
        {
          fingerprint: envelope().fingerprint,
          status: "success",
          result: stored,
        },
      ]),
      ok(),
    ]);
    const runtime = new PostgreSqlEventRuntime(poolFor(client), storage);

    const result = await runtime.execute({
      module: "Sales",
      entity,
      event,
      envelope: envelope(),
    });

    assert.deepEqual(result, {
      kind: "duplicate",
      eventId: EVENT_ID,
      result: stored,
    });
    assert.equal(client.queries.length, 4);
    client.assertComplete();
  });

  it("rejects reuse of an eventId with different immutable content", async () => {
    const client = new ScriptedClient([
      ok(),
      ok([], 0),
      ok([
        {
          fingerprint: envelope(4).fingerprint,
          status: "success",
          result: { kind: "success", eventId: EVENT_ID, revision: "1" },
        },
      ]),
      ok(),
    ]);
    const runtime = new PostgreSqlEventRuntime(poolFor(client), storage);

    await assert.rejects(
      runtime.execute({
        module: "Sales",
        entity,
        event,
        envelope: envelope(5),
      }),
      EventIdCollisionError,
    );
    assert.equal(client.queries.at(-1)?.sql, "ROLLBACK");
    client.assertComplete();
  });
});
