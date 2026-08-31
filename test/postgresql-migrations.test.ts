import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PostgreSqlMigrationApprovalError,
  type PostgreSqlMigrationClient,
  type PostgreSqlMigrationDatabase,
  PostgreSqlMigrationHistoryError,
  type PostgreSqlMigrationQueryResult,
  applyPostgreSqlMigrationPlan,
  approvePostgreSqlMigrationPlan,
} from "../src/postgresql/migration-executor.js";
import {
  type PostgreSqlMigrationPlan,
  PostgreSqlMigrationPlanningError,
  createPostgreSqlMigrationPlan,
  serializePostgreSqlMigrationPlan,
} from "../src/postgresql/migrations.js";
import type { PostgreSqlQueryResult } from "../src/postgresql/runtime.js";
import type {
  PostgreSqlColumn,
  PostgreSqlConstraint,
  PostgreSqlStorageIr,
  PostgreSqlTable,
} from "../src/postgresql/storage-ir.js";

const historyTable: PostgreSqlTable = {
  semanticId: "vane.infrastructure.migrations",
  module: null,
  name: "__vane_migrations",
  technical: true,
  columns: [],
  constraints: [],
  indexes: [],
};

const idColumn: PostgreSqlColumn = {
  semanticId: "Sales.Order.id",
  name: "id",
  type: "uuid",
  nullable: false,
  defaultSql: null,
  generated: null,
  technical: false,
};

const orderTable: PostgreSqlTable = {
  semanticId: "Sales.Order",
  module: "Sales",
  name: "sales__order",
  technical: false,
  columns: [
    idColumn,
    {
      semanticId: "Sales.Order.total",
      name: "total",
      type: "numeric",
      nullable: false,
      defaultSql: "0::numeric",
      generated: null,
      technical: false,
    },
  ],
  constraints: [
    {
      semanticId: "Sales.Order.primaryKey",
      name: "pk_sales_order",
      kind: "primaryKey",
      columns: ["id"],
      expression: null,
      references: null,
    },
  ],
  indexes: [],
};

function storage(
  tables: readonly PostgreSqlTable[],
  namespace = "public",
): PostgreSqlStorageIr {
  return {
    schema: "vane.postgresql-storage-ir",
    version: 1,
    provider: { name: "postgresql", minimumVersion: 16, namespace },
    tables,
  };
}

class RecordingDatabase
  implements PostgreSqlMigrationDatabase, PostgreSqlMigrationClient
{
  readonly calls: {
    readonly sql: string;
    readonly parameters: readonly unknown[];
  }[] = [];
  existingPlan = false;
  head: string | null = null;
  failOn = "";
  connectCount = 0;
  releaseCount = 0;

  async connect(): Promise<PostgreSqlMigrationClient> {
    this.connectCount += 1;
    return this;
  }

  async query<Row extends object = Record<string, unknown>>(
    sql: string,
    parameters: unknown[] = [],
  ): Promise<PostgreSqlQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    if (this.failOn && sql.includes(this.failOn))
      throw new Error("database failure");
    if (sql.startsWith('SELECT "plan_hash"')) {
      return {
        rows: this.existingPlan ? [{ plan_hash: parameters[0] }] : [],
      } as unknown as PostgreSqlQueryResult<Row>;
    }
    if (sql.startsWith('SELECT "target_hash"')) {
      return {
        rows: this.head === null ? [] : [{ target_hash: this.head }],
      } as unknown as PostgreSqlQueryResult<Row>;
    }
    return { rows: [], rowCount: 0 } as PostgreSqlQueryResult<Row>;
  }

  release(): void {
    this.releaseCount += 1;
  }
}

describe("PostgreSQL migration planning", () => {
  it("produces a content-addressed deterministic no-op", () => {
    const first = storage([historyTable, orderTable]);
    const reordered = storage([
      { ...orderTable, columns: [...orderTable.columns].reverse() },
      historyTable,
    ]);
    const left = createPostgreSqlMigrationPlan({
      previous: first,
      next: reordered,
    });
    const right = createPostgreSqlMigrationPlan({
      previous: reordered,
      next: first,
    });

    assert.equal(left.noOp, true);
    assert.equal(left.classification, "safe");
    assert.equal(left.sql, "");
    assert.equal(left.sourceHash, left.targetHash);
    assert.equal(left.hash, right.hash);
    assert.match(left.hash, /^[a-f0-9]{64}$/);
    assert.equal(serializePostgreSqlMigrationPlan(left).endsWith("\n"), true);
  });

  it("creates a safe baseline and leaves migration history to the executor", () => {
    const plan = createPostgreSqlMigrationPlan({
      previous: null,
      next: storage([historyTable, orderTable]),
    });

    assert.equal(plan.classification, "safe");
    assert.deepEqual(
      plan.steps.map(({ kind }) => kind),
      ["createTable"],
    );
    assert.match(plan.sql, /CREATE TABLE "public"\."sales__order"/);
    assert.doesNotMatch(plan.sql, /__vane_migrations/);
  });

  it("requires explicit table and column renames", () => {
    const renamedTable: PostgreSqlTable = {
      ...orderTable,
      semanticId: "Sales.Purchase",
      name: "sales__purchase",
      columns: orderTable.columns.map((column) =>
        column.name === "total"
          ? {
              ...column,
              semanticId: "Sales.Purchase.amount",
              name: "amount",
            }
          : {
              ...column,
              semanticId: `Sales.Purchase.${column.name}`,
            },
      ),
      constraints: [],
    };
    const withoutMap = createPostgreSqlMigrationPlan({
      previous: storage([orderTable]),
      next: storage([renamedTable]),
    });
    assert.equal(withoutMap.classification, "destructive");
    assert.deepEqual(
      withoutMap.steps.map(({ kind }) => kind),
      ["createTable", "dropTable"],
    );

    const withMap = createPostgreSqlMigrationPlan({
      previous: storage([orderTable]),
      next: storage([renamedTable]),
      renames: {
        tables: [
          {
            fromSemanticId: "Sales.Order",
            toSemanticId: "Sales.Purchase",
          },
        ],
        columns: [
          {
            fromTableSemanticId: "Sales.Order",
            fromColumnSemanticId: "Sales.Order.id",
            toTableSemanticId: "Sales.Purchase",
            toColumnSemanticId: "Sales.Purchase.id",
          },
          {
            fromTableSemanticId: "Sales.Order",
            fromColumnSemanticId: "Sales.Order.total",
            toTableSemanticId: "Sales.Purchase",
            toColumnSemanticId: "Sales.Purchase.amount",
          },
        ],
      },
    });
    assert.equal(withMap.classification, "destructive");
    assert.deepEqual(
      withMap.steps.map(({ kind }) => kind),
      ["renameTable", "renameColumn", "dropConstraint"],
    );
    assert.match(
      withMap.sql,
      /ALTER TABLE "public"\."sales__order" RENAME TO "sales__purchase";/,
    );
    assert.match(withMap.sql, /RENAME COLUMN "total" TO "amount";/);
  });

  it("classifies destructive and unsafe alterations conservatively", () => {
    const nextTable: PostgreSqlTable = {
      ...orderTable,
      columns: [
        { ...idColumn, type: "text" },
        {
          semanticId: "Sales.Order.note",
          name: "note",
          type: "text",
          nullable: true,
          defaultSql: null,
          generated: null,
          technical: false,
        },
      ],
      constraints: [],
      indexes: [
        {
          semanticId: "Sales.Order.note.index",
          name: "ix_sales_order_note",
          unique: false,
          columns: ["note"],
          where: null,
        },
      ],
    };
    const plan = createPostgreSqlMigrationPlan({
      previous: storage([orderTable]),
      next: storage([nextTable]),
    });

    assert.equal(plan.classification, "destructive");
    assert.deepEqual(
      plan.steps.map(({ kind }) => kind),
      [
        "dropConstraint",
        "addColumn",
        "alterColumnType",
        "createIndex",
        "dropColumn",
      ],
    );
    const createIndex = plan.steps.find(({ kind }) => kind === "createIndex");
    assert.ok(createIndex);
    assert.match(
      createIndex.sql,
      /^CREATE INDEX "ix_sales_order_note" ON "public"\."sales__order"/u,
    );
    assert.doesNotMatch(createIndex.sql, /"public"\."ix_sales_order_note"/u);
  });

  it("classifies every dropped database constraint as destructive", () => {
    const constraints: readonly PostgreSqlConstraint[] = [
      {
        semanticId: "Sales.Order.primaryKey",
        name: "pk_sales_order",
        kind: "primaryKey",
        columns: ["id"],
        expression: null,
        references: null,
      },
      {
        semanticId: "Sales.Order.reference.unique",
        name: "uq_sales_order_reference",
        kind: "unique",
        columns: ["id"],
        expression: null,
        references: null,
      },
      {
        semanticId: "Sales.Order.total.positive",
        name: "ck_sales_order_total_positive",
        kind: "check",
        columns: [],
        expression: '"total" > 0',
        references: null,
      },
      {
        semanticId: "Sales.Order.customer.foreignKey",
        name: "fk_sales_order_customer",
        kind: "foreignKey",
        columns: ["id"],
        expression: null,
        references: {
          table: "sales__customer",
          column: "id",
          onDelete: "NO ACTION",
          onUpdate: "NO ACTION",
        },
      },
    ];

    for (const constraint of constraints) {
      const previous = { ...orderTable, constraints: [constraint] };
      const next = { ...previous, constraints: [] };
      const plan = createPostgreSqlMigrationPlan({
        previous: storage([previous]),
        next: storage([next]),
      });

      assert.equal(plan.classification, "destructive", constraint.kind);
      assert.equal(plan.steps.length, 1, constraint.kind);
      assert.equal(plan.steps[0]?.kind, "dropConstraint", constraint.kind);
      assert.equal(
        plan.steps[0]?.classification,
        "destructive",
        constraint.kind,
      );
    }
  });

  it("drops an existing default before adding identity generation", () => {
    const counter: PostgreSqlColumn = {
      semanticId: "Sales.Order.counter",
      name: "counter",
      type: "bigint",
      nullable: false,
      defaultSql: "7::bigint",
      generated: null,
      technical: false,
    };
    const previous = {
      ...orderTable,
      columns: [...orderTable.columns, counter],
    };
    const next = {
      ...previous,
      columns: [
        ...orderTable.columns,
        { ...counter, defaultSql: null, generated: "identity" as const },
      ],
    };
    const plan = createPostgreSqlMigrationPlan({
      previous: storage([previous]),
      next: storage([next]),
    });

    assert.deepEqual(
      plan.steps.map(({ kind }) => kind),
      ["alterColumnGeneration"],
    );
    const sql = plan.steps[0]?.sql ?? "";
    assert.ok(sql.indexOf("DROP DEFAULT") < sql.indexOf("ADD GENERATED"));
  });

  it("rejects invalid rename maps instead of guessing", () => {
    assert.throws(
      () =>
        createPostgreSqlMigrationPlan({
          previous: storage([orderTable]),
          next: storage([orderTable]),
          renames: {
            tables: [
              { fromSemanticId: "Missing", toSemanticId: "Sales.Order" },
            ],
          },
        }),
      PostgreSqlMigrationPlanningError,
    );
  });

  it("rejects physical table and Column rename swaps", () => {
    const secondTable: PostgreSqlTable = {
      ...orderTable,
      semanticId: "Sales.Invoice",
      name: "sales__invoice",
      columns: orderTable.columns.map((column) => ({
        ...column,
        semanticId: `Sales.Invoice.${column.name}`,
      })),
    };
    const swappedTables = [
      { ...orderTable, semanticId: "Sales.Invoice", name: "sales__invoice" },
      { ...secondTable, semanticId: "Sales.Order", name: "sales__order" },
    ];
    assert.throws(
      () =>
        createPostgreSqlMigrationPlan({
          previous: storage([orderTable, secondTable]),
          next: storage(swappedTables),
          renames: {
            tables: [
              { fromSemanticId: "Sales.Order", toSemanticId: "Sales.Invoice" },
              { fromSemanticId: "Sales.Invoice", toSemanticId: "Sales.Order" },
            ],
          },
        }),
      PostgreSqlMigrationPlanningError,
    );

    const totalColumn = orderTable.columns[1];
    assert.ok(totalColumn);
    const renamedColumns: PostgreSqlTable = {
      ...orderTable,
      columns: [
        {
          ...idColumn,
          semanticId: "Sales.Order.total",
          name: "total",
        },
        { ...totalColumn, semanticId: "Sales.Order.id", name: "id" },
      ],
    };
    assert.throws(
      () =>
        createPostgreSqlMigrationPlan({
          previous: storage([orderTable]),
          next: storage([renamedColumns]),
          renames: {
            columns: [
              {
                fromTableSemanticId: "Sales.Order",
                toTableSemanticId: "Sales.Order",
                fromColumnSemanticId: "Sales.Order.id",
                toColumnSemanticId: "Sales.Order.total",
              },
              {
                fromTableSemanticId: "Sales.Order",
                toTableSemanticId: "Sales.Order",
                fromColumnSemanticId: "Sales.Order.total",
                toColumnSemanticId: "Sales.Order.id",
              },
            ],
          },
        }),
      PostgreSqlMigrationPlanningError,
    );
  });
});

describe("PostgreSQL migration application", () => {
  function destructivePlan(): PostgreSqlMigrationPlan {
    return createPostgreSqlMigrationPlan({
      previous: storage([orderTable]),
      next: storage([]),
    });
  }

  it("binds approval to the exact plan hash and risk", async () => {
    const plan = destructivePlan();
    const database = new RecordingDatabase();
    await assert.rejects(
      applyPostgreSqlMigrationPlan(database, plan),
      PostgreSqlMigrationApprovalError,
    );
    assert.equal(database.calls.length, 0);

    const approval = approvePostgreSqlMigrationPlan(plan, {
      classification: "destructive",
      reason: "The table was archived and deletion was reviewed.",
    });
    await assert.rejects(
      applyPostgreSqlMigrationPlan(
        database,
        {
          ...plan,
          hash: "0".repeat(64),
        },
        approval,
      ),
      PostgreSqlMigrationApprovalError,
    );
    assert.equal(database.calls.length, 0);
  });

  it("applies every statement and writes history in one transaction", async () => {
    const plan = createPostgreSqlMigrationPlan({
      previous: null,
      next: storage([orderTable]),
    });
    const database = new RecordingDatabase();
    const result = await applyPostgreSqlMigrationPlan(database, plan);

    assert.deepEqual(result, {
      status: "applied",
      planHash: plan.hash,
      appliedSteps: 1,
    });
    assert.equal(database.calls[0]?.sql, "BEGIN");
    assert.match(database.calls[1]?.sql ?? "", /pg_advisory_xact_lock/);
    assert.match(
      database.calls.map(({ sql }) => sql).join("\n"),
      /CREATE TABLE IF NOT EXISTS "public"\."__vane_migrations"/,
    );
    assert.match(
      database.calls.map(({ sql }) => sql).join("\n"),
      /INSERT INTO "public"\."__vane_migrations"/,
    );
    assert.equal(database.calls.at(-1)?.sql, "COMMIT");
    assert.equal(database.connectCount, 1);
    assert.equal(database.releaseCount, 1);
  });

  it("returns already-applied without executing plan statements", async () => {
    const plan = createPostgreSqlMigrationPlan({
      previous: null,
      next: storage([orderTable]),
    });
    const database = new RecordingDatabase();
    database.existingPlan = true;
    const result = await applyPostgreSqlMigrationPlan(database, plan);

    assert.equal(result.status, "already-applied");
    assert.equal(
      database.calls.some(({ sql }) => sql === plan.steps[0]?.sql),
      false,
    );
    assert.equal(database.calls.at(-1)?.sql, "COMMIT");
    assert.equal(database.releaseCount, 1);
  });

  it("rolls back statement failures and rejects divergent history", async () => {
    const plan = createPostgreSqlMigrationPlan({
      previous: null,
      next: storage([orderTable]),
    });
    const failing = new RecordingDatabase();
    failing.failOn = "sales__order";
    await assert.rejects(applyPostgreSqlMigrationPlan(failing, plan));
    assert.equal(failing.calls.at(-1)?.sql, "ROLLBACK");
    assert.equal(failing.releaseCount, 1);

    const divergent = new RecordingDatabase();
    divergent.head = "different-source";
    await assert.rejects(
      applyPostgreSqlMigrationPlan(divergent, plan),
      PostgreSqlMigrationHistoryError,
    );
    assert.equal(divergent.calls.at(-1)?.sql, "ROLLBACK");
  });

  it("does not touch the database for a no-op", async () => {
    const snapshot = storage([orderTable]);
    const plan = createPostgreSqlMigrationPlan({
      previous: snapshot,
      next: snapshot,
    });
    const database = new RecordingDatabase();
    const result = await applyPostgreSqlMigrationPlan(database, plan);
    assert.equal(result.status, "no-op");
    assert.equal(database.calls.length, 0);
  });
});
