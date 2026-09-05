import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { it } from "node:test";
import {
  PostgreSqlOutboxDispatcher,
  applyPostgreSqlMigrationPlan,
  compileProjectSources,
  compileServiceConfiguration,
  createPostgreSqlMigrationPlan,
  createServiceRuntime,
} from "../src/index.js";
import { phaseFiveConfiguration } from "../test/phase-five-fixture.js";
import { withTestDatabase } from "./database.js";

it("reference Sales/Billing crosses explicit ownership, enforces Rule and returns terminal-only SSE", async () => {
  const project = compileProjectSources(
    await Promise.all(
      ["billing.vane.ts", "sales.vane.ts"].map(async (fileName) => ({
        fileName,
        sourceText: await readFile(
          `examples/sales-billing/${fileName}`,
          "utf8",
        ),
      })),
    ),
  );
  assert.ok(project.success, JSON.stringify(project));
  const base = phaseFiveConfiguration();
  const p = base.profiles.development;
  assert.ok(p.topology && p.acls);
  const topology = p.topology;
  const acl = p.acls["Sales.Gateway.Authorize"];
  assert.ok(acl);
  await withTestDatabase("reference", async (db) => {
    const config = {
      ...base,
      project: project.ir,
      profiles: {
        test: {
          ...p,
          environment: "test" as const,
          topology: {
            ...topology,
            service: {
              ...topology.service,
              modules: ["Sales", "Billing"],
              persistence: {
                ...topology.service.persistence,
                namespace: db.schema,
              },
            },
          },
          acls: { "Billing.PaymentGateway.Authorize": acl },
          contracts: {
            Sales: {
              basePath: "/sales",
              events: [
                {
                  event: "Order.Place",
                  saga: "PlaceOrder",
                  terminal: {
                    view: "OrderDetails",
                    input: { id: { kind: "eventInput" as const, input: "id" } },
                  },
                },
              ],
              views: [{ view: "OrderDetails" }],
            },
            Billing: {
              basePath: "/billing",
              views: [{ view: "PaymentReceipt" }],
            },
          },
        },
      },
    };
    const plan = compileServiceConfiguration(config, "test");
    assert.ok(plan.success, JSON.stringify(plan));
    await applyPostgreSqlMigrationPlan(
      db.pool,
      createPostgreSqlMigrationPlan({
        previous: null,
        next: plan.plan.storage,
      }),
    );
    const runtime = await createServiceRuntime(config, "test", {
      pool: db.pool,
      resolveSecret: async () => "https://gateway.invalid",
      fetch: (async () =>
        new Response(
          JSON.stringify({ reference: "secret-reference" }),
        )) as typeof fetch,
    });
    await runtime.start();
    const server = createServer((req, res) => {
      void runtime.handler(req, res);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      const op = runtime.plan.contracts
        .find((c) => c.module === "Sales")
        ?.operations.find((o) => o.kind === "event");
      assert.ok(op && op.kind === "event");
      const root = `http://127.0.0.1:${address.port}`;
      const id = randomUUID();
      const accepted = await fetch(root + op.path, {
        method: "POST",
        body: JSON.stringify({ id, amount: 500, minimum: 100 }),
      });
      assert.equal(accepted.status, 202);
      const { sagaId } = (await accepted.json()) as { sagaId: string };
      for (const m of runtime.modules) while (await m.sagas.runOnce()) {}
      const result = await fetch(
        root + op.terminal.streamPath.replace("{sagaId}", sagaId),
      );
      const body = await result.text();
      assert.match(body, /complete/);
      assert.ok(!body.includes("secret-reference"));
      const billing = runtime.modules.find((m) => m.name === "Billing");
      assert.ok(billing);
      assert.equal(
        (await billing.views.execute({ view: "PaymentReceipt", input: { id } }))
          .rows[0]?.amount,
        500,
      );
      const saga = await runtime.operations.inspectSaga(sagaId);
      assert.equal(saga.steps[1]?.eventIdentity, "Payment.Create");
      assert.equal(saga.steps[2]?.eventIdentity, "PaymentGateway.Authorize");
      const bad = await fetch(root + op.path, {
        method: "POST",
        body: JSON.stringify({ id: randomUUID(), amount: 10, minimum: 100 }),
      });
      const failed = (await bad.json()) as { sagaId: string };
      for (const m of runtime.modules) while (await m.sagas.runOnce()) {}
      const fail = await fetch(
        root + op.terminal.streamPath.replace("{sagaId}", failed.sagaId),
      );
      assert.match(await fail.text(), /VANE_EVENT_RULE_VIOLATION/);
      const dispatcher = new PostgreSqlOutboxDispatcher(
        db.pool,
        plan.plan.storage,
        runtime.telemetry,
      );
      const report = await dispatcher.dispatch({
        workerId: "test",
        limit: 100,
        leaseMilliseconds: 1000,
        publisher: {
          publish: async () => {
            throw new Error("credential-do-not-log");
          },
        },
        retryAt: () => new Date().toISOString(),
        policy: {
          timeoutMs: 100,
          retry: { attempts: 1, backoff: "fixed", delayMs: 0, maxDelayMs: 0 },
          idempotency: "required",
          deduplication: "durable",
        },
      });
      assert.equal(report.exhausted, 3);
      assert.equal(
        (
          await dispatcher.claim({
            workerId: "test",
            limit: 100,
            leaseMilliseconds: 1000,
          })
        ).length,
        0,
      );
      const failures = await runtime.operations.failures();
      const outboxFailure = failures.find(
        (f) => f.code === "VANE_OUTBOX_EXHAUSTED",
      );
      assert.ok(outboxFailure);
      assert.equal(
        await runtime.operations.retryOutboxFailure(
          String(outboxFailure.failure_id),
        ),
        true,
      );
      const requeued = await dispatcher.claim({
        workerId: "redrive",
        limit: 100,
        leaseMilliseconds: 1000,
      });
      assert.equal(requeued.length, 1);
      assert.equal(requeued[0]?.eventId, outboxFailure.event_id);
      assert.ok(
        !JSON.stringify(await runtime.operations.failures()).includes(
          "credential-do-not-log",
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await runtime.stop();
    }
  });
});
