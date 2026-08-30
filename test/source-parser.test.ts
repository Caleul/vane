import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compileModuleSource,
  parseModuleSource,
  serializeSemanticIr,
} from "../src/index.js";

const validSource = `
import {
  Module,
  Entity,
  Column,
  Rule,
  Event,
  column,
  gt,
  optional,
} from "@lilka/vane";

@Entity()
class Subscription {
  @Column({ type: "uuid", identity: true, generated: "uuid" })
  id!: string;

  @Column({ type: "date" })
  startDate!: Date;

  @Column({ type: "date" })
  endDate!: Date;

  @Rule({ expression: gt(column("endDate"), column("startDate")) })
  EndsAfterStart() {}

  @Event({
    input: {
      startDate: "date",
      endDate: "date",
      couponCode: optional("string"),
    },
  })
  CreateSubscription() {}
}

@Module({ entities: [Subscription] })
class Sales {}
`;

describe("parseModuleSource", () => {
  it("turns the provisional decorator grammar into a ModuleDeclaration", () => {
    const result = parseModuleSource({
      fileName: "sales.vane.ts",
      sourceText: validSource,
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.declaration, {
      name: "Sales",
      entities: [
        {
          name: "Subscription",
          columns: [
            {
              name: "id",
              type: "uuid",
              identity: true,
              generated: "uuid",
            },
            { name: "startDate", type: "date" },
            { name: "endDate", type: "date" },
          ],
          rules: [
            {
              name: "EndsAfterStart",
              expression: {
                kind: "comparison",
                operator: "gt",
                left: { kind: "column", column: "endDate" },
                right: { kind: "column", column: "startDate" },
              },
            },
          ],
          events: [
            {
              name: "CreateSubscription",
              input: [
                { name: "startDate", type: "date" },
                { name: "endDate", type: "date" },
                { name: "couponCode", type: "string", optional: true },
              ],
            },
          ],
        },
      ],
    });
  });

  it("never executes top-level user code", () => {
    const result = parseModuleSource({
      fileName: "safe.vane.ts",
      sourceText: `${validSource}\nthrow new Error("the parser executed user code");`,
    });

    assert.equal(result.success, true);
  });

  it("resolves aliases from named Vane imports", () => {
    const result = parseModuleSource({
      fileName: "alias.vane.ts",
      sourceText: `
        import { Module as M, Entity as E, Column as C } from "@lilka/vane";
        @E()
        class Customer {
          @C({ type: "uuid", identity: true }) id!: string;
        }
        @M({ entities: [Customer] })
        class CRM {}
      `,
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.declaration.name, "CRM");
    assert.equal(result.declaration.entities[0]?.name, "Customer");
  });

  it("parses static Entity references and composed Rule expressions", () => {
    const result = parseModuleSource({
      fileName: "orders.vane.ts",
      sourceText: `
        import {
          Module, Entity, Column, Rule, column, literal, eq, gte, and, not
        } from "@lilka/vane";
        @Entity()
        class Customer {
          @Column({ type: "uuid", identity: true }) id!: string;
        }
        @Entity()
        class Order {
          @Column({ type: "uuid", identity: true }) id!: string;
          @Column({ type: "uuid", references: Customer.id }) customerId!: string;
          @Column({ type: "decimal" }) minimum!: number;
          @Column({ type: "decimal" }) total!: number;
          @Rule({
            expression: and(
              gte(column("total"), column("minimum")),
              not(eq(column("id"), literal(null))),
            ),
          })
          ValidTotal() {}
        }
        @Module({ entities: [Customer, Order] }) class Sales {}
      `,
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    const order = result.declaration.entities.find(
      ({ name }) => name === "Order",
    );
    assert.deepEqual(order?.columns[1]?.references, {
      entity: "Customer",
      column: "id",
    });
    assert.equal(order?.rules?.[0]?.expression.kind, "logical");
  });

  it("rejects dynamic decorator values and points to their source", () => {
    const result = parseModuleSource({
      fileName: "dynamic.vane.ts",
      sourceText: `
        import { Module, Entity, Column } from "@lilka/vane";
        const columnOptions = { type: "uuid", identity: true };
        @Entity()
        class Customer {
          @Column(columnOptions) id!: string;
        }
        @Module({ entities: [Customer] })
        class CRM {}
      `,
    });

    assert.equal(result.success, false);
    if (result.success) return;
    const diagnostic = result.diagnostics.find(
      ({ code }) => code === "VANE_PARSE_STATIC_VALUE",
    );
    assert.ok(diagnostic);
    assert.equal(diagnostic.location?.fileName, "dynamic.vane.ts");
    assert.equal(diagnostic.location?.start.line, 6);
    assert.match(diagnostic.message, /executing user code/);
  });

  it("rejects unknown options instead of silently accepting typos", () => {
    const result = parseModuleSource({
      fileName: "typo.vane.ts",
      sourceText: validSource.replace(
        'type: "uuid"',
        'typo: "uuid", type: "uuid"',
      ),
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(
      result.diagnostics.some(({ code }) => code === "VANE_PARSE_OPTION"),
      true,
    );
  });

  it("reports TypeScript syntax errors with a location", () => {
    const result = parseModuleSource({
      fileName: "broken.vane.ts",
      sourceText: `import { Module } from "@lilka/vane";\n@Module({ entities: [] })\nclass Broken {`,
    });

    assert.equal(result.success, false);
    if (result.success) return;
    const diagnostic = result.diagnostics.find(
      ({ code }) => code === "VANE_PARSE_SYNTAX",
    );
    assert.ok(diagnostic?.location);
    assert.equal(diagnostic.location.fileName, "broken.vane.ts");
  });
});

describe("compileModuleSource", () => {
  it("feeds parsed source into the deterministic Semantic IR compiler", () => {
    const first = compileModuleSource({
      fileName: "sales.vane.ts",
      sourceText: validSource,
    });
    const second = compileModuleSource({
      fileName: "sales-copy.vane.ts",
      sourceText: validSource,
    });

    assert.equal(first.success, true);
    assert.equal(second.success, true);
    if (!first.success || !second.success) return;
    assert.equal(serializeSemanticIr(first.ir), serializeSemanticIr(second.ir));
    assert.equal(
      first.ir.module.entities[0]?.events[0]?.identity,
      "Subscription.CreateSubscription",
    );
  });

  it("preserves semantic validation after parsing", () => {
    const result = compileModuleSource({
      fileName: "rule.vane.ts",
      sourceText: `
        import { Module, Entity, Column, Rule, column, literal, gt } from "@lilka/vane";
        @Entity()
        class Order {
          @Column({ type: "uuid", identity: true }) id!: string;
          @Column({ type: "decimal" }) total!: number;
          @Rule({ expression: gt(column("total"), literal(0)) }) PositiveTotal() {}
        }
        @Module({ entities: [Order] }) class Sales {}
      `,
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["VANE_SEM_RULE_ARITY"],
    );
    assert.equal(result.diagnostics[0]?.location?.fileName, "rule.vane.ts");
    assert.equal(result.diagnostics[0]?.location?.start.line, 7);
  });
});
