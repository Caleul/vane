import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModuleDeclaration } from "../src/declaration.js";
import {
  compileModuleSource,
  compileSemanticIr,
  parseModuleSource,
  serializeSemanticIr,
} from "../src/index.js";

const inventory: ModuleDeclaration = {
  name: "Inventory",
  entities: [
    {
      name: "Stock",
      columns: [
        { name: "id", type: "uuid", identity: true },
        { name: "quantity", type: "integer" },
        { name: "capacity", type: "integer" },
        { name: "status", type: "string", default: "available" },
      ],
      rules: [
        {
          name: "FitsCapacity",
          expression: {
            kind: "comparison",
            operator: "lte",
            left: { kind: "column", column: "quantity" },
            right: { kind: "column", column: "capacity" },
          },
        },
      ],
      events: [
        {
          name: "Create",
          input: [
            { name: "id", type: "uuid" },
            { name: "quantity", type: "integer" },
            { name: "capacity", type: "integer" },
          ],
          operation: {
            kind: "create",
            values: [
              {
                column: "quantity",
                value: { kind: "input", input: "quantity" },
              },
              { column: "id", value: { kind: "input", input: "id" } },
              {
                column: "capacity",
                value: { kind: "input", input: "capacity" },
              },
            ],
          },
        },
        {
          name: "RemoveStock",
          input: [
            { name: "id", type: "uuid" },
            { name: "amount", type: "integer" },
          ],
          operation: {
            kind: "update",
            identity: { kind: "input", input: "id" },
            values: [
              {
                column: "quantity",
                value: {
                  kind: "arithmetic",
                  operator: "subtract",
                  left: { kind: "column", column: "quantity" },
                  right: { kind: "input", input: "amount" },
                },
              },
            ],
          },
        },
        {
          name: "Delete",
          input: [{ name: "id", type: "uuid" }],
          operation: {
            kind: "delete",
            identity: { kind: "input", input: "id" },
          },
        },
        {
          name: "Materialize",
          input: [
            { name: "id", type: "uuid" },
            { name: "quantity", type: "integer" },
            { name: "capacity", type: "integer" },
          ],
          operation: {
            kind: "upsert",
            identity: { kind: "input", input: "id" },
            values: [
              {
                column: "capacity",
                value: { kind: "input", input: "capacity" },
              },
              {
                column: "quantity",
                value: { kind: "input", input: "quantity" },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe("Entity Event semantic operations", () => {
  it("preserves closed owner operations in deterministic Semantic IR v6", () => {
    const result = compileSemanticIr(inventory);
    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.ir.version, 6);
    const operations = Object.fromEntries(
      (result.ir.module.entities[0]?.events ?? []).map((event) => [
        event.name,
        event.operation,
      ]),
    );
    assert.deepEqual(operations.RemoveStock, {
      kind: "update",
      identity: { kind: "input", input: "id" },
      values: [
        {
          column: "quantity",
          value: {
            kind: "arithmetic",
            operator: "subtract",
            left: { kind: "column", column: "quantity" },
            right: { kind: "input", input: "amount" },
          },
        },
      ],
    });
    assert.deepEqual(operations.Delete, {
      kind: "delete",
      identity: { kind: "input", input: "id" },
    });

    const reversed: ModuleDeclaration = {
      ...inventory,
      entities: inventory.entities.map((entity) => {
        const events = entity.events?.map((event) =>
          "values" in event.operation
            ? {
                ...event,
                operation: {
                  ...event.operation,
                  values: [...event.operation.values].reverse(),
                },
              }
            : event,
        );
        return { ...entity, ...(events ? { events } : {}) };
      }),
    };
    const reordered = compileSemanticIr(reversed);
    assert.equal(reordered.success, true);
    if (!reordered.success) return;
    assert.equal(
      serializeSemanticIr(result.ir),
      serializeSemanticIr(reordered.ir),
    );
  });

  it("parses every operation helper without executing user source", () => {
    const result = compileModuleSource({
      fileName: "inventory.vane.ts",
      sourceText: `
        import {
          Module, Entity, Column, Event, create, update, remove, upsert,
          input, literal, column, add, subtract
        } from "@lilka/vane";
        @Entity()
        class Stock {
          id = Column({ type: "uuid", identity: true });
          quantity = Column({ type: "integer" });
          capacity = Column({ type: "integer" });
          status = Column({ type: "string", default: "available" });
          Create = Event({
            input: { id: "uuid", quantity: "integer", capacity: "integer" },
            operation: create({
              id: input("id"), quantity: input("quantity"), capacity: input("capacity"),
              status: literal("available")
            }),
          });
          Add = Event({
            input: { id: "uuid", amount: "integer" },
            operation: update(input("id"), {
              quantity: add(column("quantity"), input("amount")),
              capacity: subtract(column("capacity"), literal(0)),
            }),
          });
          Delete = Event({ input: { id: "uuid" }, operation: remove(input("id")) });
          Materialize = Event({
            input: { id: "uuid", quantity: "integer", capacity: "integer" },
            operation: upsert(input("id"), {
              quantity: input("quantity"), capacity: input("capacity"),
            }),
          });
        }
        @Module({ entities: [Stock] }) class Inventory {}
        throw new Error("must not execute");
      `,
    });
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(
      result.ir.module.entities[0]?.events.find(({ name }) => name === "Delete")
        ?.operation.kind,
      "delete",
    );
  });

  it("requires an explicit static operation", () => {
    const result = parseModuleSource({
      fileName: "missing-operation.vane.ts",
      sourceText: `
        import { Module, Entity, Column, Event } from "@lilka/vane";
        @Entity() class Order {
          id = Column({ type: "uuid", identity: true });
          Place = Event({ input: { id: "uuid" } });
        }
        @Module({ entities: [Order] }) class Sales {}
      `,
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(
        ({ code }) => code === "VANE_PARSE_EVENT_OPERATION",
      ),
    );
  });

  it("rejects operations that escape owner, identity, generated or required boundaries", () => {
    const result = compileSemanticIr({
      name: "Invalid",
      entities: [
        {
          name: "Account",
          columns: [
            {
              name: "id",
              type: "uuid",
              identity: true,
              generated: "uuid",
            },
            { name: "balance", type: "decimal" },
            { name: "label", type: "string" },
          ],
          events: [
            {
              name: "Create",
              operation: {
                kind: "create",
                values: [
                  { column: "id", value: { kind: "literal", value: "forced" } },
                  { column: "missing", value: { kind: "literal", value: 1 } },
                  {
                    column: "balance",
                    value: { kind: "column", column: "balance" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    assert.equal(result.success, false);
    if (result.success) return;
    const codes = new Set(result.diagnostics.map(({ code }) => code));
    assert.ok(codes.has("VANE_SEM_EVENT_OPERATION_GENERATED"));
    assert.ok(codes.has("VANE_SEM_EVENT_OPERATION_COLUMN"));
    assert.ok(codes.has("VANE_SEM_EVENT_OPERATION_CURRENT"));
    assert.ok(codes.has("VANE_SEM_EVENT_OPERATION_REQUIRED"));
  });

  it("rejects incompatible, optional and non-numeric expressions", () => {
    const result = compileSemanticIr({
      name: "Invalid",
      entities: [
        {
          name: "Counter",
          columns: [
            { name: "id", type: "uuid", identity: true },
            { name: "value", type: "integer" },
          ],
          events: [
            {
              name: "Change",
              input: [
                { name: "id", type: "uuid", optional: true },
                { name: "label", type: "string" },
              ],
              operation: {
                kind: "update",
                identity: { kind: "input", input: "id" },
                values: [
                  {
                    column: "value",
                    value: {
                      kind: "arithmetic",
                      operator: "add",
                      left: { kind: "input", input: "label" },
                      right: { kind: "literal", value: 1 },
                    },
                  },
                ],
              },
            },
            {
              name: "WrongIdentity",
              input: [{ name: "id", type: "string" }],
              operation: {
                kind: "delete",
                identity: { kind: "input", input: "id" },
              },
            },
          ],
        },
      ],
    });
    assert.equal(result.success, false);
    if (result.success) return;
    const codes = new Set(result.diagnostics.map(({ code }) => code));
    assert.ok(codes.has("VANE_SEM_EVENT_OPERATION_OPTIONAL"));
    assert.ok(codes.has("VANE_SEM_EVENT_OPERATION_ARITHMETIC"));
    assert.ok(codes.has("VANE_SEM_EVENT_OPERATION_TYPE"));
  });

  it("rejects operation literals that deterministic JSON cannot preserve", () => {
    const result = compileSemanticIr({
      name: "Invalid",
      entities: [
        {
          name: "Measure",
          columns: [
            { name: "id", type: "uuid", identity: true },
            { name: "value", type: "decimal" },
          ],
          events: [
            {
              name: "Create",
              operation: {
                kind: "create",
                values: [
                  { column: "id", value: { kind: "literal", value: "id" } },
                  {
                    column: "value",
                    value: {
                      kind: "literal",
                      value: Number.POSITIVE_INFINITY,
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(
        ({ code }) => code === "VANE_SEM_EVENT_OPERATION_LITERAL",
      ),
    );
  });

  it("rejects dynamic or arbitrary operation expressions in the parser", () => {
    const result = parseModuleSource({
      fileName: "dynamic-operation.vane.ts",
      sourceText: `
        import { Module, Entity, Column, Event, create, input } from "@lilka/vane";
        const dynamic = input("id");
        @Entity() class Order {
          id = Column({ type: "uuid", identity: true });
          Place = Event({
            input: { id: "uuid" },
            operation: create({ id: dynamic }),
          });
        }
        @Module({ entities: [Order] }) class Sales {}
      `,
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(({ code }) => code === "VANE_PARSE_STATIC_VALUE"),
    );
  });
});
