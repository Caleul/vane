import { hashSemanticModule } from "../module-fingerprint.js";
import type {
  SemanticEntity,
  SemanticEntityEvent,
  SemanticModule,
} from "../semantic-ir.js";
import type { RuntimeTelemetry } from "../telemetry.js";
import {
  type EventEnvelope,
  assertValidEventEnvelope,
  canonicalJson,
} from "./envelope.js";
import { quotePostgreSqlIdentifier } from "./identifiers.js";
import {
  POSTGRESQL_MIGRATION_HISTORY_TABLE,
  hashPostgreSqlStorageIr,
} from "./migrations.js";
import {
  type EventExecutionResult,
  PostgreSqlEventRuntime,
  type PostgreSqlPoolLike,
} from "./runtime.js";
import {
  POSTGRESQL_STORAGE_IR_VERSION,
  type PostgreSqlStorageIr,
  type PostgreSqlTable,
} from "./storage-ir.js";

export type PostgreSqlModuleRuntimeState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping";

export interface PostgreSqlModuleRuntimeOptions {
  readonly module: SemanticModule;
  readonly pool: PostgreSqlPoolLike;
  readonly storage: PostgreSqlStorageIr;
  readonly telemetry?: RuntimeTelemetry;
  readonly timeouts?: Readonly<Record<string, number>>;
}

interface DispatchTarget {
  readonly entity: SemanticEntity;
  readonly event: SemanticEntityEvent;
}

interface PostgreSqlVersionRow {
  readonly server_version_num: string | number;
}

interface PostgreSqlCatalogRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly udt_name: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
  readonly is_identity: string;
}

interface PostgreSqlConstraintCatalogRow {
  readonly table_name: string;
  readonly object_name: string;
  readonly constraint_type: string;
  readonly column_names: readonly string[];
  readonly reference_table: string | null;
  readonly reference_columns: readonly string[] | null;
  readonly delete_action: string;
  readonly update_action: string;
  readonly check_expression: string | null;
  readonly validated: boolean;
}

interface PostgreSqlIndexCatalogRow {
  readonly table_name: string;
  readonly object_name: string;
  readonly unique: boolean;
  readonly column_expressions: readonly string[];
  readonly predicate: string | null;
  readonly access_method: string;
}

interface PostgreSqlStorageHeadRow {
  readonly target_hash: string;
}

const REQUIRED_TECHNICAL_COLUMNS: Readonly<Record<string, readonly string[]>> =
  {
    "vane.infrastructure.mailbox": [
      "event_id",
      "fingerprint",
      "event_identity",
      "payload",
      "status",
      "result",
      "received_at",
      "completed_at",
    ],
    "vane.infrastructure.outbox": [
      "message_id",
      "event_id",
      "fingerprint",
      "event_identity",
      "payload",
      "correlation_id",
      "causation_id",
      "saga_id",
      "status",
      "attempt_count",
      "available_at",
      "occurred_at",
    ],
  };

export class PostgreSqlModuleRuntimeConfigurationError extends Error {
  readonly code = "VANE_MODULE_RUNTIME_CONFIGURATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "PostgreSqlModuleRuntimeConfigurationError";
  }
}

export class PostgreSqlModuleRuntimeStateError extends Error {
  readonly code = "VANE_MODULE_RUNTIME_STATE" as const;

  constructor(message: string) {
    super(message);
    this.name = "PostgreSqlModuleRuntimeStateError";
  }
}

export class PostgreSqlModuleEventNotFoundError extends Error {
  readonly code = "VANE_MODULE_EVENT_NOT_FOUND" as const;
  readonly eventIdentity: string;

  constructor(eventIdentity: string) {
    super(
      `Entity Event ${JSON.stringify(eventIdentity)} is not dispatched by this Module.`,
    );
    this.name = "PostgreSqlModuleEventNotFoundError";
    this.eventIdentity = eventIdentity;
  }
}

export class PostgreSqlModuleRuntime {
  readonly #module: SemanticModule;
  readonly #pool: PostgreSqlPoolLike;
  readonly #storage: PostgreSqlStorageIr;
  readonly #inFlight = new Set<Promise<EventExecutionResult>>();
  #dispatchTargets = new Map<string, DispatchTarget>();
  #eventRuntime: PostgreSqlEventRuntime | null = null;
  #state: PostgreSqlModuleRuntimeState = "stopped";
  #startPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;

  constructor(private readonly options: PostgreSqlModuleRuntimeOptions) {
    this.#module = options.module;
    this.#pool = options.pool;
    this.#storage = options.storage;
  }

  get semanticHash(): string {
    return hashSemanticModule(this.#module);
  }

  get state(): PostgreSqlModuleRuntimeState {
    return this.#state;
  }

  start(): Promise<void> {
    if (this.#state === "running") return Promise.resolve();
    if (this.#state === "starting" && this.#startPromise)
      return this.#startPromise;
    if (this.#state === "stopping") {
      return Promise.reject(
        new PostgreSqlModuleRuntimeStateError(
          "The Module runtime cannot start while it is stopping.",
        ),
      );
    }

    this.#state = "starting";
    const start = this.#open();
    this.#startPromise = start;
    return start;
  }

  dispatch(
    envelope: EventEnvelope,
    timeoutMs = this.options.timeouts?.[envelope.eventIdentity],
  ): Promise<EventExecutionResult> {
    if (this.#state !== "running" || !this.#eventRuntime) {
      return Promise.reject(
        new PostgreSqlModuleRuntimeStateError(
          "The Module runtime is not accepting Entity Events.",
        ),
      );
    }
    assertValidEventEnvelope(envelope);
    const target = this.#dispatchTargets.get(envelope.eventIdentity);
    if (!target) {
      return Promise.reject(
        new PostgreSqlModuleEventNotFoundError(envelope.eventIdentity),
      );
    }

    const runtime = this.#eventRuntime;
    const work = () =>
      runtime.execute({
        module: this.#module.name,
        entity: target.entity,
        event: target.event,
        envelope,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    const attributes = {
      eventId: envelope.eventId,
      eventIdentity: envelope.eventIdentity,
      sagaId: envelope.sagaId,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
    };
    const telemetry = this.options.telemetry;
    const execution = telemetry
      ? this.options.telemetry.span(
          "event",
          attributes,
          () => telemetry.span("persistence", attributes, work),
          (r) =>
            r.kind === "fail" ||
            (r.kind === "duplicate" && r.result.kind === "fail"),
        )
      : work();
    void execution.then(
      (r) => {
        if (r.kind === "duplicate")
          this.options.telemetry?.record("deduplication", attributes);
      },
      () => {},
    );
    this.#inFlight.add(execution);
    const remove = (): void => {
      this.#inFlight.delete(execution);
    };
    void execution.then(remove, remove);
    return execution;
  }

  stop(): Promise<void> {
    if (this.#state === "stopped") return Promise.resolve();
    if (this.#state === "stopping" && this.#stopPromise)
      return this.#stopPromise;

    const pendingStart = this.#state === "starting" ? this.#startPromise : null;
    this.#state = "stopping";
    const stop = (async (): Promise<void> => {
      if (pendingStart) {
        try {
          await pendingStart;
        } catch {
          // start() reports its own validation failure. stop() still owns the
          // transition back to a reusable stopped state.
        }
      }
      await Promise.allSettled([...this.#inFlight]);
      this.#eventRuntime = null;
      this.#dispatchTargets = new Map();
      this.#state = "stopped";
      this.#startPromise = null;
      this.#stopPromise = null;
    })();
    this.#stopPromise = stop;
    return stop;
  }

  async #open(): Promise<void> {
    try {
      const dispatchTargets = validateRuntimePlan(this.#module, this.#storage);
      await validatePostgreSqlDatabase(this.#pool, this.#storage);
      const eventRuntime = new PostgreSqlEventRuntime(
        this.#pool,
        this.#storage,
      );
      this.#dispatchTargets = dispatchTargets;
      this.#eventRuntime = eventRuntime;
      if (this.#state === "starting") this.#state = "running";
    } catch (error) {
      this.#dispatchTargets = new Map();
      this.#eventRuntime = null;
      if (this.#state === "starting") this.#state = "stopped";
      throw error;
    }
  }
}

function validateRuntimePlan(
  module: SemanticModule,
  storage: PostgreSqlStorageIr,
): Map<string, DispatchTarget> {
  if (module.name.trim().length === 0) configuration("Module name is empty.");
  if (storage.schema !== "vane.postgresql-storage-ir")
    configuration("Storage IR has an unsupported schema.");
  if (storage.version !== POSTGRESQL_STORAGE_IR_VERSION)
    configuration(
      `Storage IR version ${String(storage.version)} is not supported.`,
    );
  if (storage.provider.name !== "postgresql")
    configuration("Storage IR is not owned by the PostgreSQL provider.");
  if (
    !Number.isSafeInteger(storage.provider.minimumVersion) ||
    storage.provider.minimumVersion < 16
  )
    configuration("Storage IR requires an invalid PostgreSQL version.");
  if (
    storage.provider.namespace.trim().length === 0 ||
    storage.provider.namespace.includes("\0")
  )
    configuration("Storage IR has an invalid PostgreSQL namespace.");

  const tables = groupTables(storage.tables);
  for (const [semanticId, requiredColumns] of Object.entries(
    REQUIRED_TECHNICAL_COLUMNS,
  )) {
    const table = requireSingleTable(tables, semanticId);
    if (!table.technical || table.module !== null)
      configuration(
        `Storage table ${JSON.stringify(semanticId)} is not technical.`,
      );
    for (const column of requiredColumns) {
      const matches = table.columns.filter(
        (candidate) =>
          candidate.semanticId === `${semanticId}.${column}` &&
          candidate.name === column,
      );
      if (matches.length !== 1)
        configuration(
          `Storage table ${JSON.stringify(semanticId)} must contain exactly one runtime Column ${JSON.stringify(column)}.`,
        );
    }
  }

  const targets = new Map<string, DispatchTarget>();
  for (const entity of module.entities) {
    const tableId = `${module.name}.${entity.name}`;
    const table = requireSingleTable(tables, tableId);
    if (table.technical || table.module !== module.name)
      configuration(
        `Storage table ${JSON.stringify(tableId)} does not belong to Module ${JSON.stringify(module.name)}.`,
      );
    for (const column of entity.columns) {
      requireSingleColumn(table, `${tableId}.${column.name}`);
    }
    requireSingleColumn(table, `${tableId}.${entity.identityColumn}`);
    requireSingleColumn(table, `${tableId}.__vane_revision`);

    for (const event of entity.events) {
      const expectedIdentity = `${entity.name}.${event.name}`;
      if (
        event.identity !== expectedIdentity ||
        event.owner.kind !== "entity" ||
        event.owner.entity !== entity.name
      )
        configuration(
          `Entity Event ${JSON.stringify(event.identity)} has inconsistent owner identity; expected ${JSON.stringify(expectedIdentity)}.`,
        );
      if (targets.has(event.identity))
        configuration(
          `Entity Event identity ${JSON.stringify(event.identity)} is ambiguous in Module ${JSON.stringify(module.name)}.`,
        );
      targets.set(event.identity, { entity, event });
    }
  }
  return targets;
}

function groupTables(
  tables: readonly PostgreSqlTable[],
): ReadonlyMap<string, readonly PostgreSqlTable[]> {
  const grouped = new Map<string, PostgreSqlTable[]>();
  for (const table of tables) {
    const matches = grouped.get(table.semanticId) ?? [];
    matches.push(table);
    grouped.set(table.semanticId, matches);
  }
  return grouped;
}

function requireSingleTable(
  tables: ReadonlyMap<string, readonly PostgreSqlTable[]>,
  semanticId: string,
): PostgreSqlTable {
  const matches = tables.get(semanticId) ?? [];
  if (matches.length !== 1)
    configuration(
      `Storage IR must contain exactly one table ${JSON.stringify(semanticId)}; found ${matches.length}.`,
    );
  return matches[0] as PostgreSqlTable;
}

function requireSingleColumn(table: PostgreSqlTable, semanticId: string): void {
  const matches = table.columns.filter(
    (column) => column.semanticId === semanticId,
  );
  if (matches.length !== 1)
    configuration(
      `Storage table ${JSON.stringify(table.semanticId)} must contain exactly one Column ${JSON.stringify(semanticId)}; found ${matches.length}.`,
    );
}

async function validatePostgreSqlDatabase(
  pool: PostgreSqlPoolLike,
  storage: PostgreSqlStorageIr,
): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query<PostgreSqlVersionRow>(
      "SHOW server_version_num",
    );
    const raw = result.rows[0]?.server_version_num;
    const versionNumber =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number(raw)
          : Number.NaN;
    if (!Number.isSafeInteger(versionNumber))
      configuration("PostgreSQL did not report a valid server_version_num.");
    const minimum = storage.provider.minimumVersion * 10_000;
    if (versionNumber < minimum)
      configuration(
        `PostgreSQL ${String(raw)} cannot satisfy the required major version ${storage.provider.minimumVersion}.`,
      );

    const physicalTableNames = storage.tables.map((table) => table.name);
    const catalog = await client.query<PostgreSqlCatalogRow>(
      "SELECT table_name, column_name, udt_name, is_nullable, column_default, is_identity FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name, ordinal_position",
      [storage.provider.namespace, physicalTableNames],
    );
    const actualColumns = new Map<string, Map<string, PostgreSqlCatalogRow>>();
    for (const row of catalog.rows) {
      const columns =
        actualColumns.get(row.table_name) ??
        new Map<string, PostgreSqlCatalogRow>();
      columns.set(row.column_name, row);
      actualColumns.set(row.table_name, columns);
    }
    for (const table of storage.tables) {
      const actual = actualColumns.get(table.name);
      if (!actual)
        configuration(
          `PostgreSQL table ${JSON.stringify(`${storage.provider.namespace}.${table.name}`)} is missing; apply the compiled storage plan before start().`,
        );
      const expected = new Set(table.columns.map((column) => column.name));
      const missing = [...expected].filter((column) => !actual.has(column));
      const unexpected = [...actual.keys()].filter(
        (column) => !expected.has(column),
      );
      if (missing.length > 0 || unexpected.length > 0)
        configuration(
          `PostgreSQL table ${JSON.stringify(`${storage.provider.namespace}.${table.name}`)} has schema drift (missing: ${missing.sort().join(", ") || "none"}; unexpected: ${unexpected.sort().join(", ") || "none"}).`,
        );
      for (const column of table.columns) {
        const installed = actual.get(column.name);
        if (!installed) continue;
        const expectedUdt = POSTGRESQL_UDT[column.type];
        const expectedNullable = column.nullable ? "YES" : "NO";
        const expectedIdentity = column.generated === "identity" ? "YES" : "NO";
        if (
          installed.udt_name !== expectedUdt ||
          installed.is_nullable !== expectedNullable ||
          installed.is_identity !== expectedIdentity ||
          (column.generated === null &&
            normalizeDefault(installed.column_default, column.type) !==
              normalizeDefault(column.defaultSql, column.type))
        )
          configuration(
            `PostgreSQL Column ${JSON.stringify(`${storage.provider.namespace}.${table.name}.${column.name}`)} does not match its compiled type, nullability, generation or default.`,
          );
      }
    }

    const constraints = await client.query<PostgreSqlConstraintCatalogRow>(
      "SELECT relation.relname AS table_name, constraint_entry.conname AS object_name, constraint_entry.contype AS constraint_type, COALESCE(ARRAY(SELECT attribute.attname::text FROM unnest(constraint_entry.conkey) WITH ORDINALITY AS key(attnum, position) JOIN pg_attribute AS attribute ON attribute.attrelid = constraint_entry.conrelid AND attribute.attnum = key.attnum ORDER BY key.position), ARRAY[]::text[]) AS column_names, reference_relation.relname AS reference_table, CASE WHEN constraint_entry.confkey IS NULL THEN NULL ELSE ARRAY(SELECT attribute.attname::text FROM unnest(constraint_entry.confkey) WITH ORDINALITY AS key(attnum, position) JOIN pg_attribute AS attribute ON attribute.attrelid = constraint_entry.confrelid AND attribute.attnum = key.attnum ORDER BY key.position) END AS reference_columns, constraint_entry.confdeltype AS delete_action, constraint_entry.confupdtype AS update_action, CASE WHEN constraint_entry.contype = 'c' THEN pg_get_expr(constraint_entry.conbin, constraint_entry.conrelid) ELSE NULL END AS check_expression, constraint_entry.convalidated AS validated FROM pg_constraint AS constraint_entry JOIN pg_class AS relation ON relation.oid = constraint_entry.conrelid JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace LEFT JOIN pg_class AS reference_relation ON reference_relation.oid = constraint_entry.confrelid WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[]) ORDER BY relation.relname, constraint_entry.conname",
      [storage.provider.namespace, physicalTableNames],
    );
    assertConstraints(storage, constraints.rows);

    const indexes = await client.query<PostgreSqlIndexCatalogRow>(
      "SELECT relation.relname AS table_name, index_relation.relname AS object_name, index_entry.indisunique AS unique, ARRAY(SELECT pg_get_indexdef(index_entry.indexrelid, position, true) FROM generate_series(1, index_entry.indnkeyatts) AS position ORDER BY position) AS column_expressions, pg_get_expr(index_entry.indpred, index_entry.indrelid) AS predicate, access_method.amname AS access_method FROM pg_index AS index_entry JOIN pg_class AS relation ON relation.oid = index_entry.indrelid JOIN pg_class AS index_relation ON index_relation.oid = index_entry.indexrelid JOIN pg_am AS access_method ON access_method.oid = index_relation.relam JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace LEFT JOIN pg_constraint AS constraint_entry ON constraint_entry.conindid = index_entry.indexrelid WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[]) AND constraint_entry.oid IS NULL ORDER BY relation.relname, index_relation.relname",
      [storage.provider.namespace, physicalTableNames],
    );
    assertIndexes(storage, indexes.rows);

    const historyRelation = `${quotePostgreSqlIdentifier(storage.provider.namespace)}.${quotePostgreSqlIdentifier(POSTGRESQL_MIGRATION_HISTORY_TABLE)}`;
    const head = await client.query<PostgreSqlStorageHeadRow>(
      `SELECT target_hash FROM ${historyRelation} ORDER BY applied_order DESC LIMIT 1`,
    );
    const installedHash = head.rows[0]?.target_hash;
    const expectedHash = hashPostgreSqlStorageIr(storage);
    if (installedHash !== expectedHash)
      configuration(
        `PostgreSQL storage history is ${JSON.stringify(installedHash ?? null)}, but runtime requires ${JSON.stringify(expectedHash)}.`,
      );
  } finally {
    client.release();
  }
}

const POSTGRESQL_UDT = {
  text: "text",
  bigint: "int8",
  numeric: "numeric",
  boolean: "bool",
  date: "date",
  timestamptz: "timestamptz",
  uuid: "uuid",
  jsonb: "jsonb",
} as const;

function normalizeDefault(
  value: string | null,
  type: PostgreSqlStorageIr["tables"][number]["columns"][number]["type"],
): string | null {
  if (value === null) return null;
  const normalized = normalizeCatalogExpression(value);
  if (type !== "jsonb" || normalized === null) return normalized;
  const literal = /^'(.*)'$/su.exec(normalized);
  if (!literal) return normalized;
  try {
    return `jsonb:${canonicalJson(
      JSON.parse(literal[1]?.replaceAll("''", "'") ?? "") as Parameters<
        typeof canonicalJson
      >[0],
    )}`;
  } catch {
    return normalized;
  }
}

function assertConstraints(
  storage: PostgreSqlStorageIr,
  rows: readonly PostgreSqlConstraintCatalogRow[],
): void {
  const actual = new Map<string, Map<string, PostgreSqlConstraintCatalogRow>>();
  for (const row of rows) {
    const constraints =
      actual.get(row.table_name) ??
      new Map<string, PostgreSqlConstraintCatalogRow>();
    constraints.set(row.object_name, row);
    actual.set(row.table_name, constraints);
  }
  for (const table of storage.tables) {
    const expected = new Map(
      table.constraints.map((constraint) => [constraint.name, constraint]),
    );
    const installed = actual.get(table.name) ?? new Map();
    const missing = [...expected.keys()].filter((name) => !installed.has(name));
    const unexpected = [...installed.keys()].filter(
      (name) => !expected.has(name),
    );
    if (missing.length > 0 || unexpected.length > 0)
      configuration(
        `PostgreSQL table ${JSON.stringify(`${storage.provider.namespace}.${table.name}`)} has constraint drift (missing: ${missing.sort().join(", ") || "none"}; unexpected: ${unexpected.sort().join(", ") || "none"}).`,
      );
    for (const [name, constraint] of expected) {
      const found = installed.get(name);
      if (!found) continue;
      const expectedType = {
        primaryKey: "p",
        unique: "u",
        check: "c",
        foreignKey: "f",
      }[constraint.kind];
      const reference = constraint.references;
      const installedExpression = normalizeCatalogExpression(
        found.check_expression,
      );
      const expectedExpression = normalizeCatalogExpression(
        constraint.expression,
      );
      if (
        !found.validated ||
        found.constraint_type !== expectedType ||
        !sameStrings(found.column_names, constraint.columns) ||
        (reference !== null &&
          (found.reference_table !== reference.table ||
            !sameNullableStrings(found.reference_columns, [reference.column]) ||
            found.delete_action !== "a" ||
            found.update_action !== "a")) ||
        installedExpression !== expectedExpression
      )
        configuration(
          `PostgreSQL constraint ${JSON.stringify(`${storage.provider.namespace}.${table.name}.${name}`)} does not match its compiled definition (expected: ${JSON.stringify({ type: expectedType, columns: constraint.columns, reference, expression: expectedExpression, validated: true })}; installed: ${JSON.stringify({ type: found.constraint_type, columns: found.column_names, referenceTable: found.reference_table, referenceColumns: found.reference_columns, deleteAction: found.delete_action, updateAction: found.update_action, expression: installedExpression, validated: found.validated })}).`,
        );
    }
  }
}

function assertIndexes(
  storage: PostgreSqlStorageIr,
  rows: readonly PostgreSqlIndexCatalogRow[],
): void {
  const actual = new Map<string, Map<string, PostgreSqlIndexCatalogRow>>();
  for (const row of rows) {
    const indexes =
      actual.get(row.table_name) ??
      new Map<string, PostgreSqlIndexCatalogRow>();
    indexes.set(row.object_name, row);
    actual.set(row.table_name, indexes);
  }
  for (const table of storage.tables) {
    const expected = new Map(table.indexes.map((index) => [index.name, index]));
    const installed = actual.get(table.name) ?? new Map();
    const missing = [...expected.keys()].filter((name) => !installed.has(name));
    const unexpected = [...installed.keys()].filter(
      (name) => !expected.has(name),
    );
    if (missing.length > 0 || unexpected.length > 0)
      configuration(
        `PostgreSQL table ${JSON.stringify(`${storage.provider.namespace}.${table.name}`)} has index drift (missing: ${missing.sort().join(", ") || "none"}; unexpected: ${unexpected.sort().join(", ") || "none"}).`,
      );
    for (const [name, index] of expected) {
      const found = installed.get(name);
      if (
        found &&
        (found.access_method !== "btree" ||
          found.unique !== index.unique ||
          !sameStrings(
            found.column_expressions.map(normalizeCatalogIdentifier),
            index.columns.map(normalizeCatalogIdentifier),
          ) ||
          normalizeCatalogExpression(found.predicate) !==
            normalizeCatalogExpression(index.where))
      )
        configuration(
          `PostgreSQL index ${JSON.stringify(`${storage.provider.namespace}.${table.name}.${name}`)} does not match its compiled definition.`,
        );
    }
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

function sameNullableStrings(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && sameStrings(left, right);
}

function normalizeCatalogIdentifier(value: string): string {
  return value.replaceAll('"', "").trim();
}

function normalizeCatalogExpression(value: string | null): string | null {
  if (value === null) return null;
  let normalized = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character === "'") {
      normalized += character;
      if (quoted && value[index + 1] === "'") {
        normalized += "'";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (quoted) {
      normalized += character;
    } else if (!/\s/u.test(character) && character !== '"') {
      normalized += character.toLowerCase();
    }
  }
  while (hasSingleOuterParentheses(normalized)) {
    normalized = normalized.slice(1, -1);
  }
  normalized = transformUnquotedCatalogSegments(normalized, (segment) =>
    segment.replace(
      /::(?:text|bigint|integer|smallint|numeric|real|doubleprecision|boolean|date|timestampwithtimezone|uuid|jsonb)/giu,
      "",
    ),
  );
  normalized = transformUnquotedCatalogSegments(normalized, (segment) => {
    let canonical = segment;
    let previous = "";
    while (previous !== canonical) {
      previous = canonical;
      canonical = canonical.replace(
        /\(([-+]?\d+(?:\.\d+)?|true|false|null)\)/giu,
        "$1",
      );
    }
    return canonical;
  });
  while (hasSingleOuterParentheses(normalized)) {
    normalized = normalized.slice(1, -1);
  }
  const anyArray = normalized.match(/^(.+)=any\(array\[(.*)\]\)$/u);
  return anyArray ? `${anyArray[1]}in(${anyArray[2]})` : normalized;
}

function transformUnquotedCatalogSegments(
  value: string,
  transform: (segment: string) => string,
): string {
  let result = "";
  let segment = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character !== "'") {
      segment += character;
      continue;
    }
    if (!quoted) {
      result += transform(segment);
      segment = "'";
      quoted = true;
      continue;
    }
    segment += "'";
    if (value[index + 1] === "'") {
      segment += "'";
      index += 1;
      continue;
    }
    result += segment;
    segment = "";
    quoted = false;
  }
  return result + (quoted ? segment : transform(segment));
}

function hasSingleOuterParentheses(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && value[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0;
}

function configuration(message: string): never {
  throw new PostgreSqlModuleRuntimeConfigurationError(message);
}
