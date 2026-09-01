import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import {
  InMemoryTerminalResultStore,
  type PostgreSqlMigrationDatabase,
  PostgreSqlModuleRuntime,
  PostgreSqlViewRuntime,
  PublicHttpRuntime,
  applyPostgreSqlMigrationPlan,
  createPostgreSqlMigrationPlan,
  materializeContract,
  materializePostgreSql,
} from "../src/index.js";
import { withTestDatabase } from "./database.js";
import { phaseThreeProject } from "./fixtures.js";

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

describe("phase 3 PostgreSQL and HTTP integration", () => {
  it("persists an Event, executes its terminal View and exposes only the final View", async () => {
    await withTestDatabase("phase_three", async ({ pool, schema }) => {
      const project = phaseThreeProject();
      const module = project.modules[0];
      assert.ok(module);
      const materialized = materializePostgreSql(project, {
        namespace: schema,
        targetVersion: 16,
      });
      assert.equal(materialized.success, true);
      if (!materialized.success) return;
      await applyPostgreSqlMigrationPlan(
        migrationDatabase(pool),
        createPostgreSqlMigrationPlan({
          previous: null,
          next: materialized.ir,
        }),
      );
      const id = randomUUID();
      await pool.query(
        `INSERT INTO "${schema}"."inventory__stock_item" (id, name, available, reserved, price, created_at, __vane_revision) VALUES ($1, 'Before', 5, 1, 12.50, '2026-09-01T12:00:00Z', 1)`,
        [id],
      );
      const contract = materializeContract(module, {
        views: [{ view: "StockItemDetails" }],
        events: [
          {
            event: "StockItem.Rename",
            terminal: {
              view: "StockItemDetails",
              input: { id: { kind: "eventInput", input: "id" } },
            },
          },
        ],
      });
      assert.equal(contract.success, true);
      if (!contract.success) return;
      const events = new PostgreSqlModuleRuntime({
        module,
        pool,
        storage: materialized.ir,
      });
      const views = new PostgreSqlViewRuntime(module, pool, materialized.ir);
      await events.start();
      const http = new PublicHttpRuntime({
        contract: contract.ir,
        events,
        views,
        terminals: new InMemoryTerminalResultStore(),
      });
      const accepted = await http.handle({
        method: "POST",
        path: "/events/StockItem.Rename",
        body: { id, name: "After" },
      });
      assert.equal(accepted.status, 202);
      const { sagaId } = JSON.parse(accepted.body) as { sagaId: string };
      assert.equal(accepted.body.includes("revision"), false);
      const stream = await http.handle({
        method: "GET",
        path: `/sagas/${sagaId}`,
      });
      assert.equal(stream.status, 200);
      assert.match(stream.body, /^event: view\n/u);
      assert.match(stream.body, /"name":"After"/u);
      assert.match(stream.body, /"price":12\.5/u);
      assert.equal(stream.body.includes("revision"), false);
      const direct = await http.handle({
        method: "POST",
        path: "/views/StockItemDetails",
        body: { id },
      });
      assert.equal(direct.status, 200);
      assert.deepEqual(JSON.parse(direct.body), [
        { id, name: "After", price: 12.5 },
      ]);
      const moduleWithNullView = {
        ...module,
        views: [
          ...module.views,
          {
            name: "ItemsWithoutExpiry",
            input: [],
            output: [
              {
                name: "id",
                type: "uuid" as const,
                nullable: false,
                expression: {
                  kind: "column" as const,
                  entity: "StockItem",
                  column: "id",
                },
              },
            ],
            query: {
              root: "StockItem",
              relations: [],
              where: {
                kind: "comparison" as const,
                operator: "eq" as const,
                left: {
                  kind: "column" as const,
                  entity: "StockItem",
                  column: "expiresOn",
                },
                right: { kind: "literal" as const, value: null },
              },
              orderBy: [],
              pagination: null,
            },
            persistence: { allowed: false as const },
            publicResult: { kind: "view" as const },
          },
        ],
      };
      const nullResult = await new PostgreSqlViewRuntime(
        moduleWithNullView,
        pool,
        materialized.ir,
      ).execute({ view: "ItemsWithoutExpiry", input: {} });
      assert.deepEqual(nullResult.rows, [{ id }]);
      await events.stop();
    });
  });
});
