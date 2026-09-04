import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AclEventRuntime } from "../acl-runtime.js";
import type { JsonValue } from "../declaration.js";
import {
  type PublicFail,
  type PublicTerminalResult,
  TerminalResultNotFoundError,
  type TerminalResultStore,
  validatePublicInput,
} from "../http-runtime.js";
import { type SagaPlan, assertSagaPlan, bindSagaInput } from "../saga-plan.js";
import {
  type EventEnvelope,
  canonicalJson,
  createEventEnvelope,
} from "./envelope.js";
import { quotePostgreSqlIdentifier } from "./identifiers.js";
import type { PostgreSqlModuleRuntime } from "./module-runtime.js";
import type { PostgreSqlClientLike, PostgreSqlPoolLike } from "./runtime.js";
import type { PostgreSqlStorageIr } from "./storage-ir.js";
import type { PostgreSqlViewRuntime } from "./view-runtime.js";

export interface SagaStepRecord {
  readonly name: string;
  readonly envelope: EventEnvelope;
  readonly compensation: EventEnvelope | null;
  readonly causedByEventIds: readonly string[];
  result: Readonly<Record<string, JsonValue>> | null;
  status: "pending" | "executing" | "success" | "fail";
  compensationStatus: "pending" | "executing" | "success" | "fail" | null;
  fail: PublicFail | null;
  compensationFail: PublicFail | null;
}
export interface DurableSagaState {
  readonly schema: "vane.saga-state";
  readonly version: 1;
  readonly planHash: string | null;
  readonly correlationId: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  status: "registered" | "running" | "compensating" | "terminal";
  readonly steps: SagaStepRecord[];
  fail: PublicFail | null;
  terminal: PublicTerminalResult | null;
}
interface SagaRow {
  readonly saga_id: string;
  readonly saga_identity: string;
  readonly state: DurableSagaState;
}

export class SagaStateError extends Error {
  readonly code = "VANE_SAGA_STATE";
}

/** Uses the migration-managed phase-two Saga table; no hidden DDL on startup. */
export class PostgreSqlSagaStore implements TerminalResultStore {
  readonly durable = true as const;
  readonly table: string;
  constructor(
    readonly pool: PostgreSqlPoolLike,
    storage: PostgreSqlStorageIr,
    readonly pollMs = 50,
  ) {
    const table = storage.tables.find(
      (table) => table.semanticId === "vane.infrastructure.sagas",
    );
    if (!table || !table.technical)
      throw new SagaStateError("Storage IR has no technical Saga table.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000)
      throw new SagaStateError(
        "Terminal poll interval must be between 1 and 1000 milliseconds.",
      );
    this.table = `${quotePostgreSqlIdentifier(storage.provider.namespace)}.${quotePostgreSqlIdentifier(table.name)}`;
  }
  async read(sagaId: string): Promise<DurableSagaState | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<SagaRow>(
        `SELECT saga_id, saga_identity, state FROM ${this.table} WHERE saga_id = $1`,
        [sagaId],
      );
      const state = result.rows[0]?.state;
      if (state) assertState(state);
      return state ?? null;
    } finally {
      client.release();
    }
  }
  async has(sagaId: string): Promise<boolean> {
    return (await this.read(sagaId)) !== null;
  }
  async register(sagaId: string): Promise<void> {
    await this.insert(
      sagaId,
      "vane.terminal",
      {
        schema: "vane.saga-state",
        version: 1,
        planHash: null,
        correlationId: sagaId,
        input: {},
        status: "registered",
        steps: [],
        fail: null,
        terminal: null,
      },
      false,
    );
  }
  async insert(
    sagaId: string,
    identity: string,
    state: DurableSagaState,
    strict = true,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO ${this.table} (saga_id, saga_identity, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT (saga_id) DO NOTHING RETURNING saga_id`,
        [sagaId, identity, encode(state)],
      );
      if (strict && result.rowCount !== 1)
        throw new SagaStateError("Saga identity is already registered.");
    } finally {
      client.release();
    }
  }
  async publish(sagaId: string, result: PublicTerminalResult): Promise<void> {
    // Publishing never overwrites the first terminal, including concurrent publishers.
    const client = await this.pool.connect();
    try {
      const changed = await client.query(
        `UPDATE ${this.table} SET state = jsonb_set(jsonb_set(state, '{terminal}', $2::jsonb), '{status}', '"terminal"'::jsonb), revision = revision + 1, updated_at = clock_timestamp() WHERE saga_id = $1 AND state->>'status' = 'registered' RETURNING saga_id`,
        [sagaId, encode(result)],
      );
      if (changed.rowCount !== 1) {
        const existing = await client.query<SagaRow>(
          `SELECT state FROM ${this.table} WHERE saga_id = $1`,
          [sagaId],
        );
        if (!existing.rows[0]) throw new TerminalResultNotFoundError(sagaId);
        if (existing.rows[0].state.status !== "terminal")
          throw new SagaStateError(
            "Only the Saga worker may finalize active orchestration.",
          );
      }
    } finally {
      client.release();
    }
  }
  async wait(
    sagaId: string,
    signal?: AbortSignal,
  ): Promise<PublicTerminalResult> {
    while (true) {
      signal?.throwIfAborted();
      const state = await this.read(sagaId);
      if (!state) throw new TerminalResultNotFoundError(sagaId);
      if (state.terminal) return state.terminal;
      await delay(this.pollMs, undefined, { signal });
    }
  }
}

export interface PostgreSqlSagaRuntimeOptions {
  readonly plans: readonly SagaPlan[];
  readonly store: PostgreSqlSagaStore;
  readonly events: Pick<PostgreSqlModuleRuntime, "dispatch" | "semanticHash">;
  readonly acls?: Pick<AclEventRuntime, "dispatch" | "bindings">;
  readonly views: Pick<PostgreSqlViewRuntime, "execute" | "semanticHash">;
}
export class PostgreSqlSagaRuntime {
  readonly #plans: ReadonlyMap<string, SagaPlan>;
  readonly #store: PostgreSqlSagaStore;
  #stopping = false;
  #loop: Promise<void> | null = null;
  #active = new Set<Promise<boolean>>();
  constructor(readonly options: PostgreSqlSagaRuntimeOptions) {
    for (const plan of options.plans) {
      assertSagaPlan(plan);
      if (
        plan.semanticHash !== options.events.semanticHash ||
        plan.semanticHash !== options.views.semanticHash
      )
        throw new SagaStateError(
          "Saga plan semantics differ from the installed Event or View runtime.",
        );
    }
    this.#plans = new Map(
      options.plans.map((plan) => [plan.hash, structuredClone(plan)]),
    );
    this.#store = options.store;
    if (this.#plans.size !== options.plans.length)
      throw new SagaStateError("Duplicate Saga plan.");
    for (const plan of options.plans)
      for (const binding of plan.adapters) {
        if (
          !options.acls?.bindings.some(
            (actual) =>
              actual.event === binding.event &&
              actual.version === binding.version,
          )
        )
          throw new SagaStateError(
            "Installed ACL adapter version differs from the durable Saga plan.",
          );
      }
    for (const plan of options.plans)
      if (
        plan.steps.some(
          (step) =>
            step.ownerKind === "antiCorruptionLayer" ||
            step.compensation?.ownerKind === "antiCorruptionLayer",
        ) &&
        !options.acls
      )
        throw new SagaStateError("Saga requires an ACL runtime.");
  }
  async admit(
    plan: SagaPlan,
    input: Readonly<Record<string, JsonValue>>,
    identifiers: {
      readonly sagaId?: string;
      readonly eventId?: string;
      readonly correlationId?: string;
      readonly occurredAt?: string;
    } = {},
  ): Promise<string> {
    if (this.#stopping) throw new SagaStateError("Saga runtime is stopping.");
    const installed = this.#plans.get(plan.hash);
    if (!installed) throw new SagaStateError("Saga plan is not installed.");
    if (
      !validatePublicInput(
        input,
        installed.input.map((field) => ({ ...field, nullable: false })),
      ).success
    )
      throw new SagaStateError("Saga input is invalid.");
    const sagaId = identifiers.sagaId ?? randomUUID();
    const correlationId = identifiers.correlationId ?? sagaId;
    const occurredAt = identifiers.occurredAt ?? new Date().toISOString();
    const records: SagaStepRecord[] = [];
    const roots = installed.steps.filter((step) => !step.causedBy.length);
    for (const step of installed.steps) {
      const eventId =
        identifiers.eventId &&
        roots.length === 1 &&
        step.name === roots[0]?.name
          ? identifiers.eventId
          : randomUUID();
      const parent = records.find(
        (record) => record.name === step.causedBy.at(-1),
      );
      const envelope = createEventEnvelope({
        eventId,
        eventIdentity: step.event,
        sagaId,
        correlationId,
        causationId: parent?.envelope.eventId ?? null,
        occurredAt,
        payload: bindSagaInput(step.input, input),
      });
      const compensation = step.compensation
        ? createEventEnvelope({
            eventId: randomUUID(),
            eventIdentity: step.compensation.event,
            sagaId,
            correlationId,
            causationId: eventId,
            occurredAt,
            payload: bindSagaInput(step.compensation.input, input),
          })
        : null;
      records.push({
        name: step.name,
        envelope,
        compensation,
        causedByEventIds: step.causedBy.map((parent) => {
          const record = records.find((record) => record.name === parent);
          if (!record) throw new SagaStateError("Unknown causal parent.");
          return record.envelope.eventId;
        }),
        result: null,
        status: "pending",
        compensationStatus: compensation ? "pending" : null,
        fail: null,
        compensationFail: null,
      });
    }
    await this.#store.insert(sagaId, `${installed.module}.${installed.saga}`, {
      schema: "vane.saga-state",
      version: 1,
      planHash: installed.hash,
      correlationId,
      input: structuredClone(input),
      status: "running",
      steps: records,
      fail: null,
      terminal: null,
    });
    return sagaId;
  }

  /** One durable transition. Safe to invoke from multiple workers/processes. */
  runOnce(): Promise<boolean> {
    if (this.#stopping) return Promise.resolve(false);
    const execution = this.#advance();
    this.#active.add(execution);
    void execution.then(
      () => this.#active.delete(execution),
      () => this.#active.delete(execution),
    );
    return execution;
  }
  /** Explicit start; rejected loop failures remain observable to the caller. */
  start(pollMs = 50): Promise<void> {
    if (!Number.isSafeInteger(pollMs) || pollMs <= 0 || pollMs > 1000)
      throw new SagaStateError("Invalid worker poll interval.");
    if (this.#loop) return this.#loop;
    this.#stopping = false;
    this.#loop = (async () => {
      try {
        while (!this.#stopping)
          if (!(await this.runOnce())) await delay(pollMs);
      } finally {
        this.#loop = null;
      }
    })();
    return this.#loop;
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled([...this.#active]);
    if (this.#loop) await this.#loop;
  }

  async #advance(): Promise<boolean> {
    const client = await this.#store.pool.connect();
    try {
      const candidates = await client.query<SagaRow>(
        `SELECT saga_id, saga_identity, state FROM ${this.#store.table} WHERE state->>'status' IN ('running', 'compensating') AND state->>'planHash' = ANY($1::text[]) ORDER BY updated_at, saga_id LIMIT 100`,
        [[...this.#plans.keys()]],
      );
      for (const candidate of candidates.rows) {
        const lockKey = `${this.#store.table}:${candidate.saga_id}`;
        const lock = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [lockKey],
        );
        if (!lock.rows[0]?.locked) continue;
        try {
          const fresh = await client.query<SagaRow>(
            `SELECT saga_id, saga_identity, state FROM ${this.#store.table} WHERE saga_id = $1`,
            [candidate.saga_id],
          );
          const row = fresh.rows[0];
          if (!row || row.state.status === "terminal") continue;
          assertState(row.state);
          const plan = row.state.planHash
            ? this.#plans.get(row.state.planHash)
            : undefined;
          if (!plan) continue;
          await this.#transition(client, row, plan);
          return true;
        } finally {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [lockKey],
          );
        }
      }
      return false;
    } finally {
      client.release();
    }
  }
  async #save(client: PostgreSqlClientLike, row: SagaRow): Promise<void> {
    await client.query(
      `UPDATE ${this.#store.table} SET state = $2::jsonb, revision = revision + 1, updated_at = clock_timestamp() WHERE saga_id = $1`,
      [row.saga_id, encode(row.state)],
    );
  }
  async #dispatch(
    envelope: EventEnvelope,
    kind: "entity" | "antiCorruptionLayer",
    record?: SagaStepRecord,
  ): Promise<PublicFail | null> {
    if (kind === "antiCorruptionLayer") {
      const result = await this.options.acls?.dispatch(envelope);
      if (!result) throw new SagaStateError("Missing ACL runtime.");
      if (record && result.kind === "success") record.result = result.data;
      return result.kind === "fail" ? result.fail : null;
    }
    const execution = await this.options.events.dispatch(envelope);
    const result =
      execution.kind === "duplicate" ? execution.result : execution;
    return result.kind === "fail" ? result.fail : null;
  }
  async #transition(
    client: PostgreSqlClientLike,
    row: SagaRow,
    plan: SagaPlan,
  ): Promise<void> {
    const state = row.state;
    if (state.status === "compensating") {
      const record = [...state.steps]
        .reverse()
        .find(
          (step) =>
            step.status === "success" &&
            (step.compensationStatus === "pending" ||
              step.compensationStatus === "executing"),
        );
      if (record?.compensation) {
        const step = plan.steps.find((step) => step.name === record.name);
        if (!step?.compensation)
          throw new SagaStateError("Compensation plan mismatch.");
        record.compensationStatus = "executing";
        await this.#save(client, row);
        record.compensationFail = await this.#dispatch(
          record.compensation,
          step.compensation.ownerKind,
        );
        record.compensationStatus = record.compensationFail
          ? "fail"
          : "success";
        await this.#save(client, row);
        return;
      }
      const compensationFailed = state.steps.some(
        (step) => step.compensationStatus === "fail",
      );
      state.terminal = {
        kind: "fail",
        fail: compensationFailed
          ? safeFail("VANE_SAGA_COMPENSATION_FAILED", state.correlationId)
          : (state.fail ?? safeFail("VANE_SAGA_FAILED", state.correlationId)),
      };
      state.status = "terminal";
      await this.#save(client, row);
      return;
    }
    const next = state.steps.find(
      (record) =>
        (record.status === "pending" || record.status === "executing") &&
        plan.steps
          .find((step) => step.name === record.name)
          ?.causedBy.every((parent) =>
            state.steps.some(
              (done) => done.name === parent && done.status === "success",
            ),
          ),
    );
    if (next) {
      const step = plan.steps.find((step) => step.name === next.name);
      if (!step) throw new SagaStateError("Step plan mismatch.");
      next.status = "executing";
      await this.#save(client, row);
      // If the process dies after the effect, replay uses the stored Event envelope.
      next.fail = await this.#dispatch(next.envelope, step.ownerKind, next);
      next.status = next.fail ? "fail" : "success";
      if (next.fail) {
        state.fail = next.fail;
        state.status = "compensating";
      }
      await this.#save(client, row);
      return;
    }
    if (!state.steps.every((record) => record.status === "success"))
      throw new SagaStateError("Saga has no runnable step.");
    try {
      const view = await this.options.views.execute({
        view: plan.terminal.view,
        input: bindSagaInput(plan.terminal.input, state.input),
      });
      state.terminal = { kind: "view", view: view.view, data: view.rows };
      state.status = "terminal";
    } catch {
      state.fail = safeFail("VANE_SAGA_VIEW_FAILED", state.correlationId);
      state.status = "compensating";
    }
    await this.#save(client, row);
  }
}
function encode(value: unknown): string {
  return canonicalJson(value as JsonValue);
}
function assertState(state: DurableSagaState): void {
  if (state.schema !== "vane.saga-state" || state.version !== 1)
    throw new SagaStateError(
      "Unsupported durable Saga state; migrate before resuming.",
    );
}
function safeFail(code: string, correlationId: string): PublicFail {
  return { code, message: "The Saga could not be completed.", correlationId };
}
