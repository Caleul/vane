import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ColumnType } from "../src/declaration.js";
import {
  fitPostgreSqlIdentifier,
  quotePostgreSqlIdentifier,
  toPostgreSqlIdentifier,
} from "../src/postgresql/identifiers.js";
import { materializePostgreSql } from "../src/postgresql/materializer.js";
import { renderPostgreSqlSchema } from "../src/postgresql/renderer.js";
import { serializePostgreSqlStorageIr } from "../src/postgresql/storage-ir.js";
import type {
  SemanticColumn,
  SemanticEntity,
  SemanticModule,
  SemanticProjectIr,
} from "../src/semantic-ir.js";
import { SEMANTIC_PROJECT_IR_VERSION } from "../src/semantic-ir.js";

const noDefault = null;

function column(
  name: string,
  type: ColumnType,
  options: Partial<SemanticColumn> = {},
): SemanticColumn {
  return {
    name,
    type,
    identity: false,
    nullable: false,
    unique: false,
    generated: null,
    minLength: null,
    maxLength: null,
    minimum: null,
    maximum: null,
    default: noDefault,
    hasDefault: false,
    references: null,
    ...options,
  };
}

function entity(
  name: string,
  columns: readonly SemanticColumn[],
  extra: Partial<SemanticEntity> = {},
): SemanticEntity {
  return {
    name,
    identityColumn: "id",
    columns,
    rules: [],
    events: [],
    ...extra,
  };
}

function module(
  name: string,
  entities: readonly SemanticEntity[],
  imports: readonly string[] = [],
): SemanticModule {
  return {
    name,
    imports,
    entities,
    views: [],
    antiCorruptionLayers: [],
    sagas: [],
  };
}

function project(modules: readonly SemanticModule[]): SemanticProjectIr {
  return {
    schema: "vane.semantic-project-ir",
    version: SEMANTIC_PROJECT_IR_VERSION,
    modules,
  };
}

const customer = entity("Customer", [
  column("id", "uuid", {
    identity: true,
    generated: "uuid",
  }),
  column("externalCode", "string", { unique: true, maxLength: 32 }),
]);

const order = entity(
  "Order",
  [
    column("id", "integer", {
      identity: true,
      generated: "increment",
    }),
    column("customerId", "uuid", {
      references: { entity: "Customer", column: "id" },
    }),
    column("description", "string", {
      minLength: 1,
      maxLength: 120,
      default: "new order",
      hasDefault: true,
    }),
    column("total", "decimal", { minimum: 0, maximum: 9999.5 }),
    column("paid", "boolean", { default: false, hasDefault: true }),
    column("startDate", "date"),
    column("endDate", "date", { nullable: true }),
    column("createdAt", "datetime"),
    column("publicId", "uuid", { generated: "uuid", unique: true }),
    column("metadata", "json", {
      default: { channel: "web" },
      hasDefault: true,
    }),
  ],
  {
    rules: [
      {
        name: "EndAfterStart",
        columns: ["endDate", "startDate"],
        expression: {
          kind: "comparison",
          operator: "gt",
          left: { kind: "column", column: "endDate" },
          right: { kind: "column", column: "startDate" },
        },
      },
    ],
  },
);

describe("PostgreSQL materializer", () => {
  it("materializes all eight types, constraints, Rules, FKs and technical tables", () => {
    const result = materializePostgreSql(
      project([module("Core", [customer]), module("Sales", [order], ["Core"])]),
      { namespace: "application", targetVersion: 16 },
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    const sales = result.ir.tables.find(
      ({ semanticId }) => semanticId === "Sales.Order",
    );
    assert.ok(sales);
    assert.deepEqual(
      Object.fromEntries(
        sales.columns
          .filter(({ technical }) => !technical)
          .map(({ semanticId, type }) => [semanticId.split(".").at(-1), type]),
      ),
      {
        createdAt: "timestamptz",
        customerId: "uuid",
        description: "text",
        endDate: "date",
        id: "bigint",
        metadata: "jsonb",
        paid: "boolean",
        publicId: "uuid",
        startDate: "date",
        total: "numeric",
      },
    );
    assert.deepEqual(
      sales.columns
        .filter(({ technical }) => technical)
        .map(({ name }) => name),
      ["__vane_created_at", "__vane_revision", "__vane_updated_at"],
    );
    assert.ok(sales.constraints.some(({ kind }) => kind === "primaryKey"));
    assert.ok(sales.constraints.some(({ kind }) => kind === "foreignKey"));
    assert.ok(
      sales.constraints.some(
        ({ semanticId, expression }) =>
          semanticId === "Sales.Order.rule.EndAfterStart" &&
          expression === '("end_date" > "start_date")',
      ),
    );
    assert.deepEqual(
      result.ir.tables
        .filter(({ technical }) => technical)
        .map(({ name }) => name),
      [
        "__vane_failures",
        "__vane_mailbox",
        "__vane_migrations",
        "__vane_outbox",
        "__vane_sagas",
      ],
    );
  });

  it("renders quoted, executable-order DDL with FKs after all tables", () => {
    const result = materializePostgreSql(
      project([module("Core", [customer]), module("Sales", [order], ["Core"])]),
      { namespace: 'select"schema', targetVersion: 16 },
    );
    assert.equal(result.success, true);
    if (!result.success) return;
    const sql = renderPostgreSqlSchema(result.ir);

    assert.match(sql, /CREATE SCHEMA IF NOT EXISTS "select""schema";/);
    assert.match(sql, /"description" text DEFAULT 'new order'::text NOT NULL/);
    assert.match(sql, /"metadata" jsonb DEFAULT '\{"channel":"web"\}'::jsonb/);
    assert.match(sql, /GENERATED BY DEFAULT AS IDENTITY/);
    assert.match(sql, /CHECK \(\("end_date" > "start_date"\)\)/);
    assert.ok(
      sql.indexOf('CREATE TABLE "select""schema"."core__customer"') <
        sql.indexOf("FOREIGN KEY"),
    );
    assert.ok(
      sql.indexOf('CREATE TABLE "select""schema"."sales__order"') <
        sql.indexOf("FOREIGN KEY"),
    );
  });

  it("is byte deterministic for equivalent array order", () => {
    const first = project([
      module("Core", [customer]),
      module("Sales", [order], ["Core"]),
    ]);
    const reorderedOrder: SemanticEntity = {
      ...order,
      columns: [...order.columns].reverse(),
      rules: [...order.rules].reverse(),
    };
    const second = project([
      module("Sales", [reorderedOrder], ["Core"]),
      module("Core", [customer]),
    ]);
    const left = materializePostgreSql(first, {
      namespace: "public",
      targetVersion: 16,
    });
    const right = materializePostgreSql(second, {
      namespace: "public",
      targetVersion: 16,
    });
    assert.equal(left.success, true);
    assert.equal(right.success, true);
    if (!left.success || !right.success) return;
    assert.equal(
      serializePostgreSqlStorageIr(left.ir),
      serializePostgreSqlStorageIr(right.ir),
    );
    assert.equal(
      renderPostgreSqlSchema(left.ir),
      renderPostgreSqlSchema(right.ir),
    );
  });

  it("rejects provider-incompatible Rules without returning partial IR", () => {
    const invalid = entity(
      "Feature",
      [
        column("id", "uuid", { identity: true }),
        column("enabled", "boolean"),
        column("archived", "boolean"),
      ],
      {
        rules: [
          {
            name: "BooleanOrdering",
            columns: ["archived", "enabled"],
            expression: {
              kind: "comparison",
              operator: "gt",
              left: { kind: "column", column: "enabled" },
              right: { kind: "column", column: "archived" },
            },
          },
        ],
      },
    );
    const result = materializePostgreSql(project([module("Core", [invalid])]), {
      namespace: "public",
      targetVersion: 16,
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal("ir" in result, false);
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["VANE_PG_RULE_TYPE"],
    );
  });

  it("rejects a foreign key whose PostgreSQL target is not unique", () => {
    const target = entity("Target", [
      column("id", "uuid", { identity: true }),
      column("code", "string"),
    ]);
    const source = entity("Source", [
      column("id", "uuid", { identity: true }),
      column("targetCode", "string", {
        references: { entity: "Target", column: "code" },
      }),
    ]);
    const result = materializePostgreSql(
      project([module("Core", [target, source])]),
      { namespace: "public", targetVersion: 16 },
    );
    assert.equal(result.success, false);
    if (result.success) return;
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["VANE_PG_REFERENCE_UNIQUE"],
    );
  });

  it("validates configuration before exposing Storage IR", () => {
    const result = materializePostgreSql(
      project([module("Core", [customer])]),
      {
        namespace: "x".repeat(64),
        targetVersion: 15,
      },
    );
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal("ir" in result, false);
    assert.deepEqual(
      new Set(result.diagnostics.map(({ code }) => code)),
      new Set(["VANE_PG_NAMESPACE", "VANE_PG_VERSION"]),
    );
  });

  it("rejects an unsupported Semantic Project IR schema or version", () => {
    const unsupported = materializePostgreSql(
      {
        ...project([]),
        version: 999,
      } as unknown as SemanticProjectIr,
      { namespace: "public", targetVersion: 16 },
    );

    assert.equal(unsupported.success, false);
    assert.ok(
      unsupported.diagnostics.some(
        ({ code }) => code === "VANE_PG_SEMANTIC_IR_VERSION",
      ),
    );
  });

  it("rejects PostgreSQL-incompatible persistent Event literals", () => {
    const literalEntity = entity(
      "Literal",
      [
        column("id", "uuid", { identity: true }),
        column("due", "date"),
        column("occurredAt", "datetime"),
        column("label", "string"),
      ],
      {
        events: [
          {
            identity: "Literal.Create",
            name: "Create",
            owner: { kind: "entity", entity: "Literal" },
            persistence: { target: "owner", required: true },
            input: [],
            operation: {
              kind: "create",
              values: [
                {
                  column: "id",
                  value: { kind: "literal", value: "not-a-uuid" },
                },
                {
                  column: "due",
                  value: { kind: "literal", value: "2023-02-29" },
                },
                {
                  column: "occurredAt",
                  value: {
                    kind: "literal",
                    value: "2023-02-29T00:00:00Z",
                  },
                },
                {
                  column: "label",
                  value: {
                    kind: "literal",
                    value: `invalid${String.fromCharCode(0xd800)}`,
                  },
                },
              ],
            },
            publicResult: {
              success: "viewOnly",
              fail: { code: "stable", message: "safe", correlationId: true },
            },
          },
        ],
      },
    );

    const result = materializePostgreSql(
      project([module("Core", [literalEntity])]),
      { namespace: "public", targetVersion: 16 },
    );
    assert.equal(result.success, false);
    assert.equal(
      result.diagnostics.filter(({ code }) => code === "VANE_PG_EVENT_LITERAL")
        .length,
      4,
    );
  });

  it("accepts low Gregorian years and leap dates in persistent literals", () => {
    const temporal = entity(
      "Temporal",
      [
        column("id", "uuid", { identity: true }),
        column("due", "date"),
        column("occurredAt", "datetime"),
      ],
      {
        events: [
          {
            identity: "Temporal.Create",
            name: "Create",
            owner: { kind: "entity", entity: "Temporal" },
            persistence: { target: "owner", required: true },
            input: [],
            operation: {
              kind: "create",
              values: [
                {
                  column: "id",
                  value: {
                    kind: "literal",
                    value: "10000000-0000-4000-8000-000000000001",
                  },
                },
                {
                  column: "due",
                  value: { kind: "literal", value: "0099-02-28" },
                },
                {
                  column: "occurredAt",
                  value: {
                    kind: "literal",
                    value: "0096-02-29T00:00:00Z",
                  },
                },
              ],
            },
            publicResult: {
              success: "viewOnly",
              fail: { code: "stable", message: "safe", correlationId: true },
            },
          },
        ],
      },
    );

    const result = materializePostgreSql(
      project([module("Core", [temporal])]),
      { namespace: "public", targetVersion: 16 },
    );
    assert.equal(result.success, true);
  });

  it("rejects normalized physical identifier collisions", () => {
    const first = entity("URL", [column("id", "uuid", { identity: true })]);
    const second = entity("Url", [column("id", "uuid", { identity: true })]);
    const result = materializePostgreSql(
      project([module("Core", [first, second])]),
      { namespace: "public", targetVersion: 16 },
    );
    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(
        ({ code }) => code === "VANE_PG_IDENTIFIER_COLLISION",
      ),
    );
  });

  it("rejects defaults that PostgreSQL cannot cast", () => {
    const invalid = entity("Invalid", [
      column("id", "uuid", { identity: true }),
      column("externalId", "uuid", {
        default: "not-a-uuid",
        hasDefault: true,
      }),
    ]);
    const result = materializePostgreSql(project([module("Core", [invalid])]), {
      namespace: "public",
      targetVersion: 16,
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(({ code }) => code === "VANE_PG_COLUMN_DEFAULT"),
    );
  });
});

describe("PostgreSQL identifiers", () => {
  it("quotes reserved words and embedded quotes", () => {
    assert.equal(quotePostgreSqlIdentifier('select"value'), '"select""value"');
  });

  it("fits deterministically within PostgreSQL's 63-byte limit", () => {
    const source = "EntityWithAnExtremelyLongName".repeat(4);
    const first = fitPostgreSqlIdentifier(source);
    const second = fitPostgreSqlIdentifier(source);
    assert.equal(first, second);
    assert.ok(Buffer.byteLength(first, "utf8") <= 63);
    assert.notEqual(
      toPostgreSqlIdentifier([`${source}A`]),
      toPostgreSqlIdentifier([`${source}B`]),
    );
  });
});
