import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export const cases = [
  {
    id: "migrations.exact-approval",
    requirements: ["EE-PG-004", "EE-NFR-011"],
    kind: "negative",
    requires: "postgresql",
    run: async (context) => {
      const { api, packageRoot, databaseUrl } = context;
      if (!databaseUrl)
        throw Object.assign(new Error("PostgreSQL required"), {
          code: "CONFORMANCE_GAP",
        });
      const { Pool } = createRequire(resolve(packageRoot, "package.json"))(
        "pg",
      );
      const pool = new Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      });
      const namespace = `vane_approval_${randomUUID().replaceAll("-", "")}`;
      try {
        context.postgresqlVersion = String(
          (await pool.query("SHOW server_version_num")).rows[0]
            .server_version_num,
        );
        const declaration = {
          name: "Approvals",
          entities: [
            {
              name: "Entry",
              columns: [
                { name: "id", type: "uuid", identity: true },
                { name: "note", type: "string" },
              ],
            },
          ],
        };
        const storage = (input) => {
          const semantic = api.compileSemanticProject([input]);
          assert.equal(semantic.success, true);
          const result = api.materializePostgreSql(semantic.ir, {
            namespace,
            targetVersion: 16,
          });
          assert.equal(result.success, true);
          return result.ir;
        };
        const previous = storage(declaration);
        const table = previous.tables.find((t) => !t.technical);
        const relation = `"${namespace}"."${table.name}"`;
        await api.applyPostgreSqlMigrationPlan(
          pool,
          api.createPostgreSqlMigrationPlan({ previous: null, next: previous }),
        );
        const id = randomUUID();
        await pool.query(`INSERT INTO ${relation}(id,note) VALUES($1,$2)`, [
          id,
          "must survive unapproved attempts",
        ]);
        const next = storage({ name: "Approvals", entities: [] });
        const destructive = api.createPostgreSqlMigrationPlan({
          previous,
          next,
        });
        assert.equal(destructive.classification, "destructive");
        assert.ok(destructive.steps.some((s) => s.kind === "dropTable"));
        const approval = api.approvePostgreSqlMigrationPlan(destructive, {
          classification: "destructive",
          reason:
            "Disposable conformance schema explicitly approved for destruction",
        });
        assert.equal(approval.planHash, destructive.hash);
        for (const denied of [
          undefined,
          { ...approval, planHash: "0".repeat(64) },
          { ...approval, classification: "unsafe" },
        ]) {
          await assert.rejects(
            () => api.applyPostgreSqlMigrationPlan(pool, destructive, denied),
            api.PostgreSqlMigrationApprovalError,
          );
          assert.equal(
            (await pool.query(`SELECT note FROM ${relation} WHERE id=$1`, [id]))
              .rows[0].note,
            "must survive unapproved attempts",
          );
        }
        const result = await api.applyPostgreSqlMigrationPlan(
          pool,
          destructive,
          approval,
        );
        assert.equal(result.status, "applied");
        assert.equal(
          (
            await pool.query("SELECT to_regclass($1) AS target", [
              `${namespace}.${table.name}`,
            ])
          ).rows[0].target,
          null,
        );
        assert.throws(
          () =>
            api.createPostgreSqlMigrationPlan({
              previous: { ...previous, version: 999 },
              next,
            }),
          api.PostgreSqlMigrationPlanningError,
        );
        return "Destructive diff explicitly identifies drop; absent, wrong-hash and wrong-classification approval preserve row; exact-hash approval applies; incompatible Storage IR version raises migration diagnostic";
      } finally {
        try {
          await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        } finally {
          await pool.end();
        }
      }
    },
  },
];
