import assert from "node:assert/strict";
import { it } from "node:test";
import {
  type ServiceConfiguration,
  compileServiceConfiguration,
  createServiceRuntime,
  generateServiceDeployment,
  localSecret,
} from "../src/index.js";
import { phaseFiveConfiguration } from "./phase-five-fixture.js";

function generatedConfiguration(
  files: Readonly<Record<string, string>>,
): ServiceConfiguration {
  return JSON.parse(
    (files["configuration.mjs"] as string)
      .replace(/^export default /, "")
      .replace(/;\s*$/, ""),
  ) as ServiceConfiguration;
}
it("generated configuration preserves the selected profile and compiled plan identity", () => {
  const configuration = phaseFiveConfiguration();
  const compiled = compileServiceConfiguration(configuration, "test");
  assert.ok(compiled.success);
  const files = generateServiceDeployment(compiled.plan, configuration.project);
  const generated = generatedConfiguration(files);
  const result = compileServiceConfiguration(generated, "test");
  assert.ok(result.success, JSON.stringify(result));
  assert.equal(result.plan.inputHash, compiled.plan.inputHash);
  assert.deepEqual(result.plan, compiled.plan);
});
it("one plan generates identical artifacts for reordered semantic Modules", () => {
  const base = phaseFiveConfiguration();
  const development = base.profiles.development;
  assert.ok(development.topology && development.acls);
  const sales = base.project.modules[0];
  assert.ok(sales);
  const acl = development.acls["Sales.Gateway.Authorize"];
  assert.ok(acl);
  const configuration = phaseFiveConfiguration({
    topology: {
      ...development.topology,
      service: {
        ...development.topology.service,
        modules: ["Sales", "Billing"],
      },
    },
    acls: { ...development.acls, "Billing.Gateway.Authorize": acl },
  });
  const project = {
    ...configuration.project,
    modules: [sales, { ...sales, name: "Billing" }],
  };
  const compiled = compileServiceConfiguration(
    { ...configuration, project },
    "test",
  );
  assert.ok(compiled.success);
  assert.deepEqual(
    generateServiceDeployment(compiled.plan, project),
    generateServiceDeployment(compiled.plan, {
      ...project,
      modules: [...project.modules].reverse(),
    }),
  );
});

it("preserves local secret identity while resolving each deployment slot externally", async () => {
  const base = phaseFiveConfiguration();
  const profile = base.profiles.development;
  assert.ok(profile.topology && profile.acls && profile.http);
  const acl = profile.acls["Sales.Gateway.Authorize"];
  assert.ok(acl);
  const configuration = phaseFiveConfiguration({
    topology: {
      ...profile.topology,
      service: {
        ...profile.topology.service,
        persistence: {
          ...profile.topology.service.persistence,
          connection: localSecret("private-database-marker"),
        },
      },
    },
    http: {
      ...profile.http,
      security: {
        ...profile.http.security,
        authentication: { bearer: localSecret("private-bearer-marker") },
      },
    },
    acls: {
      "Sales.Gateway.Authorize": {
        ...acl,
        endpoint: localSecret("https://gateway.invalid/private-url-marker"),
        headers: { Authorization: localSecret("private-header-marker") },
      },
    },
  });
  const compiled = compileServiceConfiguration(configuration, "test");
  assert.ok(compiled.success);
  const files = generateServiceDeployment(compiled.plan, configuration.project);
  for (const marker of [
    "private-database-marker",
    "private-bearer-marker",
    "private-url-marker",
    "private-header-marker",
  ])
    assert.ok(!JSON.stringify(files).includes(marker));
  const generated = generatedConfiguration(files);
  const received: string[] = [];
  const runtime = await createServiceRuntime(generated, "test", {
    expectedInputHash: compiled.plan.inputHash,
    pool: {
      connect: async () => {
        throw new Error("must not access database before start");
      },
    },
    resolveSecret: (_reference, slot) => {
      received.push(slot);
      return slot.endsWith(".endpoint")
        ? "https://example.invalid"
        : "resolved-secret";
    },
  });
  assert.deepEqual(runtime.plan, compiled.plan);
  assert.deepEqual(received.sort(), [
    "acls.Sales.Gateway.Authorize.endpoint",
    "acls.Sales.Gateway.Authorize.headers.Authorization",
    "http.authentication.bearer",
  ]);
});
it("rejects deployment drift before secret resolution or database access", async () => {
  const configuration = phaseFiveConfiguration();
  const compiled = compileServiceConfiguration(configuration, "test");
  assert.ok(compiled.success);
  const generated = generatedConfiguration(
    generateServiceDeployment(compiled.plan, configuration.project),
  );
  const profile = generated.profiles.test;
  assert.ok(profile);
  const drifted = {
    ...generated,
    profiles: {
      test: {
        ...profile,
        contracts: { Sales: { views: [{ view: "Receipt" }] } },
      },
    },
  };
  let accesses = 0;
  await assert.rejects(
    createServiceRuntime(drifted, "test", {
      expectedInputHash: compiled.plan.inputHash,
      pool: {
        connect: async () => {
          accesses++;
          throw new Error();
        },
      },
      resolveSecret: () => {
        accesses++;
        return "https://example.invalid";
      },
    }),
    /expected deployment plan/,
  );
  assert.equal(accesses, 0);
});
