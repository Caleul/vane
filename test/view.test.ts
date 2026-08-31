import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModuleDeclaration } from "../src/declaration.js";
import {
  compileModuleSource,
  compileSemanticIr,
  serializeSemanticIr,
} from "../src/index.js";

const moduleWithView: ModuleDeclaration = {
  name: "Sales",
  entities: [
    {
      name: "Order",
      columns: [
        { name: "id", type: "uuid", identity: true },
        { name: "customerId", type: "uuid" },
        { name: "total", type: "decimal" },
        { name: "createdAt", type: "datetime" },
      ],
    },
  ],
  views: [
    {
      name: "OrderDetails",
      input: [
        { name: "customerId", type: "uuid" },
        { name: "pageSize", type: "integer" },
      ],
      output: [
        {
          name: "id",
          expression: { kind: "column", entity: "Order", column: "id" },
        },
        {
          name: "total",
          expression: { kind: "column", entity: "Order", column: "total" },
        },
      ],
      query: {
        root: "Order",
        relations: [],
        where: {
          kind: "logical",
          operator: "and",
          operands: [
            {
              kind: "comparison",
              operator: "eq",
              left: { kind: "column", entity: "Order", column: "customerId" },
              right: { kind: "input", input: "customerId" },
            },
            {
              kind: "comparison",
              operator: "gt",
              left: { kind: "column", entity: "Order", column: "total" },
              right: { kind: "literal", value: 0 },
            },
          ],
        },
        orderBy: [
          {
            value: { entity: "Order", column: "createdAt" },
            direction: "desc",
          },
        ],
        pagination: {
          limit: { kind: "input", input: "pageSize" },
          offset: { kind: "literal", value: 0 },
        },
      },
    },
  ],
};

describe("View Semantic IR", () => {
  it("materializes a typed, non-persistent public View", () => {
    const result = compileSemanticIr(moduleWithView);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.ir.version, 5);
    assert.deepEqual(result.ir.module.views[0], {
      name: "OrderDetails",
      input: [
        { name: "customerId", type: "uuid", optional: false },
        { name: "pageSize", type: "integer", optional: false },
      ],
      output: [
        {
          name: "id",
          type: "uuid",
          nullable: false,
          expression: { kind: "column", entity: "Order", column: "id" },
        },
        {
          name: "total",
          type: "decimal",
          nullable: false,
          expression: { kind: "column", entity: "Order", column: "total" },
        },
      ],
      query: {
        root: "Order",
        relations: [],
        where: result.ir.module.views[0]?.query.where,
        orderBy: [
          {
            value: { entity: "Order", column: "createdAt" },
            direction: "desc",
          },
        ],
        pagination: {
          limit: { kind: "input", input: "pageSize" },
          offset: { kind: "literal", value: 0 },
        },
      },
      persistence: { allowed: false },
      publicResult: { kind: "view" },
    });
  });

  it("serializes equivalent View declaration orders byte-identically", () => {
    const view = moduleWithView.views?.[0];
    assert.ok(view);
    const reordered: ModuleDeclaration = {
      ...moduleWithView,
      views: [
        {
          ...view,
          input: [...view.input].reverse(),
          output: [...view.output].reverse(),
        },
      ],
    };
    const first = compileSemanticIr(moduleWithView);
    const second = compileSemanticIr(reordered);

    assert.equal(first.success, true);
    assert.equal(second.success, true);
    if (!first.success || !second.success) return;
    assert.equal(serializeSemanticIr(first.ir), serializeSemanticIr(second.ir));
  });

  it("derives types for aggregate-only Views", () => {
    const view = moduleWithView.views?.[0];
    assert.ok(view);
    const result = compileSemanticIr({
      ...moduleWithView,
      views: [
        {
          ...view,
          name: "OrderSummary",
          output: [
            {
              name: "orderCount",
              expression: {
                kind: "aggregate",
                function: "count",
                value: { entity: "Order", column: "id" },
              },
            },
            {
              name: "totalAmount",
              expression: {
                kind: "aggregate",
                function: "sum",
                value: { entity: "Order", column: "total" },
              },
            },
          ],
          query: { root: "Order" },
        },
      ],
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(
      result.ir.module.views[0]?.output.map(({ name, type, nullable }) => ({
        name,
        type,
        nullable,
      })),
      [
        { name: "orderCount", type: "integer", nullable: false },
        { name: "totalAmount", type: "decimal", nullable: true },
      ],
    );
  });

  it("preserves nullability in public View output contracts", () => {
    const view = moduleWithView.views?.[0];
    const entity = moduleWithView.entities[0];
    assert.ok(view);
    assert.ok(entity);
    const result = compileSemanticIr({
      ...moduleWithView,
      entities: [
        {
          ...entity,
          columns: entity.columns.map((column) =>
            column.name === "total" ? { ...column, nullable: true } : column,
          ),
        },
      ],
      views: [
        {
          ...view,
          output: [
            {
              name: "total",
              expression: { kind: "column", entity: "Order", column: "total" },
            },
          ],
        },
      ],
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.ir.module.views[0]?.output[0]?.nullable, true);
  });

  it("rejects aggregates whose grouping semantics would be ambiguous", () => {
    const view = moduleWithView.views?.[0];
    assert.ok(view);
    const result = compileSemanticIr({
      ...moduleWithView,
      views: [
        {
          ...view,
          output: [
            {
              name: "id",
              expression: { kind: "column", entity: "Order", column: "id" },
            },
            {
              name: "orderCount",
              expression: {
                kind: "aggregate",
                function: "count",
                value: { entity: "Order", column: "id" },
              },
            },
          ],
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["VANE_SEM_VIEW_AGGREGATE_MIX", "VANE_SEM_VIEW_AGGREGATE_ORDER"],
    );
  });

  it("rejects missing Columns instead of emitting a partial View", () => {
    const view = moduleWithView.views?.[0];
    assert.ok(view);
    const result = compileSemanticIr({
      ...moduleWithView,
      views: [
        {
          ...view,
          output: [
            {
              name: "missing",
              expression: {
                kind: "column",
                entity: "Order",
                column: "missing",
              },
            },
          ],
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(
      result.diagnostics.some(({ code }) => code === "VANE_SEM_VIEW_COLUMN"),
      true,
    );
  });

  it("rejects relation navigation until it has an explicit validated path", () => {
    const view = moduleWithView.views?.[0];
    assert.ok(view);
    const result = compileSemanticIr({
      ...moduleWithView,
      entities: [
        ...moduleWithView.entities,
        {
          name: "Customer",
          columns: [{ name: "id", type: "uuid", identity: true }],
        },
      ],
      views: [
        {
          ...view,
          output: [
            {
              name: "customerId",
              expression: {
                kind: "column",
                entity: "Customer",
                column: "id",
              },
            },
          ],
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(
      result.diagnostics.some(
        ({ code }) => code === "VANE_SEM_VIEW_ROOT_SCOPE",
      ),
      true,
    );
  });

  it("validates aggregate and pagination types", () => {
    const view = moduleWithView.views?.[0];
    assert.ok(view);
    const result = compileSemanticIr({
      ...moduleWithView,
      views: [
        {
          ...view,
          input: [
            { name: "customerId", type: "uuid" },
            { name: "pageSize", type: "string" },
          ],
          output: [
            {
              name: "invalidTotal",
              expression: {
                kind: "aggregate",
                function: "sum",
                value: { entity: "Order", column: "createdAt" },
              },
            },
          ],
          query: { ...view.query, orderBy: [] },
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["VANE_SEM_VIEW_AGGREGATE", "VANE_SEM_VIEW_PAGINATION_TYPE"],
    );
  });
});

describe("View source parser", () => {
  it("compiles a static @View declaration from TypeScript source", () => {
    const result = compileModuleSource({
      fileName: "order-details.vane.ts",
      sourceText: `
        import {
          Module, Entity, Column, type ColumnMember, View, optional, input, literal,
          eq, gt, and, desc
        } from "@lilka/vane";

        @Entity()
        class Order {
          @Column({ type: "uuid", identity: true }) id!: ColumnMember<string>;
          @Column({ type: "uuid" }) customerId!: ColumnMember<string>;
          @Column({ type: "decimal" }) total!: ColumnMember<number>;
          @Column({ type: "datetime" }) createdAt!: ColumnMember<Date>;
        }

        @View({
          input: {
            customerId: "uuid",
            pageSize: "integer",
            offset: optional("integer"),
          },
          output: {
            id: Order.id,
            total: Order.total,
          },
          query: {
            root: Order,
            where: and(
              eq(Order.customerId, input("customerId")),
              gt(Order.total, literal(0)),
            ),
            orderBy: [desc(Order.createdAt)],
            pagination: {
              limit: input("pageSize"),
              offset: input("offset"),
            },
          },
        })
        class OrderDetails {}

        @Module({ entities: [Order], views: [OrderDetails] })
        class Sales {}
      `,
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.ir.module.views[0]?.name, "OrderDetails");
    assert.deepEqual(
      result.ir.module.views[0]?.output.map(({ name, type, nullable }) => ({
        name,
        type,
        nullable,
      })),
      [
        { name: "id", type: "uuid", nullable: false },
        { name: "total", type: "decimal", nullable: false },
      ],
    );
  });

  it("rejects dynamic View queries without executing them", () => {
    const result = compileModuleSource({
      fileName: "dynamic-view.vane.ts",
      sourceText: `
        import { Module, Entity, Column, type ColumnMember, View } from "@lilka/vane";
        const dynamicQuery = loadQuery();
        @Entity()
        class Order {
          @Column({ type: "uuid", identity: true }) id!: ColumnMember<string>;
        }
        @View({ input: {}, output: { id: Order.id }, query: dynamicQuery })
        class OrderDetails {}
        @Module({ entities: [Order], views: [OrderDetails] }) class Sales {}
      `,
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(
      result.diagnostics.some(({ code }) => code === "VANE_PARSE_STATIC_VALUE"),
      true,
    );
  });

  it("rejects persistent or Event members inside a View", () => {
    const result = compileModuleSource({
      fileName: "persistent-view.vane.ts",
      sourceText: `
        import { Module, Entity, Column, type ColumnMember, View } from "@lilka/vane";
        @Entity()
        class Order {
          @Column({ type: "uuid", identity: true }) id!: ColumnMember<string>;
        }
        @View({ input: {}, output: { id: Order.id }, query: { root: Order } })
        class OrderDetails {
          @Column({ type: "string" }) forbidden!: ColumnMember<string>;
        }
        @Module({ entities: [Order], views: [OrderDetails] }) class Sales {}
      `,
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(
      result.diagnostics.some(
        ({ code }) => code === "VANE_PARSE_DECORATOR_TARGET",
      ),
      true,
    );
  });
});
