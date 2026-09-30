import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Independent domain fixture. All framework behavior is accessed via the installed package API.
const sourceText = `
import { Entity, Column, Event, create, input, View, field, eq, ACL, ACLEvent, success, fail, Module } from "@lilka/vane";
@Entity()
class Note {
  id = Column({ type: "uuid", identity: true });
  text = Column({ type: "string" });
  Write = Event({ input: { id: "uuid", text: "string" }, operation: create({ id: input("id"), text: input("text") }) });
}
@View({ input: { id: "uuid" }, output: { id: field(Note, "id"), text: field(Note, "text") }, query: { root: Note, where: eq(field(Note, "id"), input("id")) } })
class NoteCard {}
@ACL()
class Delivery {
  Send = ACLEvent({ input: { text: "string" }, results: { delivered: success({ receipt: "string" }), refused: fail({}) } });
}
@Module({ entities: [Note], views: [NoteCard], antiCorruptionLayers: [Delivery] })
class Notebook {}
`;
const id = "10000000-0000-4000-8000-000000000001";
function project(api) {
  const result = api.compileProjectSources([
    { fileName: "notebook.ts", sourceText },
  ]);
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  return result.ir;
}
function exposure() {
  return {
    basePath: "/notebook",
    views: [{ view: "NoteCard", path: "/read" }],
    events: [
      {
        event: "Note.Write",
        path: "/write",
        terminal: {
          view: "NoteCard",
          input: { id: { kind: "eventInput", input: "id" } },
        },
      },
    ],
  };
}
function configuration(api) {
  return api.serviceConfiguration({
    application: "conformance-notebook",
    project: project(api),
    providers: api.BUILTIN_PROVIDERS,
    profiles: {
      development: {
        environment: "development",
        topology: api.monolith({
          name: "notebook-api",
          modules: ["Notebook"],
          runtime: api.node(),
          persistence: {
            provider: api.postgres(),
            namespace: "conformance",
            targetVersion: 16,
            connection: api.env("CONFORMANCE_DATABASE"),
          },
        }),
        communication: {
          mailbox: api.postgresMailbox(),
          outbox: api.postgresOutbox(),
          deduplication: api.postgresDeduplication(),
          saga: api.postgresSaga(),
          failureQueue: api.postgresFailureQueue(),
        },
        http: {
          provider: api.http(),
          sagaStream: api.sse(),
          security: {
            authentication: "none",
            authorization: "allow",
            cors: [],
            rateLimit: null,
          },
        },
        acls: {
          "Notebook.Delivery.Send": {
            provider: api.httpAcl(),
            version: "1",
            endpoint: api.env("CONFORMANCE_DELIVERY"),
            idempotencyHeader: "Idempotency-Key",
            responses: [
              {
                status: 200,
                result: "delivered",
                fields: { receipt: "receipt_id" },
              },
              { status: 409, result: "refused", fields: {} },
            ],
          },
        },
        contracts: { Notebook: exposure() },
      },
      test: { extends: "development", environment: "test" },
      production: { extends: "development", environment: "production" },
    },
  });
}
function plan(api, config, profile = "test") {
  const result = api.compileServiceConfiguration(config, profile);
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  return result;
}
function reject(api, config, profile = "test") {
  const result = api.compileServiceConfiguration(config, profile);
  assert.equal(result.success, false, "Invalid configuration must fail");
  assert.equal(Object.hasOwn(result, "plan"), false);
  assert.ok(result.diagnostics.length);
  for (const diagnostic of result.diagnostics)
    assert.ok(
      diagnostic.code &&
        diagnostic.path.length &&
        diagnostic.message &&
        diagnostic.correction,
    );
  return result;
}
function contract(api) {
  return plan(api, configuration(api)).plan.contracts[0];
}
function acl(api, execute) {
  const event = project(api).modules[0].antiCorruptionLayers[0].events[0];
  const adapter = {
    eventIdentity: "Delivery.Send",
    version: "1",
    results: ["delivered", "refused"],
    idempotency: "eventId",
    execute,
  };
  return {
    event,
    adapter,
    runtime: new api.AclEventRuntime([event], [adapter]),
  };
}
function envelope(api, payload = { text: "hello" }) {
  return api.createEventEnvelope({
    eventId: id,
    eventIdentity: "Delivery.Send",
    correlationId: id,
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload,
  });
}
function test(id, requirements, kind, run) {
  return { id, requirements, kind, run };
}

export const cases = [
  test(
    "service.http-security-enforcement",
    ["EE-SVC-027", "EE-NFR-006"],
    "positive",
    async (context) => {
      const { api, packageRoot, databaseUrl } = context;
      if (!databaseUrl)
        throw Object.assign(
          new Error(
            "Real PostgreSQL is required for configured HTTP security enforcement",
          ),
          { code: "CONFORMANCE_GAP" },
        );
      const { Pool } = createRequire(join(packageRoot, "package.json"))("pg");
      const pool = new Pool({
        connectionString: databaseUrl,
        max: 5,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
      });
      const namespace = `vane_service_${randomUUID().replaceAll("-", "")}`;
      let runtime;
      let server;
      let migrated = false;
      const secretToken = "SYNTHETIC-HTTP-BEARER-SECRET";
      const close = async () => {
        if (server) {
          const closing = new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          server.closeAllConnections();
          await closing;
          server = undefined;
        }
        if (runtime) {
          await runtime.stop();
          runtime = undefined;
        }
      };
      try {
        const version = await pool.query("SHOW server_version_num");
        context.postgresqlVersion = String(version.rows[0].server_version_num);
        assert.ok(Number(version.rows[0].server_version_num) >= 160000);
        const config = configuration(api);
        config.profiles.development.topology.service.persistence.namespace =
          namespace;
        config.profiles.production.http = {
          provider: api.http(),
          sagaStream: api.sse(),
          security: {
            authentication: { bearer: api.env("HTTP_TEST_TOKEN") },
            authorization: "allow",
            cors: ["https://allowed.invalid"],
            rateLimit: { requests: 2, windowMs: 60000 },
          },
        };
        config.profiles.production.contracts = {
          Notebook: { views: [{ view: "NoteCard", path: "/read" }] },
        };
        const compiled = plan(api, config, "production").plan;
        await api.applyPostgreSqlMigrationPlan(
          pool,
          api.createPostgreSqlMigrationPlan({
            previous: null,
            next: compiled.storage,
          }),
        );
        migrated = true;
        const start = async () => {
          runtime = await api.createServiceRuntime(config, "production", {
            pool,
            resolveSecret: async (_reference, slot) =>
              slot === "http.authentication.bearer"
                ? secretToken
                : "https://example.invalid/delivery",
          });
          server = createServer((request, response) => {
            runtime.handler(request, response).catch(() => {
              response.writeHead(500);
              response.end("Unexpected handler failure");
            });
          });
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          return `http://127.0.0.1:${server.address().port}`;
        };
        let base = await start();
        const request = async (path, options = {}) => {
          const response = await fetch(`${base}${path}`, {
            ...options,
            signal: AbortSignal.timeout(3000),
          });
          const body = await response.text();
          assert.equal(body.includes(secretToken), false);
          assert.equal(body.includes("stack"), false);
          return { status: response.status, headers: response.headers, body };
        };
        assert.equal((await request("/read")).status, 503);
        await runtime.start();
        assert.equal((await request("/read")).status, 401);
        assert.equal(
          (
            await request("/read", {
              headers: { Authorization: "Bearer wrong" },
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await request("/read", {
              headers: { Origin: "https://denied.invalid" },
            })
          ).status,
          403,
        );
        const preflight = await request("/read", {
          method: "OPTIONS",
          headers: { Origin: "https://allowed.invalid" },
        });
        assert.equal(preflight.status, 204);
        assert.equal(
          preflight.headers.get("access-control-allow-origin"),
          "https://allowed.invalid",
        );
        assert.match(
          preflight.headers.get("access-control-allow-headers"),
          /Authorization/,
        );
        const headers = {
          Authorization: `Bearer ${secretToken}`,
          Origin: "https://allowed.invalid",
          "Content-Type": "application/json",
        };
        assert.equal((await request("/absent", { headers })).status, 404);
        const view = await request("/read", {
          method: "POST",
          headers,
          body: JSON.stringify({ id }),
        });
        assert.equal(view.status, 200);
        assert.deepEqual(JSON.parse(view.body), []);
        assert.equal(
          view.headers.get("access-control-allow-origin"),
          "https://allowed.invalid",
        );
        const limited = await request("/read", {
          method: "POST",
          headers,
          body: JSON.stringify({ id }),
        });
        assert.equal(limited.status, 429);
        assert.deepEqual(Object.keys(JSON.parse(limited.body)).sort(), [
          "code",
          "correlationId",
          "message",
        ]);
        await close();
        config.profiles.production.http.security.authorization = "deny";
        base = await start();
        await runtime.start();
        assert.equal(
          (
            await request("/read", {
              method: "POST",
              headers,
              body: JSON.stringify({ id }),
            })
          ).status,
          403,
        );
        return "Real PostgreSQL-started production HTTP service enforces bearer authentication, explicit deny, exact-origin CORS/preflight and fixed-window quota; valid authorized View returns 200, failures are safe. No identity-provider/per-resource or distributed quota claims.";
      } finally {
        try {
          await close();
        } finally {
          try {
            if (migrated)
              await pool.query(`DROP SCHEMA "${namespace}" CASCADE`);
          } finally {
            await pool.end();
          }
        }
      }
    },
  ),
  test(
    "service.complete-policy-precedence",
    ["EE-SVC-018", "EE-SVC-019", "EE-SVC-020"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      const original = api.serializeSemanticProjectIr(config.project);
      const overrides = [
        {
          timeoutMs: 2000,
          retry: { attempts: 2, backoff: "fixed", delayMs: 10, maxDelayMs: 10 },
          idempotency: "required",
          deduplication: "durable",
        },
        {
          timeoutMs: 3000,
          retry: {
            attempts: 3,
            backoff: "exponential",
            delayMs: 20,
            maxDelayMs: 100,
          },
          idempotency: "required",
          deduplication: "durable",
        },
        {
          timeoutMs: 4000,
          retry: { attempts: 4, backoff: "fixed", delayMs: 30, maxDelayMs: 30 },
          idempotency: "required",
          deduplication: "durable",
        },
      ];
      const names = ["Notebook.Note.Write", "Notebook.Delivery.Send"];
      const assertPolicies = (expected, source) => {
        const policies = plan(api, config).plan.runtime.policies;
        assert.equal(policies.length, 2);
        for (const policy of policies) {
          assert.deepEqual(policy.effective, expected);
          for (const field of Object.keys(expected))
            assert.equal(
              policy.sources[field],
              source === "events" ? `events.${policy.event}` : source,
            );
        }
      };
      assertPolicies(
        {
          timeoutMs: 10000,
          retry: { attempts: 1, backoff: "fixed", delayMs: 0, maxDelayMs: 0 },
          idempotency: "required",
          deduplication: "durable",
        },
        "framework",
      );
      config.profiles.test.policies = { defaults: overrides[0] };
      assertPolicies(overrides[0], "defaults");
      config.profiles.test.policies.services = { "notebook-api": overrides[1] };
      assertPolicies(overrides[1], "services.notebook-api");
      config.profiles.test.policies.events = Object.fromEntries(
        names.map((name) => [name, overrides[2]]),
      );
      assertPolicies(overrides[2], "events");
      assert.equal(api.serializeSemanticProjectIr(config.project), original);
      for (const [field, value] of Object.entries(overrides[0])) {
        for (const owner of ["Write = Event({", "Send = ACLEvent({"]) {
          const invalid = api.compileProjectSources([
            {
              fileName: "misplaced-policy.ts",
              sourceText: sourceText.replace(
                owner,
                `${owner} ${field}: ${JSON.stringify(value)},`,
              ),
            },
          ]);
          assert.equal(
            invalid.success,
            false,
            `${field} must not be accepted in semantic ${owner}`,
          );
        }
      }
      return "All policy fields including complete retry/backoff resolve framework<defaults<service<Entity/ACL Event overrides with field provenance; technical policies are rejected in both semantic Event owner forms.";
    },
  ),
  test(
    "service.secret-public-surfaces",
    ["EE-ACL-006", "EE-SVC-030", "EE-NFR-004"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      const sentinel = "SECRET-SURFACE-SENTINEL-7d36";
      const profile = config.profiles.development;
      profile.topology.service.persistence.connection =
        api.localSecret(sentinel);
      profile.http.security.authentication = {
        bearer: api.localSecret(sentinel),
      };
      profile.acls["Notebook.Delivery.Send"].endpoint = api.localSecret(
        `https://example.invalid/${sentinel}`,
      );
      profile.acls["Notebook.Delivery.Send"].headers = {
        Authorization: api.localSecret(sentinel),
      };
      const result = plan(api, config);
      const surfaces = [
        api.serializeSemanticProjectIr(config.project),
        api.serializeServicePlan(result.plan),
        JSON.stringify(result.warnings),
      ];
      surfaces.push(
        ...Object.values(
          api.generateServiceDeployment(result.plan, config.project),
        ),
      );
      surfaces.push(
        ...result.plan.contracts.map((contract) =>
          api.serializeOpenApi(api.generateOpenApi(contract)),
        ),
      );
      surfaces.push(JSON.stringify(reject(api, config, "production")));
      const records = [];
      const telemetry = new api.RuntimeTelemetry(
        { exporter: "json", redact: ["privateHeader"] },
        (record) => records.push(record),
      );
      telemetry.record("service.conformance", {
        event: "Note.Write",
        correlationId: id,
        token: sentinel,
        nested: { Authorization: sentinel, privateHeader: sentinel },
        input: { text: sentinel },
        payload: { text: sentinel },
      });
      assert.equal(records.length, 1);
      assert.equal(records[0].attributes.event, "Note.Write");
      assert.equal(records[0].attributes.correlationId, id);
      surfaces.push(JSON.stringify(records));
      for (const surface of surfaces)
        assert.equal(
          surface.includes(sentinel),
          false,
          "Secret sentinel leaked into a public artefact, diagnostic or configured telemetry record",
        );
      return "Supported secret slots are excluded from semantic/technical IRs, deployment files including snapshots/OpenAPI, warnings and rejection diagnostics; configured nested telemetry redaction preserves identity but removes secrets/payload. Arbitrary user logging is not covered.";
    },
  ),
  test(
    "service.rejects-unenforceable-columns-and-rules",
    ["EE-COL-004", "EE-RUL-004"],
    "negative",
    async ({ api }) => {
      const config = configuration(api);
      const constrained = sourceText
        .replace(
          "Entity, Column, Event,",
          "Entity, Column, Rule, column, gt, Event,",
        )
        .replace(
          'text = Column({ type: "string" });',
          `text = Column({ type: "string", minLength: 1, maxLength: 40, unique: true });
        starts = Column({ type: "integer", default: 0 });
        ends = Column({ type: "integer", default: 1 });
        @Rule({ expression: gt(column("ends"), column("starts")) }) Ordered() {}`,
        );
      const semantic = api.compileProjectSources([
        { fileName: "constrained.ts", sourceText: constrained },
      ]);
      assert.equal(
        semantic.success,
        true,
        JSON.stringify(semantic.diagnostics),
      );
      config.project = semantic.ir;
      const entity = config.project.modules[0].entities[0];
      assert.equal(entity.rules.length, 1);
      assert.deepEqual(entity.rules[0].columns, ["ends", "starts"]);
      const text = entity.columns.find((column) => column.name === "text");
      assert.equal(text.minLength, 1);
      assert.equal(text.maxLength, 40);
      assert.equal(text.unique, true);
      plan(api, config);
      for (const capability of ["columns", "rules"]) {
        const inadequate = structuredClone(config);
        inadequate.providers = inadequate.providers.map((provider) =>
          provider.id === "vane.postgresql"
            ? {
                ...provider,
                capabilities: provider.capabilities.filter(
                  (value) => value !== capability,
                ),
              }
            : provider,
        );
        const rejected = reject(api, inadequate);
        assert.ok(
          rejected.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === "VANE_SVC_CAPABILITY" &&
              diagnostic.path.includes("persistence"),
          ),
        );
      }
      return "Constrained Columns and a declared two-Column Rule compile with capable PostgreSQL provider; removing columns/rules guarantee rejects with persistence capability diagnostic and no partial plan. Fine-grained per-constraint backend differences are not claimed.";
    },
  ),
  test(
    "service.canonical-root",
    ["EE-SVC-001"],
    "negative",
    async ({ api }) => {
      const config = configuration(api);
      assert.equal(config.schema, "vane.service-configuration");
      assert.equal(config.version, 1);
      plan(api, config);
      reject(api, [config, configuration(api)]);
      reject(api, { ...config, configurations: [configuration(api)] });
      reject(api, { ...config, schema: "competing-root" });
      reject(api, { ...config, version: 999 });
      return "One canonical versioned configuration root compiles; root arrays, nested competing configurations, foreign schema and unsupported version reject.";
    },
  ),
  test(
    "service.provider-metadata-contract",
    ["EE-SVC-015", "EE-NFR-010"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      const providers = plan(api, config).plan.runtime.providers;
      for (const provider of providers) {
        assert.equal(provider.interfaceVersion, 1);
        assert.equal(typeof provider.version, "string");
        assert.ok(provider.version.length);
        assert.ok(provider.capabilities.length);
        for (const dependency of provider.requires ?? []) {
          assert.ok(
            providers.some(
              (selected) =>
                selected.kind === dependency.kind &&
                selected.capabilities.includes(dependency.capability),
            ),
          );
        }
      }
      const invalid = configuration(api);
      invalid.providers = invalid.providers.map((provider) =>
        provider.id === "vane.node"
          ? { ...provider, interfaceVersion: 999 }
          : provider,
      );
      reject(api, invalid);
      const incompatible = configuration(api);
      incompatible.providers = incompatible.providers.map((provider) =>
        provider.id === "vane.node"
          ? {
              ...provider,
              requires: [
                { kind: "storage", capability: "unavailable-guarantee" },
              ],
            }
          : provider,
      );
      reject(api, incompatible);
      return "Negotiated providers expose version/interface/capabilities and satisfied compatibility dependencies; unsupported interface and unmet dependency reject.";
    },
  ),
  test(
    "service.versioned-ir-envelopes",
    ["EE-NFR-009"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      const result = plan(api, config).plan;
      const semantic = api.compileModuleSource({
        fileName: "notebook.ts",
        sourceText,
      });
      assert.equal(semantic.success, true);
      for (const ir of [
        config.project,
        semantic.ir,
        result.runtime,
        result.storage,
        ...result.contracts,
        result.infrastructure,
      ]) {
        const serialized = JSON.parse(JSON.stringify(ir));
        assert.equal(typeof serialized.schema, "string");
        assert.ok(
          Number.isInteger(serialized.version) && serialized.version > 0,
        );
      }
      return "Semantic Module/project and every generated runtime/storage/contract/infrastructure IR expose a positive integer version in their serialized envelope.";
    },
  ),
  test(
    "service.profile-semantic-stability",
    ["EE-SEM-002"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      config.profiles.staging = {
        extends: "development",
        environment: "staging",
        policies: { defaults: { timeoutMs: 9000 } },
      };
      config.profiles.production.policies = { defaults: { timeoutMs: 12000 } };
      const before = api.serializeSemanticProjectIr(config.project);
      const plans = Object.keys(config.profiles).map(
        (profile) => plan(api, config, profile).plan,
      );
      assert.equal(new Set(plans.map((value) => value.inputHash)).size, 4);
      assert.equal(
        new Set(plans.map((value) => value.runtime.semanticProjectHash)).size,
        1,
      );
      assert.equal(api.serializeSemanticProjectIr(config.project), before);
      for (const value of plans)
        assert.deepEqual(value.runtime.ownership, plans[0].runtime.ownership);
      return "Four technical environment profiles produce distinct plans while preserving byte-identical semantic project/hash and explicit ownership; productive distributed execution is not claimed.";
    },
  ),
  test(
    "acl.technical-separation-and-http-binding",
    ["EE-SVC-023", "EE-SVC-024"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      const mapping =
        config.profiles.development.acls["Notebook.Delivery.Send"];
      mapping.endpoint = api.env("CONTROLLED_DELIVERY_ENDPOINT");
      mapping.headers = { Authorization: api.env("CONTROLLED_DELIVERY_AUTH") };
      mapping.method = "PUT";
      const resolved = plan(api, config).plan;
      assert.deepEqual(
        resolved.effective.acls["Notebook.Delivery.Send"],
        mapping,
      );
      const semantic = api.serializeSemanticProjectIr(config.project);
      for (const term of [
        "CONTROLLED_DELIVERY_ENDPOINT",
        "CONTROLLED_DELIVERY_AUTH",
        "Idempotency-Key",
        "receipt_id",
      ])
        assert.equal(semantic.includes(term), false);
      const invalid = api.compileProjectSources([
        {
          fileName: "notebook.ts",
          sourceText: sourceText.replace(
            "Send = ACLEvent({",
            'Send = ACLEvent({ endpoint: "https://example.invalid",',
          ),
        },
      ]);
      assert.equal(invalid.success, false);
      let requests = 0;
      const adapter = api.httpAclAdapter({
        eventIdentity: "Delivery.Send",
        version: mapping.version,
        url: "https://example.invalid/deliver",
        method: mapping.method,
        idempotencyHeader: mapping.idempotencyHeader,
        headers: () => ({ Authorization: "Bearer synthetic-test-token" }),
        responses: mapping.responses,
        fetch: async (url, request) => {
          requests++;
          assert.equal(String(url), "https://example.invalid/deliver");
          assert.equal(request.method, "PUT");
          assert.equal(
            request.headers.get("Authorization"),
            "Bearer synthetic-test-token",
          );
          assert.equal(request.headers.get("Idempotency-Key"), id);
          assert.equal(request.headers.get("content-type"), "application/json");
          assert.equal(request.redirect, "error");
          assert.deepEqual(JSON.parse(request.body), { text: "hello" });
          return new Response(
            JSON.stringify({
              receipt_id: "external-7",
              unrelated_private_field: "must-not-escape",
            }),
            { status: 200 },
          );
        },
      });
      const event = config.project.modules[0].antiCorruptionLayers[0].events[0];
      const result = await new api.AclEventRuntime([event], [adapter]).dispatch(
        envelope(api),
      );
      assert.equal(requests, 1);
      assert.equal(result.kind, "success");
      assert.deepEqual(result.data, { receipt: "external-7" });
      return "ACL infrastructure stays in profile and is rejected in semantic DSL; public HTTP adapter port uses configured method/endpoint/auth/idempotency/JSON and maps only declared external response fields. No real external system is contacted.";
    },
  ),
  test(
    "http.synchronous-view-contract",
    ["EE-HTTP-003"],
    "positive",
    async ({ api }) => {
      const ir = contract(api);
      const operation = ir.operations.find((value) => value.kind === "view");
      assert.deepEqual(
        operation.output.map((field) => [field.name, field.type]),
        [
          ["id", "uuid"],
          ["text", "string"],
        ],
      );
      let calls = 0;
      const runtime = new api.PublicHttpRuntime({
        contract: ir,
        terminals: new api.InMemoryTerminalResultStore(),
        events: {
          dispatch: async () => {
            throw new Error("View must not dispatch an Event");
          },
        },
        views: {
          execute: async (request) => {
            calls++;
            assert.deepEqual(request, { view: "NoteCard", input: { id } });
            return { view: "NoteCard", rows: [{ id, text: "A typed card" }] };
          },
        },
      });
      const response = await runtime.handle({
        method: "POST",
        path: operation.path,
        body: { id },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers["content-type"], /^application\/json/);
      assert.deepEqual(JSON.parse(response.body), [
        { id, text: "A typed card" },
      ]);
      const invalid = await runtime.handle({
        method: "POST",
        path: operation.path,
        body: { id: 42 },
      });
      assert.equal(invalid.status, 400);
      assert.equal(calls, 1);
      return "Synchronous View HTTP port preserves declared uuid/string row output and rejects mistyped input before query; database query execution is covered separately.";
    },
  ),
  test(
    "package.public-types",
    ["EE-NFR-002", "EE-NFR-003", "EE-SVC-002"],
    "positive",
    async ({ api, packageRoot }) => {
      // Resolve the declared compiler dependency of the installed package, never repository tooling.
      const require = createRequire(join(packageRoot, "package.json"));
      const ts = require("typescript");
      const directory = await mkdtemp(
        join(resolve(packageRoot, "../../.."), "service-types-"),
      );
      try {
        const file = join(directory, "consumer.mts");
        const good = `import { Column, Event, create, input, node, postgres, serviceConfiguration, compileServiceConfiguration, type SemanticProjectIr, type ProviderSelection } from "@lilka/vane";
        const column = Column({ type: "integer" });
        const inferred: "integer" = column.semanticType;
        const runtime: ProviderSelection<"runtime"> = node();
        const storage: ProviderSelection<"storage"> = postgres();
        const event = Event({ input: { count: "integer" }, operation: create({ count: input("count") }) });
        declare const project: SemanticProjectIr;
        const config = serviceConfiguration({ application: "typed", project, providers: [], profiles: {
          development: { environment: "development" }, test: { environment: "test" },
          staging: { environment: "staging" }, production: { environment: "production" }
        } });
        compileServiceConfiguration(config, "staging");
        void [inferred, runtime, storage, event];`;
        const options = {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
        };
        const diagnostics = () =>
          ts.getPreEmitDiagnostics(ts.createProgram([file], options));
        await writeFile(file, good);
        assert.deepEqual(
          diagnostics().map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          ),
          [],
        );
        const runtimeConfig = configuration(api);
        runtimeConfig.profiles.staging = {
          extends: "development",
          environment: "staging",
        };
        for (const name of Object.keys(runtimeConfig.profiles))
          plan(api, runtimeConfig, name);
        for (const [code, source] of [
          [
            2345,
            good.replace(
              'compileServiceConfiguration(config, "staging")',
              'compileServiceConfiguration(config, "unknown")',
            ),
          ],
          [
            2322,
            good.replace(
              'staging: { environment: "staging" }',
              'staging: { environment: "preview" }',
            ),
          ],
          [
            2322,
            good.replace(
              'const inferred: "integer"',
              'const inferred: "string"',
            ),
          ],
          [
            2322,
            good.replace(
              'ProviderSelection<"runtime"> = node()',
              'ProviderSelection<"runtime"> = postgres()',
            ),
          ],
          [
            2345,
            `import { Event } from "@lilka/vane"; Event({ input: { count: "integer" } });`,
          ],
        ]) {
          await writeFile(file, source);
          const errors = diagnostics();
          assert.ok(
            errors.some((diagnostic) => diagnostic.code === code),
            JSON.stringify(
              errors.map((diagnostic) => ({
                code: diagnostic.code,
                message: ts.flattenDiagnosticMessageText(
                  diagnostic.messageText,
                  "\n",
                ),
              })),
            ),
          );
          assert.ok(
            errors.every(
              (diagnostic) => ![2307, 7016].includes(diagnostic.code),
            ),
            "Missing package/types must not masquerade as a negative type test",
          );
        }
        return "External installed-package TypeScript consumer preserves Column semantic type/provider kind and rejects unknown profile, invalid environment, wrong inferred type/provider kind and Event without persistence operation; full View/input inference remains untested.";
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  ),
  test(
    "cli.static-validation-and-plan",
    [
      "EE-CLI-001",
      "EE-CLI-002",
      "EE-CLI-003",
      "EE-CMD-001",
      "EE-CMD-002",
      "EE-RUN-001",
      "EE-SVC-017",
    ],
    "positive",
    async ({ api, cli }) => {
      const directory = await mkdtemp(join(tmpdir(), "vane-service-cli-"));
      try {
        const config = configuration(api);
        config.profiles.test.policies = { defaults: { timeoutMs: 4567 } };
        const configPath = join(directory, "configuration.mjs");
        await writeFile(
          configPath,
          `export default ${JSON.stringify(config)};\n`,
        );
        const env = {
          ...process.env,
          CONFORMANCE_DATABASE: "",
          CONFORMANCE_DELIVERY: "",
        };
        assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
        assert.equal(
          plan(api, config).plan.runtime.service.runtime,
          "vane.node",
        );
        const json = await cli(["validate", "--config", configPath, "--json"], {
          env,
        });
        assert.equal(json.status, 0, json.stderr);
        const validation = JSON.parse(json.stdout);
        assert.equal(validation.success, true);
        assert.deepEqual(Object.keys(validation.profiles).sort(), [
          "development",
          "production",
          "test",
        ]);
        const human = await cli(["validate", "--config", configPath], { env });
        assert.equal(human.status, 0, human.stderr);
        assert.match(human.stdout, /\n\s+"profiles"/);
        const planned = await cli(
          ["plan", "--config", configPath, "--profile", "test", "--json"],
          { env },
        );
        assert.equal(planned.status, 0, planned.stderr);
        const result = JSON.parse(planned.stdout);
        assert.equal(result.profile, "test");
        assert.equal(result.effective.environment, "test");
        assert.deepEqual(result.runtime.ownership, [
          { entity: "Notebook.Note", service: "notebook-api" },
        ]);
        assert.ok(
          result.runtime.providers.every(
            (provider) => provider.capabilities.length,
          ),
        );
        assert.ok(Object.keys(result.artifactHashes).length >= 4);
        assert.ok(
          result.runtime.policies.every(
            (policy) => policy.effective.timeoutMs === 4567,
          ),
        );
        return "Installed CLI validates all profiles in readable/JSON modes and resolves inspectable ownership/providers/capabilities/artifact hashes with unresolved database and endpoint references.";
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  ),
  test(
    "cli.invalid-configuration-and-generation",
    ["EE-CLI-001", "EE-CLI-004", "EE-CMD-003"],
    "negative",
    async ({ api, cli }) => {
      const directory = await mkdtemp(join(tmpdir(), "vane-service-cli-"));
      try {
        const config = configuration(api);
        const sentinel = "CLI-PRIVATE-SENTINEL-MUST-NOT-APPEAR";
        config.profiles.development.topology.service.persistence.connection =
          api.localSecret(sentinel);
        const configPath = join(directory, "configuration.mjs");
        await writeFile(
          configPath,
          `export default ${JSON.stringify(config)};\n`,
        );
        const commands = [
          ["validate", "--config", configPath, "--profile", "test", "--json"],
          ["plan", "--config", configPath, "--profile", "test", "--json"],
          [
            "generate",
            "--config",
            configPath,
            "--profile",
            "test",
            "--out",
            join(directory, "generated"),
            "--json",
          ],
          [
            "validate",
            "--config",
            configPath,
            "--profile",
            "production",
            "--json",
          ],
          ["plan", "--config", configPath, "--profile", "production", "--json"],
        ];
        for (const [index, args] of commands.entries()) {
          const result = await cli(args);
          assert.equal(result.status, index < 3 ? 0 : 1, result.stderr);
          assert.equal(
            `${result.stdout}${result.stderr}`.includes(sentinel),
            false,
          );
          const output = JSON.parse(result.stdout);
          if (index >= 3) {
            assert.equal(output.success, false);
            assert.ok(output.diagnostics.length);
          }
          if (index === 2) {
            assert.equal(output.success, true);
            assert.ok(output.files.includes("Dockerfile"));
          }
        }
        const generatedPlan = await readFile(
          join(directory, "generated", "plan.json"),
          "utf8",
        );
        assert.equal(generatedPlan.includes(sentinel), false);
        const repeated = await cli(commands[2]);
        assert.equal(
          repeated.status,
          1,
          "Generation must refuse existing output",
        );
        assert.equal(
          `${repeated.stdout}${repeated.stderr}`.includes(sentinel),
          false,
        );
        assert.equal(
          await readFile(join(directory, "generated", "plan.json"), "utf8"),
          generatedPlan,
        );
        const unknown = await cli(["unknown", "--config", configPath]);
        assert.equal(unknown.status, 1);
        assert.match(unknown.stderr, /Usage:/);
        return "Static validate/plan/generate redact local sentinel secrets; production literals fail with JSON diagnostics; generation refuses overwrites and invalid commands fail nonzero. Operational CLI families remain untested.";
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  ),
  test(
    "service.multi-module-ownership",
    ["EE-SVC-006", "EE-SVC-009", "EE-SVC-010", "EE-SVC-013", "EE-SVC-022"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      const compiled = api.compileProjectSources([
        {
          fileName: "notebook.ts",
          sourceText: sourceText.replace(
            "class Notebook",
            "export class Notebook",
          ),
        },
        {
          fileName: "tags.ts",
          sourceText: `import { Entity, Column, Module } from "@lilka/vane";
        import { Notebook } from "./notebook.js";
        @Entity() class Tag { id = Column({ type: "uuid", identity: true }); }
        @Module({ imports: [Notebook], entities: [Tag] }) class Tags {}`,
        },
      ]);
      assert.equal(
        compiled.success,
        true,
        JSON.stringify(compiled.diagnostics),
      );
      config.project = compiled.ir;
      assert.deepEqual(
        config.project.modules.find((module) => module.name === "Tags").imports,
        ["Notebook"],
      );
      config.profiles.development.topology.service.modules.push("Tags");
      const resolved = plan(api, config).plan;
      assert.deepEqual(resolved.runtime.service.modules, ["Notebook", "Tags"]);
      assert.equal(resolved.runtime.service.runtime, "vane.node");
      assert.deepEqual(resolved.runtime.ownership, [
        { entity: "Notebook.Note", service: "notebook-api" },
        { entity: "Tags.Tag", service: "notebook-api" },
      ]);
      assert.equal(resolved.infrastructure.services.length, 1);
      assert.equal(resolved.infrastructure.services[0].name, "notebook-api");
      assert.equal(
        resolved.runtime.service.connectionSlot,
        "persistence.connection",
      );
      const kinds = resolved.runtime.providers.map((provider) => provider.kind);
      for (const kind of [
        "storage",
        "mailbox",
        "outbox",
        "saga",
        "failureQueue",
      ])
        assert.equal(kinds.filter((value) => value === kind).length, 1);
      return "Two explicit Modules share one named service/persistence selection; each Entity has one owner and technical store providers remain explicit.";
    },
  ),
  test(
    "service.rejects-weakened-policies",
    ["EE-SVC-019", "EE-SVC-020"],
    "negative",
    async ({ api }) => {
      for (const override of [
        { timeoutMs: 0 },
        { idempotency: "optional" },
        { deduplication: "none" },
        { retry: { attempts: 0, backoff: "fixed", delayMs: 0, maxDelayMs: 0 } },
      ]) {
        const config = configuration(api);
        config.profiles.test.policies = { defaults: override };
        reject(api, config);
      }
      const unknown = configuration(api);
      unknown.profiles.test.policies = {
        events: { "Notebook.Note.Absent": { timeoutMs: 1000 } },
      };
      reject(api, unknown);
      return "Invalid timeout/retry bounds, weakened idempotency/deduplication and unknown Event override fail statically.";
    },
  ),
  test(
    "service.explicit-http-security",
    ["EE-SVC-027"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      const security = {
        authentication: { bearer: api.env("CONFORMANCE_BEARER") },
        authorization: "deny",
        cors: ["https://example.invalid"],
        rateLimit: { requests: 5, windowMs: 1000 },
      };
      config.profiles.test.http = {
        provider: api.http(),
        sagaStream: api.sse(),
        security,
      };
      const effective = plan(api, config).plan.effective.http;
      assert.deepEqual(effective.security, security);
      assert.equal(effective.sagaStream.provider, "vane.sse");
      for (const invalid of [
        { ...security, authorization: "guess" },
        { ...security, cors: ["not an origin"] },
        { ...security, rateLimit: { requests: 0, windowMs: 1000 } },
      ]) {
        config.profiles.test.http.security = invalid;
        reject(api, config);
      }
      return "Authentication, authorization, CORS, rate limits and SSE are inspectable configuration; invalid security fails statically (not network enforcement).";
    },
  ),
  test(
    "service.deterministic-artifacts",
    ["EE-COMP-007", "EE-SVC-031", "EE-ART-001", "EE-NFR-001"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      const resolved = plan(api, config).plan;
      const repeated = configuration(api);
      assert.equal(
        api.serializeSemanticProjectIr(config.project),
        api.serializeSemanticProjectIr(repeated.project),
      );
      assert.equal(
        api.serializeServicePlan(resolved),
        api.serializeServicePlan(plan(api, repeated).plan),
      );
      const artifacts = api.generateServiceDeployment(resolved, config.project);
      assert.deepEqual(
        artifacts,
        api.generateServiceDeployment(plan(api, config).plan, config.project),
      );
      for (const name of [
        "runtime-ir.json",
        "storage-ir.json",
        "contract-ir.json",
        "infrastructure-ir.json",
        "Dockerfile",
        "deploy-plan.json",
      ])
        assert.ok(artifacts[name]);
      assert.equal(JSON.parse(artifacts["deploy-plan.json"]).apply, "manual");
      assert.equal(resolved.infrastructure.apply, "manual");
      assert.match(artifacts.Dockerfile, /FROM node:24/);
      assert.match(artifacts["bootstrap.mjs"], /createServiceRuntime/);
      assert.match(artifacts["configuration.mjs"], /export default/);
      assert.equal(
        JSON.parse(artifacts["package.json"]).dependencies["@lilka/vane"],
        "file:./vane.tgz",
      );
      return "Repeated public deployment generation returns identical separate IRs, Docker recipe and manual plan; no image build/cloud apply is claimed.";
    },
  ),
  test(
    "service.profile-inheritance",
    ["EE-SVC-004", "EE-SVC-005", "EE-COMP-005", "EE-COMP-007"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      for (const name of Object.keys(config.profiles)) {
        const { plan: resolved } = plan(api, config, name);
        assert.equal(resolved.profile, name);
        assert.equal(resolved.effective.environment, name);
        assert.equal(resolved.runtime.schema, "vane.runtime-ir");
        assert.equal(resolved.storage.schema, "vane.postgresql-storage-ir");
        assert.equal(resolved.contracts[0].schema, "vane.contract-ir");
        assert.equal(resolved.infrastructure.schema, "vane.infrastructure-ir");
        assert.deepEqual(resolved.runtime.ownership, [
          { entity: "Notebook.Note", service: "notebook-api" },
        ]);
      }
      return "All profiles resolve inherited configuration and separate IRs without runtime/database startup.";
    },
  ),
  test(
    "service.invalid-profiles-and-ownership",
    ["EE-SVC-012", "EE-COMP-008", "EE-COMP-009"],
    "negative",
    async ({ api }) => {
      for (const modules of [[], ["Notebook", "Notebook"], ["Missing"]]) {
        const config = configuration(api);
        config.profiles.development.topology.service.modules = modules;
        reject(api, config);
      }
      for (const parent of ["absent", "test"]) {
        const config = configuration(api);
        config.profiles.test.extends = parent;
        reject(api, config);
      }
      return "Absent/duplicate/unknown ownership and missing/cyclic inheritance reject with actionable diagnostics and no partial plan.";
    },
  ),
  test(
    "service.provider-negotiation",
    ["EE-SVC-014", "EE-SVC-016", "EE-COMP-006", "EE-COMP-009"],
    "negative",
    async ({ api }) => {
      const missing = configuration(api);
      missing.providers = missing.providers.filter(
        (provider) => provider.id !== "vane.node",
      );
      reject(api, missing);
      const incapable = configuration(api);
      incapable.providers = incapable.providers.map((provider) =>
        provider.id === "vane.postgresql"
          ? { ...provider, capabilities: [] }
          : provider,
      );
      reject(api, incapable);
      const wrong = configuration(api);
      wrong.profiles.development.topology.service.runtime = api.postgres();
      reject(api, wrong);
      return "Unregistered runtime, insufficient storage capabilities and wrong-kind provider selection fail before materialization.";
    },
  ),
  test(
    "service.policy-precedence",
    ["EE-SVC-019", "EE-SVC-020"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      config.profiles.development.policies = {
        defaults: { timeoutMs: 1000 },
        services: { "notebook-api": { timeoutMs: 2000 } },
        events: {
          "Notebook.Note.Write": { timeoutMs: 3000 },
          "Notebook.Delivery.Send": { timeoutMs: 4000 },
        },
      };
      const resolved = plan(api, config).plan;
      for (const [event, timeout] of [
        ["Notebook.Note.Write", 3000],
        ["Notebook.Delivery.Send", 4000],
      ]) {
        const policy = resolved.runtime.policies.find(
          (item) => item.event === event,
        );
        assert.equal(policy.effective.timeoutMs, timeout);
        assert.equal(policy.sources.timeoutMs, `events.${event}`);
        assert.equal(policy.effective.idempotency, "required");
      }
      config.profiles.development.policies.events = undefined;
      assert.ok(
        plan(api, config).plan.runtime.policies.every(
          (policy) =>
            policy.effective.timeoutMs === 2000 &&
            policy.sources.timeoutMs === "services.notebook-api",
        ),
      );
      config.profiles.development.policies.services = undefined;
      assert.ok(
        plan(api, config).plan.runtime.policies.every(
          (policy) =>
            policy.effective.timeoutMs === 1000 &&
            policy.sources.timeoutMs === "defaults",
        ),
      );
      return "Entity and ACL Event overrides beat service/defaults; removing overrides reveals service then defaults with explicit provenance.";
    },
  ),
  test(
    "service.secret-slots",
    ["EE-SVC-028", "EE-SVC-029", "EE-SVC-030", "EE-COMP-010", "EE-ACL-006"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      const sentinel = "CONFORMANCE-SECRET-DO-NOT-EMIT";
      config.profiles.development.topology.service.persistence.connection =
        api.localSecret(sentinel);
      config.profiles.development.acls["Notebook.Delivery.Send"].endpoint =
        api.localSecret(`https://example.invalid/${sentinel}`);
      const result = plan(api, config);
      assert.ok(result.warnings.length);
      const artifacts = api.generateServiceDeployment(
        result.plan,
        config.project,
      );
      for (const content of [
        api.serializeServicePlan(result.plan),
        api.serializeSemanticProjectIr(config.project),
        JSON.stringify(artifacts),
      ])
        assert.equal(content.includes(sentinel), false);
      reject(api, config, "production");
      config.profiles.staging = {
        extends: "development",
        environment: "staging",
      };
      reject(api, config, "staging");
      return "Local literals warn and are absent from semantic IR, inspected plan and generated deployment; staging/production literals fail.";
    },
  ),
  test(
    "service.semantic-independence",
    ["EE-SVC-026"],
    "positive",
    async ({ api }) => {
      const config = configuration(api);
      const before = api.serializeSemanticProjectIr(config.project);
      const first = plan(api, config).plan;
      config.profiles.test.policies = { defaults: { timeoutMs: 4321 } };
      config.profiles.test.contracts = { Notebook: {} };
      const second = plan(api, config).plan;
      assert.notEqual(first.inputHash, second.inputHash);
      assert.equal(api.serializeSemanticProjectIr(config.project), before);
      assert.equal(second.contracts[0].operations.length, 0);
      assert.equal(
        config.project.modules[0].entities[0].events[0].identity,
        "Note.Write",
      );
      return "Policy/exposure changes alter technical hash without changing semantic bytes; hidden Event retains identity.";
    },
  ),
  test(
    "service.acl-binding-incompatibility",
    ["EE-ACL-005"],
    "negative",
    async ({ api }) => {
      const config = configuration(api);
      config.profiles.development.acls[
        "Notebook.Delivery.Send"
      ].responses[0].result = "undeclared";
      reject(api, config);
      const { event, adapter } = acl(api, async () => ({
        result: "delivered",
        data: { receipt: "r" },
      }));
      assert.throws(
        () =>
          new api.AclEventRuntime(
            [event],
            [{ ...adapter, results: ["delivered"] }],
          ),
        api.AclConfigurationError,
      );
      return "Technical mappings and runtime adapters must cover the declared semantic ACL result contract.";
    },
  ),
  test(
    "service.runtime-plan-guard",
    ["EE-RUN-002"],
    "negative",
    async ({ api }) => {
      let touched = 0;
      const bindings = {
        pool: {
          connect: async () => {
            touched++;
            throw new Error("must not connect");
          },
        },
        resolveSecret: async () => {
          touched++;
          throw new Error("must not resolve");
        },
      };
      const invalid = configuration(api);
      invalid.profiles.test.extends = "absent";
      await assert.rejects(
        api.createServiceRuntime(invalid, "test", bindings),
        api.ServiceRuntimeError,
      );
      await assert.rejects(
        api.createServiceRuntime(configuration(api), "test", {
          ...bindings,
          expectedInputHash: "wrong-plan",
        }),
        api.ServiceRuntimeError,
      );
      assert.equal(touched, 0);
      return "Invalid configuration and mismatched deployment hash reject construction before secrets or database access.";
    },
  ),
  test(
    "contract.exposure-and-openapi",
    ["EE-SVC-025", "EE-HTTP-001", "EE-HTTP-007", "EE-HTTP-008"],
    "positive",
    async ({ api }) => {
      const ir = plan(api, configuration(api)).plan.contracts[0];
      const event = ir.operations.find(
        (operation) => operation.kind === "event",
      );
      assert.equal(event.path, "/notebook/write");
      assert.equal(event.identity, "Note.Write");
      assert.equal(event.terminal.view, "NoteCard");
      const document = api.generateOpenApi(ir);
      assert.equal(document.openapi, "3.1.0");
      assert.ok(document.paths["/notebook/write"].post.responses["202"]);
      assert.ok(document.paths["/notebook/read"].post.responses["200"]);
      assert.ok(
        document.paths["/notebook/sagas/{sagaId}"].get.responses["200"].content[
          "text/event-stream"
        ],
      );
      assert.equal(
        api.serializeOpenApi(document),
        api.serializeOpenApi(api.generateOpenApi(ir)),
      );
      return "Service routes preserve identities and generate deterministic OpenAPI for View, async admission and terminal SSE.";
    },
  ),
  test(
    "contract.invalid-exposure",
    ["EE-SVC-025"],
    "negative",
    async ({ api }) => {
      for (const change of [
        (value) => {
          value.events[0].event = "Note.Unknown";
        },
        (value) => {
          value.events[0].terminal.view = "Absent";
        },
        (value) => {
          value.events[0].path = "/read";
        },
        (value) => {
          value.events[0].terminal.input = {};
        },
      ]) {
        const config = exposure();
        change(config);
        const result = api.materializeContract(project(api).modules[0], config);
        assert.equal(result.success, false);
        assert.equal(Object.hasOwn(result, "ir"), false);
        assert.ok(
          result.diagnostics.every(
            (diagnostic) =>
              diagnostic.code && diagnostic.message && diagnostic.correction,
          ),
        );
      }
      return "Unknown references, route collisions and missing terminal inputs reject without a partial contract.";
    },
  ),
  test(
    "acl.interpreted-success-and-fail",
    ["EE-ACL-003"],
    "positive",
    async ({ api }) => {
      for (const [result, data, outcome] of [
        ["delivered", { receipt: "safe-receipt" }, "success"],
        ["refused", {}, "fail"],
      ]) {
        const { runtime } = acl(api, async (received) => {
          assert.equal(received.eventIdentity, "Delivery.Send");
          assert.equal(received.eventId, id);
          return { result, data };
        });
        const terminal = await runtime.dispatch(envelope(api));
        assert.equal(terminal.kind, outcome);
        assert.equal(terminal.eventId, id);
        if (outcome === "success") assert.deepEqual(terminal.data, data);
        else
          assert.deepEqual(Object.keys(terminal.fail).sort(), [
            "code",
            "correlationId",
            "message",
          ]);
      }
      return "ACL adapter results follow semantic success/fail interpretation and preserve Event identity.";
    },
  ),
  test(
    "acl.rejects-malformed-results",
    ["EE-ACL-003"],
    "negative",
    async ({ api }) => {
      for (const response of [
        { result: "unknown", data: {} },
        { result: "delivered", data: {} },
        { result: "delivered", data: { receipt: 42 } },
      ]) {
        const { runtime } = acl(api, async () => response);
        assert.equal((await runtime.dispatch(envelope(api))).kind, "fail");
      }
      let calls = 0;
      const { runtime } = acl(api, async () => {
        calls++;
        return { result: "delivered", data: { receipt: "r" } };
      });
      assert.equal(
        (await runtime.dispatch(envelope(api, { text: 42 }))).kind,
        "fail",
      );
      assert.equal(calls, 0);
      return "Undeclared/missing/wrong-type ACL results fail; invalid input never reaches the adapter.";
    },
  ),
  test(
    "http.terminal-only-contract",
    ["EE-HTTP-001", "EE-HTTP-002", "EE-HTTP-005", "EE-HTTP-006"],
    "positive",
    async ({ api }) => {
      // Public port doubles only prove HTTP contracts, not PostgreSQL persistence or recovery.
      const calls = [];
      const runtime = new api.PublicHttpRuntime({
        contract: contract(api),
        terminals: new api.InMemoryTerminalResultStore(),
        events: {
          dispatch: async (event) => {
            calls.push("event");
            return { kind: "success", eventId: event.eventId };
          },
        },
        views: {
          execute: async (request) => {
            calls.push("view");
            assert.deepEqual(request, { view: "NoteCard", input: { id } });
            return { view: "NoteCard", rows: [{ id, text: "hello" }] };
          },
        },
      });
      const response = await runtime.handle({
        method: "POST",
        path: "/notebook/write",
        body: { id, text: "hello" },
      });
      assert.equal(response.status, 202);
      const accepted = JSON.parse(response.body);
      assert.deepEqual(Object.keys(accepted), ["sagaId"]);
      const stream = await runtime.handle({
        method: "GET",
        path: `/notebook/sagas/${accepted.sagaId}`,
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers["content-type"], /^text\/event-stream/);
      assert.equal(stream.body.split("event: ").length - 1, 1);
      assert.match(stream.body, /^event: view\ndata: /);
      assert.deepEqual(JSON.parse(stream.body.split("data: ")[1].trim()), {
        kind: "view",
        view: "NoteCard",
        data: [{ id, text: "hello" }],
      });
      assert.deepEqual(calls, ["event", "view"]);
      return "Port-level HTTP contract returns only 202+sagaId, queries View after successful dispatch and emits one terminal View SSE frame.";
    },
  ),
  test(
    "http.safe-failure-contract",
    ["EE-HTTP-004", "EE-HTTP-006", "EE-NFR-005"],
    "negative",
    async ({ api }) => {
      const sentinel = "PRIVATE-STACK-CREDENTIAL";
      const runtime = new api.PublicHttpRuntime({
        contract: contract(api),
        terminals: new api.InMemoryTerminalResultStore(),
        events: {
          dispatch: async () => {
            throw new Error(sentinel);
          },
        },
        views: {
          execute: async () => {
            throw new Error(sentinel);
          },
        },
      });
      const synchronous = await runtime.handle({
        method: "POST",
        path: "/notebook/read",
        body: { id },
      });
      assert.equal(synchronous.status, 500);
      const fail = JSON.parse(synchronous.body);
      assert.deepEqual(Object.keys(fail).sort(), [
        "code",
        "correlationId",
        "message",
      ]);
      assert.ok(fail.code && fail.message && fail.correlationId);
      assert.equal(synchronous.body.includes(sentinel), false);
      const admission = await runtime.handle({
        method: "POST",
        path: "/notebook/write",
        body: { id, text: "hello" },
      });
      const stream = await runtime.handle({
        method: "GET",
        path: `/notebook/sagas/${JSON.parse(admission.body).sagaId}`,
        signal: AbortSignal.timeout(2000),
      });
      assert.match(stream.body, /^event: fail\ndata: /);
      assert.equal(stream.body.includes(sentinel), false);
      assert.equal(stream.body.split("event: ").length - 1, 1);
      assert.deepEqual(
        Object.keys(JSON.parse(stream.body.split("data: ")[1].trim())).sort(),
        ["code", "correlationId", "message"],
      );
      return "Thrown port errors produce stable correlated safe failures without exception text; Event stream emits exactly one terminal fail.";
    },
  ),
];
