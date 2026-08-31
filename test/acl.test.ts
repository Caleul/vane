import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModuleDeclaration } from "../src/declaration.js";
import {
  compileModuleSource,
  compileSemanticIr,
  parseModuleSource,
  serializeSemanticIr,
} from "../src/index.js";

const moduleWithAcl: ModuleDeclaration = {
  name: "Payments",
  entities: [
    {
      name: "Payment",
      columns: [{ name: "id", type: "uuid", identity: true }],
    },
  ],
  antiCorruptionLayers: [
    {
      name: "PaymentGateway",
      events: [
        {
          name: "Authorize",
          input: [
            { name: "amount", type: "decimal" },
            { name: "currency", type: "string" },
          ],
          results: [
            {
              name: "approved",
              outcome: "success",
              data: [
                { name: "authorizationCode", type: "string" },
                { name: "transactionId", type: "string" },
              ],
            },
            {
              name: "declined",
              outcome: "fail",
              data: [
                { name: "declineCode", type: "string" },
                { name: "reason", type: "string", optional: true },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("Anti-Corruption Layer Semantic IR", () => {
  it("materializes ACL-owned Events and semantic result interpretations", () => {
    const result = compileSemanticIr(moduleWithAcl);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.ir.version, 6);
    assert.deepEqual(result.ir.module.antiCorruptionLayers[0], {
      name: "PaymentGateway",
      events: [
        {
          identity: "PaymentGateway.Authorize",
          name: "Authorize",
          owner: {
            kind: "antiCorruptionLayer",
            antiCorruptionLayer: "PaymentGateway",
          },
          input: [
            { name: "amount", type: "decimal", optional: false },
            { name: "currency", type: "string", optional: false },
          ],
          results: [
            {
              name: "approved",
              outcome: "success",
              data: [
                {
                  name: "authorizationCode",
                  type: "string",
                  optional: false,
                },
                {
                  name: "transactionId",
                  type: "string",
                  optional: false,
                },
              ],
            },
            {
              name: "declined",
              outcome: "fail",
              data: [
                {
                  name: "declineCode",
                  type: "string",
                  optional: false,
                },
                { name: "reason", type: "string", optional: true },
              ],
            },
          ],
          publicResult: {
            success: "viewOnly",
            fail: { code: "stable", message: "safe", correlationId: true },
          },
        },
      ],
    });
  });

  it("serializes equivalent ACL declaration orders byte-identically", () => {
    const layer = moduleWithAcl.antiCorruptionLayers?.[0];
    const event = layer?.events[0];
    assert.ok(layer);
    assert.ok(event);
    const reordered: ModuleDeclaration = {
      ...moduleWithAcl,
      antiCorruptionLayers: [
        {
          ...layer,
          events: [
            {
              ...event,
              input: [...(event.input ?? [])].reverse(),
              results: [...event.results].reverse().map((result) => ({
                ...result,
                data: [...result.data].reverse(),
              })),
            },
          ],
        },
      ],
    };

    const first = compileSemanticIr(moduleWithAcl);
    const second = compileSemanticIr(reordered);
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    if (!first.success || !second.success) return;
    assert.equal(serializeSemanticIr(first.ir), serializeSemanticIr(second.ir));
  });

  it("requires both success and fail interpretations", () => {
    const layer = moduleWithAcl.antiCorruptionLayers?.[0];
    const event = layer?.events[0];
    assert.ok(layer);
    assert.ok(event);
    const result = compileSemanticIr({
      ...moduleWithAcl,
      antiCorruptionLayers: [
        {
          ...layer,
          events: [
            {
              ...event,
              results: event.results.filter(
                ({ outcome }) => outcome === "success",
              ),
            },
          ],
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(
        ({ code }) => code === "VANE_SEM_ACL_EVENT_OUTCOME",
      ),
    );
  });

  it("keeps Event owner identities unambiguous", () => {
    const layer = moduleWithAcl.antiCorruptionLayers?.[0];
    assert.ok(layer);
    const result = compileSemanticIr({
      ...moduleWithAcl,
      entities: [
        {
          name: "PaymentGateway",
          columns: [{ name: "id", type: "uuid", identity: true }],
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(({ code }) => code === "VANE_SEM_EVENT_OWNER"),
    );
  });

  it("does not copy technical details or credentials into the Semantic IR", () => {
    const layer = moduleWithAcl.antiCorruptionLayers?.[0];
    assert.ok(layer);
    const declaration = {
      ...moduleWithAcl,
      antiCorruptionLayers: [
        {
          ...layer,
          endpoint: "https://gateway.example",
          credential: "must-not-leak",
        },
      ],
    } as unknown as ModuleDeclaration;
    const result = compileSemanticIr(declaration);

    assert.equal(result.success, true);
    if (!result.success) return;
    const serialized = serializeSemanticIr(result.ir);
    assert.equal(serialized.includes("gateway.example"), false);
    assert.equal(serialized.includes("must-not-leak"), false);
  });
});

describe("Anti-Corruption Layer source parser", () => {
  it("compiles static @ACL Events without executing user code", () => {
    const result = compileModuleSource({
      fileName: "payments.vane.ts",
      sourceText: `
        import {
          Module, Entity, Column, ACL, ACLEvent, optional, success, fail
        } from "@lilka/vane";

        @Entity()
        class Payment {
          id = Column({ type: "uuid", identity: true });
        }

        @ACL()
        class PaymentGateway {
          Authorize = ACLEvent({
            input: { amount: "decimal", currency: "string" },
            results: {
              approved: success({
                transactionId: "string",
                authorizationCode: "string",
              }),
              declined: fail({
                declineCode: "string",
                reason: optional("string"),
              }),
            },
          });
        }

        @Module({
          entities: [Payment],
          antiCorruptionLayers: [PaymentGateway],
        })
        class Payments {}

        throw new Error("the parser executed user code");
      `,
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(
      result.ir.module.antiCorruptionLayers[0]?.events[0]?.identity,
      "PaymentGateway.Authorize",
    );
    assert.deepEqual(
      result.ir.module.antiCorruptionLayers[0]?.events[0]?.results.map(
        ({ name, outcome }) => ({ name, outcome }),
      ),
      [
        { name: "approved", outcome: "success" },
        { name: "declined", outcome: "fail" },
      ],
    );
  });

  it("rejects technical policy inside an ACL Event", () => {
    const result = parseModuleSource({
      fileName: "leaky-acl.vane.ts",
      sourceText: `
        import {
          Module, Entity, Column, ACL, ACLEvent, success, fail
        }
          from "@lilka/vane";
        @Entity()
        class Payment {
          id = Column({ type: "uuid", identity: true });
        }
        @ACL()
        class PaymentGateway {
          Authorize = ACLEvent({
            endpoint: "https://gateway.example",
            timeout: 5000,
            results: {
              approved: success({}),
              unavailable: fail({}),
            },
          });
        }
        @Module({
          entities: [Payment],
          antiCorruptionLayers: [PaymentGateway],
        })
        class Payments {}
      `,
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.deepEqual(
      result.diagnostics
        .filter(({ code }) => code === "VANE_PARSE_OPTION")
        .map(({ path }) => path.at(-1)),
      ["endpoint", "timeout"],
    );
  });

  it("rejects dynamic result interpretation helpers", () => {
    const result = parseModuleSource({
      fileName: "dynamic-acl.vane.ts",
      sourceText: `
        import {
          Module, Entity, Column, ACL, ACLEvent
        }
          from "@lilka/vane";
        const approved = loadResult();
        @Entity()
        class Payment {
          id = Column({ type: "uuid", identity: true });
        }
        @ACL()
        class PaymentGateway {
          Authorize = ACLEvent({ results: { approved } });
        }
        @Module({
          entities: [Payment],
          antiCorruptionLayers: [PaymentGateway],
        })
        class Payments {}
      `,
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(({ code }) => code === "VANE_PARSE_STATIC_VALUE"),
    );
  });

  it("keeps Entity and ACL Event member factories owner-specific", () => {
    const entityResult = parseModuleSource({
      fileName: "entity-acl-event.vane.ts",
      sourceText: `
        import {
          Module, Entity, ACLEvent, success, fail
        } from "@lilka/vane";
        @Entity()
        class Order {
          Place = ACLEvent({
            results: { approved: success({}), declined: fail({}) },
          });
        }
        @Module({ entities: [Order] }) class Sales {}
      `,
    });
    assert.equal(entityResult.success, false);
    if (!entityResult.success) {
      assert.ok(
        entityResult.diagnostics.some(
          ({ code, message }) =>
            code === "VANE_PARSE_DECORATOR_TARGET" &&
            message.includes("ACLEvent"),
        ),
      );
    }

    const aclResult = parseModuleSource({
      fileName: "acl-entity-event.vane.ts",
      sourceText: `
        import { Module, ACL, Event } from "@lilka/vane";
        @ACL()
        class PaymentGateway {
          Authorize = Event();
        }
        @Module({ entities: [], antiCorruptionLayers: [PaymentGateway] })
        class Payments {}
      `,
    });
    assert.equal(aclResult.success, false);
    if (!aclResult.success) {
      assert.ok(
        aclResult.diagnostics.some(
          ({ code, message }) =>
            code === "VANE_PARSE_DECORATOR_TARGET" && message.includes("Event"),
        ),
      );
    }

    const wrongTypeResult = parseModuleSource({
      fileName: "wrong-event-type.vane.ts",
      sourceText: `
        import { Module, Entity, Event } from "@lilka/vane";
        @Entity()
        class Order {
          Place: string = Event();
        }
        @Module({ entities: [Order] }) class Sales {}
      `,
    });
    assert.equal(wrongTypeResult.success, false);
    if (!wrongTypeResult.success) {
      assert.ok(
        wrongTypeResult.diagnostics.some(
          ({ code }) => code === "VANE_PARSE_MEMBER_DECLARATION",
        ),
      );
    }

    const staticResult = parseModuleSource({
      fileName: "static-event.vane.ts",
      sourceText: `
        import {
          Module, Entity, Event
        } from "@lilka/vane";
        @Entity()
        class Order {
          static Place = Event();
        }
        @Module({ entities: [Order] }) class Sales {}
      `,
    });
    assert.equal(staticResult.success, false);
    if (!staticResult.success) {
      assert.ok(
        staticResult.diagnostics.some(
          ({ code }) => code === "VANE_PARSE_MEMBER_DECLARATION",
        ),
      );
    }
  });
});
