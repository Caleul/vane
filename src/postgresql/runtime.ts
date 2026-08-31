import type {
  ColumnType,
  EntityEventOperationDeclaration,
  EventOperationValueDeclaration,
  JsonValue,
} from "../declaration.js";
import type { SemanticEntity, SemanticEntityEvent } from "../semantic-ir.js";
import { type EventEnvelope, assertValidEventEnvelope } from "./envelope.js";
import { quotePostgreSqlIdentifier } from "./identifiers.js";
import type {
  PostgreSqlColumn,
  PostgreSqlStorageIr,
  PostgreSqlTable,
} from "./storage-ir.js";

export interface PostgreSqlQueryResult<
  Row extends object = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface PostgreSqlClientLike {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgreSqlQueryResult<Row>>;
  release(): void;
}

export interface PostgreSqlPoolLike {
  connect(): Promise<PostgreSqlClientLike>;
}

export interface SafeEventFail {
  readonly code:
    | "VANE_EVENT_CONSTRAINT_VIOLATION"
    | "VANE_EVENT_INPUT_INVALID"
    | "VANE_EVENT_OWNER_NOT_FOUND"
    | "VANE_EVENT_RULE_VIOLATION";
  readonly message: string;
  readonly correlationId: string;
}

export interface EventSuccess {
  readonly kind: "success";
  readonly eventId: string;
  readonly revision: string;
}

export interface EventFailure {
  readonly kind: "fail";
  readonly eventId: string;
  readonly fail: SafeEventFail;
}

export type EventTerminalResult = EventSuccess | EventFailure;

export interface DuplicateEventResult {
  readonly kind: "duplicate";
  readonly eventId: string;
  readonly result: EventTerminalResult;
}

export type EventExecutionResult = EventTerminalResult | DuplicateEventResult;

export interface ExecuteEntityEventInput {
  readonly module: string;
  readonly entity: SemanticEntity;
  readonly event: SemanticEntityEvent;
  readonly envelope: EventEnvelope;
}

interface MailboxRow {
  readonly fingerprint: string;
  readonly status: string;
  readonly result: unknown;
}

interface RevisionRow {
  readonly revision: string | number | bigint;
}

interface PostgreSqlErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

const MAILBOX_SEMANTIC_ID = "vane.infrastructure.mailbox";
const OUTBOX_SEMANTIC_ID = "vane.infrastructure.outbox";

export class EventIdCollisionError extends Error {
  readonly code = "VANE_EVENT_ID_COLLISION" as const;
  readonly eventId: string;

  constructor(eventId: string) {
    super(
      `eventId ${JSON.stringify(eventId)} was reused with different content.`,
    );
    this.name = "EventIdCollisionError";
    this.eventId = eventId;
  }
}

export class EventRuntimeConfigurationError extends Error {
  readonly code = "VANE_EVENT_RUNTIME_CONFIGURATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "EventRuntimeConfigurationError";
  }
}

class TerminalMutationError extends Error {
  readonly fail: SafeEventFail;

  constructor(fail: SafeEventFail) {
    super(fail.message);
    this.fail = fail;
  }
}

export class PostgreSqlEventRuntime {
  readonly #pool: PostgreSqlPoolLike;
  readonly #storage: PostgreSqlStorageIr;

  constructor(pool: PostgreSqlPoolLike, storage: PostgreSqlStorageIr) {
    this.#pool = pool;
    this.#storage = storage;
    requiredTechnicalTable(storage, MAILBOX_SEMANTIC_ID);
    requiredTechnicalTable(storage, OUTBOX_SEMANTIC_ID);
  }

  async execute(input: ExecuteEntityEventInput): Promise<EventExecutionResult> {
    assertValidEventEnvelope(input.envelope);
    if (input.envelope.eventIdentity !== input.event.identity) {
      throw new EventRuntimeConfigurationError(
        `Envelope targets ${JSON.stringify(input.envelope.eventIdentity)}, but the operation is ${JSON.stringify(input.event.identity)}.`,
      );
    }
    if (input.event.owner.entity !== input.entity.name) {
      throw new EventRuntimeConfigurationError(
        `Event ${JSON.stringify(input.event.identity)} cannot mutate non-owner Entity ${JSON.stringify(input.entity.name)}.`,
      );
    }
    const declaredEvent = input.entity.events.find(
      (candidate) => candidate.identity === input.event.identity,
    );
    if (!declaredEvent) {
      throw new EventRuntimeConfigurationError(
        `Event ${JSON.stringify(input.event.identity)} is not declared by owner Entity ${JSON.stringify(input.entity.name)}.`,
      );
    }
    const executionInput: ExecuteEntityEventInput = {
      ...input,
      event: declaredEvent,
    };

    const client = await this.#pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;

      const mailbox = await this.#claimMailbox(client, input.envelope);
      if (mailbox) {
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          kind: "duplicate",
          eventId: input.envelope.eventId,
          result: parseTerminalResult(mailbox.result, input.envelope.eventId),
        };
      }

      await client.query("SAVEPOINT vane_owner_mutation");
      let result: EventTerminalResult;
      try {
        validateEventPayload(
          executionInput.event,
          executionInput.envelope.payload,
          executionInput.envelope.correlationId,
        );
        const revision = await this.#mutateOwner(client, executionInput);
        result = {
          kind: "success",
          eventId: input.envelope.eventId,
          revision,
        };
      } catch (error) {
        const terminal = toTerminalMutationError(
          error,
          input.envelope,
          this.#storage,
        );
        if (!terminal) throw error;
        await client.query("ROLLBACK TO SAVEPOINT vane_owner_mutation");
        result = {
          kind: "fail",
          eventId: input.envelope.eventId,
          fail: terminal.fail,
        };
      }

      if (result.kind === "success") {
        await this.#appendOutbox(client, input.envelope);
      }
      await this.#completeMailbox(client, input.envelope.eventId, result);
      await client.query("RELEASE SAVEPOINT vane_owner_mutation");
      await client.query("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original error. A broken connection cannot provide a
          // stronger rollback signal to this process.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async #claimMailbox(
    client: PostgreSqlClientLike,
    envelope: EventEnvelope,
  ): Promise<MailboxRow | null> {
    const mailbox = qualifiedTechnicalTable(this.#storage, MAILBOX_SEMANTIC_ID);
    const inserted = await client.query(
      `INSERT INTO ${mailbox} (event_id, fingerprint, event_identity, payload, status, received_at)\nVALUES ($1, $2, $3, $4, 'processing', transaction_timestamp())\nON CONFLICT (event_id) DO NOTHING\nRETURNING event_id`,
      [
        envelope.eventId,
        envelope.fingerprint,
        envelope.eventIdentity,
        JSON.stringify(envelope),
      ],
    );
    if (inserted.rowCount === 1) return null;

    const existing = await client.query<MailboxRow>(
      `SELECT fingerprint, status, result FROM ${mailbox} WHERE event_id = $1 FOR UPDATE`,
      [envelope.eventId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new EventRuntimeConfigurationError(
        `Mailbox conflict for ${JSON.stringify(envelope.eventId)} did not expose an existing receipt.`,
      );
    }
    if (row.fingerprint !== envelope.fingerprint) {
      throw new EventIdCollisionError(envelope.eventId);
    }
    if (row.status !== "success" && row.status !== "fail") {
      throw new EventRuntimeConfigurationError(
        `Mailbox receipt ${JSON.stringify(envelope.eventId)} has non-terminal status ${JSON.stringify(row.status)}.`,
      );
    }
    return row;
  }

  async #mutateOwner(
    client: PostgreSqlClientLike,
    input: ExecuteEntityEventInput,
  ): Promise<string> {
    const tableId = `${input.module}.${input.entity.name}`;
    const table = this.#storage.tables.find(
      (candidate) => candidate.semanticId === tableId && !candidate.technical,
    );
    if (!table) {
      throw new EventRuntimeConfigurationError(
        `Storage IR has no owner table ${JSON.stringify(tableId)}.`,
      );
    }
    const revision = physicalColumn(table, `${tableId}.__vane_revision`);
    const updatedAt = optionalPhysicalColumn(
      table,
      `${tableId}.__vane_updated_at`,
    );
    const identity = physicalColumn(
      table,
      `${tableId}.${input.entity.identityColumn}`,
    );
    const relation = qualifiedTable(this.#storage, table);
    const sql = buildMutationSql({
      relation,
      table,
      tableId,
      identity,
      revision,
      updatedAt,
      operation: input.event.operation,
      payload: input.envelope.payload,
    });

    const execution = await client.query<RevisionRow>(sql.text, sql.values);
    const row = execution.rows[0];
    if (!row) {
      throw new TerminalMutationError({
        code: "VANE_EVENT_OWNER_NOT_FOUND",
        message: "The Event owner does not exist.",
        correlationId: input.envelope.correlationId,
      });
    }
    return String(row.revision);
  }

  async #appendOutbox(
    client: PostgreSqlClientLike,
    envelope: EventEnvelope,
  ): Promise<void> {
    const outbox = qualifiedTechnicalTable(this.#storage, OUTBOX_SEMANTIC_ID);
    await client.query(
      `INSERT INTO ${outbox} (message_id, event_id, fingerprint, event_identity, payload, correlation_id, causation_id, saga_id, status, attempt_count, available_at, occurred_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'pending', 0, transaction_timestamp(), $9::timestamptz)`,
      [
        envelope.eventId,
        envelope.eventId,
        envelope.fingerprint,
        envelope.eventIdentity,
        JSON.stringify(envelope),
        envelope.correlationId,
        envelope.causationId,
        envelope.sagaId,
        envelope.occurredAt,
      ],
    );
  }

  async #completeMailbox(
    client: PostgreSqlClientLike,
    eventId: string,
    result: EventTerminalResult,
  ): Promise<void> {
    const mailbox = qualifiedTechnicalTable(this.#storage, MAILBOX_SEMANTIC_ID);
    const completion = await client.query(
      `UPDATE ${mailbox} SET status = $2, result = $3::jsonb, completed_at = transaction_timestamp() WHERE event_id = $1 AND status = 'processing'`,
      [eventId, result.kind, JSON.stringify(result)],
    );
    if (completion.rowCount !== 1) {
      throw new EventRuntimeConfigurationError(
        `Mailbox receipt ${JSON.stringify(eventId)} could not be completed.`,
      );
    }
  }
}

function validateEventPayload(
  event: SemanticEntityEvent,
  payload: Readonly<Record<string, JsonValue>>,
  correlationId: string,
): void {
  const declared = new Map(event.input.map((input) => [input.name, input]));
  const problems: string[] = [];
  if (!isPostgreSqlJsonbCompatible(payload)) {
    problems.push("payload must be PostgreSQL jsonb-compatible");
  }

  for (const input of event.input) {
    if (!Object.hasOwn(payload, input.name)) {
      if (!input.optional) problems.push(`missing ${input.name}`);
      continue;
    }
    if (!matchesInputType(payload[input.name], input.type)) {
      problems.push(`${input.name} must be ${input.type}`);
    }
  }
  for (const name of Object.keys(payload)) {
    if (!declared.has(name)) problems.push(`undeclared ${name}`);
  }

  if (problems.length > 0) {
    throw new TerminalMutationError({
      code: "VANE_EVENT_INPUT_INVALID",
      message: `The Event input is invalid: ${problems.sort().join(", ")}.`,
      correlationId,
    });
  }
}

function isPostgreSqlJsonbCompatible(value: JsonValue): boolean {
  if (typeof value === "string") return isPostgreSqlTextCompatible(value);
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPostgreSqlJsonbCompatible);
  return Object.entries(value).every(
    ([key, item]) =>
      isPostgreSqlTextCompatible(key) && isPostgreSqlJsonbCompatible(item),
  );
}

function isPostgreSqlTextCompatible(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function matchesInputType(
  value: JsonValue | undefined,
  type: ColumnType,
): boolean {
  if (value === null || value === undefined) return false;
  if (type === "string") return typeof value === "string";
  if (type === "integer")
    return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "decimal")
    return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "uuid")
    return (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        value,
      )
    );
  if (type === "date") return typeof value === "string" && isIsoDate(value);
  if (type === "datetime")
    return (
      typeof value === "string" &&
      isIsoDate(value.slice(0, 10)) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) &&
      Number.isFinite(Date.parse(value))
    );
  return type === "json";
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] as number);
}

interface MutationSqlInput {
  readonly relation: string;
  readonly table: PostgreSqlTable;
  readonly tableId: string;
  readonly identity: string;
  readonly revision: string;
  readonly updatedAt: string | null;
  readonly operation: EntityEventOperationDeclaration;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

interface BuiltSql {
  readonly text: string;
  readonly values: unknown[];
}

function buildMutationSql(input: MutationSqlInput): BuiltSql {
  const values: unknown[] = [];
  const valueSql = (
    value: EventOperationValueDeclaration,
    type: PostgreSqlColumn["type"],
  ): string => compileOperationValue(value, input, values, type);
  const revision = quotePostgreSqlIdentifier(input.revision);
  const updatedAtAssignment = input.updatedAt
    ? `, ${quotePostgreSqlIdentifier(input.updatedAt)} = transaction_timestamp()`
    : "";

  if (input.operation.kind === "create") {
    const assignments = input.operation.values.map((assignment) => {
      const column = operationColumnDefinition(input, assignment.column);
      return {
        column: column.name,
        value: valueSql(assignment.value, column.type),
      };
    });
    const columns = [
      ...assignments.map(({ column }) => quotePostgreSqlIdentifier(column)),
      revision,
    ];
    const expressions = [...assignments.map(({ value }) => value), "1"];
    return {
      text:
        `INSERT INTO ${input.relation} (${columns.join(", ")}) ` +
        `VALUES (${expressions.join(", ")}) RETURNING ${revision} AS revision`,
      values,
    };
  }

  const identityColumn = input.table.columns.find(
    (column) => column.name === input.identity,
  );
  if (!identityColumn)
    throw new EventRuntimeConfigurationError(
      `Storage table ${JSON.stringify(input.table.semanticId)} has no physical identity Column ${JSON.stringify(input.identity)}.`,
    );
  const identitySql = valueSql(input.operation.identity, identityColumn.type);
  const identity = quotePostgreSqlIdentifier(input.identity);

  if (input.operation.kind === "delete") {
    return {
      text:
        `DELETE FROM ${input.relation} WHERE ${identity} = ${identitySql} ` +
        `RETURNING (${revision} + 1) AS revision`,
      values,
    };
  }

  const assignments = input.operation.values.map((assignment) => {
    const column = operationColumnDefinition(input, assignment.column);
    return {
      column: column.name,
      value: valueSql(assignment.value, column.type),
    };
  });

  if (input.operation.kind === "update") {
    return {
      text: `UPDATE ${input.relation} SET ${[
        ...assignments.map(
          ({ column, value }) =>
            `${quotePostgreSqlIdentifier(column)} = ${value}`,
        ),
        `${revision} = ${revision} + 1${updatedAtAssignment}`,
      ].join(
        ", ",
      )} WHERE ${identity} = ${identitySql} RETURNING ${revision} AS revision`,
      values,
    };
  }

  const insertColumns = [
    identity,
    ...assignments.map(({ column }) => quotePostgreSqlIdentifier(column)),
    revision,
  ];
  const insertValues = [
    identitySql,
    ...assignments.map(({ value }) => value),
    "1",
  ];
  const updateAssignments = [
    ...assignments.map(({ column }) => {
      const quoted = quotePostgreSqlIdentifier(column);
      return `${quoted} = EXCLUDED.${quoted}`;
    }),
    `${revision} = ${quotePostgreSqlIdentifier("vane_owner")}.${revision} + 1${updatedAtAssignment}`,
  ];
  return {
    text:
      `INSERT INTO ${input.relation} AS ${quotePostgreSqlIdentifier("vane_owner")} (${insertColumns.join(", ")}) ` +
      `VALUES (${insertValues.join(", ")}) ON CONFLICT (${identity}) DO UPDATE SET ` +
      `${updateAssignments.join(", ")} RETURNING ${revision} AS revision`,
    values,
  };
}

function compileOperationValue(
  value: EventOperationValueDeclaration,
  input: MutationSqlInput,
  parameters: unknown[],
  expectedType: PostgreSqlColumn["type"],
): string {
  if (value.kind === "input") {
    if (!Object.hasOwn(input.payload, value.input)) {
      throw new EventRuntimeConfigurationError(
        `Event payload does not contain required input ${JSON.stringify(value.input)}.`,
      );
    }
    parameters.push(input.payload[value.input]);
    return `$${parameters.length}::${expectedType}`;
  }
  if (value.kind === "literal") {
    parameters.push(value.value);
    return `$${parameters.length}::${expectedType}`;
  }
  if (value.kind === "column") {
    return quotePostgreSqlIdentifier(operationColumn(input, value.column));
  }
  const left = compileOperationValue(
    value.left,
    input,
    parameters,
    expectedType,
  );
  const right = compileOperationValue(
    value.right,
    input,
    parameters,
    expectedType,
  );
  const operator = value.operator === "add" ? "+" : "-";
  return `(${left} ${operator} ${right})`;
}

function operationColumn(
  input: MutationSqlInput,
  semanticName: string,
): string {
  return operationColumnDefinition(input, semanticName).name;
}

function operationColumnDefinition(
  input: MutationSqlInput,
  semanticName: string,
): PostgreSqlColumn {
  const semanticId = `${input.tableId}.${semanticName}`;
  const column = input.table.columns.find(
    (candidate) => candidate.semanticId === semanticId,
  );
  if (!column)
    throw new EventRuntimeConfigurationError(
      `Storage table ${JSON.stringify(input.table.semanticId)} has no Column ${JSON.stringify(semanticId)}.`,
    );
  return column;
}

function requiredTechnicalTable(
  storage: PostgreSqlStorageIr,
  semanticId: string,
): PostgreSqlTable {
  const table = storage.tables.find(
    (candidate) =>
      candidate.semanticId === semanticId && candidate.technical === true,
  );
  if (!table) {
    throw new EventRuntimeConfigurationError(
      `Storage IR has no technical table ${JSON.stringify(semanticId)}.`,
    );
  }
  return table;
}

function qualifiedTechnicalTable(
  storage: PostgreSqlStorageIr,
  semanticId: string,
): string {
  return qualifiedTable(storage, requiredTechnicalTable(storage, semanticId));
}

function qualifiedTable(
  storage: PostgreSqlStorageIr,
  table: PostgreSqlTable,
): string {
  return `${quotePostgreSqlIdentifier(storage.provider.namespace)}.${quotePostgreSqlIdentifier(table.name)}`;
}

function physicalColumn(table: PostgreSqlTable, semanticId: string): string {
  const column = table.columns.find(
    (candidate) => candidate.semanticId === semanticId,
  );
  if (!column) {
    throw new EventRuntimeConfigurationError(
      `Storage table ${JSON.stringify(table.semanticId)} has no Column ${JSON.stringify(semanticId)}.`,
    );
  }
  return column.name;
}

function optionalPhysicalColumn(
  table: PostgreSqlTable,
  semanticId: string,
): string | null {
  return (
    table.columns.find((candidate) => candidate.semanticId === semanticId)
      ?.name ?? null
  );
}

function toTerminalMutationError(
  error: unknown,
  envelope: EventEnvelope,
  storage: PostgreSqlStorageIr,
): TerminalMutationError | null {
  if (error instanceof TerminalMutationError) return error;
  if (!isPostgreSqlIntegrityError(error)) return null;
  const ruleViolation =
    error.code === "23514" &&
    typeof error.constraint === "string" &&
    storage.tables.some((table) =>
      table.constraints.some(
        (constraint) =>
          constraint.name === error.constraint &&
          constraint.semanticId.includes(".rule."),
      ),
    );
  const code = ruleViolation
    ? "VANE_EVENT_RULE_VIOLATION"
    : "VANE_EVENT_CONSTRAINT_VIOLATION";
  const message =
    code === "VANE_EVENT_RULE_VIOLATION"
      ? "The Event violates an Entity Rule."
      : "The Event violates an Entity constraint.";
  return new TerminalMutationError({
    code,
    message,
    correlationId: envelope.correlationId,
  });
}

function isPostgreSqlIntegrityError(
  error: unknown,
): error is PostgreSqlErrorLike & { readonly code: string } {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as PostgreSqlErrorLike).code;
  return typeof code === "string" && code.startsWith("23");
}

function parseTerminalResult(
  value: unknown,
  eventId: string,
): EventTerminalResult {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof parsed !== "object" || parsed === null) {
    throw new EventRuntimeConfigurationError(
      `Mailbox receipt ${JSON.stringify(eventId)} has no terminal result.`,
    );
  }
  const candidate = parsed as Partial<EventTerminalResult>;
  if (
    (candidate.kind !== "success" && candidate.kind !== "fail") ||
    candidate.eventId !== eventId
  ) {
    throw new EventRuntimeConfigurationError(
      `Mailbox receipt ${JSON.stringify(eventId)} has an invalid terminal result.`,
    );
  }
  return candidate as EventTerminalResult;
}
