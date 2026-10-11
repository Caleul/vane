import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PostgreSqlModuleRuntime,
  PostgreSqlModuleRuntimeConfigurationError,
  applyPostgreSqlMigrationPlan,
  compileProjectSources,
  createPostgreSqlMigrationPlan,
  materializePostgreSql,
} from "../src/index.js";
import { withTestDatabase } from "./database.js";

// AND/OR in a literal, an escaped apostrophe and parentheses must stay opaque.
const marker = "O'Reilly (AND OR)";
const sourceText = `
import { Entity, Column, Rule, Module, and, or, not, column, literal, eq, gt, gte, lt } from "@lilka/vane";
@Entity() class Entry {
  id = Column({type:"uuid",identity:true});
  a = Column({type:"integer",default:3});
  b = Column({type:"integer",default:2});
  c = Column({type:"integer",default:1});
  label = Column({type:"string",default:${JSON.stringify(marker)}});
  or = Column({type:"string",default:"quoted AND OR identifier"});
  @Rule({expression:or(or(gt(column("a"),column("b")),gt(column("b"),column("c"))),eq(column("label"),literal(${JSON.stringify(marker)})))}) LeftOr() {}
  @Rule({expression:or(gt(column("a"),column("b")),or(gt(column("b"),column("c")),eq(column("label"),literal(${JSON.stringify(marker)}))))}) RightOr() {}
  @Rule({expression:and(and(gte(column("a"),column("b")),gte(column("b"),column("c"))),eq(column("label"),literal(${JSON.stringify(marker)})))}) LeftAnd() {}
  @Rule({expression:and(gte(column("a"),column("b")),and(gte(column("b"),column("c")),eq(column("label"),literal(${JSON.stringify(marker)}))))}) RightAnd() {}
  @Rule({expression:or(and(gt(column("a"),column("b")),gt(column("b"),column("c"))),and(eq(column("label"),literal(${JSON.stringify(marker)})),lt(column("a"),column("c"))))}) Mixed() {}
  @Rule({expression:or(eq(column("or"),literal("quoted AND OR identifier")),gt(column("a"),column("b")))}) QuotedIdentifier() {}
  @Rule({expression:not(or(or(lt(column("a"),column("b")),lt(column("b"),column("c"))),not(eq(column("label"),literal(${JSON.stringify(marker)})))))}) Negated() {}
}
@Module({entities:[Entry]}) class BooleanChecks {}
`;

describe("PostgreSQL associative CHECK normalization", () => {
  it("accepts left/right AND and OR, preserving mixed operators, negation and escaped literals across restarts", async () => {
    await withTestDatabase("boolean_checks", async ({ schema, pool }) => {
      const semantic = compileProjectSources([
        { fileName: "boolean-checks.vane.ts", sourceText },
      ]);
      assert.ok(semantic.success);
      const storage = materializePostgreSql(semantic.ir, {
        namespace: schema,
        targetVersion: 16,
      });
      assert.ok(storage.success);
      const migration = createPostgreSqlMigrationPlan({
        previous: null,
        next: storage.ir,
      });
      await applyPostgreSqlMigrationPlan(pool, migration);
      await applyPostgreSqlMigrationPlan(pool, migration);
      const module = semantic.ir.modules[0];
      assert.ok(module);
      const table = storage.ir.tables.find(
        (entry) => entry.semanticId === "BooleanChecks.Entry",
      );
      assert.ok(table);
      const relation = `"${schema}"."${table.name}"`;
      const runtime = new PostgreSqlModuleRuntime({
        module,
        pool,
        storage: storage.ir,
      });
      try {
        for (let iteration = 0; iteration < 2; iteration += 1) {
          await runtime.start();
          await runtime.stop();
        }
        const inserted = await pool.query(
          `INSERT INTO ${relation} (id) VALUES (gen_random_uuid()) RETURNING label`,
        );
        assert.equal(inserted.rows[0]?.label, marker);
        await assert.rejects(
          pool.query(
            `INSERT INTO ${relation} (id,a,b,c) VALUES (gen_random_uuid(),1,2,3)`,
          ),
          (error: unknown) => (error as { code?: string }).code === "23514",
        );
        // Same Columns/names, genuinely different precedence or literal: startup
        // must reject even though the default row still satisfies the new CHECK.
        const mixed = table.constraints.find((constraint) =>
          constraint.semanticId.endsWith(".rule.Mixed"),
        );
        assert.ok(mixed);
        for (const expression of [
          `((a > b) OR (b > c)) AND ((label = 'O''Reilly (AND OR)') OR (a < c))`,
          `((a > b) AND (b > c)) OR ((label = 'O''Reilly (AND OR changed)') AND (a < c))`,
          `((a > b) AND (b > c)) OR NOT ((label = 'O''Reilly (AND OR)') AND (a < c))`,
        ]) {
          await pool.query(
            `ALTER TABLE ${relation} DROP CONSTRAINT "${mixed.name}", ADD CONSTRAINT "${mixed.name}" CHECK (${expression})`,
          );
          await assert.rejects(
            runtime.start(),
            PostgreSqlModuleRuntimeConfigurationError,
          );
          assert.equal(runtime.state, "stopped");
        }
      } finally {
        await runtime.stop();
      }
    });
  });
});
