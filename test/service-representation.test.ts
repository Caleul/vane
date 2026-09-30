import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ServiceConfiguration,
  compileServiceConfiguration,
} from "../src/index.js";
import { phaseFiveConfiguration } from "./phase-five-fixture.js";

test("planned allocation is opt-in, redacted technical metadata, not runtime topology", () => {
  const config = phaseFiveConfiguration({
    plannedAllocation: [
      { name: "sales-service", modules: ["Sales"], database: "shared-orders" },
    ],
  });
  const result = compileServiceConfiguration(config, "test");
  assert.ok(result.success, JSON.stringify(result));
  assert.deepEqual(
    result.plan.runtime.plannedAllocation?.map((a) => ({
      name: a.name,
      modules: a.modules,
      database: a.database,
    })),
    [{ name: "sales-service", modules: ["Sales"], database: "shared-orders" }],
  );
  assert.ok(
    result.plan.runtime.plannedAllocation?.[0]?.entities.includes(
      "Sales.Order",
    ),
  );
  assert.equal(result.plan.infrastructure.topology, "monolith");
  assert.equal(result.plan.infrastructure.services.length, 1);
  assert.ok(
    result.plan.runtime.ownership.every((owner) => owner.service === "api"),
  );
  const legacy = compileServiceConfiguration(phaseFiveConfiguration(), "test");
  assert.ok(legacy.success);
  assert.equal(Object.hasOwn(legacy.plan.runtime, "plannedAllocation"), false);
});

test("planned ownership rejects ambiguous, missing, unknown, empty and malformed allocation", () => {
  const variants: unknown[] = [
    [],
    [{ name: "a", modules: [], database: "db" }],
    [{ name: "a", modules: ["Missing"], database: "db" }],
    [{ name: "a", modules: ["Sales", "Sales"], database: "db" }],
    [
      { name: "a", modules: ["Sales"], database: "db" },
      { name: "b", modules: ["Sales"], database: "db" },
    ],
    [{ name: "a", modules: ["Sales"], database: "postgres://secret" }],
    [{ name: "a", modules: "Sales", database: "db" }],
    {},
    null,
  ];
  for (const allocation of variants) {
    const config = phaseFiveConfiguration();
    const bad = {
      ...config,
      profiles: {
        development: {
          ...config.profiles.development,
          plannedAllocation: allocation,
        },
      },
    };
    const result = compileServiceConfiguration(
      bad as unknown as ServiceConfiguration,
      "development",
    );
    assert.equal(result.success, false, JSON.stringify(allocation));
    assert.equal(Object.hasOwn(result, "plan"), false);
  }
});

test("planned allocation is inherited, replaceable and changes technical hash only", () => {
  const config = phaseFiveConfiguration({
    plannedAllocation: [
      { name: "sales-service", modules: ["Sales"], database: "primary-db" },
    ],
  });
  const first = compileServiceConfiguration(config, "test");
  assert.ok(first.success);
  const changed = {
    ...config,
    profiles: {
      ...config.profiles,
      test: {
        ...config.profiles.test,
        plannedAllocation: [
          { name: "future-sales", modules: ["Sales"], database: "shared-db" },
        ],
      },
    },
  };
  const second = compileServiceConfiguration(changed, "test");
  assert.ok(second.success);
  assert.equal(
    first.plan.runtime.semanticProjectHash,
    second.plan.runtime.semanticProjectHash,
  );
  assert.notEqual(first.plan.inputHash, second.plan.inputHash);
  assert.deepEqual(first.plan.runtime.ownership, second.plan.runtime.ownership);
  assert.equal(
    second.plan.runtime.plannedAllocation?.[0]?.database,
    "shared-db",
  );
});

test("planning metadata cannot smuggle provider or connection overrides", () => {
  for (const extra of [
    { provider: "other-database" },
    { connection: "postgres://sensitive" },
    { runtime: { kind: "runtime", provider: "distributed" } },
  ]) {
    const config = phaseFiveConfiguration();
    const bad = {
      ...config,
      profiles: {
        development: {
          ...config.profiles.development,
          plannedAllocation: [
            { name: "sales", modules: ["Sales"], database: "shared", ...extra },
          ],
        },
      },
    };
    const result = compileServiceConfiguration(
      bad as unknown as ServiceConfiguration,
      "development",
    );
    assert.equal(result.success, false);
    assert.equal(Object.hasOwn(result, "plan"), false);
    assert.equal(
      JSON.stringify(result).includes("postgres://sensitive"),
      false,
    );
  }
});
