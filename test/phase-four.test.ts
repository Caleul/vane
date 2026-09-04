import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  AclConfigurationError,
  type AclEventAdapter,
  AclEventRuntime,
  InMemoryTerminalResultStore,
  PublicHttpRuntime,
  SagaPlanError,
  createEventEnvelope,
  httpAclAdapter,
  materializeContract,
  materializeSagaPlan,
  serializeSagaPlan,
} from "../src/index.js";
import { phaseFourModule } from "./phase-four-fixture.js";

function adapter(
  execute: AclEventAdapter["execute"] = async () => ({
    result: "approved",
    data: { reference: "ok" },
  }),
): AclEventAdapter {
  return {
    eventIdentity: "Gateway.Authorize",
    version: "1",
    results: ["approved", "declined"],
    idempotency: "eventId",
    execute,
  };
}
function envelope() {
  return createEventEnvelope({
    eventId: randomUUID(),
    eventIdentity: "Gateway.Authorize",
    occurredAt: new Date().toISOString(),
    payload: { id: randomUUID() },
  });
}
function runtime(binding = adapter(), timeoutMs = 1000) {
  return new AclEventRuntime(
    phaseFourModule().antiCorruptionLayers.flatMap((acl) => acl.events),
    [binding],
    timeoutMs,
  );
}

describe("phase 4 ACL boundary", () => {
  it("rejects incompatible HTTP result field mappings before execution", () => {
    const http = httpAclAdapter({
      eventIdentity: "Gateway.Authorize",
      version: "1",
      url: "https://example.invalid",
      idempotencyHeader: "Idempotency-Key",
      responses: [
        { status: 200, result: "approved", fields: {} },
        { status: 402, result: "declined", fields: {} },
      ],
    });
    assert.throws(() => runtime(http), AclConfigurationError);
  });

  it("normalizes declared success and fail without leaking external data", async () => {
    const input = envelope();
    assert.equal((await runtime().dispatch(input)).kind, "success");
    const result = await runtime(
      adapter(async () => ({ result: "declined", data: {} })),
    ).dispatch(input);
    assert.equal(result.kind, "fail");
    assert.ok(!JSON.stringify(result).includes("declined"));
  });
  it("rejects unknown results, extra fields and wrong result types", async () => {
    for (const result of [
      { result: "unknown", data: {} },
      { result: "approved", data: { reference: 2 } },
      { result: "approved", data: { reference: "ok", secret: "credential" } },
    ]) {
      const actual = await runtime(adapter(async () => result)).dispatch(
        envelope(),
      );
      assert.equal(actual.kind, "fail");
      assert.ok(!JSON.stringify(actual).includes("credential"));
    }
  });
  it("redacts exceptions and bounds execution with an abort signal", async () => {
    const result = await runtime(
      adapter(async () => {
        throw new Error("secret-password");
      }),
    ).dispatch(envelope());
    assert.equal(result.kind, "fail");
    assert.ok(!JSON.stringify(result).includes("secret-password"));
    let signal: AbortSignal | undefined;
    const timed = await runtime(
      adapter(async (_, value) => {
        signal = value;
        return new Promise(() => {});
      }),
      5,
    ).dispatch(envelope());
    assert.equal(timed.kind, "fail");
    assert.equal(signal?.aborted, true);
  });
  it("rejects incompatible bindings before execution", () => {
    assert.throws(
      () => runtime({ ...adapter(), results: ["approved"] }),
      AclConfigurationError,
    );
    assert.throws(
      () => runtime({ ...adapter(), eventIdentity: "Unknown.Event" }),
      AclConfigurationError,
    );
  });
  it("sends stable idempotency and whitelists external fields", async () => {
    const input = envelope();
    let key: string | null = null;
    const http = httpAclAdapter({
      eventIdentity: "Gateway.Authorize",
      version: "1",
      url: "https://example.invalid/authorize",
      idempotencyHeader: "Idempotency-Key",
      responses: [
        {
          status: 200,
          result: "approved",
          fields: { reference: "external_ref" },
        },
        { status: 402, result: "declined", fields: {} },
      ],
      fetch: async (_url, init) => {
        key = new Headers(init?.headers).get("Idempotency-Key");
        assert.equal(init?.redirect, "error");
        return new Response(
          JSON.stringify({ external_ref: "approved-1", secret: "hidden" }),
          { status: 200 },
        );
      },
    });
    const result = await runtime(http).dispatch(input);
    assert.equal(key, input.eventId);
    assert.equal(result.kind, "success");
    assert.ok(!JSON.stringify(result).includes("hidden"));
  });
  it("bounds HTTP response bytes and refuses unmapped statuses", async () => {
    for (const status of [200, 503]) {
      const http = httpAclAdapter({
        eventIdentity: "Gateway.Authorize",
        version: "1",
        url: "https://example.invalid",
        idempotencyHeader: "Idempotency-Key",
        maxResponseBytes: 4,
        responses: [
          { status: 200, result: "approved", fields: { reference: "ref" } },
          { status: 402, result: "declined", fields: {} },
        ],
        fetch: async () => new Response('{"ref":"too long"}', { status }),
      });
      assert.equal((await runtime(http).dispatch(envelope())).kind, "fail");
    }
  });
});
describe("phase 4 Saga materialization", () => {
  it("orders dependencies, binds compensation and hashes deterministically without secrets", () => {
    const module = phaseFourModule();
    const plan = materializeSagaPlan(module, "PlaceOrder", {}, [adapter()]);
    assert.deepEqual(
      plan.steps.map((step) => step.name),
      ["place", "authorize", "complete"],
    );
    assert.equal(plan.steps[0]?.compensation?.event, "Order.Cancel");
    assert.equal(
      serializeSagaPlan(plan),
      serializeSagaPlan(
        materializeSagaPlan(module, "PlaceOrder", {}, [adapter()]),
      ),
    );
    assert.notEqual(
      plan.hash,
      materializeSagaPlan(module, "PlaceOrder", {}, [
        { ...adapter(), version: "2" },
      ]).hash,
    );
    assert.ok(!serializeSagaPlan(plan).includes("execute"));
  });
  it("rejects missing adapters and invalid input bindings before admission", () => {
    const module = phaseFourModule();
    assert.throws(
      () => materializeSagaPlan(module, "PlaceOrder"),
      SagaPlanError,
    );
    assert.throws(
      () =>
        materializeSagaPlan(module, "PlaceOrder", { steps: { missing: {} } }, [
          adapter(),
        ]),
      SagaPlanError,
    );
    assert.throws(
      () =>
        materializeSagaPlan(
          module,
          "PlaceOrder",
          { steps: { place: { id: { kind: "literal", value: 3 } } } },
          [adapter()],
        ),
      SagaPlanError,
    );
    assert.throws(
      () =>
        materializeSagaPlan(module, "PlaceOrder", { terminal: {} }, [
          adapter(),
        ]),
      SagaPlanError,
    );
  });
  it("requires durable admission for public Saga contracts", () => {
    const contract = materializeContract(phaseFourModule(), {
      events: [
        {
          event: "Order.Place",
          saga: "PlaceOrder",
          terminal: {
            view: "Receipt",
            input: { id: { kind: "eventInput", input: "id" } },
          },
        },
      ],
    });
    assert.equal(contract.success, true);
    if (!contract.success) return;
    assert.throws(
      () =>
        new PublicHttpRuntime({
          contract: contract.ir,
          terminals: new InMemoryTerminalResultStore(),
          events: {
            dispatch: async () => {
              throw new Error("unused");
            },
          },
          views: {
            execute: async () => {
              throw new Error("unused");
            },
          },
        }),
      /durable admission/,
    );
  });
});
