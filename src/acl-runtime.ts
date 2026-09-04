import type { JsonValue } from "./declaration.js";
import { type PublicFail, validatePublicInput } from "./http-runtime.js";
import {
  type EventEnvelope,
  assertValidEventEnvelope,
} from "./postgresql/envelope.js";
import type { SemanticAntiCorruptionLayerEvent } from "./semantic-ir.js";

/** A technical adapter; credentials and transport never enter Semantic IR. */
export interface AclEventAdapter {
  readonly eventIdentity: string;
  /** Change when interpretation or remote behavior changes. Contains no secrets. */
  readonly version: string;
  readonly results: readonly string[];
  readonly idempotency: "eventId";
  readonly resultFields?: readonly {
    readonly result: string;
    readonly fields: readonly string[];
  }[];
  execute(
    envelope: EventEnvelope,
    signal: AbortSignal,
  ): Promise<{
    readonly result: string;
    readonly data: Readonly<Record<string, JsonValue>>;
  }>;
}

export type AclEventResult =
  | {
      readonly kind: "success";
      readonly eventId: string;
      readonly result: string;
      readonly data: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly kind: "fail";
      readonly eventId: string;
      readonly fail: PublicFail;
    };

export class AclConfigurationError extends Error {
  readonly code = "VANE_ACL_CONFIGURATION";
}

export function validateAclAdapter(
  event: SemanticAntiCorruptionLayerEvent,
  adapter: AclEventAdapter,
): void {
  if (
    adapter.eventIdentity !== event.identity ||
    !adapter.version.trim() ||
    adapter.idempotency !== "eventId" ||
    adapter.results.length !== new Set(adapter.results).size ||
    event.results.some((result) => !adapter.results.includes(result.name)) ||
    adapter.results.some(
      (name) => !event.results.some((result) => result.name === name),
    )
  ) {
    throw new AclConfigurationError(
      "ACL adapter must bind the declared Event, all result interpretations, a version and Event identity idempotency.",
    );
  }
  validateMappedFields(event, adapter);
}

function validateMappedFields(
  event: SemanticAntiCorruptionLayerEvent,
  adapter: AclEventAdapter,
): void {
  for (const mapping of adapter.resultFields ?? []) {
    const interpretation = event.results.find(
      (result) => result.name === mapping.result,
    );
    if (
      !interpretation ||
      mapping.fields.some(
        (name) => !interpretation.data.some((field) => field.name === name),
      ) ||
      interpretation.data.some(
        (field) => !field.optional && !mapping.fields.includes(field.name),
      )
    )
      throw new AclConfigurationError(
        "HTTP ACL field mapping does not satisfy its semantic result contract.",
      );
  }
}

export class AclEventRuntime {
  readonly #events: ReadonlyMap<string, SemanticAntiCorruptionLayerEvent>;
  readonly #adapters: ReadonlyMap<string, AclEventAdapter>;
  constructor(
    events: readonly SemanticAntiCorruptionLayerEvent[],
    adapters: readonly AclEventAdapter[],
    readonly timeoutMs = 10_000,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2_147_483_647
    )
      throw new AclConfigurationError(
        "ACL timeout must be a positive bounded integer.",
      );
    this.#events = new Map(events.map((event) => [event.identity, event]));
    this.#adapters = new Map(
      adapters.map((adapter) => [adapter.eventIdentity, adapter]),
    );
    if (
      this.#adapters.size !== adapters.length ||
      this.#events.size !== events.length ||
      adapters.length !== events.length
    )
      throw new AclConfigurationError(
        "ACL bindings must be unique and complete.",
      );
    for (const event of events) {
      const adapter = this.#adapters.get(event.identity);
      if (!adapter)
        throw new AclConfigurationError("A declared ACL Event has no adapter.");
      validateAclAdapter(event, adapter);
    }
  }

  get bindings(): readonly {
    readonly event: string;
    readonly version: string;
  }[] {
    return [...this.#adapters.values()]
      .map((adapter) => ({
        event: adapter.eventIdentity,
        version: adapter.version,
      }))
      .sort((a, b) => a.event.localeCompare(b.event));
  }

  async dispatch(
    envelope: EventEnvelope,
    timeoutMs = this.timeoutMs,
  ): Promise<AclEventResult> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2147483647
    )
      throw new AclConfigurationError("Invalid timeout.");
    assertValidEventEnvelope(envelope);
    const event = this.#events.get(envelope.eventIdentity);
    const adapter = this.#adapters.get(envelope.eventIdentity);
    if (!event || !adapter)
      throw new AclConfigurationError("Unknown ACL Event.");
    const fail = (code: string, message: string): AclEventResult => ({
      kind: "fail",
      eventId: envelope.eventId,
      fail: { code, message, correlationId: envelope.correlationId },
    });
    if (
      !validatePublicInput(
        envelope.payload,
        event.input.map((field) => ({ ...field, nullable: false })),
      ).success
    )
      return fail("VANE_ACL_INPUT_INVALID", "The ACL Event input is invalid.");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          adapter.execute(structuredClone(envelope), controller.signal),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, timeoutMs);
        }),
      ]);
      const interpretation = event.results.find(
        (candidate) => candidate.name === result.result,
      );
      if (
        !interpretation ||
        !validatePublicInput(
          result.data,
          interpretation.data.map((field) => ({ ...field, nullable: false })),
        ).success
      )
        return fail(
          "VANE_ACL_RESULT_INVALID",
          "The external result does not match the ACL contract.",
        );
      if (interpretation.outcome === "fail")
        return fail("VANE_ACL_REJECTED", "The external Event was rejected.");
      return {
        kind: "success",
        eventId: envelope.eventId,
        result: interpretation.name,
        data: structuredClone(result.data),
      };
    } catch {
      return fail(
        controller.signal.aborted ? "VANE_ACL_TIMEOUT" : "VANE_ACL_UNAVAILABLE",
        "The external Event could not be completed.",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export interface HttpAclAdapterOptions {
  readonly eventIdentity: string;
  readonly version: string;
  readonly url: string;
  readonly method?: "POST" | "PUT" | "PATCH" | "DELETE";
  /** The remote provider must honor this key for the full recovery horizon. */
  readonly idempotencyHeader: string;
  readonly headers?: () =>
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>>>;
  readonly responses: readonly {
    readonly status: number;
    readonly result: string;
    /** Maps semantic data field names to top-level external JSON fields. */
    readonly fields: Readonly<Record<string, string>>;
  }[];
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

export function httpAclAdapter(
  options: HttpAclAdapterOptions,
): AclEventAdapter {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new AclConfigurationError("Invalid HTTP ACL URL.");
  }
  const maxBytes = options.maxResponseBytes ?? 1_048_576;
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(options.idempotencyHeader) ||
    ["authorization", "content-type", "host", "content-length"].includes(
      options.idempotencyHeader.toLowerCase(),
    ) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    options.responses.length === 0 ||
    new Set(options.responses.map((r) => r.status)).size !==
      options.responses.length ||
    options.responses.some(
      (r) => !Number.isInteger(r.status) || r.status < 200 || r.status > 599,
    )
  )
    throw new AclConfigurationError("Invalid HTTP ACL mapping.");
  return {
    eventIdentity: options.eventIdentity,
    version: options.version,
    results: [
      ...new Set(options.responses.map((response) => response.result)),
    ].sort(),
    idempotency: "eventId",
    resultFields: options.responses.map((response) => ({
      result: response.result,
      fields: Object.keys(response.fields).sort(),
    })),
    async execute(envelope, signal) {
      const headers = new Headers(await options.headers?.());
      headers.set("content-type", "application/json");
      headers.set(options.idempotencyHeader, envelope.eventId);
      const response = await (options.fetch ?? fetch)(url, {
        method: options.method ?? "POST",
        headers,
        body: JSON.stringify(envelope.payload),
        signal,
        redirect: "error",
      });
      const mapping = options.responses.find(
        (candidate) => candidate.status === response.status,
      );
      if (!mapping) {
        await response.body?.cancel();
        throw new Error("Unmapped external response.");
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        if (reader)
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxBytes)
              throw new Error(
                "External response exceeds the configured bound.",
              );
            chunks.push(chunk.value);
          }
      } finally {
        await reader?.cancel();
      }
      const body: unknown =
        bytes === 0
          ? {}
          : JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
            );
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid external response.");
      const data = Object.fromEntries(
        Object.entries(mapping.fields).flatMap(([name, source]) =>
          Object.hasOwn(body, source)
            ? [[name, (body as Record<string, JsonValue>)[source] as JsonValue]]
            : [],
        ),
      );
      return { result: mapping.result, data };
    },
  };
}
