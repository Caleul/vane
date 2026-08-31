import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModuleDeclaration } from "../src/declaration.js";
import { compileSemanticIr, serializeSemanticIr } from "../src/index.js";

const salesModule: ModuleDeclaration = {
  name: "Sales",
  entities: [
    {
      name: "Subscription",
      columns: [
        { name: "endDate", type: "date" },
        { name: "id", type: "uuid", identity: true, generated: "uuid" },
        { name: "startDate", type: "date" },
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
          ],
          operation: {
            kind: "create",
            values: [
              {
                column: "startDate",
                value: { kind: "input", input: "startDate" },
              },
              {
                column: "endDate",
                value: { kind: "input", input: "endDate" },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe("compileSemanticIr", () => {
  it("materializes Entity ownership and mandatory persistence in the Semantic IR", () => {
    const result = compileSemanticIr(salesModule);

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.ir.schema, "vane.semantic-ir");
    assert.equal(result.ir.version, 6);
    assert.equal(result.ir.module.entities[0]?.identityColumn, "id");
    assert.deepEqual(result.ir.module.entities[0]?.events[0], {
      identity: "Subscription.CreateSubscription",
      name: "CreateSubscription",
      owner: { kind: "entity", entity: "Subscription" },
      persistence: { target: "owner", required: true },
      input: [
        { name: "endDate", type: "date", optional: false },
        { name: "startDate", type: "date", optional: false },
      ],
      operation: {
        kind: "create",
        values: [
          {
            column: "endDate",
            value: { kind: "input", input: "endDate" },
          },
          {
            column: "startDate",
            value: { kind: "input", input: "startDate" },
          },
        ],
      },
      publicResult: {
        success: "viewOnly",
        fail: { code: "stable", message: "safe", correlationId: true },
      },
    });
  });

  it("serializes equivalent declaration orders byte-identically", () => {
    const sourceExpression = salesModule.entities[0]?.rules?.[0]?.expression;
    assert.equal(sourceExpression?.kind, "comparison");
    if (!sourceExpression || sourceExpression.kind !== "comparison") return;

    const reordered: ModuleDeclaration = {
      ...salesModule,
      entities: salesModule.entities.map((entity) => {
        const events = entity.events?.map((event) => ({
          ...event,
          input: [...(event.input ?? [])].reverse(),
        }));

        return {
          ...entity,
          columns: [...entity.columns].reverse(),
          ...(events ? { events } : {}),
          rules: [
            {
              name: "EndsAfterStart",
              expression: {
                right: { column: "startDate", kind: "column" },
                left: { column: "endDate", kind: "column" },
                operator: "gt",
                kind: "comparison",
              },
            },
          ],
        };
      }),
    };

    const first = compileSemanticIr(salesModule);
    const second = compileSemanticIr(reordered);
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    if (!first.success || !second.success) return;

    assert.equal(serializeSemanticIr(first.ir), serializeSemanticIr(second.ir));
  });

  it("rejects a Rule that belongs in a single Column", () => {
    const result = compileSemanticIr({
      name: "Sales",
      entities: [
        {
          name: "Order",
          columns: [
            { name: "id", type: "uuid", identity: true },
            { name: "total", type: "decimal" },
          ],
          rules: [
            {
              name: "PositiveTotal",
              expression: {
                kind: "comparison",
                operator: "gt",
                left: { kind: "column", column: "total" },
                right: { kind: "literal", value: 0 },
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
      ["VANE_SEM_RULE_ARITY"],
    );
  });

  it("returns diagnostics instead of a partial IR", () => {
    const result = compileSemanticIr({
      name: "Sales",
      entities: [
        {
          name: "Order",
          columns: [{ name: "number", type: "string" }],
          events: [
            { name: "CreateOrder", operation: { kind: "create", values: [] } },
            { name: "CreateOrder", operation: { kind: "create", values: [] } },
          ],
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal("ir" in result, false);
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["VANE_SEM_ENTITY_IDENTITY", "VANE_SEM_DUPLICATE_NAME"],
    );
  });

  it("validates both sides of a Column reference", () => {
    const result = compileSemanticIr({
      name: "Sales",
      entities: [
        {
          name: "Customer",
          columns: [{ name: "id", type: "uuid", identity: true }],
        },
        {
          name: "Order",
          columns: [
            { name: "id", type: "uuid", identity: true },
            {
              name: "customerId",
              type: "integer",
              references: { entity: "Customer", column: "missing" },
            },
          ],
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["VANE_SEM_REFERENCE_COLUMN"],
    );
  });

  it("rejects numeric Rule literals that JSON cannot preserve", () => {
    const result = compileSemanticIr({
      name: "Sales",
      entities: [
        {
          name: "Range",
          columns: [
            { name: "id", type: "uuid", identity: true },
            { name: "minimum", type: "decimal" },
            { name: "maximum", type: "decimal" },
          ],
          rules: [
            {
              name: "FiniteRange",
              expression: {
                kind: "logical",
                operator: "and",
                operands: [
                  {
                    kind: "comparison",
                    operator: "lte",
                    left: { kind: "column", column: "minimum" },
                    right: { kind: "column", column: "maximum" },
                  },
                  {
                    kind: "comparison",
                    operator: "lt",
                    left: { kind: "column", column: "maximum" },
                    right: { kind: "literal", value: Number.POSITIVE_INFINITY },
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
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["VANE_SEM_RULE_LITERAL"],
    );
  });
});
