import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  type AclEventAdapter,
  AclEventRuntime,
  type PostgreSqlClientLike,
  PostgreSqlModuleRuntime,
  type PostgreSqlPoolLike,
  PostgreSqlPublicSagaAdmission,
  PostgreSqlSagaRuntime,
  PostgreSqlSagaStore,
  PostgreSqlViewRuntime,
  PublicHttpRuntime,
  applyPostgreSqlMigrationPlan,
  createEventEnvelope,
  createNodeHttpHandler,
  createPostgreSqlMigrationPlan,
  httpAclAdapter,
  materializeContract,
  materializePostgreSql,
  materializeSagaPlan,
} from "../src/index.js";
import { phaseFourModule } from "../test/phase-four-fixture.js";
import { withTestDatabase } from "./database.js";

async function fixture(
  run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  options: { declined?: boolean; dag?: boolean } = {},
) {
  await withTestDatabase("phase_four", async (database) => {
    const context = await setup(database, options);
    try {
      await run(context);
    } finally {
      await context.events.stop();
    }
  });
}
async function setup(
  database: Parameters<Parameters<typeof withTestDatabase>[1]>[0],
  options: { declined?: boolean; dag?: boolean },
) {
  const module = phaseFourModule(options.dag);
  const storage = materializePostgreSql(
    { schema: "vane.semantic-project-ir", version: 2, modules: [module] },
    { namespace: database.schema, targetVersion: 16 },
  );
  assert.ok(storage.success);
  await applyPostgreSqlMigrationPlan(
    {
      connect: async () => {
        const client = await database.pool.connect();
        return {
          query: async (text, values) => {
            const result = await client.query(text, values ? [...values] : []);
            return { rows: result.rows, rowCount: result.rowCount };
          },
          release: () => client.release(),
        };
      },
    },
    createPostgreSqlMigrationPlan({ previous: null, next: storage.ir }),
  );
  const calls: string[] = [];
  const adapter: AclEventAdapter = {
    eventIdentity: "Gateway.Authorize",
    version: "1",
    idempotency: "eventId",
    results: ["approved", "declined"],
    execute: async (envelope) => {
      calls.push(envelope.eventId);
      return options.declined
        ? { result: "declined", data: {} }
        : { result: "approved", data: { reference: "internal-reference" } };
    },
  };
  const acls = new AclEventRuntime(
    module.antiCorruptionLayers.flatMap((acl) => acl.events),
    [adapter],
  );
  const plan = materializeSagaPlan(module, "PlaceOrder", {}, [adapter]);
  const events = new PostgreSqlModuleRuntime({
    module,
    pool: database.pool,
    storage: storage.ir,
  });
  await events.start();
  const views = new PostgreSqlViewRuntime(module, database.pool, storage.ir);
  const store = new PostgreSqlSagaStore(database.pool, storage.ir);
  const makeRuntime = (
    overrides: Partial<
      ConstructorParameters<typeof PostgreSqlSagaRuntime>[0]
    > = {},
  ) =>
    new PostgreSqlSagaRuntime({
      plans: [plan],
      store,
      events,
      views,
      acls,
      ...overrides,
    });
  const runtime = makeRuntime();
  const contract = materializeContract(module, {
    events: [
      {
        event: "Order.Place",
        saga: "PlaceOrder",
        terminal: {
          view: "Receipt",
          input: { id: { kind: "eventInput", input: "id" } },
        },
      },
    ],
  });
  assert.ok(contract.success);
  const makeHttp = (worker = runtime, terminals = store) =>
    new PublicHttpRuntime({
      contract: contract.ir,
      events,
      views,
      terminals,
      admission: new PostgreSqlPublicSagaAdmission(worker, {
        "Order.Place": plan,
      }),
    });
  return {
    ...database,
    module,
    storage: storage.ir,
    calls,
    adapter,
    acls,
    plan,
    events,
    views,
    store,
    runtime,
    makeRuntime,
    makeHttp,
  };
}
async function drain(runtime: PostgreSqlSagaRuntime) {
  for (let i = 0; i < 30; i++) if (!(await runtime.runOnce())) return;
  throw new Error("Saga did not settle.");
}

describe("phase 4 durable PostgreSQL orchestration", () => {
  it("keeps ordinary Entity endpoints on their own flow in a mixed public contract", async () =>
    fixture(async (context) => {
      const terminal = {
        view: "Receipt",
        input: { id: { kind: "eventInput" as const, input: "id" } },
      };
      const contract = materializeContract(context.module, {
        events: [
          { event: "Order.Place", saga: "PlaceOrder", path: "/saga", terminal },
          { event: "Order.Place", path: "/plain", terminal },
          { event: "Order.Cancel", path: "/cancel", terminal },
        ],
      });
      assert.ok(contract.success);
      const http = new PublicHttpRuntime({
        contract: contract.ir,
        events: context.events,
        views: context.views,
        terminals: context.store,
        admission: new PostgreSqlPublicSagaAdmission(context.runtime, {
          "Order.Place": context.plan,
        }),
      });
      const id = randomUUID();
      const plain = await http.handle({
        method: "POST",
        path: "/plain",
        body: { id },
      });
      assert.equal(plain.status, 202);
      await drain(context.runtime);
      const plainFinal = await context.store.wait(
        JSON.parse(plain.body).sagaId,
        AbortSignal.timeout(1000),
      );
      assert.equal(plainFinal.kind, "view");
      if (plainFinal.kind === "view")
        assert.equal(plainFinal.data[0]?.status, "placed");
      assert.equal(context.calls.length, 0);
      const cancel = await http.handle({
        method: "POST",
        path: "/cancel",
        body: { id },
      });
      assert.equal(cancel.status, 202);
      const cancelFinal = await context.store.wait(
        JSON.parse(cancel.body).sagaId,
        AbortSignal.timeout(1000),
      );
      assert.equal(cancelFinal.kind, "view");
      if (cancelFinal.kind === "view")
        assert.equal(cancelFinal.data[0]?.status, "cancelled");
      const saga = await http.handle({
        method: "POST",
        path: "/saga",
        body: { id: randomUUID() },
      });
      await drain(context.runtime);
      assert.equal(
        (await context.store.wait(JSON.parse(saga.body).sagaId)).kind,
        "view",
      );
      assert.equal(context.calls.length, 1);
    }));

  it("rejects structurally different terminal and root bindings even when values coincide", async () =>
    fixture(async (context) => {
      const id = randomUUID();
      const contract = materializeContract(context.module, {
        events: [
          {
            event: "Order.Place",
            saga: "PlaceOrder",
            terminal: {
              view: "Receipt",
              input: { id: { kind: "eventInput", input: "id" } },
            },
          },
        ],
      });
      assert.ok(contract.success);
      const operation = contract.ir.operations.find(
        (operation) => operation.kind === "event",
      );
      assert.ok(operation && operation.kind === "event");
      for (const configuration of [
        { terminal: { id: { kind: "literal" as const, value: id } } },
        { steps: { place: { id: { kind: "literal" as const, value: id } } } },
      ]) {
        const plan = materializeSagaPlan(
          context.module,
          "PlaceOrder",
          configuration,
          [context.adapter],
        );
        const runtime = context.makeRuntime({ plans: [plan] });
        const admission = new PostgreSqlPublicSagaAdmission(runtime, {
          "Order.Place": plan,
        });
        assert.throws(
          () =>
            new PublicHttpRuntime({
              contract: contract.ir,
              events: context.events,
              views: context.views,
              terminals: context.store,
              admission,
            }),
          /binding differs/,
        );
        for (const value of [id, randomUUID()]) {
          const envelope = createEventEnvelope({
            eventId: randomUUID(),
            eventIdentity: "Order.Place",
            sagaId: randomUUID(),
            occurredAt: new Date().toISOString(),
            payload: { id: value },
          });
          await assert.rejects(admission.admitPublic(operation, envelope));
          assert.equal(
            await context.store.has(envelope.sagaId as string),
            false,
          );
        }
      }
    }));

  it("uses a runnable-only index instead of scanning retained Saga history", async () =>
    fixture(async (context) => {
      await context.query(
        `INSERT INTO ${context.store.table} (saga_id, saga_identity, state) SELECT gen_random_uuid(), 'history', jsonb_build_object('status', 'terminal', 'planHash', $1::text) FROM generate_series(1, 20000)`,
        [context.plan.hash],
      );
      await context.runtime.admit(context.plan, { id: randomUUID() });
      await context.query(`ANALYZE ${context.store.table}`);
      const result = await context.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) SELECT saga_id, saga_identity, state FROM ${context.store.table} WHERE state->>'status' IN ('running', 'compensating') AND state->>'planHash' = ANY($1::text[]) AND saga_identity = ANY($2::text[]) ORDER BY updated_at, saga_id LIMIT 100`,
        [[context.plan.hash], [`${context.plan.module}.${context.plan.saga}`]],
      );
      const plan = JSON.stringify(result.rows);
      assert.match(plan, /ix_vane_sagas__runnable/);
      assert.doesNotMatch(plan, /Seq Scan/);
    }));

  it("accepts an ACL-owned public Event and causally orders an Entity Event", async () =>
    fixture(async (context) => {
      const original = context.module.sagas[0];
      assert.ok(original);
      const module = {
        ...context.module,
        sagas: [
          {
            ...original,
            steps: [
              {
                name: "authorize",
                event: { owner: "Gateway", event: "Authorize" },
                causedBy: [],
                compensateWith: null,
              },
              {
                name: "place",
                event: { owner: "Order", event: "Place" },
                causedBy: ["authorize"],
                compensateWith: null,
              },
            ],
            terminal: { ...original.terminal, step: "place" },
          },
        ],
      };
      const plan = materializeSagaPlan(module, "PlaceOrder", {}, [
        context.adapter,
      ]);
      const events = new PostgreSqlModuleRuntime({
        module,
        storage: context.storage,
        pool: context.pool,
      });
      await events.start();
      try {
        const views = new PostgreSqlViewRuntime(
          module,
          context.pool,
          context.storage,
        );
        const runtime = new PostgreSqlSagaRuntime({
          plans: [plan],
          store: context.store,
          events,
          views,
          acls: context.acls,
        });
        const contract = materializeContract(module, {
          events: [
            {
              event: "Gateway.Authorize",
              saga: "PlaceOrder",
              terminal: {
                view: "Receipt",
                input: { id: { kind: "eventInput", input: "id" } },
              },
            },
          ],
        });
        assert.ok(contract.success);
        const http = new PublicHttpRuntime({
          contract: contract.ir,
          events,
          views,
          terminals: context.store,
          admission: new PostgreSqlPublicSagaAdmission(runtime, {
            "Gateway.Authorize": plan,
          }),
        });
        const accepted = await http.handle({
          method: "POST",
          path: "/events/Gateway.Authorize",
          body: { id: randomUUID() },
        });
        assert.equal(accepted.status, 202);
        const { sagaId } = JSON.parse(accepted.body) as { sagaId: string };
        await drain(runtime);
        const terminal = await context.store.wait(sagaId);
        assert.equal(terminal.kind, "view");
        if (terminal.kind === "view")
          assert.equal(terminal.data[0]?.status, "placed");
        assert.equal(context.calls.length, 1);
      } finally {
        await events.stop();
      }
    }));

  it("rejects a runtime with changed Event semantics before executing an old plan", async () =>
    fixture(async (context) => {
      const changed = { ...context.module, name: "Changed" };
      const events = new PostgreSqlModuleRuntime({
        module: changed,
        pool: context.pool,
        storage: context.storage,
      });
      assert.throws(() => context.makeRuntime({ events }), /semantics differ/);
    }));

  it("resumes admission in a fresh Node process and retains the terminal after exit", async () =>
    fixture(async (context) => {
      const sagaId = await context.runtime.admit(context.plan, {
        id: randomUUID(),
      });
      const script = `
      import {Pool} from "pg";
      import {phaseFourModule} from ${JSON.stringify(new URL("../test/phase-four-fixture.js", import.meta.url).href)};
      import {materializePostgreSql, materializeSagaPlan, AclEventRuntime, PostgreSqlModuleRuntime, PostgreSqlViewRuntime, PostgreSqlSagaStore, PostgreSqlSagaRuntime} from ${JSON.stringify(new URL("../src/index.js", import.meta.url).href)};
      const pool = new Pool({connectionString: process.env.VANE_TEST_DATABASE_URL});
      const module = phaseFourModule();
      const materialized = materializePostgreSql({schema: "vane.semantic-project-ir", version: 2, modules: [module]}, {namespace: process.env.VANE_PHASE4_SCHEMA, targetVersion: 16});
      if (!materialized.success) throw new Error("storage");
      const storage = materialized.ir;
      const adapter = {eventIdentity: "Gateway.Authorize", version: "1", idempotency: "eventId", results: ["approved", "declined"], execute: async () => ({result: "approved", data: {reference: "fresh-process"}})};
      const plan = materializeSagaPlan(module, "PlaceOrder", {}, [adapter]);
      const events = new PostgreSqlModuleRuntime({module, pool, storage});
      await events.start();
      const runtime = new PostgreSqlSagaRuntime({plans: [plan], events, store: new PostgreSqlSagaStore(pool, storage), views: new PostgreSqlViewRuntime(module, pool, storage), acls: new AclEventRuntime(module.antiCorruptionLayers.flatMap(acl => acl.events), [adapter])});
      for (let i=0; i<10 && await runtime.runOnce(); i++) {}
      await runtime.stop();
      await events.stop();
      await pool.end();
    `;
      await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          env: { ...process.env, VANE_PHASE4_SCHEMA: context.schema },
          timeout: 30_000,
        },
      );
      const terminal = await context.store.wait(
        sagaId,
        AbortSignal.timeout(1000),
      );
      assert.equal(terminal.kind, "view");
      assert.equal(context.calls.length, 0);
      assert.equal(
        (await context.store.read(sagaId))?.steps[1]?.result?.reference,
        "fresh-process",
      );
    }));

  it("joins all DAG parents and compensates in reverse causal order", async () =>
    fixture(
      async (context) => {
        const compensationCauses: (string | null)[] = [];
        const runtime = context.makeRuntime({
          events: {
            semanticHash: context.events.semanticHash,
            dispatch: async (envelope) => {
              if (envelope.eventIdentity === "Order.Cancel")
                compensationCauses.push(envelope.causationId);
              return context.events.dispatch(envelope);
            },
          },
        });
        const sagaId = await runtime.admit(context.plan, { id: randomUUID() });
        await runtime.runOnce();
        await runtime.runOnce();
        assert.equal(context.calls.length, 0);
        await runtime.runOnce();
        await runtime.runOnce();
        const state = await context.store.read(sagaId);
        assert.equal(state?.status, "compensating");
        assert.deepEqual(state?.steps[3]?.causedByEventIds, [
          state?.steps[1]?.envelope.eventId,
          state?.steps[2]?.envelope.eventId,
        ]);
        await drain(runtime);
        assert.deepEqual(compensationCauses, [
          state?.steps[2]?.envelope.eventId,
          state?.steps[1]?.envelope.eventId,
          state?.steps[0]?.envelope.eventId,
        ]);
        assert.equal((await context.store.wait(sagaId)).kind, "fail");
      },
      { declined: true, dag: true },
    ));

  it("compensates when the final View cannot be produced and keeps only a safe terminal", async () =>
    fixture(async (context) => {
      const runtime = context.makeRuntime({
        views: {
          semanticHash: context.views.semanticHash,
          execute: async () => {
            throw new Error("password=must-not-leak");
          },
        },
      });
      const sagaId = await runtime.admit(context.plan, { id: randomUUID() });
      await drain(runtime);
      const terminal = await context.store.wait(sagaId);
      assert.equal(terminal.kind, "fail");
      assert.doesNotMatch(JSON.stringify(terminal), /must-not-leak/);
      assert.equal(
        (await context.store.read(sagaId))?.steps[0]?.compensationStatus,
        "success",
      );
    }));

  it("checks adapter versions and plan integrity before running", async () =>
    fixture(async (context) => {
      assert.throws(
        () =>
          context.makeRuntime({
            acls: {
              bindings: [{ event: "Gateway.Authorize", version: "changed" }],
              dispatch: (envelope) => context.acls.dispatch(envelope),
            },
          }),
        /adapter version/,
      );
      assert.throws(
        () =>
          context.makeRuntime({
            plans: [{ ...context.plan, saga: "tampered" }],
          }),
        /content hash/,
      );
    }));

  it("persists admission before 202, resumes in a new runtime and reconnects to terminal SSE", async () =>
    fixture(async (context) => {
      const id = randomUUID();
      const http = context.makeHttp();
      const response = await http.handle({
        method: "POST",
        path: "/events/Order.Place",
        body: { id },
      });
      assert.equal(response.status, 202);
      const { sagaId } = JSON.parse(response.body) as { sagaId: string };
      const admitted = await context.store.read(sagaId);
      assert.equal(admitted?.status, "running");
      assert.equal(context.calls.length, 0);
      assert.equal(
        (
          await context.query(
            `SELECT * FROM "${context.schema}"."sales__order"`,
          )
        ).rowCount,
        0,
      );
      const resumed = context.makeRuntime();
      await drain(resumed);
      const reconnected = new PostgreSqlSagaStore(
        context.pool,
        context.storage,
      );
      const final = await context
        .makeHttp(resumed, reconnected)
        .handle({ method: "GET", path: `/sagas/${sagaId}` });
      assert.equal(final.status, 200);
      assert.match(final.body, /^event: view\n/);
      assert.match(final.body, /"status":"complete"/);
      assert.doesNotMatch(
        final.body,
        /internal-reference|revision|compensation|executing/,
      );
      const state = await reconnected.read(sagaId);
      assert.equal(
        state?.steps[1]?.envelope.causationId,
        state?.steps[0]?.envelope.eventId,
      );
      assert.equal(
        state?.steps[2]?.envelope.causationId,
        state?.steps[1]?.envelope.eventId,
      );
      assert.ok(
        state?.steps.every(
          (step) =>
            step.envelope.sagaId === sagaId &&
            step.envelope.correlationId === state.correlationId,
        ),
      );
    }));

  it("compensates success with another Entity Event and only then publishes safe fail", async () =>
    fixture(
      async (context) => {
        const id = randomUUID();
        const sagaId = await context.runtime.admit(context.plan, { id });
        await context.runtime.runOnce();
        await context.runtime.runOnce();
        assert.equal(
          (await context.store.read(sagaId))?.status,
          "compensating",
        );
        assert.equal((await context.store.read(sagaId))?.terminal, null);
        await drain(context.makeRuntime());
        const rows = await context.query<{ status: string }>(
          `SELECT status FROM "${context.schema}"."sales__order" WHERE id = $1`,
          [id],
        );
        assert.equal(rows.rows[0]?.status, "cancelled");
        const state = await context.store.read(sagaId);
        assert.equal(state?.steps[0]?.compensationStatus, "success");
        assert.equal(state?.steps[2]?.status, "pending");
        assert.equal((await context.store.wait(sagaId)).kind, "fail");
      },
      { declined: true },
    ));

  it("replays an Entity after a crash between its commit and Saga checkpoint without repeating its effect", async () =>
    fixture(async (context) => {
      let failed = false;
      const broken = context.makeRuntime({
        events: {
          semanticHash: context.events.semanticHash,
          dispatch: async (envelope) => {
            const result = await context.events.dispatch(envelope);
            if (!failed) {
              failed = true;
              throw new Error("process lost after commit");
            }
            return result;
          },
        },
      });
      const id = randomUUID();
      const sagaId = await broken.admit(context.plan, { id });
      await assert.rejects(broken.runOnce(), /process lost/);
      assert.equal(
        (await context.store.read(sagaId))?.steps[0]?.status,
        "executing",
      );
      await drain(context.makeRuntime());
      const rows = await context.query<{ revision: string }>(
        `SELECT __vane_revision AS revision FROM "${context.schema}"."sales__order" WHERE id = $1`,
        [id],
      );
      assert.equal(rows.rows[0]?.revision, "2"); // Place + Complete; no duplicate Place.
      assert.equal((await context.store.wait(sagaId)).kind, "view");
    }));

  it("replays an ACL with the exact same idempotency key after a lost checkpoint", async () =>
    fixture(async (context) => {
      let failed = false;
      const broken = context.makeRuntime({
        acls: {
          bindings: context.acls.bindings,
          dispatch: async (envelope) => {
            const result = await context.acls.dispatch(envelope);
            if (!failed) {
              failed = true;
              throw new Error("lost ACL checkpoint");
            }
            return result;
          },
        },
      });
      const sagaId = await broken.admit(context.plan, { id: randomUUID() });
      await broken.runOnce();
      await assert.rejects(broken.runOnce(), /lost ACL/);
      await drain(context.makeRuntime());
      assert.equal(context.calls.length, 2);
      assert.equal(context.calls[0], context.calls[1]);
      assert.equal((await context.store.wait(sagaId)).kind, "view");
    }));

  it("serializes concurrent workers and first terminal publication", async () =>
    fixture(async (context) => {
      const sagaId = await context.runtime.admit(context.plan, {
        id: randomUUID(),
      });
      const workers = [
        context.runtime,
        context.makeRuntime(),
        context.makeRuntime(),
      ];
      for (let i = 0; i < 8; i++)
        await Promise.all(workers.map((worker) => worker.runOnce()));
      assert.equal(context.calls.length, 1);
      assert.equal((await context.store.wait(sagaId)).kind, "view");
      const terminalId = randomUUID();
      await context.store.register(terminalId);
      await Promise.all([
        context.store.publish(terminalId, {
          kind: "view",
          view: "Receipt",
          data: [],
        }),
        context.store.publish(terminalId, {
          kind: "fail",
          fail: { code: "SAFE", message: "safe", correlationId: terminalId },
        }),
      ]);
      const first = await context.store.wait(terminalId);
      await context.store.publish(terminalId, {
        kind: "view",
        view: "Different",
        data: [],
      });
      assert.deepEqual(await context.store.wait(terminalId), first);
    }));

  it("preserves pending work on stop, rejects duplicate admission and cancels disconnected waits", async () =>
    fixture(async (context) => {
      const sagaId = await context.runtime.admit(context.plan, {
        id: randomUUID(),
      });
      await assert.rejects(
        context.runtime.admit(context.plan, { id: randomUUID() }, { sagaId }),
      );
      const controller = new AbortController();
      const waiting = context.store.wait(sagaId, controller.signal);
      controller.abort();
      await assert.rejects(waiting, { name: "AbortError" });
      await context.runtime.stop();
      await assert.rejects(
        context.runtime.admit(context.plan, { id: randomUUID() }),
      );
      await drain(context.makeRuntime());
      assert.equal((await context.store.wait(sagaId)).kind, "view");
    }));

  it("records failed compensation and suppresses raw operational errors", async () =>
    fixture(
      async (context) => {
        const runtime = context.makeRuntime({
          events: {
            semanticHash: context.events.semanticHash,
            dispatch: async (envelope) => {
              if (envelope.eventIdentity === "Order.Cancel")
                return {
                  kind: "fail",
                  eventId: envelope.eventId,
                  fail: {
                    code: "VANE_EVENT_CONSTRAINT_VIOLATION",
                    message: "The Event violates a constraint.",
                    correlationId: envelope.correlationId,
                  },
                };
              return context.events.dispatch(envelope);
            },
          },
        });
        const sagaId = await runtime.admit(context.plan, { id: randomUUID() });
        await drain(runtime);
        const state = await context.store.read(sagaId);
        assert.equal(state?.steps[0]?.compensationStatus, "fail");
        const terminal = await context.store.wait(sagaId);
        assert.equal(terminal.kind, "fail");
        if (terminal.kind === "fail")
          assert.equal(terminal.fail.code, "VANE_SAGA_COMPENSATION_FAILED");
      },
      { declined: true },
    ));

  it("does not acknowledge HTTP admission if durable storage fails", async () =>
    fixture(async (context) => {
      const unavailable: PostgreSqlPoolLike = {
        connect: async (): Promise<PostgreSqlClientLike> => {
          throw new Error("database unavailable");
        },
      };
      const store = new PostgreSqlSagaStore(unavailable, context.storage);
      const runtime = context.makeRuntime({ store });
      await assert.rejects(
        context.makeHttp(runtime, store).handle({
          method: "POST",
          path: "/events/Order.Place",
          body: { id: randomUUID() },
        }),
        /database unavailable/,
      );
      assert.equal(context.calls.length, 0);
    }));

  it("executes a real HTTP ACL and serves terminal-only SSE through Node", async () =>
    fixture(async (context) => {
      let key = "";
      const provider = createServer((request, response) => {
        key = String(request.headers["idempotency-key"]);
        request.resume();
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            external_reference: "provider-result",
            credential: "must-not-leak",
          }),
        );
      });
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const address = provider.address();
      assert.ok(address && typeof address !== "string");
      const adapter = httpAclAdapter({
        eventIdentity: "Gateway.Authorize",
        version: "1",
        url: `http://127.0.0.1:${address.port}`,
        idempotencyHeader: "Idempotency-Key",
        responses: [
          {
            status: 200,
            result: "approved",
            fields: { reference: "external_reference" },
          },
          { status: 402, result: "declined", fields: {} },
        ],
      });
      const runtime = context.makeRuntime({
        acls: new AclEventRuntime(
          context.module.antiCorruptionLayers.flatMap((acl) => acl.events),
          [adapter],
        ),
      });
      const server = createServer(
        createNodeHttpHandler(context.makeHttp(runtime)),
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const local = server.address();
      assert.ok(local && typeof local !== "string");
      try {
        const accepted = await fetch(
          `http://127.0.0.1:${local.port}/events/Order.Place`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: randomUUID() }),
          },
        );
        assert.equal(accepted.status, 202);
        const { sagaId } = (await accepted.json()) as { sagaId: string };
        await drain(runtime);
        const stream = await fetch(
          `http://127.0.0.1:${local.port}/sagas/${sagaId}`,
        );
        const body = await stream.text();
        assert.match(body, /^event: view\n/);
        assert.doesNotMatch(
          body,
          /provider-result|must-not-leak|progress|retry/,
        );
        assert.equal(
          key,
          (await context.store.read(sagaId))?.steps[1]?.envelope.eventId,
        );
      } finally {
        server.close();
        provider.close();
        await Promise.all([once(server, "close"), once(provider, "close")]);
      }
    }));
});
