import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_EXECUTION_POLICY,
  PostgreSqlSagaRuntime,
  PostgreSqlSagaStore,
  RuntimeTelemetry,
  compileServiceConfiguration,
  createServiceRuntime,
  createVaultSecretResolver,
  env,
  generateServiceDeployment,
  localSecret,
  materializeSagaPlan,
  monolith,
  node,
  postgres,
  retryDelay,
} from "../src/index.js";
import { PostgreSqlOperations } from "../src/postgresql/operations.js";
import { phaseFiveConfiguration } from "./phase-five-fixture.js";
import { phaseFourModule } from "./phase-four-fixture.js";

describe("phase six policies and secrets", () => {
  it("caps exponential backoff", () => {
    const p = {
      ...DEFAULT_EXECUTION_POLICY,
      retry: {
        attempts: 5,
        backoff: "exponential" as const,
        delayMs: 10,
        maxDelayMs: 25,
      },
    };
    assert.deepEqual(
      [1, 2, 3, 1000].map((a) => retryDelay(p, a)),
      [10, 20, 25, 25],
    );
  });
  it("redacts metadata recursively and contains exporter failures", async () => {
    const t = new RuntimeTelemetry(
      { exporter: "json", redact: ["email"] },
      () => {
        throw new Error("secret");
      },
    );
    assert.deepEqual(
      t.redact({ nested: [{ email: "private", token: "private", count: 1 }] }),
      { nested: [{ email: "[REDACTED]", token: "[REDACTED]", count: 1 }] },
    );
    assert.equal(await t.span("event", {}, async () => 42), 42);
    assert.equal(t.exporterFailures, 1);
    assert.equal(t.metrics()["event.success"]?.count, 1);
  });
  it("reads Vault KV v2 without forwarding tokens on redirects or error messages", async () => {
    const seen: string[] = [];
    const resolver = await createVaultSecretResolver(
      {
        provider: "vault-kv-v2",
        address: localSecret("https://vault.example"),
        token: localSecret("private-token"),
        mount: "secret",
        timeoutMs: 100,
      },
      (async (url, options) => {
        seen.push(String(url));
        assert.equal(options?.redirect, "error");
        assert.equal(
          new Headers(options?.headers).get("X-Vault-Token"),
          "private-token",
        );
        return new Response(
          JSON.stringify({ data: { data: { password: "resolved-value" } } }),
        );
      }) as typeof fetch,
    );
    assert.equal(
      await resolver({ kind: "secret", name: "app/database#password" }),
      "resolved-value",
    );
    assert.deepEqual(seen, [
      "https://vault.example/v1/secret/data/app/database",
    ]);
    await assert.rejects(
      resolver({ kind: "secret", name: "../escape#password" }),
      /required secret/,
    );
    await assert.rejects(
      createVaultSecretResolver({
        provider: "vault-kv-v2",
        address: localSecret("http://vault.example"),
        token: localSecret("private-token"),
        mount: "secret",
        timeoutMs: 100,
      }),
      /required secret/,
    );
  });
  it("validates telemetry and Vault before infrastructure access", () => {
    const valid = compileServiceConfiguration(
      phaseFiveConfiguration({
        telemetry: { exporter: "json", redact: ["email"] },
        secrets: {
          provider: "vault-kv-v2",
          address: env("VAULT_ADDR"),
          token: env("VAULT_TOKEN"),
          mount: "secret",
          timeoutMs: 100,
        },
      }),
      "production",
    );
    assert.ok(valid.success, JSON.stringify(valid));
    assert.ok(
      valid.plan.runtime.bindings.some((b) => b.slot === "secrets.token"),
    );
    assert.equal(
      compileServiceConfiguration(
        phaseFiveConfiguration({
          secrets: {
            provider: "vault-kv-v2",
            address: env("VAULT_ADDR"),
            token: localSecret("do-not-print"),
            mount: "secret",
            timeoutMs: 100,
          },
        }),
        "production",
      ).success,
      false,
    );
  });
});

it("CLI inspects Event and computes deterministic migration diff without secrets or database", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "vane-phase6-cli-"));
  try {
    const config = join(dir, "config.mjs");
    await writeFile(
      config,
      `export default ${JSON.stringify(phaseFiveConfiguration())}`,
    );
    const invoke = (...args: string[]) =>
      execFileSync(
        process.execPath,
        [
          resolve("dist-test/src/cli.js"),
          ...args,
          "--config",
          config,
          "--profile",
          "test",
          "--json",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    assert.equal(
      JSON.parse(invoke("inspect", "event", "Sales.Order.Place")).policy.event,
      "Sales.Order.Place",
    );
    const diff = invoke("migrate", "diff");
    assert.equal(diff, invoke("migrate", "diff"));
    assert.ok(JSON.parse(diff).hash);
    assert.throws(() => invoke("inspect", "event", "Missing.Event"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects Vault references that its installed resolver cannot execute", () => {
  const base = phaseFiveConfiguration();
  const acls = base.profiles.development.acls;
  assert.ok(acls);
  const mapping = acls["Sales.Gateway.Authorize"];
  assert.ok(mapping);
  for (const name of [
    "gateway-token",
    "app//token#value",
    "app/../token#value",
    "app/token.value#value",
  ]) {
    const c = phaseFiveConfiguration({
      secrets: {
        provider: "vault-kv-v2",
        address: env("VAULT_ADDR"),
        token: env("VAULT_TOKEN"),
        mount: "secret",
        timeoutMs: 100,
      },
      acls: {
        "Sales.Gateway.Authorize": {
          ...mapping,
          headers: { Authorization: { kind: "secret", name } },
        },
      },
    });
    const compiled = compileServiceConfiguration(c, "production");
    assert.equal(
      compiled.success,
      false,
      `Unexpected valid Vault reference: ${name}`,
    );
  }
  const custom = phaseFiveConfiguration({
    acls: {
      "Sales.Gateway.Authorize": {
        ...mapping,
        headers: { Authorization: { kind: "secret", name: "gateway-token" } },
      },
    },
  });
  assert.equal(compileServiceConfiguration(custom, "production").success, true);
});

it("rejects ambiguous imported Event owners before policy resolution", () => {
  const configuration = phaseFiveConfiguration();
  const sales = configuration.project.modules[0];
  assert.ok(sales);
  const billing = {
    ...sales,
    name: "Billing",
    imports: [],
    antiCorruptionLayers: [],
    sagas: [],
    views: [],
  };
  const result = compileServiceConfiguration(
    {
      ...configuration,
      project: {
        ...configuration.project,
        modules: [{ ...sales, imports: ["Billing"] }, billing],
      },
      profiles: {
        ...configuration.profiles,
        test: {
          ...configuration.profiles.test,
          topology: monolith({
            name: "api",
            modules: ["Sales", "Billing"],
            runtime: node(),
            persistence: {
              provider: postgres(),
              namespace: "vane_five",
              targetVersion: 16,
              connection: env("DATABASE_URL"),
            },
          }),
        },
      },
    },
    "test",
  );
  assert.equal(result.success, false);
  if (!result.success)
    assert.equal(result.diagnostics[0]?.code, "VANE_SVC_IMPORT_SCOPE");
});

it("preserves the operation error when rollback also fails", async () => {
  const compiled = compileServiceConfiguration(
    phaseFiveConfiguration(),
    "test",
  );
  assert.ok(compiled.success);
  const original = new Error("operation failed");
  let released = false;
  const operations = new PostgreSqlOperations(
    {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql === "BEGIN") return { rows: [], rowCount: 0 };
          if (sql === "ROLLBACK") throw new Error("connection lost");
          throw original;
        },
        release: () => {
          released = true;
        },
      }),
    },
    compiled.plan.storage,
  );
  await assert.rejects(
    operations.retryOutboxFailure("failure"),
    (error) => error === original,
  );
  assert.equal(released, true);
});

it("omits literal Vault bootstrap values from every generated artifact", () => {
  const configuration = phaseFiveConfiguration({
    secrets: {
      provider: "vault-kv-v2",
      address: localSecret("https://vault-bootstrap-marker.invalid"),
      token: localSecret("vault-bootstrap-token-marker"),
      mount: "secret",
      timeoutMs: 100,
    },
  });
  const compiled = compileServiceConfiguration(configuration, "development");
  assert.ok(compiled.success);
  const artifacts = generateServiceDeployment(
    compiled.plan,
    configuration.project,
  );
  for (const serialized of [
    JSON.stringify(compiled.plan),
    ...Object.values(artifacts),
  ]) {
    assert.equal(serialized.includes("vault-bootstrap-token-marker"), false);
    assert.equal(serialized.includes("vault-bootstrap-marker"), false);
  }
});

it("lets an explicit caller resolver override Vault for symbolic and Vault names", async () => {
  const mapping =
    phaseFiveConfiguration().profiles.development.acls?.[
      "Sales.Gateway.Authorize"
    ];
  assert.ok(mapping);
  for (const name of ["gateway-token", "app/gateway#token"]) {
    const configuration = phaseFiveConfiguration({
      secrets: {
        provider: "vault-kv-v2",
        address: env("VAULT_ADDR"),
        token: env("VAULT_TOKEN"),
        mount: "secret",
        timeoutMs: 100,
      },
      acls: {
        "Sales.Gateway.Authorize": {
          ...mapping,
          headers: { Authorization: { kind: "secret", name } },
        },
      },
    });
    const plan = compileServiceConfiguration(configuration, "development", {
      secretResolver: "caller",
    });
    assert.ok(plan.success);
    const seen: string[] = [];
    const runtime = await createServiceRuntime(configuration, "development", {
      expectedInputHash: plan.plan.inputHash,
      pool: {
        connect: async () => {
          throw new Error("unexpected database access");
        },
      },
      fetch: async () => {
        throw new Error("Vault must not be called");
      },
      resolveSecret: (value, slot) => {
        seen.push(slot);
        return value.kind === "secret"
          ? "resolved-caller-value"
          : "https://gateway.invalid";
      },
    });
    assert.equal(runtime.state, "stopped");
    assert.ok(
      seen.includes("acls.Sales.Gateway.Authorize.headers.Authorization"),
    );
    assert.equal(
      seen.some((slot) => slot.startsWith("secrets.")),
      false,
    );
  }
});

it("rejects missing or stale imported hashes before installing a Saga plan", () => {
  const root = { ...phaseFourModule(), imports: ["Billing"] };
  const billing = {
    ...phaseFourModule(),
    name: "Billing",
    imports: [],
    entities: [],
    views: [],
    sagas: [],
    antiCorruptionLayers: [],
  };
  const plan = materializeSagaPlan(
    root,
    "PlaceOrder",
    {},
    [
      {
        eventIdentity: "Gateway.Authorize",
        version: "1",
        results: ["approved", "declined"],
        idempotency: "eventId",
        execute: async () => ({
          result: "approved",
          data: { reference: "ok" },
        }),
      },
    ],
    [root, billing],
  );
  const compiled = compileServiceConfiguration(
    phaseFiveConfiguration(),
    "test",
  );
  assert.ok(compiled.success);
  const store = new PostgreSqlSagaStore(
    {
      connect: async () => {
        throw new Error("must not connect");
      },
    },
    compiled.plan.storage,
  );
  assert.ok(plan.importedHashes);
  const events = {
    semanticHash: plan.semanticHash,
    importedHashes: plan.importedHashes,
    dispatch: async () => {
      throw new Error("must not dispatch");
    },
  };
  const views = {
    semanticHash: plan.semanticHash,
    importedHashes: plan.importedHashes,
    execute: async () => {
      throw new Error("must not query");
    },
  };
  const acls = {
    bindings: plan.adapters,
    dispatch: async () => {
      throw new Error("must not dispatch");
    },
  };
  for (const hashes of [{}, { Billing: "changed" }]) {
    const changedEvents = { ...events, importedHashes: hashes };
    assert.throws(
      () =>
        new PostgreSqlSagaRuntime({
          plans: [plan],
          store,
          events: changedEvents,
          views,
          acls,
        }),
      /imported/,
    );
    const changedViews = { ...views, importedHashes: hashes };
    assert.throws(
      () =>
        new PostgreSqlSagaRuntime({
          plans: [plan],
          store,
          events,
          views: changedViews,
          acls,
        }),
      /imported/,
    );
  }
  assert.doesNotThrow(
    () =>
      new PostgreSqlSagaRuntime({ plans: [plan], store, events, views, acls }),
  );
});

it("shares identical standalone aliases and rejects conflicting terminal bindings", () => {
  const exposure = {
    event: "Order.Place",
    terminal: {
      view: "Receipt",
      input: { id: { kind: "eventInput" as const, input: "id" } },
    },
  };
  const config = phaseFiveConfiguration({
    contracts: {
      Sales: {
        basePath: "/sales",
        events: [
          { ...exposure, path: "/first" },
          { ...exposure, path: "/second" },
        ],
      },
    },
  });
  const compiled = compileServiceConfiguration(config, "test");
  assert.ok(compiled.success);
  assert.equal(
    compiled.plan.runtime.sagas.filter(
      (p) => p.saga === "vane.event.Order.Place",
    ).length,
    1,
  );
  const conflicting = phaseFiveConfiguration({
    contracts: {
      Sales: {
        basePath: "/sales",
        events: [
          { ...exposure, path: "/first" },
          {
            ...exposure,
            path: "/second",
            terminal: {
              view: "Receipt",
              input: {
                id: {
                  kind: "literal",
                  value: "10000000-0000-4000-8000-000000000001",
                },
              },
            },
          },
        ],
      },
    },
  });
  const rejected = compileServiceConfiguration(conflicting, "test");
  assert.equal(rejected.success, false);
  if (!rejected.success)
    assert.equal(
      rejected.diagnostics[0]?.code,
      "VANE_SVC_PUBLIC_EVENT_BINDING",
    );
  const mixed = compileServiceConfiguration(
    phaseFiveConfiguration({
      contracts: {
        Sales: {
          basePath: "/sales",
          events: [
            { ...exposure, path: "/first" },
            { ...exposure, path: "/second", saga: "PlaceOrder" },
          ],
        },
      },
    }),
    "test",
  );
  assert.equal(mixed.success, false);
  if (!mixed.success)
    assert.equal(mixed.diagnostics[0]?.code, "VANE_SVC_PUBLIC_EVENT_BINDING");
});

it("contains asynchronous telemetry rejection without changing execution", async () => {
  const telemetry = new RuntimeTelemetry({ exporter: "json" }, async () => {
    throw new Error("private-exporter-error");
  });
  assert.equal(await telemetry.span("event", {}, async () => 42), 42);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(telemetry.exporterFailures, 1);
  assert.equal(telemetry.metrics()["event.success"]?.count, 1);
});

it("rejects invalid low-level Saga policy catalogs before admission", () => {
  const compiled = compileServiceConfiguration(
    phaseFiveConfiguration(),
    "test",
  );
  assert.ok(compiled.success);
  const store = new PostgreSqlSagaStore(
    {
      connect: async () => {
        throw new Error("must not connect");
      },
    },
    compiled.plan.storage,
  );
  const events = {
    semanticHash: "unused",
    dispatch: async () => {
      throw new Error("must not dispatch");
    },
  };
  const views = {
    semanticHash: "unused",
    execute: async () => {
      throw new Error("must not query");
    },
  };
  assert.throws(
    () =>
      new PostgreSqlSagaRuntime({
        plans: [],
        store,
        events,
        views,
        policies: {
          "Order.Place": {
            ...DEFAULT_EXECUTION_POLICY,
            retry: { ...DEFAULT_EXECUTION_POLICY.retry, attempts: 0 },
          },
        },
      }),
    /Execution policy is invalid/,
  );
});
