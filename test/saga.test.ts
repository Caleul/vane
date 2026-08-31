import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModuleDeclaration, SagaDeclaration } from "../src/declaration.js";
import {
  compileModuleSource,
  compileSemanticIr,
  parseModuleSource,
  serializeSemanticIr,
} from "../src/index.js";

const placeOrder: SagaDeclaration = {
  name: "PlaceOrder",
  input: [{ name: "orderId", type: "uuid" }],
  steps: [
    {
      name: "place",
      event: { owner: "Order", event: "Place" },
      causedBy: [],
      compensateWith: { owner: "Order", event: "Cancel" },
    },
    {
      name: "authorize",
      event: { owner: "PaymentGateway", event: "Authorize" },
      causedBy: ["place"],
    },
    {
      name: "capture",
      event: { owner: "Payment", event: "Capture" },
      causedBy: ["authorize"],
      compensateWith: { owner: "Payment", event: "Refund" },
    },
  ],
  terminal: { step: "capture", view: "PaymentReceipt" },
};

const moduleWithSaga: ModuleDeclaration = {
  name: "Sales",
  entities: [
    {
      name: "Order",
      columns: [{ name: "id", type: "uuid", identity: true }],
      events: [{ name: "Place" }, { name: "Cancel" }],
    },
    {
      name: "Payment",
      columns: [{ name: "id", type: "uuid", identity: true }],
      events: [{ name: "Capture" }, { name: "Refund" }],
    },
  ],
  views: [
    {
      name: "PaymentReceipt",
      input: [],
      output: [
        {
          name: "id",
          expression: { kind: "column", entity: "Payment", column: "id" },
        },
      ],
      query: { root: "Payment" },
    },
  ],
  antiCorruptionLayers: [
    {
      name: "PaymentGateway",
      events: [
        {
          name: "Authorize",
          results: [
            { name: "approved", outcome: "success", data: [] },
            { name: "declined", outcome: "fail", data: [] },
          ],
        },
      ],
    },
  ],
  sagas: [placeOrder],
};

describe("Saga Semantic IR", () => {
  it("materializes a causal DAG with compensation and terminal-only output", () => {
    const result = compileSemanticIr(moduleWithSaga);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.ir.version, 5);
    assert.deepEqual(result.ir.module.sagas[0], {
      name: "PlaceOrder",
      input: [{ name: "orderId", type: "uuid", optional: false }],
      steps: [
        {
          name: "authorize",
          event: { owner: "PaymentGateway", event: "Authorize" },
          causedBy: ["place"],
          compensateWith: null,
        },
        {
          name: "capture",
          event: { owner: "Payment", event: "Capture" },
          causedBy: ["authorize"],
          compensateWith: { owner: "Payment", event: "Refund" },
        },
        {
          name: "place",
          event: { owner: "Order", event: "Place" },
          causedBy: [],
          compensateWith: { owner: "Order", event: "Cancel" },
        },
      ],
      terminal: {
        step: "capture",
        success: { kind: "view", view: "PaymentReceipt" },
        fail: { kind: "fail" },
      },
      guarantees: {
        causalMetadata: ["eventId", "sagaId", "causationId", "correlationId"],
        durableState: true,
        intermediateResults: "internal",
        streamVisibility: "terminalOnly",
      },
    });
  });

  it("serializes equivalent Saga declaration orders byte-identically", () => {
    const reordered: ModuleDeclaration = {
      ...moduleWithSaga,
      sagas: [
        {
          ...placeOrder,
          input: [...placeOrder.input].reverse(),
          steps: [...placeOrder.steps].reverse().map((step) => ({
            ...step,
            causedBy: [...step.causedBy].reverse(),
          })),
        },
      ],
    };

    const first = compileSemanticIr(moduleWithSaga);
    const second = compileSemanticIr(reordered);
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    if (!first.success || !second.success) return;
    assert.equal(serializeSemanticIr(first.ir), serializeSemanticIr(second.ir));
  });

  it("rejects unknown ordered and compensation Events", () => {
    const result = compileSemanticIr({
      ...moduleWithSaga,
      sagas: [
        {
          ...placeOrder,
          steps: placeOrder.steps.map((step) =>
            step.name === "capture"
              ? {
                  ...step,
                  event: { owner: "Payment", event: "Missing" },
                  compensateWith: { owner: "Payment", event: "AlsoMissing" },
                }
              : step,
          ),
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(
      result.diagnostics.filter(({ code }) => code === "VANE_SEM_SAGA_EVENT")
        .length,
      2,
    );
  });

  it("rejects causal cycles", () => {
    const result = compileSemanticIr({
      ...moduleWithSaga,
      sagas: [
        {
          ...placeOrder,
          steps: placeOrder.steps.map((step) =>
            step.name === "place" ? { ...step, causedBy: ["capture"] } : step,
          ),
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(({ code }) => code === "VANE_SEM_SAGA_CYCLE"),
    );
  });

  it("requires every branch to converge on the selected terminal step", () => {
    const result = compileSemanticIr({
      ...moduleWithSaga,
      sagas: [
        {
          ...placeOrder,
          steps: [
            ...placeOrder.steps,
            {
              name: "orphan",
              event: { owner: "Order", event: "Place" },
              causedBy: [],
            },
          ],
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(
        ({ code }) => code === "VANE_SEM_SAGA_TERMINAL_GRAPH",
      ),
    );
  });

  it("rejects unknown terminal steps and Views", () => {
    const result = compileSemanticIr({
      ...moduleWithSaga,
      sagas: [
        {
          ...placeOrder,
          terminal: { step: "missing", view: "MissingView" },
        },
      ],
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(
        ({ code }) => code === "VANE_SEM_SAGA_TERMINAL_STEP",
      ),
    );
    assert.ok(
      result.diagnostics.some(
        ({ code }) => code === "VANE_SEM_SAGA_TERMINAL_VIEW",
      ),
    );
  });
});

describe("Saga source parser", () => {
  const source = `
    import {
      Module, Entity, Column, type ColumnMember, Event, View, ACL, ACLEvent, Saga,
      event, success, fail, type EventMember
    } from "@lilka/vane";

    @Entity()
    class Order {
      @Column({ type: "uuid", identity: true }) id!: ColumnMember<string>;
      @Event() Place!: EventMember;
      @Event() Cancel!: EventMember;
    }

    @Entity()
    class Payment {
      @Column({ type: "uuid", identity: true }) id!: ColumnMember<string>;
      @Event() Capture!: EventMember;
      @Event() Refund!: EventMember;
    }

    @View({
      input: {},
      output: { id: Payment.id },
      query: { root: Payment },
    })
    class PaymentReceipt {}

    @ACL()
    class PaymentGateway {
      @ACLEvent({
        results: {
          approved: success({}),
          declined: fail({}),
        },
      })
      Authorize!: EventMember;
    }

    @Saga({
      input: { orderId: "uuid" },
      steps: {
        place: event(Order.Place, { compensateWith: Order.Cancel }),
        authorize: event(PaymentGateway.Authorize, {
          causedBy: ["place"],
        }),
        capture: event(Payment.Capture, {
          causedBy: ["authorize"],
          compensateWith: Payment.Refund,
        }),
      },
      terminal: { step: "capture", view: PaymentReceipt },
    })
    class PlaceOrder {}

    @Module({
      entities: [Order, Payment],
      views: [PaymentReceipt],
      antiCorruptionLayers: [PaymentGateway],
      sagas: [PlaceOrder],
    })
    class Sales {}
  `;

  it("compiles static @Saga causal graphs without executing source", () => {
    const result = compileModuleSource({
      fileName: "saga.vane.ts",
      sourceText: `${source}\nthrow new Error("executed");`,
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.ir.module.sagas[0]?.name, "PlaceOrder");
    assert.equal(
      result.ir.module.sagas[0]?.terminal.success.view,
      "PaymentReceipt",
    );
  });

  it("rejects progress or intermediate result declarations", () => {
    const result = parseModuleSource({
      fileName: "progress-saga.vane.ts",
      sourceText: source.replace(
        'causedBy: ["place"],',
        'causedBy: ["place"], emitProgress: true,',
      ),
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(
        ({ code, path }) =>
          code === "VANE_PARSE_OPTION" && path.at(-1) === "emitProgress",
      ),
    );
  });

  it("rejects dynamic causal graphs", () => {
    const result = parseModuleSource({
      fileName: "dynamic-saga.vane.ts",
      sourceText: source.replace(
        'causedBy: ["place"],',
        "causedBy: dependencies,",
      ),
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(
      result.diagnostics.some(({ code }) => code === "VANE_PARSE_STATIC_VALUE"),
    );
  });
});
