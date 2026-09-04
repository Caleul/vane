import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type TelemetryRecord,
  applyPostgreSqlMigrationPlan,
  compileServiceConfiguration,
  createPostgreSqlMigrationPlan,
  createServiceRuntime,
} from "../src/index.js";
import { phaseFiveConfiguration } from "../test/phase-five-fixture.js";
import { withTestDatabase } from "./database.js";

async function fixture(
  run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  failures = 1,
) {
  await withTestDatabase("phase_six", async (db) => {
    const context = await setup(db, failures);
    try {
      await run(context);
    } finally {
      await context.runtime.stop();
    }
  });
}
async function setup(
  db: Parameters<Parameters<typeof withTestDatabase>[1]>[0],
  failures: number,
) {
  const base = phaseFiveConfiguration();
  const p = base.profiles.development;
  assert.ok(p.topology);
  const configuration = phaseFiveConfiguration({
    topology: {
      ...p.topology,
      service: {
        ...p.topology.service,
        persistence: {
          ...p.topology.service.persistence,
          namespace: db.schema,
        },
      },
    },
    telemetry: { exporter: "json" },
    policies: {
      defaults: {
        timeoutMs: 30,
        retry: {
          attempts: 3,
          backoff: "exponential",
          delayMs: 60,
          maxDelayMs: 120,
        },
      },
    },
  });
  const compiled = compileServiceConfiguration(configuration, "test");
  assert.ok(compiled.success, JSON.stringify(compiled));
  await applyPostgreSqlMigrationPlan(
    db.pool,
    createPostgreSqlMigrationPlan({
      previous: null,
      next: compiled.plan.storage,
    }),
  );
  const calls: string[] = [];
  const telemetry: TelemetryRecord[] = [];
  const bindings = {
    pool: db.pool,
    resolveSecret: async () => "https://gateway.invalid",
    telemetrySink: (r: TelemetryRecord) => telemetry.push(r),
    fetch: (async (_url, init) => {
      calls.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (calls.length <= failures) throw new Error("private-provider-token");
      return new Response(JSON.stringify({ reference: "private-result" }), {
        status: 200,
      });
    }) as typeof fetch,
  };
  const runtime = await createServiceRuntime(configuration, "test", bindings);
  await runtime.start();
  const module = runtime.modules[0];
  assert.ok(module);
  const plan = runtime.plan.runtime.sagas[0];
  assert.ok(plan);
  return {
    db,
    configuration,
    bindings,
    runtime,
    module,
    plan,
    calls,
    telemetry,
  };
}

describe("phase six robustness", () => {
  it("persists backoff across restart and retains remote idempotency identity", async () =>
    fixture(async (c) => {
      const sagaId = await c.module.sagas.admit(c.plan, { id: randomUUID() });
      await c.module.sagas.runOnce();
      await c.module.sagas.runOnce();
      const pending = await c.module.store.read(sagaId);
      assert.equal(pending?.steps[1]?.attempts, 1);
      assert.ok(pending?.steps[1]?.retryAt);
      assert.equal(await c.module.sagas.runOnce(), false);
      await c.runtime.stop();
      const restarted = await createServiceRuntime(
        c.configuration,
        "test",
        c.bindings,
      );
      await restarted.start();
      try {
        await delay(80);
        const m = restarted.modules[0];
        assert.ok(m);
        while (await m.sagas.runOnce()) {}
        assert.equal((await m.store.wait(sagaId)).kind, "view");
        assert.equal(c.calls.length, 2);
        assert.equal(c.calls[0], c.calls[1]);
        const state = await m.store.read(sagaId);
        assert.equal(state?.steps[1]?.attempts, 2);
        assert.ok(c.telemetry.some((r) => r.operation === "retry"));
        assert.ok(!JSON.stringify(c.telemetry).includes("private-"));
        const inspected = await restarted.operations.inspectSaga(sagaId);
        assert.equal(inspected.steps.length, 3);
        assert.ok(!JSON.stringify(inspected).includes("private-"));
      } finally {
        await restarted.stop();
      }
    }));
  it("exhausts retries, compensates, queues once and keeps terminal immutable", async () =>
    fixture(async (c) => {
      const sagaId = await c.module.sagas.admit(c.plan, { id: randomUUID() });
      for (let i = 0; i < 12; i++) {
        await c.module.sagas.runOnce();
        await delay(70);
      }
      const terminal = await c.module.store.wait(sagaId);
      assert.equal(terminal.kind, "fail");
      assert.equal(c.calls.length, 3);
      const failures = await c.runtime.operations.failures();
      assert.equal(failures.length, 1);
      assert.equal(Number(failures[0]?.attempt_count), 3);
      assert.equal(
        await c.runtime.operations.resolveFailure(
          String(failures[0]?.failure_id),
        ),
        true,
      );
      assert.equal(
        await c.runtime.operations.resolveFailure(
          String(failures[0]?.failure_id),
        ),
        false,
      );
      assert.deepEqual(await c.module.store.wait(sagaId), terminal);
      const failureTable = c.runtime.plan.storage.tables.find(
        (t) => t.semanticId === "vane.infrastructure.failures",
      );
      assert.ok(failureTable);
      await c.db.query(
        `UPDATE ${c.db.qualifiedSchema}."${failureTable.name}" SET resolved_at='2020-01-01' WHERE status='resolved'`,
      );
      assert.equal(
        await c.runtime.operations.pruneResolvedFailures(
          new Date().toISOString(),
        ),
        1,
      );
      assert.deepEqual(await c.runtime.operations.failures(), []);
      const state = await c.module.store.read(sagaId);
      assert.equal(state?.steps[0]?.compensationStatus, "success");
    }, 100));
  it("enforces Entity timeout on a locked row and rolls back the mailbox", async () =>
    fixture(async (c) => {
      const id = randomUUID();
      const sagaId = await c.module.sagas.admit(c.plan, { id });
      await c.module.sagas.runOnce();
      await c.module.sagas.runOnce();
      const table = c.runtime.plan.storage.tables.find(
        (t) => t.semanticId === "Sales.Order",
      );
      assert.ok(table);
      const lock = await c.db.connect();
      await lock.query("BEGIN");
      await lock.query(
        `SELECT * FROM ${c.db.qualifiedSchema}."${table.name}" FOR UPDATE`,
      );
      try {
        await c.module.sagas.runOnce();
        const state = await c.module.store.read(sagaId);
        assert.equal(state?.steps[2]?.fail?.code, "VANE_EVENT_TIMEOUT");
        assert.ok(state?.steps[2]?.retryAt);
        const mailbox = c.runtime.plan.storage.tables.find(
          (t) => t.semanticId === "vane.infrastructure.mailbox",
        );
        assert.ok(mailbox);
        assert.equal(
          (
            await c.db.query(
              `SELECT * FROM ${c.db.qualifiedSchema}."${mailbox.name}" WHERE event_id=$1`,
              [state?.steps[2]?.envelope.eventId],
            )
          ).rowCount,
          0,
        );
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
      await delay(80);
      while (await c.module.sagas.runOnce()) {}
      assert.equal((await c.module.store.wait(sagaId)).kind, "view");
    }, 0));
});

it("standalone configured Event is durable before dispatch and survives restart", async () =>
  fixture(async (c) => {
    await c.runtime.stop();
    const p = c.configuration.profiles.development;
    const config = {
      ...c.configuration,
      profiles: {
        ...c.configuration.profiles,
        development: {
          ...p,
          contracts: {
            Sales: {
              basePath: "/sales",
              events: [
                {
                  event: "Order.Place",
                  terminal: {
                    view: "Receipt",
                    input: { id: { kind: "eventInput" as const, input: "id" } },
                  },
                },
              ],
            },
          },
        },
      },
    };
    const runtime = await createServiceRuntime(config, "test", c.bindings);
    await runtime.start();
    const m = runtime.modules[0];
    assert.ok(m);
    const op = m.contract.operations.find((o) => o.kind === "event");
    assert.ok(op);
    const response = await m.http.handle({
      method: "POST",
      path: op.path,
      body: { id: randomUUID() },
    });
    assert.equal(response.status, 202);
    const sagaId = (JSON.parse(response.body) as { sagaId: string }).sagaId;
    const before = await m.store.read(sagaId);
    assert.equal(before?.steps[0]?.status, "pending");
    await runtime.stop();
    const recovered = await createServiceRuntime(config, "test", c.bindings);
    await recovered.start();
    try {
      const worker = recovered.modules[0];
      assert.ok(worker);
      while (await worker.sagas.runOnce()) {}
      assert.equal((await worker.store.wait(sagaId)).kind, "view");
    } finally {
      await recovered.stop();
    }
  }, 0));

it("concurrent workers serialize the same step without duplicate external calls", async () =>
  fixture(async (c) => {
    const sagaId = await c.module.sagas.admit(c.plan, { id: randomUUID() });
    const second = await createServiceRuntime(
      c.configuration,
      "test",
      c.bindings,
    );
    await second.start();
    try {
      const m = second.modules[0];
      assert.ok(m);
      for (let i = 0; i < 5; i++)
        await Promise.all([c.module.sagas.runOnce(), m.sagas.runOnce()]);
      assert.equal((await m.store.wait(sagaId)).kind, "view");
      assert.equal(c.calls.length, 1);
    } finally {
      await second.stop();
    }
  }, 0));

it("retrying compensation remains durable and does not publish an early terminal", async () =>
  fixture(async (c) => {
    const sagaId = await c.module.sagas.admit(c.plan, { id: randomUUID() });
    for (let i = 0; i < 4; i++) {
      await c.module.sagas.runOnce();
      await delay(150);
    }
    assert.equal((await c.module.store.read(sagaId))?.status, "compensating");
    const table = c.runtime.plan.storage.tables.find(
      (t) => t.semanticId === "Sales.Order",
    );
    assert.ok(table);
    const lock = await c.db.connect();
    await lock.query("BEGIN");
    await lock.query(
      `SELECT * FROM ${c.db.qualifiedSchema}."${table.name}" FOR UPDATE`,
    );
    try {
      await c.module.sagas.runOnce();
      const state = await c.module.store.read(sagaId);
      assert.equal(state?.terminal, null);
      assert.ok(state?.steps[0]?.compensationRetryAt);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    await delay(80);
    while (await c.module.sagas.runOnce()) {}
    assert.equal((await c.module.store.wait(sagaId)).kind, "fail");
    assert.equal(
      (await c.module.store.read(sagaId))?.steps[0]?.compensationAttempts,
      2,
    );
  }, 100));
