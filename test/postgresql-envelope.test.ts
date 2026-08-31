import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonValue } from "../src/declaration.js";
import {
  InvalidEventEnvelopeError,
  assertValidEventEnvelope,
  canonicalJson,
  createEventEnvelope,
} from "../src/postgresql/envelope.js";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const CORRELATION_1 = "10000000-0000-4000-8000-000000000002";
const CORRELATION_2 = "10000000-0000-4000-8000-000000000003";

describe("PostgreSQL Event envelope", () => {
  it("uses canonical JSON for stable fingerprints", () => {
    const first = createEventEnvelope({
      eventId: EVENT_ID,
      eventIdentity: "Order.Update",
      occurredAt: "2026-08-31T12:00:00-03:00",
      payload: { nested: { z: 2, a: 1 }, quantity: 4 },
    });
    const second = createEventEnvelope({
      eventId: EVENT_ID,
      eventIdentity: "Order.Update",
      occurredAt: "2026-08-31T15:00:00.000Z",
      payload: { quantity: 4, nested: { a: 1, z: 2 } },
    });

    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(first.correlationId, EVENT_ID);
    assert.equal(first.occurredAt, "2026-08-31T15:00:00.000Z");
    assert.doesNotThrow(() => assertValidEventEnvelope(first));
  });

  it("changes the fingerprint when immutable causal content changes", () => {
    const first = createEventEnvelope({
      eventId: EVENT_ID,
      eventIdentity: "Order.Update",
      correlationId: CORRELATION_1,
      occurredAt: "2026-08-31T15:00:00.000Z",
      payload: { quantity: 4 },
    });
    const second = createEventEnvelope({
      eventId: EVENT_ID,
      eventIdentity: "Order.Update",
      correlationId: CORRELATION_2,
      occurredAt: "2026-08-31T15:00:00.000Z",
      payload: { quantity: 4 },
    });

    assert.notEqual(first.fingerprint, second.fingerprint);
  });

  it("rejects a forged fingerprint and non-JSON payloads", () => {
    const envelope = createEventEnvelope({
      eventId: EVENT_ID,
      eventIdentity: "Order.Update",
      occurredAt: "2026-08-31T15:00:00.000Z",
      payload: {},
    });
    assert.throws(
      () => assertValidEventEnvelope({ ...envelope, fingerprint: "forged" }),
      InvalidEventEnvelopeError,
    );

    const cyclic: { self?: JsonValue } = {};
    cyclic.self = cyclic as JsonValue;
    assert.throws(
      () => canonicalJson(cyclic as JsonValue),
      InvalidEventEnvelopeError,
    );
  });
});
