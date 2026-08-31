import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { createEventEnvelope } from "../src/postgresql/envelope.js";
import { materializePostgreSql } from "../src/postgresql/materializer.js";
import {
  type PostgreSqlMigrationDatabase,
  applyPostgreSqlMigrationPlan,
} from "../src/postgresql/migration-executor.js";
import { createPostgreSqlMigrationPlan } from "../src/postgresql/migrations.js";
import {
  PostgreSqlModuleRuntime,
  PostgreSqlModuleRuntimeConfigurationError,
} from "../src/postgresql/module-runtime.js";
import { withTestDatabase } from "./database.js";
import { phaseTwoProject } from "./fixtures.js";

function migrationDatabase(pool: Pool): PostgreSqlMigrationDatabase {
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

describe("PostgreSQL integration gate", () => {
  it("connects to a real PostgreSQL 16+ server with transactional DDL", async () => {
    await withTestDatabase("gate", async ({ pool, qualifiedSchema }) => {
      const versionResult = await pool.query<{
        server_version_num: string;
      }>("SHOW server_version_num");
      const serverVersion = Number(
        versionResult.rows[0]?.server_version_num ?? "0",
      );

      assert.ok(
        serverVersion >= 160000,
        `PostgreSQL 16 or newer is required, received ${serverVersion}.`,
      );

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `CREATE TABLE ${qualifiedSchema}.rollback_probe (id bigint PRIMARY KEY)`,
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      const relation = await pool.query<{ name: string | null }>(
        "SELECT to_regclass($1) AS name",
        [`${qualifiedSchema}.rollback_probe`],
      );
      assert.equal(relation.rows[0]?.name, null);
    });
  });

  it("starts, dispatches, stops and restarts only against the installed Storage IR", async () => {
    await withTestDatabase("module_runtime", async ({ pool, schema }) => {
      const project = phaseTwoProject();
      const module = project.modules[0];
      assert.ok(module);
      const materialized = materializePostgreSql(project, {
        namespace: schema,
        targetVersion: 16,
      });
      assert.equal(materialized.success, true);
      if (!materialized.success) return;
      const plan = createPostgreSqlMigrationPlan({
        previous: null,
        next: materialized.ir,
      });
      await applyPostgreSqlMigrationPlan(migrationDatabase(pool), plan);

      const event = module.entities[0]?.events.find(
        ({ name }) => name === "Create",
      );
      assert.ok(event);
      const envelope = createEventEnvelope({
        eventId: randomUUID(),
        eventIdentity: event.identity,
        occurredAt: new Date().toISOString(),
        payload: {
          available: 5,
          createdAt: "0096-02-29T00:00:00Z",
          name: "Module runtime",
          price: 12.5,
          reserved: 1,
        },
      });
      const runtime = new PostgreSqlModuleRuntime({
        module,
        pool,
        storage: materialized.ir,
      });
      await runtime.start();
      assert.equal((await runtime.dispatch(envelope)).kind, "success");
      await runtime.stop();
      await runtime.start();
      assert.equal((await runtime.dispatch(envelope)).kind, "duplicate");
      await runtime.stop();

      const rule = materialized.ir.tables
        .flatMap((table) => table.constraints)
        .find((constraint) => constraint.semanticId.includes(".rule."));
      assert.ok(rule);
      await pool.query(
        `ALTER TABLE "${schema}"."inventory__stock_item" DROP CONSTRAINT "${rule.name}", ADD CONSTRAINT "${rule.name}" CHECK (true)`,
      );
      await assert.rejects(
        runtime.start(),
        PostgreSqlModuleRuntimeConfigurationError,
      );
    });
  });
});
