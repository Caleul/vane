import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type EntityDeclaration,
  type ModuleDeclaration,
  compileProjectSources,
  compileSemanticIr,
  compileSemanticProject,
  serializeSemanticProjectIr,
} from "../src/index.js";

const customer: EntityDeclaration = {
  name: "Customer",
  columns: [
    { name: "id", type: "uuid", identity: true, generated: "uuid" },
    { name: "name", type: "string", minLength: 1, maxLength: 120 },
  ],
  events: [{ name: "Register", input: [{ name: "name", type: "string" }] }],
};

const order: EntityDeclaration = {
  name: "Order",
  columns: [
    { name: "id", type: "uuid", identity: true, generated: "uuid" },
    {
      name: "customerId",
      type: "uuid",
      references: { entity: "Customer", column: "id" },
    },
    { name: "total", type: "decimal", minimum: 0, default: 0 },
  ],
};

describe("phase one completion gate", () => {
  it("preserves every Column constraint and terminal Event guarantee in IR v5", () => {
    const result = compileSemanticIr({ name: "CRM", entities: [customer] });
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.ir.module.entities[0]?.columns[1], {
      name: "name",
      type: "string",
      identity: false,
      nullable: false,
      unique: false,
      generated: null,
      minLength: 1,
      maxLength: 120,
      minimum: null,
      maximum: null,
      default: null,
      hasDefault: false,
      references: null,
    });
    assert.deepEqual(result.ir.module.entities[0]?.events[0]?.publicResult, {
      success: "viewOnly",
      fail: { code: "stable", message: "safe", correlationId: true },
    });
  });

  it("rejects contradictory Column constraints without partial IR", () => {
    const result = compileSemanticIr({
      name: "Invalid",
      entities: [
        {
          name: "Broken",
          columns: [
            {
              name: "id",
              type: "uuid",
              identity: true,
              nullable: true,
              generated: "increment",
              default: null,
              minLength: 5,
              maxLength: 2,
            },
            {
              name: "code",
              type: "string",
              minLength: 5,
              default: "x",
            },
            {
              name: "score",
              type: "integer",
              minimum: 0.5,
              maximum: 10,
              default: 12,
            },
          ],
        },
      ],
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal("ir" in result, false);
    assert.ok(
      result.diagnostics.filter(
        ({ code }) => code === "VANE_SEM_COLUMN_CONSTRAINT",
      ).length >= 7,
    );
  });

  it("composes explicit Module imports and resolves cross-Module references", () => {
    const core: ModuleDeclaration = { name: "Core", entities: [customer] };
    const sales: ModuleDeclaration = {
      name: "Sales",
      imports: ["Core"],
      entities: [order],
      views: [
        {
          name: "OrderCustomer",
          input: [],
          output: [
            {
              name: "customerName",
              expression: {
                kind: "column",
                entity: "Customer",
                column: "name",
              },
            },
          ],
          query: {
            root: "Order",
            relations: [
              {
                name: "customer",
                from: { entity: "Order", column: "customerId" },
                to: { entity: "Customer", column: "id" },
              },
            ],
          },
        },
      ],
    };
    const result = compileSemanticProject([sales, core]);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(
      result.ir.modules.map(({ name }) => name),
      ["Core", "Sales"],
    );
    assert.deepEqual(result.ir.modules[1]?.imports, ["Core"]);
    assert.deepEqual(
      result.ir.modules[1]?.entities.map(({ name }) => name),
      ["Order"],
    );
    assert.equal(result.ir.modules[1]?.views[0]?.output[0]?.type, "string");

    const reordered = compileSemanticProject([core, sales]);
    assert.equal(reordered.success, true);
    if (!reordered.success) return;
    assert.equal(
      serializeSemanticProjectIr(result.ir),
      serializeSemanticProjectIr(reordered.ir),
    );
  });

  it("rejects unknown, duplicate, self and cyclic Module imports", () => {
    const result = compileSemanticProject([
      { name: "A", imports: ["B", "B", "A", "Missing"], entities: [] },
      { name: "B", imports: ["A"], entities: [] },
    ]);
    assert.equal(result.success, false);
    if (result.success) return;
    const codes = new Set(result.diagnostics.map(({ code }) => code));
    assert.ok(codes.has("VANE_SEM_IMPORT_DUPLICATE"));
    assert.ok(codes.has("VANE_SEM_IMPORT_SELF"));
    assert.ok(codes.has("VANE_SEM_IMPORT_UNKNOWN"));
    assert.ok(codes.has("VANE_SEM_IMPORT_CYCLE"));
  });

  it("rejects an empty project", () => {
    const result = compileSemanticProject([]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.diagnostics[0]?.code, "VANE_SEM_PROJECT_EMPTY");
  });

  it("rejects same-named Sagas made visible by an import", () => {
    const saga = {
      name: "Process",
      input: [],
      steps: [],
      terminal: { step: "missing", view: "Missing" },
    } as const;
    const result = compileSemanticProject([
      { name: "Core", entities: [], sagas: [saga] },
      { name: "Application", imports: ["Core"], entities: [], sagas: [saga] },
    ]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(
        ({ code, path }) =>
          code === "VANE_SEM_DUPLICATE_NAME" && path.includes("sagas"),
      ),
    );
  });

  it("canonicalizes nested JSON defaults independently of object key order", () => {
    const first = compileSemanticIr({
      name: "Configuration",
      entities: [
        {
          name: "Profile",
          columns: [
            { name: "id", type: "uuid", identity: true },
            {
              name: "settings",
              type: "json",
              default: { z: 1, a: { y: true, b: null } },
            },
          ],
        },
      ],
    });
    const second = compileSemanticIr({
      name: "Configuration",
      entities: [
        {
          name: "Profile",
          columns: [
            { name: "id", type: "uuid", identity: true },
            {
              name: "settings",
              type: "json",
              default: { a: { b: null, y: true }, z: 1 },
            },
          ],
        },
      ],
    });
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    if (!first.success || !second.success) return;
    assert.deepEqual(first.ir, second.ir);
  });

  it("rejects non-finite numbers anywhere in a JSON default", () => {
    const declarationResult = compileSemanticIr({
      name: "Configuration",
      entities: [
        {
          name: "Profile",
          columns: [
            { name: "id", type: "uuid", identity: true },
            {
              name: "settings",
              type: "json",
              default: { nested: [1, Number.POSITIVE_INFINITY] },
            },
          ],
        },
      ],
    });
    assert.equal(declarationResult.success, false);
    if (declarationResult.success) return;
    assert.ok(
      declarationResult.diagnostics.some(
        ({ code, path }) =>
          code === "VANE_SEM_COLUMN_CONSTRAINT" &&
          path.slice(-2).join(".") === "nested.1",
      ),
    );

    const sourceResult = compileProjectSources([
      {
        fileName: "configuration.vane.ts",
        sourceText: `
          import { Module, Entity, Column } from "@lilka/vane";
          @Entity() class Profile {
            @Column({ type: "uuid", identity: true }) id!: string;
            @Column({ type: "json", default: { nested: 1e400 } }) settings!: unknown;
          }
          @Module({ entities: [Profile] }) class Configuration {}
        `,
      },
    ]);
    assert.equal(sourceResult.success, false);
    if (sourceResult.success) return;
    assert.ok(
      sourceResult.diagnostics.some(
        ({ code }) => code === "VANE_SEM_COLUMN_CONSTRAINT",
      ),
    );
  });

  it("requires project context when a single Module declares imports", () => {
    const result = compileSemanticIr({
      name: "Sales",
      imports: ["Core"],
      entities: [],
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.diagnostics[0]?.code, "VANE_SEM_IMPORT_CONTEXT");
  });

  it("parses multiple files and the typed helper grammar without execution", () => {
    const result = compileProjectSources([
      {
        fileName: "core.vane.ts",
        sourceText: `
          import { Module, Entity, Column } from "@lilka/vane";
          @Entity() class Customer {
            @Column({ type: "uuid", identity: true }) id!: string;
            @Column({ type: "json", default: { source: "test", flags: ["safe"] } }) metadata!: unknown;
          }
          @Module({ entities: [Customer] }) class Core {}
          throw new Error("must not execute");
        `,
      },
      {
        fileName: "sales.vane.ts",
        sourceText: `
          import { Module, Entity, Column, reference } from "@lilka/vane";
          import { Core as Foundation, Customer as Client } from "./core.vane.js";
          @Entity() class Order {
            @Column({ type: "uuid", identity: true }) id!: string;
            @Column({ type: "uuid", references: reference(Client, "id") }) customerId!: string;
          }
          @Module({ imports: [Foundation], entities: [Order] }) class Sales {}
        `,
      },
    ]);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(
      result.ir.modules.map(({ name }) => name),
      ["Core", "Sales"],
    );
  });

  it("parses typed Column, relation and Saga references end to end", () => {
    const result = compileProjectSources([
      {
        fileName: "commerce.vane.ts",
        sourceText: `
          import {
            Module, Entity, Column, Event, View, Saga,
            field, reference, relation, event, eventRef
          } from "@lilka/vane";
          @Entity() class Customer {
            @Column({ type: "uuid", identity: true }) id!: string;
            @Column({ type: "string", minLength: 1, maxLength: 120 }) name!: string;
          }
          @Entity() class Order {
            @Column({ type: "uuid", identity: true }) id!: string;
            @Column({ type: "uuid", references: reference(Customer, "id") }) customerId!: string;
            @Event() Place() {}
            @Event() Cancel() {}
          }
          @View({
            input: {},
            output: { customerName: field(Customer, "name") },
            query: {
              root: Order,
              relations: {
                customer: relation(field(Order, "customerId"), field(Customer, "id")),
              },
            },
          }) class Receipt {}
          @Saga({
            steps: {
              place: event(Order, "Place", {
                compensateWith: eventRef(Order, "Cancel"),
              }),
            },
            terminal: { step: "place", view: Receipt },
          }) class PlaceOrder {}
          @Module({
            entities: [Customer, Order],
            views: [Receipt],
            sagas: [PlaceOrder],
          }) class Commerce {}
        `,
      },
    ]);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(
      result.ir.modules[0]?.views[0]?.query.relations[0]?.name,
      "customer",
    );
    assert.equal(
      result.ir.modules[0]?.sagas[0]?.steps[0]?.event.event,
      "Place",
    );
  });

  it("rejects a View relation that does not follow a declared reference", () => {
    const result = compileSemanticIr({
      name: "Commerce",
      entities: [
        customer,
        {
          ...order,
          columns: order.columns.map(
            ({ references: _references, ...column }) => column,
          ),
        },
      ],
      views: [
        {
          name: "InvalidJoin",
          input: [],
          output: [
            {
              name: "name",
              expression: {
                kind: "column",
                entity: "Customer",
                column: "name",
              },
            },
          ],
          query: {
            root: "Order",
            relations: [
              {
                name: "customer",
                from: { entity: "Order", column: "customerId" },
                to: { entity: "Customer", column: "id" },
              },
            ],
          },
        },
      ],
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(
        ({ code }) => code === "VANE_SEM_VIEW_RELATION_REFERENCE",
      ),
    );
  });

  it("rejects multiple relation paths to the same Entity identity", () => {
    const result = compileSemanticIr({
      name: "Commerce",
      entities: [
        customer,
        {
          name: "Order",
          columns: [
            { name: "id", type: "uuid", identity: true },
            {
              name: "billingId",
              type: "uuid",
              references: { entity: "Customer", column: "id" },
            },
            {
              name: "shippingId",
              type: "uuid",
              references: { entity: "Customer", column: "id" },
            },
          ],
        },
      ],
      views: [
        {
          name: "Addresses",
          input: [],
          output: [
            {
              name: "customerName",
              expression: {
                kind: "column",
                entity: "Customer",
                column: "name",
              },
            },
          ],
          query: {
            root: "Order",
            relations: [
              {
                name: "billing",
                from: { entity: "Order", column: "billingId" },
                to: { entity: "Customer", column: "id" },
              },
              {
                name: "shipping",
                from: { entity: "Order", column: "shippingId" },
                to: { entity: "Customer", column: "id" },
              },
            ],
          },
        },
      ],
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(
        ({ code }) => code === "VANE_SEM_VIEW_RELATION_AMBIGUOUS",
      ),
    );
  });
});
