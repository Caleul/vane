import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// All runtime/provider classes come from the installed tarball's public API.
// Only pg, an installed runtime dependency, is loaded separately.
// Attempt every owned-resource cleanup even when a prior stop rejects or stalls.
async function cleanup(...actions) {
  const errors = [];
  for (const action of actions) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Conformance cleanup exceeded 5 seconds")),
            5000,
          );
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(timer);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Conformance resource cleanup failed");
}
const source = new URL(
  "../fixtures/postgres-registry.vane.ts",
  import.meta.url,
);
async function fixture(context, run) {
  const { api, packageRoot, databaseUrl } = context;
  if (!databaseUrl)
    throw Object.assign(
      new Error(
        "VANE_CONFORMANCE_DATABASE_URL is required for real PostgreSQL evidence",
      ),
      { code: "CONFORMANCE_GAP" },
    );
  const { Pool } = createRequire(resolve(packageRoot, "package.json"))("pg");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 12,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const namespace = `vane_cf_${randomUUID().replaceAll("-", "")}`;
  const q = (name) => `"${name.replaceAll('"', '""')}"`;
  let databaseReady = false;
  let runtime;
  try {
    const compiled = api.compileModuleSource({
      fileName: "postgres-registry.vane.ts",
      sourceText: context.fixtureSourceTransform
        ? context.fixtureSourceTransform(await readFile(source, "utf8"))
        : await readFile(source, "utf8"),
    });
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
    const module = compiled.ir.module;
    const materialized = api.materializePostgreSql(
      {
        schema: "vane.semantic-project-ir",
        version: api.SEMANTIC_PROJECT_IR_VERSION,
        modules: [module],
      },
      { namespace, targetVersion: 16 },
    );
    assert.equal(
      materialized.success,
      true,
      JSON.stringify(materialized.diagnostics),
    );
    const storage = materialized.ir;
    const version = await pool.query("SHOW server_version_num");
    databaseReady = true;
    context.postgresqlVersion = version.rows[0].server_version_num;
    assert.ok(
      Number(version.rows[0].server_version_num) >= 160000,
      "Requires PostgreSQL 16+",
    );
    await api.applyPostgreSqlMigrationPlan(
      pool,
      api.createPostgreSqlMigrationPlan({ previous: null, next: storage }),
    );
    const relation = (semanticId) => {
      const table = storage.tables.find((t) => t.semanticId === semanticId);
      assert.ok(table, `Missing physical table for ${semanticId}`);
      return `${q(namespace)}.${q(table.name)}`;
    };
    const owner = relation("Registry.Parcel");
    const technical = (name) => relation(`vane.infrastructure.${name}`);
    runtime = new api.PostgreSqlModuleRuntime({ module, pool, storage });
    await runtime.start();
    const envelope = (name, payload) =>
      api.createEventEnvelope({
        eventId: randomUUID(),
        eventIdentity: `Parcel.${name}`,
        occurredAt: new Date().toISOString(),
        payload,
      });
    const execute = (name, payload, delivery = envelope(name, payload)) =>
      runtime.dispatch(delivery);
    const count = async (table) =>
      Number(
        (await pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0]
          .count,
      );
    return await run({
      api,
      Pool,
      pool,
      databaseUrl,
      module,
      storage,
      namespace,
      runtime,
      relation,
      owner,
      technical,
      execute,
      envelope,
      count,
    });
  } finally {
    // Unique per-case namespace is the sole destructive cleanup target.
    await cleanup(
      () => runtime?.stop(),
      () =>
        databaseReady
          ? pool.query(`DROP SCHEMA IF EXISTS ${q(namespace)} CASCADE`)
          : undefined,
      () => pool.end(),
    );
  }
}
function pg(id, requirements, kind, run, fixtureOptions = {}) {
  return {
    id: `postgres.${id}`,
    requirements,
    kind,
    requires: "postgresql",
    run: (context) =>
      fixture(
        Object.keys(fixtureOptions).length
          ? { ...context, ...fixtureOptions }
          : context,
        run,
      ),
  };
}
export const cases = [
  pg(
    "all-operation-telemetry-spans",
    ["EE-OBS-002"],
    "positive",
    async (c) => {
      const records = [];
      const received = [];
      const telemetry = new c.api.RuntimeTelemetry(
        { exporter: "json" },
        (record) => records.push(record),
      );
      const gateway = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        received.push({
          path: req.url,
          payload: JSON.parse(raw),
          idempotency: req.headers["idempotency-key"],
        });
        if (req.url === "/acl") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ receipt: "external-accepted" }));
        } else {
          res.writeHead(204);
          res.end();
        }
      });
      let events;
      let runtime;
      try {
        gateway.listen(0, "127.0.0.1");
        await once(gateway, "listening");
        const base = `http://127.0.0.1:${gateway.address().port}`;
        const adapter = c.api.httpAclAdapter({
          eventIdentity: "Relay.Transmit",
          version: "1",
          url: `${base}/acl`,
          idempotencyHeader: "Idempotency-Key",
          responses: [
            { status: 200, result: "accepted", fields: { receipt: "receipt" } },
            { status: 409, result: "denied", fields: {} },
          ],
        });
        const acls = new c.api.AclEventRuntime(
          c.module.antiCorruptionLayers.flatMap((acl) => acl.events),
          [adapter],
        );
        const plan = c.api.materializeSagaPlan(c.module, "RelayParcel", {}, [
          adapter,
        ]);
        events = new c.api.PostgreSqlModuleRuntime({
          module: c.module,
          pool: c.pool,
          storage: c.storage,
          telemetry,
        });
        await events.start();
        const store = new c.api.PostgreSqlSagaStore(c.pool, c.storage);
        runtime = new c.api.PostgreSqlSagaRuntime({
          plans: [plan],
          store,
          events,
          acls,
          telemetry,
          views: new c.api.PostgreSqlViewRuntime(
            c.module,
            c.pool,
            c.storage,
            [c.module],
            telemetry,
          ),
        });
        const id = randomUUID();
        const sagaId = await runtime.admit(plan, {
          id,
          label: "span inventory",
        });
        for (let i = 0; i < 20; i++) {
          if (!(await runtime.runOnce())) break;
        }
        const state = await store.read(sagaId);
        assert.equal(state.status, "terminal");
        assert.equal(state.terminal.kind, "view");
        const dispatcher = new c.api.PostgreSqlOutboxDispatcher(
          c.pool,
          c.storage,
          telemetry,
        );
        const report = await dispatcher.dispatch({
          workerId: "telemetry-publisher",
          limit: 10,
          leaseMilliseconds: 60000,
          retryAt: () => new Date().toISOString(),
          publisher: {
            publish: async (envelope) => {
              const response = await fetch(`${base}/publish`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(envelope),
                signal: AbortSignal.timeout(5000),
              });
              assert.equal(response.status, 204);
            },
          },
        });
        assert.equal(report.published, 1);
        assert.equal(received.filter((r) => r.path === "/acl").length, 1);
        assert.equal(received.filter((r) => r.path === "/publish").length, 1);
        const aclStep = state.steps.find((step) => step.name === "transmit");
        assert.equal(
          received.find((r) => r.path === "/acl").idempotency,
          aclStep.envelope.eventId,
        );
        for (const operation of [
          "event",
          "persistence",
          "publication",
          "consumption",
          "acl",
          "view",
        ]) {
          const spans = records.filter(
            (record) => record.operation === operation,
          );
          assert.ok(spans.length, operation);
          assert.ok(
            spans.every(
              (span) =>
                span.schema === "vane.telemetry" &&
                typeof span.spanId === "string" &&
                span.spanId.length > 0 &&
                Number.isFinite(span.durationMs) &&
                span.durationMs >= 0 &&
                span.outcome === "success",
            ),
            operation,
          );
          assert.ok(telemetry.metrics()[`${operation}.success`].count >= 1);
        }
        return "Real Entity/Saga/View/HTTP ACL/outbox publication work emits public runtime spans and latency/count metrics for every named Event, persistence, publication, consumption, ACL and View operation";
      } finally {
        await cleanup(
          () => runtime?.stop(),
          () => events?.stop(),
          () => {
            gateway.closeAllConnections();
            return new Promise((resolve) => gateway.close(resolve));
          },
        );
      }
    },
    {
      fixtureSourceTransform: (source) =>
        source
          .replace("  Column,", "  ACL, ACLEvent, success, fail, Column,")
          .replace(
            "@Module({",
            `@ACL() class Relay { Transmit=ACLEvent({input:{id:"uuid"},results:{accepted:success({receipt:"string"}),denied:fail({})}}); }
@Saga({input:{id:"uuid",label:"string"},steps:{register:event(Parcel,"Register"),transmit:event(Relay,"Transmit",{causedBy:["register"]})},terminal:{step:"transmit",view:ParcelCard}}) class RelayParcel {}
@Module({ antiCorruptionLayers:[Relay],`,
          )
          .replace(
            "sagas: [RegisterParcel, OverfillParcel, StampParcel]",
            "sagas: [RegisterParcel, OverfillParcel, StampParcel, RelayParcel]",
          ),
    },
  ),
  pg(
    "view-query-and-identities",
    ["EE-VIEW-004", "EE-RUN-003"],
    "positive",
    async (c) => {
      for (const [label, units] of [
        ["delta", 4],
        ["alpha", 1],
        ["charlie", 3],
        ["bravo", 2],
      ]) {
        const id = randomUUID();
        assert.equal(
          (await c.execute("Register", { id, label })).kind,
          "success",
        );
        assert.equal(
          (await c.execute("AddUnits", { id, amount: units })).kind,
          "success",
        );
      }
      const views = new c.api.PostgreSqlViewRuntime(
        c.module,
        c.pool,
        c.storage,
      );
      const page = await views.execute({
        view: "ParcelPage",
        input: { minimum: 2, limit: 2, offset: 1 },
      });
      assert.equal(page.kind, "view");
      assert.equal(page.view, "ParcelPage");
      assert.deepEqual(page.rows, [
        { label: "charlie", units: 3 },
        { label: "delta", units: 4 },
      ]);
      assert.deepEqual(
        (
          await views.execute({
            view: "ParcelPage",
            input: { minimum: 99, limit: 2, offset: 0 },
          })
        ).rows,
        [],
      );
      await assert.rejects(
        views.execute({ view: "MissingView", input: {} }),
        c.api.PostgreSqlViewNotFoundError,
      );
      await assert.rejects(
        c.execute("MissingEvent", {}),
        c.api.PostgreSqlModuleEventNotFoundError,
      );
      return "Real View query filters known rows, projects exactly two fields, orders and paginates deterministically; public Event/View dispatch selects registered identities and rejects unknown ones";
    },
  ),
  pg(
    "ordered-second-entity",
    ["EE-EVT-006", "EE-VIEW-006"],
    "positive",
    async (c) => {
      const plan = c.api.materializeSagaPlan(c.module, "StampParcel");
      const store = new c.api.PostgreSqlSagaStore(c.pool, c.storage);
      const runtime = new c.api.PostgreSqlSagaRuntime({
        plans: [plan],
        store,
        events: c.runtime,
        views: new c.api.PostgreSqlViewRuntime(c.module, c.pool, c.storage),
      });
      try {
        const id = randomUUID();
        const sagaId = await runtime.admit(plan, {
          id,
          label: "ordered stamp",
        });
        for (let i = 0; i < 20; i++) {
          const state = await store.read(sagaId);
          if (
            state.steps.find((s) => s.name === "register").status === "success"
          )
            break;
          assert.equal(await runtime.runOnce(), true);
        }
        assert.equal(await c.count(c.owner), 1);
        assert.equal(await c.count(c.relation("Registry.ReceiptStamp")), 0);
        for (let i = 0; i < 20; i++) {
          if (!(await runtime.runOnce())) break;
        }
        const final = await store.read(sagaId);
        assert.equal(final.status, "terminal");
        assert.equal(await c.count(c.relation("Registry.ReceiptStamp")), 1);
        assert.deepEqual(final.terminal.data, [
          { id, label: "ordered stamp", active: true },
        ]);
        const identities = (
          await c.pool.query(
            `SELECT event_identity FROM ${c.technical("mailbox")} ORDER BY event_identity`,
          )
        ).rows.map((r) => r.event_identity);
        assert.deepEqual(identities, ["Parcel.Register", "ReceiptStamp.Stamp"]);
        return "First Entity commits without touching second; causally ordered second-Entity Event then commits its own row/receipt, and terminal View observes required persistence";
      } finally {
        await runtime.stop();
      }
    },
  ),
  pg(
    "http-terminal-stream-and-telemetry",
    [
      "EE-SAGA-007",
      "EE-SAGA-008",
      "EE-OBS-001",
      "EE-OBS-004",
      "EE-OBS-005",
      "EE-OBS-003",
      "EE-EVT-009",
      "EE-RUN-006",
    ],
    "positive",
    async (c) => {
      const records = [];
      const telemetry = new c.api.RuntimeTelemetry(
        { exporter: "json" },
        (record) => records.push(record),
      );
      const events = new c.api.PostgreSqlModuleRuntime({
        module: c.module,
        pool: c.pool,
        storage: c.storage,
        telemetry,
      });
      const views = new c.api.PostgreSqlViewRuntime(
        c.module,
        c.pool,
        c.storage,
        [c.module],
        telemetry,
      );
      const store = new c.api.PostgreSqlSagaStore(c.pool, c.storage);
      const plans = [
        c.api.materializeSagaPlan(c.module, "RegisterParcel"),
        c.api.materializeSagaPlan(c.module, "OverfillParcel"),
      ];
      const runtime = new c.api.PostgreSqlSagaRuntime({
        plans,
        store,
        events,
        views,
        telemetry,
        policies: {
          "Parcel.AddUnits": {
            timeoutMs: 5000,
            retry: { attempts: 2, backoff: "fixed", delayMs: 0, maxDelayMs: 0 },
            idempotency: "required",
            deduplication: "durable",
          },
        },
      });
      const contract = c.api.materializeContract(c.module, {
        events: [
          {
            event: "Parcel.Register",
            saga: "RegisterParcel",
            path: "/register",
            terminal: {
              view: "ParcelCard",
              input: { id: { kind: "eventInput", input: "id" } },
            },
          },
          {
            event: "Parcel.RegisterLoad",
            saga: "OverfillParcel",
            path: "/overfill",
            terminal: {
              view: "ParcelCard",
              input: { id: { kind: "eventInput", input: "id" } },
            },
          },
        ],
      });
      assert.equal(
        contract.success,
        true,
        JSON.stringify(contract.diagnostics),
      );
      const http = new c.api.PublicHttpRuntime({
        contract: contract.ir,
        events,
        views,
        terminals: store,
        admission: new c.api.PostgreSqlPublicSagaAdmission(runtime, {
          "Parcel.Register": plans[0],
          "Parcel.RegisterLoad": plans[1],
        }),
      });
      const server = createServer(c.api.createNodeHttpHandler(http));
      try {
        await events.start();
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const base = `http://127.0.0.1:${server.address().port}`;
        // Sequence is deliberately nontransactional: one real DB serialization failure,
        // then the retry reaches the semantic Rule failure and compensating Event.
        await c.pool.query(`CREATE SEQUENCE "${c.namespace}".retry_probe;
        CREATE FUNCTION "${c.namespace}".fail_once() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.units>OLD.units AND nextval('"${c.namespace}".retry_probe')=1 THEN RAISE EXCEPTION 'conformance transient' USING ERRCODE='40001'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER retry_probe BEFORE UPDATE ON ${c.owner} FOR EACH ROW EXECUTE FUNCTION "${c.namespace}".fail_once()`);
        let replayEnvelope;
        for (const [path, eventIdentity, payload, expected] of [
          [
            "/register",
            "Parcel.Register",
            { id: randomUUID(), label: "stream success" },
            "view",
          ],
          [
            "/overfill",
            "Parcel.RegisterLoad",
            { id: randomUUID(), label: "stream failed", amount: 101 },
            "fail",
          ],
        ]) {
          const accepted = await fetch(base + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000),
          });
          assert.equal(accepted.status, 202);
          const { sagaId } = await accepted.json();
          const operation = contract.ir.operations.find(
            (o) => o.kind === "event" && o.identity === eventIdentity,
          );
          let emitted = false;
          const controller = new AbortController();
          // Attach rejection handling immediately, including body-read failures.
          // Early assertion failure must not leave an unhandled fetch rejection.
          const stream = fetch(
            base + operation.terminal.streamPath.replace("{sagaId}", sagaId),
            {
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(10000),
              ]),
            },
          )
            .then(async (response) => {
              assert.equal(response.status, 200);
              assert.match(
                response.headers.get("content-type"),
                /text\/event-stream/,
              );
              const decoder = new TextDecoder();
              let body = "";
              for await (const chunk of response.body) {
                if (chunk.byteLength) emitted = true;
                body += decoder.decode(chunk, { stream: true });
              }
              body += decoder.decode();
              return { body };
            })
            .catch((error) => ({ error }));
          try {
            await delay(30);
            assert.equal(emitted, false, "No stream event before execution");
            for (let i = 0; i < 30; i++) {
              assert.equal(await runtime.runOnce(), true);
              const state = await store.read(sagaId);
              if (state.status === "terminal") break;
              await delay(5);
              assert.equal(
                emitted,
                false,
                "No intermediate step/retry/compensation can escape to stream",
              );
            }
            const terminal = await store.read(sagaId);
            replayEnvelope = terminal.steps.find(
              (step) => step.name === "register",
            ).envelope;
            assert.equal(terminal.status, "terminal");
            const outcome = await stream;
            if (outcome.error) throw outcome.error;
            const body = outcome.body;
            assert.equal((body.match(/^event:/gm) || []).length, 1);
            assert.ok(body.startsWith(`event: ${expected}\n`));
            assert.doesNotMatch(
              body,
              /retry|compensation|attempts|planHash|stepStatus/,
            );
            const data = JSON.parse(body.split("\ndata: ")[1].trim());
            if (expected === "view")
              assert.deepEqual(data.data, [
                { id: payload.id, label: payload.label, active: false },
              ]);
            else {
              assert.equal(data.code, "VANE_EVENT_RULE_VIOLATION");
              assert.equal(
                terminal.steps.find((s) => s.name === "overfill").attempts,
                2,
              );
              assert.equal(
                terminal.steps.find((s) => s.name === "register")
                  .compensationStatus,
                "success",
              );
            }
            for (const step of terminal.steps) {
              const spans = records.filter(
                (r) =>
                  r.operation === "event" &&
                  r.attributes.eventId === step.envelope.eventId,
              );
              assert.ok(spans.length);
              assert.ok(
                spans.every(
                  (r) =>
                    r.schema === "vane.telemetry" &&
                    r.attributes.sagaId === sagaId &&
                    r.attributes.correlationId ===
                      step.envelope.correlationId &&
                    r.attributes.causationId === step.envelope.causationId &&
                    r.durationMs >= 0,
                ),
              );
            }
          } finally {
            controller.abort();
            // Always settle and await the handled stream before closing server.
            await stream;
          }
        }
        assert.equal((await events.dispatch(replayEnvelope)).kind, "duplicate");
        const metrics = telemetry.metrics();
        for (const key of [
          "event.success",
          "event.fail",
          "retry.success",
          "deduplication.success",
          "failure.queued.fail",
          "saga.admitted.success",
          "saga.terminal.success",
          "saga.terminal.fail",
        ]) {
          assert.ok(metrics[key]?.count >= 1, key);
          assert.ok(
            Number.isFinite(metrics[key].durationMs) &&
              metrics[key].durationMs >= 0,
            key,
          );
        }
        assert.ok(metrics["event.success"].durationMs > 0);
        assert.ok(records.some((r) => r.operation === "retry"));
        assert.ok(records.some((r) => r.attributes.compensation === true));
        assert.ok(records.some((r) => r.operation === "failure.queued"));
        for (const operation of [
          "event",
          "persistence",
          "consumption",
          "view",
          "saga.admitted",
        ])
          assert.ok(
            records.some((r) => r.operation === operation),
            operation,
          );
        return "Actual HTTP SSE over real durable Saga emits exactly one final View or fail and no intermediate data; PostgreSQL-induced retry and compensation appear only in structured internal causal telemetry";
      } finally {
        await cleanup(
          () => {
            server.closeAllConnections();
            return new Promise((resolve) => server.close(resolve));
          },
          () => runtime.stop(),
          () => events.stop(),
        );
      }
    },
  ),
  pg(
    "saga-failure-and-compensation",
    ["EE-PG-006", "EE-SAGA-005"],
    "negative",
    async (c) => {
      const plan = c.api.materializeSagaPlan(c.module, "OverfillParcel");
      const events = new c.api.PostgreSqlModuleRuntime({
        module: c.module,
        pool: c.pool,
        storage: c.storage,
      });
      const store = new c.api.PostgreSqlSagaStore(c.pool, c.storage);
      const runtime = new c.api.PostgreSqlSagaRuntime({
        plans: [plan],
        store,
        events,
        views: new c.api.PostgreSqlViewRuntime(c.module, c.pool, c.storage),
      });
      try {
        await events.start();
        const sagaId = await runtime.admit(plan, {
          id: randomUUID(),
          label: "compensate failed overfill",
          amount: 101,
        });
        for (let i = 0; i < 20; i++) {
          if (!(await runtime.runOnce())) break;
        }
        const final = await store.read(sagaId);
        assert.equal(final.status, "terminal");
        assert.equal(final.terminal.kind, "fail");
        assert.equal(
          final.steps.find((s) => s.name === "register").compensationStatus,
          "success",
        );
        const failed = final.steps.find((s) => s.name === "overfill");
        assert.equal(failed.status, "fail");
        assert.equal(await c.count(c.owner), 0);
        const queued = (
          await c.pool.query(
            `SELECT event_id,event_identity,saga_id,code FROM ${c.technical("failures")} WHERE saga_id=$1`,
            [sagaId],
          )
        ).rows;
        assert.deepEqual(queued, [
          {
            event_id: failed.envelope.eventId,
            event_identity: "Parcel.AddUnits",
            saga_id: sagaId,
            code: "VANE_EVENT_RULE_VIOLATION",
          },
        ]);
        assert.equal(await c.count(c.technical("mailbox")), 3);
        assert.equal(await c.count(c.technical("outbox")), 2);
        return "Failed Saga step persists failure queue and terminal state, invokes explicit compensating Event, removes owner row, and durably records all three delivery receipts";
      } finally {
        await cleanup(
          () => runtime.stop(),
          () => events.stop(),
        );
      }
    },
  ),
  {
    id: "postgres.rule-column-order-startup",
    requirements: ["EE-RUL-003"],
    kind: "positive",
    requires: "postgresql",
    run: (context) =>
      fixture(
        {
          ...context,
          fixtureSourceTransform: (source) =>
            source
              .replace("  gte,", "  gte,\n  lte,")
              .replace(
                'gte(column("capacity"), column("units"))',
                'lte(column("units"), column("capacity"))',
              ),
        },
        async (c) => {
          await assert.rejects(
            c.pool.query(
              `INSERT INTO ${c.owner} (id,label,units,capacity) VALUES ($1,$2,2,1)`,
              [randomUUID(), "invalid bound"],
            ),
            (e) => e.code === "23514",
          );
          return "Valid Rule whose operand order differs from alphabetical Column order starts successfully and enforces the generated PostgreSQL CHECK";
        },
      ),
  },
  {
    id: "postgres.datetime-default-startup",
    requirements: ["EE-COL-002"],
    kind: "positive",
    requires: "postgresql",
    run: (context) =>
      fixture(
        {
          ...context,
          fixtureSourceTransform: (source) =>
            source.replace(
              'recorded = Column({ type: "datetime", nullable: true });',
              'recorded = Column({ type: "datetime", default: "2026-09-01T08:00:00.000Z" });',
            ),
        },
        async (c) => {
          const row = (
            await c.pool.query(
              `INSERT INTO ${c.owner} (id,label) VALUES ($1,$2) RETURNING recorded`,
              [randomUUID(), "datetime default"],
            )
          ).rows[0];
          assert.equal(row.recorded.toISOString(), "2026-09-01T08:00:00.000Z");
          return "Public runtime accepts its own migration-generated datetime default and PostgreSQL persists the declared default";
        },
      ),
  },
  pg(
    "physical-types-and-owner",
    ["EE-ENT-003", "EE-COL-001", "EE-PG-001", "EE-EVT-004", "EE-EVT-005"],
    "positive",
    async (c) => {
      const id = randomUUID();
      assert.equal(
        (await c.execute("Register", { id, label: "physical proof" })).kind,
        "success",
      );
      const tables = c.storage.tables.filter((t) => !t.technical);
      assert.deepEqual(tables.map((t) => t.semanticId).sort(), [
        "Registry.Parcel",
        "Registry.ReceiptStamp",
      ]);
      const actual = await c.pool.query(
        "SELECT table_name,column_name,udt_name FROM information_schema.columns WHERE table_schema=$1",
        [c.namespace],
      );
      for (const table of tables)
        assert.ok(actual.rows.some((r) => r.table_name === table.name));
      const ownerTable = tables.find((t) => t.semanticId === "Registry.Parcel");
      const types = {
        id: "uuid",
        label: "text",
        units: "int8",
        capacity: "int8",
        weight: "numeric",
        active: "bool",
        expires: "date",
        recorded: "timestamptz",
        metadata: "jsonb",
      };
      for (const [name, type] of Object.entries(types))
        assert.ok(
          actual.rows.some(
            (r) =>
              r.table_name === ownerTable.name &&
              r.column_name === name &&
              r.udt_name === type,
          ),
          name,
        );
      const row = (
        await c.pool.query(`SELECT * FROM ${c.owner} WHERE id=$1`, [id])
      ).rows[0];
      assert.equal(row.label, "physical proof");
      assert.equal(row.units, "0");
      assert.equal(row.weight, "1.25");
      assert.equal(row.active, true);
      assert.equal(row.expires, null);
      assert.deepEqual(row.metadata, { kind: "conformance" });
      assert.equal(row.recorded.toISOString(), "2026-09-01T08:00:00.000Z");
      assert.equal(await c.count(c.relation("Registry.ReceiptStamp")), 0);
      return "Real PostgreSQL catalogs contain one table per each of two Entities and all eight Column types; successful owner Event committed all defaults without changing second Entity";
    },
  ),
  pg(
    "crud-and-concurrent-derived-write",
    ["EE-EVT-014", "EE-EVT-007", "EE-EVT-008"],
    "positive",
    async (c) => {
      const id = randomUUID();
      assert.equal(
        (await c.execute("Register", { id, label: "original" })).kind,
        "success",
      );
      const writes = await Promise.all(
        Array.from({ length: 8 }, () =>
          c.execute("AddUnits", { id, amount: 1 }),
        ),
      );
      assert.ok(writes.every((r) => r.kind === "success"));
      const before = (
        await c.pool.query(
          `SELECT units,__vane_revision::text AS revision,xmin::text AS xmin FROM ${c.owner} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      assert.equal(before.units, "8");
      assert.equal(before.revision, "9");
      assert.equal(
        (await c.execute("Rename", { id, label: "original" })).kind,
        "success",
      );
      const after = (
        await c.pool.query(
          `SELECT __vane_revision::text AS revision,xmin::text AS xmin FROM ${c.owner} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      assert.equal(after.revision, "10");
      assert.notEqual(
        after.xmin,
        before.xmin,
        "Equal-value Event must perform a real write",
      );
      assert.equal(
        (await c.execute("Store", { id, label: "updated via upsert" })).kind,
        "success",
      );
      assert.deepEqual(
        (
          await c.pool.query(
            `SELECT label,__vane_revision::text AS revision,units FROM ${c.owner} WHERE id=$1`,
            [id],
          )
        ).rows,
        [{ label: "updated via upsert", revision: "11", units: "8" }],
      );
      const second = randomUUID();
      assert.equal(
        (await c.execute("Store", { id: second, label: "inserted via upsert" }))
          .kind,
        "success",
      );
      assert.equal(await c.count(c.owner), 2);
      assert.equal((await c.execute("Erase", { id })).kind, "success");
      assert.deepEqual(
        (await c.pool.query(`SELECT id,label FROM ${c.owner}`)).rows,
        [{ id: second, label: "inserted via upsert" }],
      );
      return "Real DB create/update/delete plus both upsert branches; eight concurrent SQL-derived increments retain every effect; identical-value update changes xmin and technical revision";
    },
  ),
  pg(
    "rule-and-column-rejection",
    ["EE-RUL-003", "EE-EVT-010"],
    "negative",
    async (c) => {
      const id = randomUUID();
      const sentinel = `private-${randomUUID().slice(0, 8)}`;
      await c.execute("Register", { id, label: sentinel });
      await assert.rejects(
        c.pool.query(`UPDATE ${c.owner} SET units=101 WHERE id=$1`, [id]),
        (error) => error.code === "23514" && error.detail.includes(sentinel),
      );
      const outboxBefore = await c.count(c.technical("outbox"));
      const delivery = c.envelope("AddUnits", { id, amount: 101 });
      const result = await c.execute("AddUnits", delivery.payload, delivery);
      assert.equal(result.kind, "fail");
      assert.equal(result.fail.code, "VANE_EVENT_RULE_VIOLATION");
      assert.equal(result.fail.correlationId, delivery.correlationId);
      assert.deepEqual(Object.keys(result.fail).sort(), [
        "code",
        "correlationId",
        "message",
      ]);
      assert.ok(
        !JSON.stringify(result.fail).includes(sentinel),
        "Raw DB detail containing protected row data must not escape",
      );
      assert.equal(typeof result.fail.message, "string");
      assert.ok(result.fail.message.length);
      assert.ok(!JSON.stringify(result.fail).includes(c.namespace));
      assert.equal(
        (await c.pool.query(`SELECT units FROM ${c.owner} WHERE id=$1`, [id]))
          .rows[0].units,
        "0",
      );
      assert.equal(await c.count(c.technical("outbox")), outboxBefore);
      assert.equal(
        (await c.execute("AddUnits", delivery.payload, delivery)).kind,
        "duplicate",
      );
      return "Real PostgreSQL CHECK rejects invalid direct row; Rule-failing Event returns stable correlated safe fail, rolls back owner/outbox and durably deduplicates failure";
    },
  ),
  pg("column-boundaries", ["EE-COL-002"], "negative", async (c) => {
    const id = randomUUID();
    await c.execute("Register", { id, label: "unique" });
    for (const [sql, values, code] of [
      [`UPDATE ${c.owner} SET label=NULL WHERE id=$1`, [id], "23502"],
      [`UPDATE ${c.owner} SET units=-1 WHERE id=$1`, [id], "23514"],
      [
        `UPDATE ${c.owner} SET units=1001,capacity=2000 WHERE id=$1`,
        [id],
        "23514",
      ],
      [`UPDATE ${c.owner} SET label='' WHERE id=$1`, [id], "23514"],
      [
        `UPDATE ${c.owner} SET label=$2 WHERE id=$1`,
        [id, "x".repeat(41)],
        "23514",
      ],
      [
        `INSERT INTO ${c.owner} (id,label) VALUES ($1,$2)`,
        [randomUUID(), "unique"],
        "23505",
      ],
    ])
      await assert.rejects(c.pool.query(sql, values), (e) => e.code === code);
    const stamp = c.relation("Registry.ReceiptStamp");
    const generated = (
      await c.pool.query(
        `INSERT INTO ${stamp} DEFAULT VALUES RETURNING id,value`,
      )
    ).rows[0];
    assert.match(generated.id, /^[0-9a-f-]{36}$/);
    assert.equal(generated.value, "untouched");
    await c.pool.query(
      `UPDATE ${c.owner} SET units=1000,capacity=1000,expires=NULL WHERE id=$1`,
      [id],
    );
    assert.equal(
      (await c.pool.query(`SELECT units FROM ${c.owner} WHERE id=$1`, [id]))
        .rows[0].units,
      "1000",
    );
    return "Database enforces nonnull/unique/minimum/maximum/string boundaries, accepts inclusive maximum and nullable date, and generates UUID/default values";
  }),
  pg(
    "durable-deduplication",
    ["EE-NFR-008", "EE-PG-006"],
    "positive",
    async (c) => {
      const id = randomUUID();
      const delivery = c.envelope("Register", {
        id,
        label: "one protected effect",
      });
      const results = await Promise.all(
        Array.from({ length: 7 }, () =>
          c.execute("Register", delivery.payload, delivery),
        ),
      );
      assert.equal(results.filter((r) => r.kind === "success").length, 1);
      assert.equal(results.filter((r) => r.kind === "duplicate").length, 6);
      assert.equal(await c.count(c.owner), 1);
      assert.equal(await c.count(c.technical("mailbox")), 1);
      assert.equal(await c.count(c.technical("outbox")), 1);
      const pool2 = new c.Pool({
        connectionString: c.databaseUrl,
        connectionTimeoutMillis: 5000,
      });
      const restarted = new c.api.PostgreSqlModuleRuntime({
        module: c.module,
        pool: pool2,
        storage: c.storage,
      });
      try {
        await restarted.start();
        const execute = (envelope) => restarted.dispatch(envelope);
        assert.equal((await execute(delivery)).kind, "duplicate");
        await assert.rejects(
          execute(
            c.api.createEventEnvelope({
              ...delivery,
              payload: { id, label: "collision" },
            }),
          ),
          c.api.EventIdCollisionError,
        );
      } finally {
        await cleanup(
          () => restarted.stop(),
          () => pool2.end(),
        );
      }
      return "Seven concurrent deliveries produce one owner row/outbox/mailbox; fresh DB connection and runtime retain deduplication and reject same eventId with different payload";
    },
  ),
  pg("outbox-transaction-rollback", ["EE-PG-005"], "negative", async (c) => {
    const id = randomUUID();
    await c.execute("Register", { id, label: "atomic" });
    const before = (
      await c.pool.query(
        `SELECT label,__vane_revision::text AS revision FROM ${c.owner}`,
      )
    ).rows;
    assert.equal(await c.count(c.technical("outbox")), 1);
    await c.pool.query(
      `ALTER TABLE ${c.technical("outbox")} ADD CONSTRAINT conformance_reject_append CHECK(false) NOT VALID`,
    );
    const delivery = c.envelope("Rename", { id, label: "must roll back" });
    await assert.rejects(c.execute("Rename", delivery.payload, delivery));
    assert.deepEqual(
      (
        await c.pool.query(
          `SELECT label,__vane_revision::text AS revision FROM ${c.owner}`,
        )
      ).rows,
      before,
    );
    assert.equal(await c.count(c.technical("outbox")), 1);
    assert.equal(
      Number(
        (
          await c.pool.query(
            `SELECT count(*) AS count FROM ${c.technical("mailbox")} WHERE event_id=$1`,
            [delivery.eventId],
          )
        ).rows[0].count,
      ),
      0,
    );
    return "Successful persistence and outbox commit together; deliberate DB outbox rejection rolls back owner revision/value and mailbox receipt";
  }),
  pg(
    "outbox-restart-recovery",
    ["EE-RUN-005", "EE-NFR-007"],
    "positive",
    async (c) => {
      const delivery = c.envelope("Register", {
        id: randomUUID(),
        label: "recover accepted",
      });
      await c.execute("Register", delivery.payload, delivery);
      const first = new c.api.PostgreSqlOutboxDispatcher(c.pool, c.storage);
      const claimed = await first.claim({
        workerId: "before",
        limit: 1,
        leaseMilliseconds: 60000,
      });
      assert.equal(claimed.length, 1);
      assert.equal(
        (
          await first.claim({
            workerId: "competitor",
            limit: 1,
            leaseMilliseconds: 60000,
          })
        ).length,
        0,
      );
      await c.pool.query(
        `UPDATE ${c.technical("outbox")} SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1`,
        [delivery.eventId],
      );
      const pool2 = new c.Pool({
        connectionString: c.databaseUrl,
        connectionTimeoutMillis: 5000,
      });
      try {
        const recoveredDispatcher = new c.api.PostgreSqlOutboxDispatcher(
          pool2,
          c.storage,
        );
        const recovered = await recoveredDispatcher.claim({
          workerId: "after",
          limit: 1,
          leaseMilliseconds: 60000,
        });
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].eventId, delivery.eventId);
        assert.equal(recovered[0].attempt, 2);
        await assert.rejects(
          first.acknowledge({
            messageId: claimed[0].messageId,
            workerId: "before",
            leaseToken: claimed[0].leaseToken,
            publishedAt: new Date().toISOString(),
          }),
          c.api.LostOutboxLeaseError,
        );
        await recoveredDispatcher.acknowledge({
          messageId: recovered[0].messageId,
          workerId: "after",
          leaseToken: recovered[0].leaseToken,
          publishedAt: new Date().toISOString(),
        });
      } finally {
        await pool2.end();
      }
      assert.equal(
        (
          await c.pool.query(
            `SELECT status FROM ${c.technical("outbox")} WHERE event_id=$1`,
            [delivery.eventId],
          )
        ).rows[0].status,
        "published",
      );
      return "Accepted outbox message survives abandoned lease and fresh connection/runtime; competing claim excluded, expired delivery recovered, stale acknowledgement rejected, recovered publication persisted";
    },
  ),
  pg(
    "saga-restart-recovery",
    ["EE-SAGA-003", "EE-SAGA-004", "EE-RUN-005", "EE-PG-006"],
    "positive",
    async (c) => {
      const plan = c.api.materializeSagaPlan(c.module, "RegisterParcel");
      const events = new c.api.PostgreSqlModuleRuntime({
        module: c.module,
        pool: c.pool,
        storage: c.storage,
      });
      await events.start();
      const views = new c.api.PostgreSqlViewRuntime(
        c.module,
        c.pool,
        c.storage,
      );
      const store = new c.api.PostgreSqlSagaStore(c.pool, c.storage);
      const runtime = new c.api.PostgreSqlSagaRuntime({
        plans: [plan],
        store,
        events,
        views,
      });
      let pool2;
      let events2;
      let runtime2;
      try {
        const id = randomUUID();
        const correlationId = randomUUID();
        const sagaId = await runtime.admit(
          plan,
          { id, label: "saga durable" },
          { correlationId },
        );
        assert.equal(await runtime.runOnce(), true);
        const checkpoint = await store.read(sagaId);
        assert.ok(checkpoint);
        assert.notEqual(checkpoint.status, "terminal");
        await cleanup(
          () => runtime.stop(),
          () => events.stop(),
        );
        pool2 = new c.Pool({
          connectionString: c.databaseUrl,
          connectionTimeoutMillis: 5000,
        });
        events2 = new c.api.PostgreSqlModuleRuntime({
          module: c.module,
          pool: pool2,
          storage: c.storage,
        });
        await events2.start();
        const store2 = new c.api.PostgreSqlSagaStore(pool2, c.storage);
        runtime2 = new c.api.PostgreSqlSagaRuntime({
          plans: [plan],
          store: store2,
          events: events2,
          views: new c.api.PostgreSqlViewRuntime(c.module, pool2, c.storage),
        });
        for (let i = 0; i < 20; i++) {
          if (!(await runtime2.runOnce())) break;
        }
        const finished = await store2.read(sagaId);
        assert.equal(finished.status, "terminal");
        assert.equal(finished.terminal.kind, "view");
        assert.equal(finished.terminal.view, "ParcelCard");
        assert.deepEqual(finished.terminal.data, [
          { id, label: "saga durable", active: false },
        ]);
        assert.ok(finished.steps.every((s) => s.status === "success"));
        const root = finished.steps.find((s) => s.name === "register");
        const child = finished.steps.find((s) => s.name === "activate");
        for (const step of finished.steps) {
          assert.equal(step.envelope.sagaId, sagaId);
          assert.equal(step.envelope.correlationId, correlationId);
          assert.match(step.envelope.eventIdentity, /^Parcel\./);
        }
        assert.equal(child.envelope.causationId, root.envelope.eventId);
        assert.deepEqual(child.causedByEventIds, [root.envelope.eventId]);
        assert.equal(await c.count(c.owner), 1);
        assert.equal(await c.count(c.technical("outbox")), 2);
        return "Saga checkpoint survives stopped runtime and fresh connection/store/runtime; remaining Events finish once, final View matches persisted state, saga/correlation/causation/Event identities retained";
      } finally {
        await cleanup(
          () => runtime.stop(),
          () => events.stop(),
          () => runtime2?.stop(),
          () => events2?.stop(),
          () => pool2?.end(),
        );
      }
    },
  ),
];
