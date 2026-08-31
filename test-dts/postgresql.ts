import type { Pool } from "pg";
import {
  type PostgreSqlMaterializerConfiguration,
  type PostgreSqlMigrationDatabase,
  PostgreSqlModuleRuntime,
  PostgreSqlOutboxDispatcher,
  type PostgreSqlPoolLike,
  SEMANTIC_PROJECT_IR_VERSION,
  type SemanticProjectIr,
  applyPostgreSqlMigrationPlan,
  createEventEnvelope,
  createPostgreSqlMigrationPlan,
  materializePostgreSql,
  renderPostgreSqlSchema,
  requiresPostgreSqlMigrationApproval,
  serializePostgreSqlStorageIr,
} from "../src/index.js";

declare const pool: PostgreSqlPoolLike;
declare const migrationDatabase: PostgreSqlMigrationDatabase;
declare const pgPool: Pool;

const project: SemanticProjectIr = {
  schema: "vane.semantic-project-ir",
  version: SEMANTIC_PROJECT_IR_VERSION,
  modules: [],
};

const configuration = {
  namespace: "application",
  targetVersion: 16,
} satisfies PostgreSqlMaterializerConfiguration;

const materialized = materializePostgreSql(project, configuration);
if (materialized.success) {
  renderPostgreSqlSchema(materialized.ir);
  serializePostgreSqlStorageIr(materialized.ir);
  const plan = createPostgreSqlMigrationPlan({
    previous: null,
    next: materialized.ir,
  });
  requiresPostgreSqlMigrationApproval(plan.classification);
  void applyPostgreSqlMigrationPlan(migrationDatabase, plan);
  void applyPostgreSqlMigrationPlan(pgPool, plan);
  new PostgreSqlOutboxDispatcher(pool, materialized.ir);
  const module = project.modules[0];
  if (module) {
    new PostgreSqlModuleRuntime({ module, pool, storage: materialized.ir });
  }
}

createEventEnvelope({
  eventId: "0198f6ce-5f90-7f10-8c3f-35e959649919",
  eventIdentity: "Order.Place",
  occurredAt: "2026-08-31T12:00:00.000Z",
  payload: { orderId: "0198f6ce-5f90-7f10-8c3f-35e959649920" },
});

materializePostgreSql(project, {
  namespace: "application",
  // @ts-expect-error PostgreSQL target versions are numeric.
  targetVersion: "16",
});

createEventEnvelope({
  eventId: "0198f6ce-5f90-7f10-8c3f-35e959649919",
  eventIdentity: "Order.Place",
  occurredAt: "2026-08-31T12:00:00.000Z",
  // @ts-expect-error Event envelope payloads must be JSON values.
  payload: { invalid: undefined },
});
