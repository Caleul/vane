import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ContractEventOperation,
  ContractField,
  ContractIr,
  ContractViewOperation,
  TerminalViewInputMapping,
} from "./contract-ir.js";
import type { JsonValue } from "./declaration.js";
import {
  type EventExecutionResult,
  createEventEnvelope,
} from "./postgresql/index.js";
import type { PostgreSqlModuleRuntime } from "./postgresql/module-runtime.js";
import {
  type PostgreSqlViewRuntime,
  type ViewExecutionResult,
  ViewInputError,
} from "./postgresql/view-runtime.js";

export interface PublicFail {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
}

export type PublicTerminalResult =
  | {
      readonly kind: "view";
      readonly view: string;
      readonly data: readonly Readonly<Record<string, unknown>>[];
    }
  | { readonly kind: "fail"; readonly fail: PublicFail };

export interface TerminalResultStore {
  register(sagaId: string): Promise<void>;
  has(sagaId: string): Promise<boolean>;
  publish(sagaId: string, result: PublicTerminalResult): Promise<void>;
  wait(sagaId: string, signal?: AbortSignal): Promise<PublicTerminalResult>;
}

export interface InMemoryTerminalResultStoreOptions {
  readonly retentionMs?: number;
  readonly maxEntries?: number;
}

export class InMemoryTerminalResultStore implements TerminalResultStore {
  readonly #known = new Map<string, ReturnType<typeof setTimeout> | null>();
  readonly #results = new Map<string, PublicTerminalResult>();
  readonly #waiters = new Map<
    string,
    {
      readonly resolve: (result: PublicTerminalResult) => void;
      readonly reject: (error: Error) => void;
      readonly signal?: AbortSignal;
      readonly abort: () => void;
    }[]
  >();
  readonly #retentionMs: number;
  readonly #maxEntries: number;

  constructor(options: InMemoryTerminalResultStoreOptions = {}) {
    this.#retentionMs = options.retentionMs ?? 300_000;
    this.#maxEntries = options.maxEntries ?? 1_000;
    if (!Number.isSafeInteger(this.#retentionMs) || this.#retentionMs <= 0)
      throw new Error("Terminal retentionMs must be a positive integer.");
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries <= 0)
      throw new Error("Terminal maxEntries must be a positive integer.");
  }

  async register(sagaId: string): Promise<void> {
    if (this.#known.has(sagaId)) return;
    if (this.#known.size >= this.#maxEntries)
      throw new Error("The terminal result store is at capacity.");
    this.#known.set(sagaId, null);
  }

  async has(sagaId: string): Promise<boolean> {
    return this.#known.has(sagaId);
  }

  async publish(sagaId: string, result: PublicTerminalResult): Promise<void> {
    if (!this.#known.has(sagaId)) await this.register(sagaId);
    if (this.#results.has(sagaId)) return;
    this.#results.set(sagaId, result);
    for (const waiter of this.#waiters.get(sagaId) ?? []) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.resolve(result);
    }
    this.#waiters.delete(sagaId);
    this.#retainResult(sagaId);
  }

  wait(sagaId: string, signal?: AbortSignal): Promise<PublicTerminalResult> {
    const result = this.#results.get(sagaId);
    if (result) return Promise.resolve(result);
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiters = this.#waiters.get(sagaId) ?? [];
      const abort = (): void => {
        const current = this.#waiters.get(sagaId) ?? [];
        const remaining = current.filter(
          (candidate) => candidate.abort !== abort,
        );
        if (remaining.length > 0) this.#waiters.set(sagaId, remaining);
        else this.#waiters.delete(sagaId);
        reject(abortError());
      };
      waiters.push({ resolve, reject, ...(signal ? { signal } : {}), abort });
      this.#waiters.set(sagaId, waiters);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #retainResult(sagaId: string): void {
    const previous = this.#known.get(sagaId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => this.#expire(sagaId), this.#retentionMs);
    timer.unref();
    this.#known.set(sagaId, timer);
  }

  #expire(sagaId: string): void {
    const timer = this.#known.get(sagaId);
    if (timer) clearTimeout(timer);
    this.#known.delete(sagaId);
    this.#results.delete(sagaId);
    for (const waiter of this.#waiters.get(sagaId) ?? []) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(new Error("The terminal result retention period expired."));
    }
    this.#waiters.delete(sagaId);
  }
}

export interface PublicHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface PublicHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface PublicHttpRuntimeOptions {
  readonly contract: ContractIr;
  readonly events: Pick<PostgreSqlModuleRuntime, "dispatch">;
  readonly views: Pick<PostgreSqlViewRuntime, "execute">;
  readonly terminals: TerminalResultStore;
  readonly now?: () => Date;
  readonly uuid?: () => string;
}

export class PublicHttpRuntime {
  readonly #contract: ContractIr;
  readonly #events: PublicHttpRuntimeOptions["events"];
  readonly #views: PublicHttpRuntimeOptions["views"];
  readonly #terminals: TerminalResultStore;
  readonly #now: () => Date;
  readonly #uuid: () => string;

  constructor(options: PublicHttpRuntimeOptions) {
    this.#contract = options.contract;
    this.#events = options.events;
    this.#views = options.views;
    this.#terminals = options.terminals;
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
  }

  async handle(request: PublicHttpRequest): Promise<PublicHttpResponse> {
    const method = request.method.toUpperCase();
    const operation = this.#contract.operations.find(
      (candidate) =>
        candidate.method === method && candidate.path === request.path,
    );
    if (operation?.kind === "view")
      return this.#queryView(operation, request.body);
    if (operation?.kind === "event")
      return this.#dispatchEvent(operation, request.body);
    const stream = this.#contract.operations.find(
      (candidate): candidate is ContractEventOperation =>
        candidate.kind === "event" &&
        streamMatch(candidate.terminal.streamPath, request.path),
    );
    if (stream && method === "GET")
      return this.#streamTerminal(stream, request.path, request.signal);
    const pathExists =
      Boolean(stream) ||
      this.#contract.operations.some(
        (candidate) => candidate.path === request.path,
      );
    return response(
      pathExists ? 405 : 404,
      safeFail(
        pathExists ? "VANE_HTTP_METHOD_NOT_ALLOWED" : "VANE_HTTP_NOT_FOUND",
        pathExists
          ? "The HTTP method is not allowed."
          : "The public operation was not found.",
        this.#uuid(),
      ),
    );
  }

  async #queryView(
    operation: ContractViewOperation,
    body: unknown,
  ): Promise<PublicHttpResponse> {
    const correlationId = this.#uuid();
    const input = validateObject(body, operation.input);
    if (!input.success)
      return response(
        400,
        safeFail("VANE_VIEW_INPUT_INVALID", input.message, correlationId),
      );
    try {
      const result = await this.#views.execute({
        view: operation.identity,
        input: input.value,
      });
      return response(200, result.rows);
    } catch (error) {
      if (error instanceof ViewInputError) {
        return response(
          400,
          safeFail("VANE_VIEW_INPUT_INVALID", error.message, correlationId),
        );
      }
      return response(
        500,
        safeFail(
          "VANE_PUBLIC_INTERNAL",
          "The View could not be produced.",
          correlationId,
        ),
      );
    }
  }

  async #dispatchEvent(
    operation: ContractEventOperation,
    body: unknown,
  ): Promise<PublicHttpResponse> {
    const correlationId = this.#uuid();
    const input = validateObject(body, operation.input);
    if (!input.success)
      return response(
        400,
        safeFail("VANE_EVENT_INPUT_INVALID", input.message, correlationId),
      );
    const eventId = this.#uuid();
    const sagaId = this.#uuid();
    await this.#terminals.register(sagaId);
    const envelope = createEventEnvelope({
      eventId,
      eventIdentity: operation.identity,
      correlationId,
      sagaId,
      occurredAt: this.#now().toISOString(),
      payload: input.value,
    });
    void this.#finishEvent(operation, envelope, sagaId).catch(async () => {
      try {
        await this.#terminals.publish(sagaId, {
          kind: "fail",
          fail: safeFail(
            "VANE_PUBLIC_INTERNAL",
            "The Event could not be completed.",
            correlationId,
          ),
        });
      } catch {
        // The public request is already accepted and no additional safe
        // channel exists when the terminal store itself is unavailable.
      }
    });
    return response(202, { sagaId });
  }

  async #finishEvent(
    operation: ContractEventOperation,
    envelope: ReturnType<typeof createEventEnvelope>,
    sagaId: string,
  ): Promise<void> {
    const execution = unwrap(await this.#events.dispatch(envelope));
    if (execution.kind === "fail") {
      await this.#terminals.publish(sagaId, {
        kind: "fail",
        fail: execution.fail,
      });
      return;
    }
    const input = terminalInput(operation.terminal.input, envelope.payload);
    const result: ViewExecutionResult = await this.#views.execute({
      view: operation.terminal.view,
      input,
    });
    await this.#terminals.publish(sagaId, {
      kind: "view",
      view: result.view,
      data: result.rows,
    });
  }

  async #streamTerminal(
    operation: ContractEventOperation,
    path: string,
    signal?: AbortSignal,
  ): Promise<PublicHttpResponse> {
    const sagaId = streamParameter(operation.terminal.streamPath, path);
    if (!sagaId || !UUID.test(sagaId)) {
      return response(
        400,
        safeFail(
          "VANE_SAGA_ID_INVALID",
          "The sagaId is invalid.",
          this.#uuid(),
        ),
      );
    }
    if (!(await this.#terminals.has(sagaId))) {
      return response(
        404,
        safeFail(
          "VANE_SAGA_NOT_FOUND",
          "The saga was not found.",
          this.#uuid(),
        ),
      );
    }
    const terminal = await this.#terminals.wait(sagaId, signal);
    return {
      status: 200,
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "close",
        "content-type": "text/event-stream; charset=utf-8",
      },
      body: `event: ${terminal.kind}\ndata: ${JSON.stringify(terminal.kind === "view" ? terminal : terminal.fail)}\n\n`,
    };
  }
}

export function createNodeHttpHandler(runtime: PublicHttpRuntime) {
  return async (
    request: IncomingMessage,
    responseTarget: ServerResponse,
  ): Promise<void> => {
    let publicRequest: PublicHttpRequest;
    try {
      const url = new URL(request.url ?? "/", "http://vane.local");
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await readJsonBody(request);
      publicRequest = {
        method: request.method ?? "GET",
        path: url.pathname,
        body,
      };
    } catch {
      const correlationId = randomUUID();
      const result = response(
        400,
        safeFail(
          "VANE_HTTP_REQUEST_INVALID",
          "The HTTP request is invalid.",
          correlationId,
        ),
      );
      responseTarget.writeHead(result.status, result.headers);
      responseTarget.end(result.body);
      return;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once("aborted", abort);
    responseTarget.once("close", abort);
    try {
      const result = await runtime.handle({
        ...publicRequest,
        signal: controller.signal,
      });
      request.off("aborted", abort);
      responseTarget.off("close", abort);
      responseTarget.writeHead(result.status, result.headers);
      responseTarget.end(result.body);
    } catch {
      request.off("aborted", abort);
      responseTarget.off("close", abort);
      if (controller.signal.aborted || responseTarget.destroyed) return;
      const result = response(
        500,
        safeFail(
          "VANE_PUBLIC_INTERNAL",
          "The public operation could not be completed.",
          randomUUID(),
        ),
      );
      responseTarget.writeHead(result.status, result.headers);
      responseTarget.end(result.body);
    }
  };
}

function abortError(): Error {
  const error = new Error("The terminal wait was aborted.");
  error.name = "AbortError";
  return error;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function terminalInput(
  mapping: TerminalViewInputMapping,
  payload: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(
    Object.entries(mapping).flatMap(([name, source]) => {
      const value =
        source.kind === "eventInput" ? payload[source.input] : source.value;
      return value === undefined ? [] : [[name, value]];
    }),
  ) as Readonly<Record<string, JsonValue>>;
}

function unwrap(result: EventExecutionResult) {
  return result.kind === "duplicate" ? result.result : result;
}

type ValidatedObject =
  | {
      readonly success: true;
      readonly value: Readonly<Record<string, JsonValue>>;
    }
  | { readonly success: false; readonly message: string };

function validateObject(
  value: unknown,
  fields: readonly ContractField[],
): ValidatedObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      success: false,
      message: "The request body must be a JSON object.",
    };
  }
  const object = value as Record<string, unknown>;
  const allowed = new Map(fields.map((field) => [field.name, field]));
  const problems: string[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(object, field.name)) {
      if (!field.optional) problems.push(`missing ${field.name}`);
      continue;
    }
    if (!matches(object[field.name], field.type))
      problems.push(`${field.name} must be ${field.type}`);
  }
  for (const name of Object.keys(object))
    if (!allowed.has(name)) problems.push(`undeclared ${name}`);
  return problems.length > 0
    ? {
        success: false,
        message: `The input is invalid: ${problems.sort().join(", ")}.`,
      }
    : { success: true, value: object as Readonly<Record<string, JsonValue>> };
}

function matches(value: unknown, type: ContractField["type"]): boolean {
  if (value === null || value === undefined) return false;
  if (type === "string")
    return typeof value === "string" && isPostgreSqlTextCompatible(value);
  if (type === "integer")
    return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "decimal")
    return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "uuid") return typeof value === "string" && UUID.test(value);
  if (type === "date") return typeof value === "string" && isIsoDate(value);
  if (type === "datetime")
    return (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      ) &&
      isIsoDate(value.slice(0, 10)) &&
      Number.isFinite(Date.parse(value))
    );
  return isJson(value) && isPostgreSqlJsonCompatible(value);
}

function isPostgreSqlTextCompatible(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function isPostgreSqlJsonCompatible(value: JsonValue): boolean {
  if (typeof value === "string") return isPostgreSqlTextCompatible(value);
  if (Array.isArray(value)) return value.every(isPostgreSqlJsonCompatible);
  if (value && typeof value === "object")
    return Object.entries(value).every(
      ([key, item]) =>
        isPostgreSqlTextCompatible(key) && isPostgreSqlJsonCompatible(item),
    );
  return true;
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isJson);
}

function safeFail(
  code: string,
  message: string,
  correlationId: string,
): PublicFail {
  return { code, message, correlationId };
}

function response(status: number, body: unknown): PublicHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function streamMatch(template: string, path: string): boolean {
  const prefix = template.replace("{sagaId}", "");
  return path.startsWith(prefix) && path.length > prefix.length;
}

function streamParameter(template: string, path: string): string | null {
  if (!streamMatch(template, path)) return null;
  return path.slice(template.indexOf("{sagaId}"));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] as number);
}
