import {
  type AclEventAdapter,
  AclEventRuntime,
  PostgreSqlModuleRuntime,
  type PostgreSqlPoolLike,
  PostgreSqlPublicSagaAdmission,
  PostgreSqlSagaRuntime,
  PostgreSqlSagaStore,
  type PostgreSqlStorageIr,
  PostgreSqlViewRuntime,
  type SagaPlanConfiguration,
  type SemanticModule,
  httpAclAdapter,
  materializeSagaPlan,
} from "../src/index.js";

declare const module: SemanticModule;
declare const pool: PostgreSqlPoolLike;
declare const storage: PostgreSqlStorageIr;
const adapter = httpAclAdapter({
  eventIdentity: "Gateway.Authorize",
  version: "v1",
  url: "https://provider.invalid/authorize",
  idempotencyHeader: "Idempotency-Key",
  responses: [
    { status: 200, result: "approved", fields: { reference: "externalId" } },
  ],
});
const acls = new AclEventRuntime(
  module.antiCorruptionLayers.flatMap((acl) => acl.events),
  [adapter],
);
const plan = materializeSagaPlan(module, "PlaceOrder", {}, [adapter]);
const store = new PostgreSqlSagaStore(pool, storage);
const runtime = new PostgreSqlSagaRuntime({
  plans: [plan],
  store,
  acls,
  events: new PostgreSqlModuleRuntime({ module, pool, storage }),
  views: new PostgreSqlViewRuntime(module, pool, storage),
});
new PostgreSqlPublicSagaAdmission(runtime, { "Order.Place": plan });
void runtime.admit(plan, { id: "id" });

const invalidAdapter: AclEventAdapter = {
  ...adapter,
  // @ts-expect-error recoverable adapters must support Event identity idempotency.
  idempotency: "none",
};
const invalidMapping: SagaPlanConfiguration = {
  steps: {
    place: {
      id: {
        // @ts-expect-error Saga bindings cannot invoke callbacks or await another Event.
        kind: "callback",
      },
    },
  },
};
void invalidAdapter;
void invalidMapping;
