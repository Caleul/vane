import assert from "node:assert/strict";
import { it } from "node:test";
import {
  type DurableSagaState,
  applyPostgreSqlMigrationPlan,
  compileServiceConfiguration,
  createPostgreSqlMigrationPlan,
  createServiceRuntime,
} from "../src/index.js";
import { phaseFiveConfiguration } from "../test/phase-five-fixture.js";
import { withTestDatabase } from "./database.js";

it("persisted public SSE cannot cross equivalent Module plans or inspect private Views", async () => {
  await withTestDatabase("security_scope", async (database) => {
    const base = phaseFiveConfiguration();
    const sales = base.project.modules[0];
    const receipt = sales?.views[0];
    const saga = sales?.sagas[0];
    const profile = base.profiles.development;
    const gatewayMapping = profile.acls?.["Sales.Gateway.Authorize"];
    assert.ok(
      sales && receipt && saga && profile.topology?.kind === "monolith",
    );
    assert.ok(gatewayMapping);
    const internalSaga = {
      ...saga,
      name: "InternalOrder",
      terminal: {
        ...saga.terminal,
        success: { kind: "view" as const, view: "PrivateReceipt" },
      },
    };
    const configuration = {
      ...base,
      project: {
        ...base.project,
        modules: [
          {
            ...sales,
            views: [...sales.views, { ...receipt, name: "PrivateReceipt" }],
            sagas: [
              ...sales.sagas,
              internalSaga,
              { ...saga, name: "ApplicationConfirm" },
            ],
          },
          { ...sales, name: "Other" },
        ],
      },
      profiles: {
        ...base.profiles,
        development: {
          ...profile,
          topology: {
            ...profile.topology,
            service: {
              ...profile.topology.service,
              modules: ["Sales", "Other"],
              persistence: {
                ...profile.topology.service.persistence,
                namespace: database.schema,
              },
            },
          },
          acls: {
            ...profile.acls,
            "Other.Gateway.Authorize": gatewayMapping,
          },
        },
      },
    };
    const compiled = compileServiceConfiguration(configuration, "test");
    assert.ok(compiled.success, JSON.stringify(compiled));
    await applyPostgreSqlMigrationPlan(
      database.pool,
      createPostgreSqlMigrationPlan({
        previous: null,
        next: compiled.plan.storage,
      }),
    );
    const runtime = await createServiceRuntime(configuration, "test", {
      pool: database.pool,
      resolveSecret: () => "https://gateway.invalid",
    });
    const module = runtime.modules.find((entry) => entry.name === "Sales");
    assert.ok(module);
    const stateFor = (
      moduleName: string,
      sagaName: string,
      view: string,
    ): DurableSagaState => {
      const plan = runtime.plan.runtime.sagas.find(
        (plan) => plan.module === moduleName && plan.saga === sagaName,
      );
      assert.ok(plan);
      return {
        schema: "vane.saga-state",
        version: 1,
        planHash: plan.hash,
        correlationId: "10000000-0000-4000-8000-000000000001",
        input: {},
        status: "terminal",
        steps: [],
        fail: null,
        terminal: {
          kind: "view",
          view,
          data: [{ value: "private-cross-module-sentinel" }],
        },
      };
    };
    const sagaId = "10000000-0000-4000-8000-000000000001";
    const replaceState = async (state: DurableSagaState) => {
      await database.query(
        `DELETE FROM ${module.store.table} WHERE saga_id = $1`,
        [sagaId],
      );
      await module.store.insert(sagaId, "test.security", state);
    };
    await replaceState(stateFor("Other", "PlaceOrder", "Receipt"));
    const request = {
      method: "GET",
      path: "/sales/sagas/10000000-0000-4000-8000-000000000001",
    };
    const crossModule = await module.http.handle(request);
    assert.equal(crossModule.status, 404);
    assert.ok(!crossModule.body.includes("private-cross-module-sentinel"));
    await replaceState(stateFor("Sales", "InternalOrder", "PrivateReceipt"));
    assert.equal((await module.http.handle(request)).status, 404);

    await replaceState(stateFor("Sales", "ApplicationConfirm", "Receipt"));
    const application = await module.http.handle(request);
    assert.equal(application.status, 200);
    assert.match(application.body, /^event: view\n/);
    assert.equal((await module.http.handle(request)).body, application.body);
    // Privileged inspection retains access; only the public streaming adapter is scoped.
    await replaceState(stateFor("Sales", "InternalOrder", "PrivateReceipt"));
    assert.equal((await module.store.read(sagaId))?.terminal?.kind, "view");
  });
});
