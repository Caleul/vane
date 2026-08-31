import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { materializePostgreSql } from "../src/postgresql/materializer.js";
import {
  type PostgreSqlMigrationDatabase,
  applyPostgreSqlMigrationPlan,
  approvePostgreSqlMigrationPlan,
} from "../src/postgresql/migration-executor.js";
import { createPostgreSqlMigrationPlan } from "../src/postgresql/migrations.js";
import type { PostgreSqlStorageIr } from "../src/postgresql/storage-ir.js";
import { withTestDatabase } from "./database.js";
import { phaseTwoProject } from "./fixtures.js";

function database(pool: Pool): PostgreSqlMigrationDatabase {
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql, parameters) => {
          const result = await client.query(
            sql,
            parameters ? [...parameters] : [],
          );
          return { rows: result.rows, rowCount: result.rowCount };
        },
        release: () => client.release(),
      };
    },
  };
}

function storage(namespace: string): PostgreSqlStorageIr {
  const result = materializePostgreSql(phaseTwoProject(), {
    namespace,
    targetVersion: 16,
  });
  assert.equal(result.success, true);
  if (!result.success) throw new Error("Materialization failed.");
  return result.ir;
}

function withInvalidDefault(
  snapshot: PostgreSqlStorageIr,
): PostgreSqlStorageIr {
  return {
    ...snapshot,
    tables: snapshot.tables.map((table) =>
      table.semanticId !== "Inventory.StockItem"
        ? table
        : {
            ...table,
            columns: table.columns.map((column) =>
              column.semanticId !== "Inventory.StockItem.name"
                ? column
                : { ...column, defaultSql: "invalid_sql(" },
            ),
          },
    ),
  };
}

function withNullableNote(snapshot: PostgreSqlStorageIr): PostgreSqlStorageIr {
  return {
    ...snapshot,
    tables: snapshot.tables.map((table) =>
      table.semanticId !== "Inventory.StockItem"
        ? table
        : {
            ...table,
            columns: [
              ...table.columns,
              {
                semanticId: "Inventory.StockItem.note",
                name: "note",
                type: "text" as const,
                nullable: true,
                defaultSql: null,
                generated: null,
                technical: false,
              },
            ],
          },
    ),
  };
}

describe("PostgreSQL migrations", () => {
  it("applies a deterministic initial plan once and records immutable history", async () => {
    await withTestDatabase("migration_apply", async ({ pool, schema }) => {
      const target = storage(schema);
      const plan = createPostgreSqlMigrationPlan({
        previous: null,
        next: target,
      });
      assert.equal(plan.classification, "safe");
      assert.equal(plan.noOp, false);

      const concurrent = await Promise.all([
        applyPostgreSqlMigrationPlan(database(pool), plan),
        applyPostgreSqlMigrationPlan(database(pool), plan),
      ]);
      assert.deepEqual(concurrent.map(({ status }) => status).sort(), [
        "already-applied",
        "applied",
      ]);
      const first = concurrent.find(({ status }) => status === "applied");
      assert.equal(first?.appliedSteps, plan.steps.length);
      const history = await pool.query<{
        plan_hash: string;
        source_hash: string;
        target_hash: string;
      }>(
        `SELECT plan_hash, source_hash, target_hash FROM "${schema}"."__vane_migrations"`,
      );
      assert.deepEqual(history.rows, [
        {
          plan_hash: plan.hash,
          source_hash: plan.sourceHash,
          target_hash: plan.targetHash,
        },
      ]);

      await pool.query(
        `INSERT INTO "${schema}"."inventory__stock_item" (available, created_at, name, price, reserved)
         VALUES (5, '2026-08-31T12:00:00Z', 'Preserved row', 10.50, 1)`,
      );
      const upgraded = withNullableNote(target);
      const upgradePlan = createPostgreSqlMigrationPlan({
        previous: target,
        next: upgraded,
      });
      assert.equal(upgradePlan.classification, "safe");
      assert.equal(
        (await applyPostgreSqlMigrationPlan(database(pool), upgradePlan))
          .status,
        "applied",
      );
      const preserved = await pool.query<{
        name: string;
        note: string | null;
      }>(
        `SELECT name, note FROM "${schema}"."inventory__stock_item" WHERE name = 'Preserved row'`,
      );
      assert.deepEqual(preserved.rows, [{ name: "Preserved row", note: null }]);

      const noOp = createPostgreSqlMigrationPlan({
        previous: upgraded,
        next: upgraded,
      });
      assert.equal(noOp.noOp, true);
      assert.equal(
        (await applyPostgreSqlMigrationPlan(database(pool), noOp)).status,
        "no-op",
      );
    });
  });

  it("rolls back every migration step and history when PostgreSQL rejects the plan", async () => {
    await withTestDatabase("migration_rollback", async ({ pool, schema }) => {
      const initial = storage(schema);
      const initialPlan = createPostgreSqlMigrationPlan({
        previous: null,
        next: initial,
      });
      await applyPostgreSqlMigrationPlan(database(pool), initialPlan);

      const invalidTarget = withInvalidDefault(initial);
      const invalidPlan = createPostgreSqlMigrationPlan({
        previous: initial,
        next: invalidTarget,
      });
      assert.equal(invalidPlan.classification, "unsafe");
      const approval = approvePostgreSqlMigrationPlan(invalidPlan, {
        classification: "unsafe",
        reason: "Exercise transactional rollback in the integration gate.",
      });

      await assert.rejects(
        applyPostgreSqlMigrationPlan(database(pool), invalidPlan, approval),
      );

      const history = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "${schema}"."__vane_migrations"`,
      );
      assert.equal(history.rows[0]?.count, "1");
      const defaultState = await pool.query<{
        column_default: string | null;
      }>(
        `SELECT column_default FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'inventory__stock_item' AND column_name = 'name'`,
        [schema],
      );
      assert.equal(defaultState.rows[0]?.column_default, null);
    });
  });
});
