import { createHash } from "node:crypto";
import type { JsonValue } from "../declaration.js";

export const EVENT_ENVELOPE_SCHEMA = "vane.event" as const;
export const EVENT_ENVELOPE_VERSION = 1 as const;

export type EventPayload = Readonly<Record<string, JsonValue>>;

export interface EventEnvelopeContent {
  readonly schema: typeof EVENT_ENVELOPE_SCHEMA;
  readonly version: typeof EVENT_ENVELOPE_VERSION;
  readonly eventId: string;
  readonly eventIdentity: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly sagaId: string | null;
  readonly occurredAt: string;
  readonly payload: EventPayload;
}

export interface EventEnvelope extends EventEnvelopeContent {
  readonly fingerprint: string;
}

export interface CreateEventEnvelopeInput {
  readonly eventId: string;
  readonly eventIdentity: string;
  readonly correlationId?: string;
  readonly causationId?: string | null;
  readonly sagaId?: string | null;
  readonly occurredAt: string;
  readonly payload: EventPayload;
}

export class InvalidEventEnvelopeError extends Error {
  readonly code = "VANE_EVENT_ENVELOPE_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidEventEnvelopeError";
  }
}

export function canonicalJson(value: JsonValue): string {
  return canonicalize(value, new Set<object>());
}

export function fingerprintEventEnvelope(
  envelope: EventEnvelopeContent,
): string {
  const content: JsonValue = {
    causationId: envelope.causationId,
    correlationId: envelope.correlationId,
    eventId: envelope.eventId,
    eventIdentity: envelope.eventIdentity,
    occurredAt: envelope.occurredAt,
    payload: envelope.payload,
    sagaId: envelope.sagaId,
    schema: envelope.schema,
    version: envelope.version,
  };

  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function createEventEnvelope(
  input: CreateEventEnvelopeInput,
): EventEnvelope {
  assertUuid("eventId", input.eventId);
  assertNonEmpty("eventIdentity", input.eventIdentity);
  const correlationId = input.correlationId ?? input.eventId;
  assertUuid("correlationId", correlationId);

  if (input.causationId !== undefined && input.causationId !== null) {
    assertUuid("causationId", input.causationId);
  }
  if (input.sagaId !== undefined && input.sagaId !== null) {
    assertUuid("sagaId", input.sagaId);
  }

  const occurredAt = normalizeInstant(input.occurredAt);
  // Canonicalizing here rejects cyclic and non-JSON runtime values before they
  // can reach a transaction or produce an unstable deduplication key.
  canonicalJson(input.payload);

  const content: EventEnvelopeContent = {
    schema: EVENT_ENVELOPE_SCHEMA,
    version: EVENT_ENVELOPE_VERSION,
    eventId: input.eventId,
    eventIdentity: input.eventIdentity,
    correlationId,
    causationId: input.causationId ?? null,
    sagaId: input.sagaId ?? null,
    occurredAt,
    payload: input.payload,
  };

  return { ...content, fingerprint: fingerprintEventEnvelope(content) };
}

export function assertValidEventEnvelope(
  envelope: EventEnvelope,
): asserts envelope is EventEnvelope {
  if (envelope.schema !== EVENT_ENVELOPE_SCHEMA) {
    throw new InvalidEventEnvelopeError(
      `Unsupported envelope schema ${JSON.stringify(envelope.schema)}.`,
    );
  }
  if (envelope.version !== EVENT_ENVELOPE_VERSION) {
    throw new InvalidEventEnvelopeError(
      `Unsupported envelope version ${JSON.stringify(envelope.version)}.`,
    );
  }
  assertUuid("eventId", envelope.eventId);
  assertNonEmpty("eventIdentity", envelope.eventIdentity);
  assertUuid("correlationId", envelope.correlationId);
  if (envelope.causationId !== null) {
    assertUuid("causationId", envelope.causationId);
  }
  if (envelope.sagaId !== null) assertUuid("sagaId", envelope.sagaId);
  normalizeInstant(envelope.occurredAt);

  const expected = fingerprintEventEnvelope(envelope);
  if (envelope.fingerprint !== expected) {
    throw new InvalidEventEnvelopeError(
      `Envelope ${JSON.stringify(envelope.eventId)} has an invalid fingerprint.`,
    );
  }
}

function canonicalize(value: JsonValue, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidEventEnvelopeError(
        "Event envelope JSON cannot contain a non-finite number.",
      );
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (typeof value !== "object") {
    throw new InvalidEventEnvelopeError(
      "Event envelope data must contain only JSON values.",
    );
  }

  if (ancestors.has(value)) {
    throw new InvalidEventEnvelopeError(
      "Event envelope JSON cannot contain a cycle.",
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new InvalidEventEnvelopeError(
            "Event envelope JSON cannot contain a sparse array.",
          );
        }
        items.push(canonicalize(value[index] as JsonValue, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const object = value as Readonly<Record<string, JsonValue>>;
    const prototype = Object.getPrototypeOf(object) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidEventEnvelopeError(
        "Event envelope JSON objects must be plain objects.",
      );
    }
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(object[key] as JsonValue, ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertNonEmpty(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new InvalidEventEnvelopeError(`${field} must not be empty.`);
  }
}

function assertUuid(field: string, value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new InvalidEventEnvelopeError(`${field} must be a UUID.`);
  }
}

function normalizeInstant(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new InvalidEventEnvelopeError(
      `occurredAt ${JSON.stringify(value)} is not a valid instant.`,
    );
  }
  return new Date(time).toISOString();
}
