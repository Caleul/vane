import assert from "node:assert/strict";

function project(api) {
  const result = api.compileProjectSources([
    {
      fileName: "accounts.ts",
      sourceText: `import { Entity, Column, Module } from "@lilka/vane";
@Entity() class Customer { id = Column({type:"uuid",identity:true}); displayName = Column({type:"string",nullable:true}); }
@Module({entities:[Customer]}) export class Accounts {}`,
    },
    {
      fileName: "commerce.ts",
      sourceText: `import { Entity, Column, Module } from "@lilka/vane";
import {Accounts} from "./accounts.js";
@Entity() class Purchase { id = Column({type:"uuid",identity:true}); }
@Module({entities:[Purchase],imports:[Accounts]}) class Commerce {}`,
    },
  ]);
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  return result.ir;
}
function configuration(api) {
  const persistence = (namespace) => ({
    provider: api.postgres(),
    namespace,
    targetVersion: 16,
    connection: api.env("REPRESENTATION_DATABASE"),
  });
  const topology = (name, namespace, modules) =>
    api.monolith({
      name,
      modules,
      runtime: api.node(),
      persistence: persistence(namespace),
    });
  return api.serviceConfiguration({
    application: "representation",
    project: project(api),
    providers: api.BUILTIN_PROVIDERS,
    profiles: {
      development: {
        environment: "development",
        topology: topology("local-api", "local_schema", [
          "Accounts",
          "Commerce",
        ]),
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
      },
      test: {
        extends: "development",
        environment: "test",
        topology: topology("test-api", "test_schema", ["Commerce", "Accounts"]),
        policies: { defaults: { timeoutMs: 2345 } },
      },
    },
  });
}
function compile(api, config, name) {
  const result = api.compileServiceConfiguration(config, name);
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  return result.plan;
}
export const cases = [
  {
    id: "representation.semantic-boundaries",
    requirements: ["EE-COMP-004"],
    kind: "positive",
    run: ({ api }) => {
      const config = configuration(api);
      const plan = compile(api, config, "development");
      assert.deepEqual(config.project.modules.map((m) => m.name).sort(), [
        "Accounts",
        "Commerce",
      ]);
      assert.deepEqual(
        config.project.modules.find((m) => m.name === "Commerce").imports,
        ["Accounts"],
      );
      assert.deepEqual(plan.runtime.ownership, [
        { entity: "Accounts.Customer", service: "local-api" },
        { entity: "Commerce.Purchase", service: "local-api" },
      ]);
      assert.deepEqual(plan.runtime.service.modules, ["Accounts", "Commerce"]);
      assert.equal(plan.infrastructure.topology, "monolith");
      assert.equal(plan.infrastructure.services.length, 1);
      return "Explicit semantic Module/import and qualified Entity boundaries survive technical compilation without inventing services; v0.1 remains a single runtime service.";
    },
  },
  {
    id: "representation.profile-semantic-invariance",
    requirements: ["EE-SEM-002"],
    kind: "positive",
    run: ({ api }) => {
      const config = configuration(api);
      const before = api.serializeSemanticProjectIr(config.project);
      const dev = compile(api, config, "development");
      const test = compile(api, config, "test");
      assert.equal(api.serializeSemanticProjectIr(config.project), before);
      assert.equal(
        dev.runtime.semanticProjectHash,
        test.runtime.semanticProjectHash,
      );
      assert.notEqual(dev.inputHash, test.inputHash);
      assert.equal(dev.storage.provider.namespace, "local_schema");
      assert.equal(test.storage.provider.namespace, "test_schema");
      assert.equal(dev.runtime.service.name, "local-api");
      assert.equal(test.runtime.service.name, "test-api");
      assert.deepEqual(
        dev.runtime.service.modules,
        test.runtime.service.modules,
      );
      assert.equal(dev.infrastructure.services.length, 1);
      assert.equal(test.infrastructure.services.length, 1);
      return "The unchanged public semantic project compiles under distinct monolithic profile names, namespaces and policies with equal semantic hashes and distinct technical hashes.";
    },
  },
  {
    id: "representation.planned-allocation",
    requirements: ["EE-ENT-004", "EE-SVC-011"],
    kind: "positive",
    run: ({ api }) => {
      const config = configuration(api);
      const before = api.serializeSemanticProjectIr(config.project);
      config.profiles.test.plannedAllocation = [
        {
          name: "commerce-service",
          modules: ["Commerce"],
          database: "shared-db",
        },
        {
          name: "accounts-service",
          modules: ["Accounts"],
          database: "shared-db",
        },
      ];
      const plan = compile(api, config, "test");
      assert.deepEqual(plan.runtime.plannedAllocation, [
        {
          name: "accounts-service",
          modules: ["Accounts"],
          database: "shared-db",
          entities: ["Accounts.Customer"],
        },
        {
          name: "commerce-service",
          modules: ["Commerce"],
          database: "shared-db",
          entities: ["Commerce.Purchase"],
        },
      ]);
      config.profiles.test.plannedAllocation.reverse();
      const reordered = compile(api, config, "test");
      assert.equal(reordered.inputHash, plan.inputHash);
      assert.deepEqual(
        reordered.runtime.plannedAllocation,
        plan.runtime.plannedAllocation,
      );
      assert.equal(plan.infrastructure.services.length, 1);
      assert.equal(plan.infrastructure.services[0].name, "test-api");
      assert.ok(
        plan.runtime.ownership.every((owner) => owner.service === "test-api"),
      );
      assert.equal(api.serializeSemanticProjectIr(config.project), before);
      return "Distinct planned services have explicit unique Module/Entity ownership and may share one physical-database label, while executable ownership/infrastructure remains monolithic.";
    },
  },
  {
    id: "representation.invalid-planned-allocation",
    requirements: ["EE-ENT-004"],
    kind: "negative",
    run: ({ api }) => {
      const variants = [
        [
          {
            name: "one",
            modules: ["Accounts", "Commerce"],
            database: "shared",
          },
          { name: "two", modules: ["Accounts"], database: "shared" },
        ],
        [{ name: "one", modules: ["Accounts"], database: "shared" }],
        [{ name: "one", modules: ["Accounts", "Absent"], database: "shared" }],
        [
          { name: "one", modules: ["Accounts"], database: "shared" },
          { name: "one", modules: ["Commerce"], database: "shared" },
        ],
        [
          {
            name: "one",
            modules: ["Accounts", "Accounts"],
            database: "shared",
          },
        ],
        [],
      ];
      for (const allocation of variants) {
        const config = configuration(api);
        config.profiles.test.plannedAllocation = allocation;
        const result = api.compileServiceConfiguration(config, "test");
        assert.equal(result.success, false);
        assert.equal("plan" in result, false);
        assert.ok(
          result.diagnostics.some(
            (d) => d.code === "VANE_SVC_PLANNED_OWNERSHIP",
          ),
        );
      }
      return "Duplicate/missing/unknown owners, duplicate service names and empty allocations fail without partial executable plans.";
    },
  },
  {
    id: "representation.provider-materialization",
    requirements: ["EE-COL-006"],
    kind: "positive",
    run: ({ api }) => {
      const config = configuration(api);
      const before = api.serializeSemanticProjectIr(config.project);
      const direct = api.materializePostgreSql(config.project, {
        namespace: "provider_schema",
        targetVersion: 16,
      });
      assert.equal(direct.success, true, JSON.stringify(direct.diagnostics));
      const plan = compile(api, config, "test");
      for (const storage of [direct.ir, plan.storage]) {
        const table = storage.tables.find(
          (t) => t.semanticId === "Accounts.Customer",
        );
        assert.ok(table);
        const column = table.columns.find(
          (c) => c.semanticId === "Accounts.Customer.displayName",
        );
        assert.equal(column.name, "display_name");
        assert.equal(column.type, "text");
        assert.equal(column.nullable, true);
        assert.equal(
          table.columns.find((c) => c.semanticId === "Accounts.Customer.id")
            .type,
          "uuid",
        );
      }
      assert.equal(api.serializeSemanticProjectIr(config.project), before);
      assert.equal(direct.ir.provider.namespace, "provider_schema");
      assert.equal(plan.storage.provider.namespace, "test_schema");
      return "Physical Column naming/SQL types/nullability are chosen by the PostgreSQL provider, directly or through ServiceConfiguration; the semantic Module needs no physical override and remains unchanged.";
    },
  },
  {
    id: "representation.profile-provider-selection",
    requirements: ["EE-SVC-003"],
    kind: "positive",
    run: ({ api }) => {
      const config = configuration(api);
      const before = api.serializeSemanticProjectIr(config.project);
      config.profiles.test.http = {
        provider: api.http(),
        sagaStream: api.sse(),
        security: {
          authentication: { bearer: api.env("REPRESENTATION_BEARER") },
          authorization: "deny",
          cors: ["https://client.example"],
          rateLimit: { requests: 7, windowMs: 1000 },
        },
      };
      const development = compile(api, config, "development");
      const test = compile(api, config, "test");
      assert.equal(
        development.runtime.configuration.http.security.authentication,
        "none",
      );
      assert.equal(
        test.runtime.configuration.http.security.authorization,
        "deny",
      );
      assert.deepEqual(test.runtime.configuration.http.security.rateLimit, {
        requests: 7,
        windowMs: 1000,
      });
      assert.deepEqual(test.runtime.configuration.http.security.cors, [
        "https://client.example",
      ]);
      assert.deepEqual(test.runtime.configuration.http.provider, {
        kind: "http",
        provider: "vane.http",
      });
      assert.deepEqual(test.runtime.configuration.http.sagaStream, {
        kind: "sagaStream",
        provider: "vane.sse",
      });
      assert.equal(test.runtime.service.runtime, "vane.node");
      assert.equal(development.infrastructure.topology, "monolith");
      assert.equal(test.infrastructure.topology, "monolith");
      assert.equal(
        test.runtime.semanticProjectHash,
        development.runtime.semanticProjectHash,
      );
      assert.equal(api.serializeSemanticProjectIr(config.project), before);
      for (const selection of [
        { kind: "runtime", provider: "unknown.runtime" },
        api.postgres(),
      ]) {
        config.profiles.test.topology.service.runtime = selection;
        const invalid = api.compileServiceConfiguration(config, "test");
        assert.equal(invalid.success, false);
        assert.equal("plan" in invalid, false);
        assert.ok(
          invalid.diagnostics.some(
            (d) => d.code === "VANE_SVC_PROVIDER_SELECTION",
          ),
        );
        compile(api, config, "development");
      }
      config.profiles.test.topology = { kind: "distributed", services: [] };
      const distributed = api.compileServiceConfiguration(config, "test");
      assert.equal(distributed.success, false);
      assert.equal("plan" in distributed, false);
      return "Each profile independently selects supported Node/PostgreSQL/HTTP/SSE wiring and meaningful HTTP authentication/authorization/CORS/rate-limit configuration; unsupported provider or productive distributed topology is rejected. No alternative productive runtime is claimed.";
    },
  },
];
