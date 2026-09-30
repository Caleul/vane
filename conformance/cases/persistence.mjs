import assert from "node:assert/strict";
import { domain } from "./semantic.mjs";

function physical(api, declaration = domain()) {
  const semantic = api.compileSemanticProject([declaration]);
  assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
  const result = api.materializePostgreSql(semantic.ir, {
    namespace: "conformance",
    targetVersion: 16,
  });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  return result.ir;
}
export const cases = [
  {
    id: "persistence.entity-table",
    requirements: ["EE-ENT-003"],
    kind: "positive",
    run: ({ api }) => {
      const storage = physical(api);
      const tables = storage.tables.filter((t) => !t.technical);
      assert.equal(tables.length, 1);
      assert.equal(tables[0].semanticId, "Calendar.Booking");
      assert.deepEqual(
        tables[0].columns
          .filter((c) => !c.technical)
          .map((c) => c.semanticId)
          .sort(),
        [
          "Calendar.Booking.ends",
          "Calendar.Booking.id",
          "Calendar.Booking.starts",
        ],
      );
      return "One declared Entity produces exactly one nontechnical table with each declared Column";
    },
  },
  {
    id: "persistence.column-types",
    requirements: ["EE-COL-001"],
    kind: "positive",
    run: ({ api }) => {
      const d = {
        name: "Types",
        entities: [
          {
            name: "Record",
            columns: [
              { name: "id", type: "uuid", identity: true },
              ...[
                "string",
                "integer",
                "decimal",
                "boolean",
                "date",
                "datetime",
                "uuid",
                "json",
              ].map((type) => ({ name: `value${type}`, type, nullable: true })),
            ],
          },
        ],
      };
      const storage = physical(api, d);
      const table = storage.tables.find((t) => !t.technical);
      const expected = {
        string: "text",
        integer: "bigint",
        decimal: "numeric",
        boolean: "boolean",
        date: "date",
        datetime: "timestamptz",
        uuid: "uuid",
        json: "jsonb",
      };
      for (const [type, sql] of Object.entries(expected))
        assert.equal(
          table.columns.find(
            (c) => c.semanticId === `Types.Record.value${type}`,
          ).type,
          sql,
        );
      return "All eight normative Column types compile and materialize to PostgreSQL types";
    },
  },
  {
    id: "persistence.rule-ddl",
    requirements: ["EE-RUL-003", "EE-PG-001"],
    kind: "positive",
    run: ({ api }) => {
      const storage = physical(api);
      const table = storage.tables.find((t) => !t.technical);
      const sql = api.renderPostgreSqlSchema(storage);
      assert.ok(
        table.constraints.some(
          (c) =>
            c.kind === "check" && c.expression?.includes('"ends" > "starts"'),
        ),
      );
      assert.match(sql, /CHECK\s*\(/);
      assert.match(sql, /"ends" > "starts"/);
      assert.match(sql, /PRIMARY KEY/);
      return "Two-Column Rule materializes as database CHECK with Entity table and primary key (DDL proof only; no database execution claimed)";
    },
  },
  {
    id: "persistence.unsupported-target",
    requirements: ["EE-COL-004"],
    kind: "negative",
    run: ({ api }) => {
      const result = api.materializePostgreSql(
        api.compileSemanticProject([domain()]).ir,
        { namespace: "conformance", targetVersion: 15 },
      );
      assert.equal(result.success, false);
      assert.equal("ir" in result, false);
      assert.ok(result.diagnostics.some((d) => d.code === "VANE_PG_VERSION"));
      physical(api);
      return "Unsupported PostgreSQL target is rejected before any Storage IR is produced";
    },
  },
  {
    id: "persistence.migration-determinism",
    requirements: ["EE-PG-002", "EE-PG-003"],
    kind: "positive",
    run: ({ api }) => {
      const next = physical(api);
      const initial = api.createPostgreSqlMigrationPlan({
        previous: null,
        next,
      });
      const again = api.createPostgreSqlMigrationPlan({
        previous: null,
        next: JSON.parse(api.serializePostgreSqlStorageIr(next)),
      });
      assert.equal(
        api.serializePostgreSqlMigrationPlan(initial),
        api.serializePostgreSqlMigrationPlan(again),
      );
      assert.ok(initial.version > 0);
      assert.ok(initial.sourceHash);
      assert.ok(initial.targetHash);
      assert.ok(initial.hash);
      assert.equal(api.verifyPostgreSqlMigrationPlanHash(initial), true);
      const noop = api.createPostgreSqlMigrationPlan({ previous: next, next });
      assert.equal(noop.noOp, true);
      assert.equal(noop.steps.length, 0);
      const changed = domain();
      changed.entities[0].columns.push({
        name: "memo",
        type: "string",
        nullable: true,
      });
      const diff = api.createPostgreSqlMigrationPlan({
        previous: next,
        next: physical(api, changed),
      });
      assert.ok(diff.steps.some((s) => s.kind === "addColumn"));
      assert.notEqual(diff.targetHash, initial.targetHash);
      return "Versioned content-addressed migration deterministic across serialized snapshot roundtrip; identical snapshot has empty diff; adding Column changes diff/hash";
    },
  },
  {
    id: "persistence.destructive-approval",
    requirements: ["EE-PG-004"],
    kind: "negative",
    run: async ({ api }) => {
      const previous = physical(api);
      const next = physical(api, { name: "Calendar", entities: [] });
      const plan = api.createPostgreSqlMigrationPlan({ previous, next });
      assert.equal(api.requiresPostgreSqlMigrationApproval(plan), true);
      let connections = 0;
      const database = {
        connect: async () => {
          connections++;
          throw new Error("Unexpected database access");
        },
      };
      await assert.rejects(
        () => api.applyPostgreSqlMigrationPlan(database, plan),
        api.PostgreSqlMigrationApprovalError,
      );
      assert.equal(connections, 0);
      return "Destructive plan is rejected without exact-hash approval before database access";
    },
  },
];
