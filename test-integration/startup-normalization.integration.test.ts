import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Pool } from "pg";
import {
  PostgreSqlModuleRuntime,
  PostgreSqlModuleRuntimeConfigurationError,
  applyPostgreSqlMigrationPlan,
  compileProjectSources,
  createPostgreSqlMigrationPlan,
  materializePostgreSql,
} from "../src/index.js";
import { testDatabaseUrl, withTestDatabase } from "./database.js";

const sourceText = `
import { Entity, Column, Event, Rule, Module, create, input, column, gte } from "@lilka/vane";
@Entity() class Entry {
  id = Column({type:"uuid", identity:true});
  lower = Column({type:"integer", default:0});
  upper = Column({type:"integer", default:10});
  recorded = Column({type:"datetime", default:"2026-09-01T08:00:00.123456+05:45"});
  @Rule({expression:gte(column("upper"),column("lower"))}) Ordered() {}
  Add = Event({input:{id:"uuid"},operation:create({id:input("id")})});
}
@Module({entities:[Entry]}) class Startup {}
`;

describe("PostgreSQL startup normalization", () => {
  it("accepts timezone-aware microsecond defaults and reversed CHECK operands without leaking session settings", async () => {
    await withTestDatabase("startup_literals", async ({ schema, pool }) => {
      const semantic = compileProjectSources([
        { fileName: "startup.vane.ts", sourceText },
      ]);
      assert.ok(semantic.success);
      const materialized = materializePostgreSql(semantic.ir, {
        namespace: schema,
        targetVersion: 16,
      });
      assert.ok(materialized.success);
      await applyPostgreSqlMigrationPlan(
        pool,
        createPostgreSqlMigrationPlan({
          previous: null,
          next: materialized.ir,
        }),
      );
      const module = semantic.ir.modules[0];
      assert.ok(module);
      const table = materialized.ir.tables.find(
        (table) => table.semanticId === "Startup.Entry",
      );
      assert.ok(table);
      const relation = `"${schema}"."${table.name}"`;
      // A one-connection pool proves startup returns the same session settings.
      const session = new Pool({ connectionString: testDatabaseUrl, max: 1 });
      const runtime = new PostgreSqlModuleRuntime({
        module,
        pool: session,
        storage: materialized.ir,
      });
      try {
        await session.query("SET DateStyle TO 'SQL, DMY'");
        await session.query("SET TIME ZONE 'Asia/Kathmandu'");
        const settings = async () =>
          (
            await session.query(
              "SELECT current_setting('DateStyle') AS date_style, current_setting('TimeZone') AS time_zone",
            )
          ).rows[0];
        const original = await settings();
        assert.deepEqual(original, {
          date_style: "SQL, DMY",
          time_zone: "Asia/Kathmandu",
        });
        await runtime.start();
        await runtime.stop();
        assert.deepEqual(await settings(), original);
        // Stored precision remains six digits, beyond JavaScript Date's milliseconds.
        const result = await session.query(
          `INSERT INTO ${relation} (id) VALUES (gen_random_uuid()) RETURNING to_char(recorded AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS recorded`,
        );
        assert.equal(result.rows[0]?.recorded, "2026-09-01 02:15:00.123456");
        for (const defaultValue of [
          "2026-09-01T02:15:00.123457Z",
          "2026-09-01T02:15:00.123455Z",
          "2026-09-01T02:15:00.123456+01:00",
        ]) {
          await session.query(
            `ALTER TABLE ${relation} ALTER COLUMN recorded SET DEFAULT '${defaultValue}'::timestamptz`,
          );
          await assert.rejects(
            runtime.start(),
            PostgreSqlModuleRuntimeConfigurationError,
          );
          assert.equal(runtime.state, "stopped");
          assert.deepEqual(await settings(), original);
        }
        // Cast chains and functions are expressions, not equivalent literals:
        // stripping their casts would hide real default truncation/timezone drift.
        for (const defaultExpression of [
          "('2026-09-01 02:15:00.123456+00'::timestamptz)::date",
          "('2026-09-01 02:15:00.123456+00'::timestamptz)::timestamp",
          "date_trunc('day', '2026-09-01 02:15:00.123456+00'::timestamptz)",
        ]) {
          await session.query(
            `ALTER TABLE ${relation} ALTER COLUMN recorded SET DEFAULT ${defaultExpression}`,
          );
          await assert.rejects(
            runtime.start(),
            PostgreSqlModuleRuntimeConfigurationError,
          );
          assert.deepEqual(await settings(), original);
        }
        await session.query(
          `ALTER TABLE ${relation} ALTER COLUMN recorded SET DEFAULT '2026-09-01T02:15:00.123456Z'::timestamptz`,
        );
        await runtime.start();
        await runtime.stop();
        assert.deepEqual(await settings(), original);
        const rule = table.constraints.find(
          (constraint) =>
            constraint.kind === "check" && constraint.columns.length === 2,
        );
        assert.ok(rule);
        for (const replacement of [
          'CHECK ("upper" > "lower")',
          'CHECK ("upper" >= "lower") NOT VALID',
        ]) {
          await session.query(
            `ALTER TABLE ${relation} DROP CONSTRAINT "${rule.name}", ADD CONSTRAINT "${rule.name}" ${replacement}`,
          );
          await assert.rejects(
            runtime.start(),
            PostgreSqlModuleRuntimeConfigurationError,
          );
          assert.deepEqual(await settings(), original);
        }
      } finally {
        try {
          await runtime.stop();
        } finally {
          await session.end();
        }
      }
    });
  });
});
