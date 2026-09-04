import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  type ServiceConfiguration,
  type ServicePlan,
  compileServiceConfiguration,
  createServiceRuntime,
  generateServiceDeployment,
  localSecret,
  resolveServiceProfile,
  serializeServicePlan,
  technicalJson,
  validateServiceConfiguration,
} from "../src/index.js";
import { phaseFiveConfiguration } from "./phase-five-fixture.js";

function plan(
  configuration = phaseFiveConfiguration(),
  profile: "development" | "test" | "production" = "development",
): ServicePlan {
  const result = compileServiceConfiguration(configuration, profile);
  assert.ok(result.success, JSON.stringify(result));
  return result.plan;
}
function invalid(configuration: unknown, code?: string) {
  const result = compileServiceConfiguration(
    configuration as ServiceConfiguration,
    "development",
  );
  assert.equal(result.success, false);
  if (result.success) throw new Error();
  assert.ok(!("plan" in result));
  if (code)
    assert.ok(
      result.diagnostics.some((d) => d.code === `VANE_SVC_${code}`),
      JSON.stringify(result),
    );
  assert.ok(
    result.diagnostics.every((d) => d.path && d.message && d.correction),
  );
}
// biome-ignore lint/suspicious/noExplicitAny: Intentionally malformed inputs exercise the JavaScript configuration boundary.
type MalformedConfiguration = any;
function change(mutator: (c: MalformedConfiguration) => void) {
  const c = structuredClone(phaseFiveConfiguration());
  mutator(c);
  return c;
}

describe("phase five configuration", () => {
  it("compiles four versioned technical IRs without changing semantic input", () => {
    const c = phaseFiveConfiguration();
    const before = technicalJson(c.project);
    const p = plan(c);
    assert.equal(technicalJson(c.project), before);
    assert.equal(p.runtime.ownership[0]?.entity, "Sales.Order");
    assert.equal(p.runtime.sagas.length, 1);
    assert.equal(p.contracts[0]?.operations.length, 2);
    assert.equal(p.runtime.providers.length, 10);
    assert.equal(p.infrastructure.apply, "manual");
    assert.equal(p.runtime.inputHash, p.inputHash);
    assert.deepEqual(p.runtime.configuration, p.effective);
    assert.equal(p.infrastructure.inputHash, p.inputHash);
    assert.equal(p.runtime.bindings.length, 2);
    assert.ok(
      Object.values(validateServiceConfiguration(c)).every((r) => r.success),
    );
  });
  it("resolves inheritance and field precedence with visible sources", () => {
    const c = phaseFiveConfiguration({
      policies: {
        defaults: { timeoutMs: 2000 },
        services: { api: { timeoutMs: 3000 } },
        events: { "Sales.Gateway.Authorize": { timeoutMs: 4000 } },
      },
    });
    const p = plan(c, "test");
    assert.equal(
      p.runtime.policies.find((p) => p.event === "Sales.Order.Place")?.effective
        .timeoutMs,
      3000,
    );
    assert.equal(
      p.runtime.policies.find((p) => p.event === "Sales.Gateway.Authorize")
        ?.sources.timeoutMs,
      "events.Sales.Gateway.Authorize",
    );
    assert.equal(resolveServiceProfile(c, "test").environment, "test");
    const child = {
      ...c,
      profiles: {
        ...c.profiles,
        test: {
          ...c.profiles.test,
          policies: {
            events: { "Sales.Gateway.Authorize": { timeoutMs: 5000 } },
          },
        },
      },
    };
    assert.equal(
      plan(child, "test").runtime.policies.find((p) =>
        p.event.endsWith("Authorize"),
      )?.effective.timeoutMs,
      5000,
    );
  });
  it("preserves semantics while switching technical profiles", () => {
    const c = phaseFiveConfiguration();
    const prod = {
      ...c,
      profiles: {
        ...c.profiles,
        production: {
          ...c.profiles.production,
          contracts: {
            Sales: { basePath: "/v2", views: [{ view: "Receipt" }] },
          },
        },
      },
    };
    const dev = plan(prod);
    const p = plan(prod, "production");
    assert.equal(
      dev.runtime.semanticProjectHash,
      p.runtime.semanticProjectHash,
    );
    assert.notEqual(dev.inputHash, p.inputHash);
    assert.equal(p.contracts[0]?.operations[0]?.path, "/v2/views/Receipt");
    assert.equal(
      dev.runtime.sagas[0]?.semanticHash,
      p.runtime.sagas[0]?.semanticHash,
    );
  });
  it("is deterministic under provider declaration order", () => {
    const c = phaseFiveConfiguration();
    assert.equal(
      serializeServicePlan(plan(c)),
      serializeServicePlan(
        plan({ ...c, providers: [...c.providers].reverse() }),
      ),
    );
    assert.deepEqual(
      generateServiceDeployment(plan(c), c.project),
      generateServiceDeployment(plan(c), c.project),
    );
  });
  it("omits literal secrets from every artifact and input hash", () => {
    const c = phaseFiveConfiguration();
    const topology = c.profiles.development.topology;
    assert.ok(topology);
    const withSecret = (s: string) => ({
      ...c,
      profiles: {
        ...c.profiles,
        development: {
          ...c.profiles.development,
          topology: {
            ...topology,
            service: {
              ...topology.service,
              persistence: {
                ...topology.service.persistence,
                connection: localSecret(s),
              },
            },
          },
        },
      },
    });
    const first = withSecret("unique-secret-DO-NOT-PRINT");
    const result = compileServiceConfiguration(first, "development");
    assert.ok(result.success);
    assert.equal(result.warnings.length, 1);
    assert.equal(
      result.plan.inputHash,
      plan(withSecret("different-secret")).inputHash,
    );
    const artifacts = generateServiceDeployment(result.plan, first.project);
    assert.ok(
      !JSON.stringify(artifacts).includes("unique-secret-DO-NOT-PRINT"),
    );
    assert.ok(artifacts["deploy-plan.json"]?.includes("VANE_BINDING_"));
    const prod = compileServiceConfiguration(first, "production");
    assert.equal(prod.success, false);
    assert.ok(!JSON.stringify(prod).includes("unique-secret-DO-NOT-PRINT"));
  });
  for (const [name, mutate, code] of [
    [
      "inheritance cycles",
      (c: MalformedConfiguration) => {
        c.profiles.development.extends = "test";
      },
      "PROFILE_CYCLE",
    ],
    [
      "missing parents",
      (c: MalformedConfiguration) => {
        c.profiles.development.extends = "absent";
      },
      "PROFILE_MISSING",
    ],
    [
      "missing ownership",
      (c: MalformedConfiguration) => {
        c.profiles.development.topology.service.modules = [];
      },
      "OWNERSHIP",
    ],
    [
      "duplicate ownership",
      (c: MalformedConfiguration) => {
        c.profiles.development.topology.service.modules = ["Sales", "Sales"];
      },
      "OWNERSHIP",
    ],
    [
      "distributed topology",
      (c: MalformedConfiguration) => {
        c.profiles.development.topology.kind = "distributed";
      },
      "TOPOLOGY",
    ],
    [
      "duplicate provider",
      (c: MalformedConfiguration) => {
        c.providers.push(c.providers[0]);
      },
      "PROVIDER_REGISTRY",
    ],
    [
      "missing provider",
      (c: MalformedConfiguration) => {
        c.providers = [];
      },
      "PROVIDER_SELECTION",
    ],
    [
      "wrong provider kind",
      (c: MalformedConfiguration) => {
        c.profiles.development.topology.service.runtime = {
          kind: "storage",
          provider: "vane.postgresql",
        };
      },
      "PROVIDER_SELECTION",
    ],
    [
      "missing rule capability",
      (c: MalformedConfiguration) => {
        c.providers[1].capabilities = ["postgresql16", "transactions"];
      },
      "CAPABILITY",
    ],
    [
      "provider dependency",
      (c: MalformedConfiguration) => {
        c.providers[0].requires = [
          { kind: "storage", capability: "impossible" },
        ];
      },
      "COMPATIBILITY",
    ],
    [
      "provider interface version",
      (c: MalformedConfiguration) => {
        c.providers[0].interfaceVersion = 2;
      },
      "PROVIDER_REGISTRY",
    ],
    [
      "unimplemented provider",
      (c: MalformedConfiguration) => {
        c.providers[0].id = "other.node";
        c.profiles.development.topology.service.runtime.provider = "other.node";
      },
      "PROVIDER_IMPLEMENTATION",
    ],
    [
      "unknown policy Event",
      (c: MalformedConfiguration) => {
        c.profiles.development.policies = {
          events: { "Order.Place": { timeoutMs: 3 } },
        };
      },
      "POLICY_EVENT",
    ],
    [
      "unknown policy service",
      (c: MalformedConfiguration) => {
        c.profiles.development.policies = { services: { absent: {} } };
      },
      "POLICY_SERVICE",
    ],
    [
      "invalid timeout",
      (c: MalformedConfiguration) => {
        c.profiles.development.policies = { defaults: { timeoutMs: -1 } };
      },
      "POLICY",
    ],
    [
      "invalid retry",
      (c: MalformedConfiguration) => {
        c.profiles.development.policies = {
          defaults: {
            retry: { attempts: 0, backoff: "fixed", delayMs: 0, maxDelayMs: 0 },
          },
        };
      },
      "RETRY",
    ],
    [
      "weakened deduplication",
      (c: MalformedConfiguration) => {
        c.profiles.development.policies = {
          defaults: { deduplication: "none" },
        };
      },
      "POLICY",
    ],
    [
      "missing ACL",
      (c: MalformedConfiguration) => {
        c.profiles.development.acls = {};
      },
      "ACL_MISSING",
    ],
    [
      "incompatible ACL result",
      (c: MalformedConfiguration) => {
        c.profiles.development.acls["Sales.Gateway.Authorize"].responses = [
          { status: 200, result: "unknown", fields: {} },
        ];
      },
      "ACL_MAPPING",
    ],
    [
      "unknown ACL",
      (c: MalformedConfiguration) => {
        c.profiles.development.acls.extra =
          c.profiles.development.acls["Sales.Gateway.Authorize"];
      },
      "ACL_UNKNOWN",
    ],
    [
      "unknown Saga",
      (c: MalformedConfiguration) => {
        c.profiles.development.sagas = { "Sales.Absent": {} };
      },
      "SAGA_UNKNOWN",
    ],
    [
      "bad Saga binding",
      (c: MalformedConfiguration) => {
        c.profiles.development.sagas = {
          "Sales.PlaceOrder": {
            steps: { place: { id: { kind: "input", name: "missing" } } },
          },
        };
      },
      "SAGA_BINDING",
    ],
    [
      "mismatched public binding",
      (c: MalformedConfiguration) => {
        c.profiles.development.sagas = {
          "Sales.PlaceOrder": {
            steps: {
              place: {
                id: {
                  kind: "literal",
                  value: "00000000-0000-4000-8000-000000000001",
                },
              },
            },
          },
        };
      },
      "PUBLIC_SAGA_BINDING",
    ],
    [
      "unknown top-level credential",
      (c: MalformedConfiguration) => {
        c.profiles.development.password = "secret-marker";
      },
      "STRUCTURE",
    ],
    [
      "secret reference extra credential",
      (c: MalformedConfiguration) => {
        c.profiles.development.topology.service.persistence.connection.password =
          "secret-marker";
      },
      "STRUCTURE",
    ],
    [
      "invalid CORS",
      (c: MalformedConfiguration) => {
        c.profiles.development.http.security.cors = [
          "https://example.com/path",
        ];
      },
      "CORS",
    ],
    [
      "invalid rate limit",
      (c: MalformedConfiguration) => {
        c.profiles.development.http.security.rateLimit = {
          requests: 0,
          windowMs: 1,
        };
      },
      "RATE_LIMIT",
    ],
  ] as const)
    it(`rejects ${name} without partial output`, () =>
      invalid(change(mutate), code));
  it("allows several Events to share their Module terminal stream", () => {
    const c = change((c) => {
      c.profiles.development.contracts.Sales.events.push({
        event: "Order.Cancel",
        terminal: {
          view: "Receipt",
          input: { id: { kind: "eventInput", input: "id" } },
        },
      });
    });
    assert.equal(
      plan(c).contracts[0]?.operations.filter((o) => o.kind === "event").length,
      2,
    );
  });
  it("maps multiple Modules explicitly and rejects cross-Module route collisions", () => {
    const c = change((c) => {
      const billing = structuredClone(c.project.modules[0]);
      billing.name = "Billing";
      c.project.modules.push(billing);
      c.profiles.development.topology.service.modules.push("Billing");
      c.profiles.development.acls["Billing.Gateway.Authorize"] =
        structuredClone(c.profiles.development.acls["Sales.Gateway.Authorize"]);
      c.profiles.development.contracts.Billing = {
        basePath: "/billing",
        views: [{ view: "Receipt" }],
      };
    });
    const p = plan(c);
    assert.equal(p.runtime.ownership.length, 2);
    assert.equal(p.runtime.policies.length, 8);
    const collide = change((original) => Object.assign(original, c));
    const malformed: MalformedConfiguration = collide;
    malformed.profiles.development.contracts.Billing.basePath = "/sales";
    invalid(collide, "ROUTE_COLLISION");
    assert.equal(p.runtime.service.name, "api");
  });
  it("refuses to bootstrap deferred policies before database access", async () => {
    const c = phaseFiveConfiguration({
      policies: {
        defaults: {
          retry: {
            attempts: 3,
            backoff: "exponential",
            delayMs: 10,
            maxDelayMs: 100,
          },
        },
      },
    });
    assert.ok(compileServiceConfiguration(c, "development").success);
    await assert.rejects(
      createServiceRuntime(c, "development", {
        pool: {
          connect: async () => {
            throw new Error("must not connect");
          },
        },
      }),
      /phase-six/,
    );
  });
  it("does not expose resolver errors", async () => {
    await assert.rejects(
      createServiceRuntime(phaseFiveConfiguration(), "development", {
        pool: {
          connect: async () => {
            throw new Error();
          },
        },
        resolveSecret: () => {
          throw new Error("secret-marker");
        },
      }),
      (error) =>
        error instanceof Error && !error.message.includes("secret-marker"),
    );
  });
  it("rejects generation against a different semantic project", () => {
    const c = phaseFiveConfiguration();
    assert.throws(
      () => generateServiceDeployment(plan(c), { ...c.project, modules: [] }),
      /differs/,
    );
  });
  it("CLI validates, plans, generates atomically and refuses overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vane-phase5-"));
    try {
      const config = join(dir, "configuration.mjs");
      const c = phaseFiveConfiguration();
      await writeFile(config, `export default ${JSON.stringify(c)};`);
      const cli = resolve("dist-test/src/cli.js");
      const invoke = (...args: string[]) =>
        execFileSync(process.execPath, [cli, ...args, "--config", config], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      assert.equal(JSON.parse(invoke("validate", "--json")).success, true);
      assert.equal(
        JSON.parse(invoke("plan", "--profile", "test", "--json")).profile,
        "test",
      );
      const output = join(dir, "generated");
      assert.equal(
        JSON.parse(invoke("generate", "--profile", "test", "--out", output))
          .success,
        true,
      );
      assert.ok(
        (await readFile(join(output, "deploy-plan.json"), "utf8")).includes(
          "VANE_BINDING_",
        ),
      );
      assert.throws(() =>
        invoke("generate", "--profile", "test", "--out", output),
      );
      assert.throws(() => invoke("plan", "--profile", "missing"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
