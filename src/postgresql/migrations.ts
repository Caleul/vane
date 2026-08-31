import { createHash } from "node:crypto";
import { quotePostgreSqlIdentifier } from "./identifiers.js";
import type {
  PostgreSqlColumn,
  PostgreSqlConstraint,
  PostgreSqlIndex,
  PostgreSqlStorageIr,
  PostgreSqlTable,
} from "./storage-ir.js";
import { POSTGRESQL_STORAGE_IR_VERSION } from "./storage-ir.js";

export const POSTGRESQL_MIGRATION_PLAN_VERSION = 1 as const;
export const POSTGRESQL_MIGRATION_HISTORY_SEMANTIC_ID =
  "vane.infrastructure.migrations";
export const POSTGRESQL_MIGRATION_HISTORY_TABLE = "__vane_migrations";

export type PostgreSqlMigrationClassification =
  | "safe"
  | "unsafe"
  | "destructive";

export type PostgreSqlMigrationStepKind =
  | "renameTable"
  | "createTable"
  | "renameColumn"
  | "addColumn"
  | "alterColumnType"
  | "alterColumnNullability"
  | "alterColumnDefault"
  | "alterColumnGeneration"
  | "dropConstraint"
  | "addConstraint"
  | "dropIndex"
  | "createIndex"
  | "dropColumn"
  | "dropTable";

export interface PostgreSqlTableRename {
  readonly fromSemanticId: string;
  readonly toSemanticId: string;
}

export interface PostgreSqlColumnRename {
  readonly fromTableSemanticId: string;
  readonly fromColumnSemanticId: string;
  readonly toTableSemanticId: string;
  readonly toColumnSemanticId: string;
}

export interface PostgreSqlRenameMap {
  readonly tables?: readonly PostgreSqlTableRename[];
  readonly columns?: readonly PostgreSqlColumnRename[];
}

export interface PostgreSqlMigrationStep {
  readonly id: string;
  readonly kind: PostgreSqlMigrationStepKind;
  readonly semanticId: string;
  readonly classification: PostgreSqlMigrationClassification;
  readonly sql: string;
}

export interface PostgreSqlMigrationPlan {
  readonly schema: "vane.postgresql-migration-plan";
  readonly version: typeof POSTGRESQL_MIGRATION_PLAN_VERSION;
  readonly hash: string;
  readonly sourceHash: string;
  readonly targetHash: string;
  readonly namespace: string;
  readonly classification: PostgreSqlMigrationClassification;
  readonly noOp: boolean;
  readonly renames: {
    readonly tables: readonly PostgreSqlTableRename[];
    readonly columns: readonly PostgreSqlColumnRename[];
  };
  readonly steps: readonly PostgreSqlMigrationStep[];
  readonly sql: string;
}

export interface CreatePostgreSqlMigrationPlanInput {
  readonly previous: PostgreSqlStorageIr | null;
  readonly next: PostgreSqlStorageIr;
  readonly renames?: PostgreSqlRenameMap;
}

export class PostgreSqlMigrationPlanningError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("\n"));
    this.name = "PostgreSqlMigrationPlanningError";
    this.issues = issues;
  }
}

interface TablePair {
  readonly previous: PostgreSqlTable;
  readonly next: PostgreSqlTable;
  readonly renamed: boolean;
}

interface ColumnPair {
  readonly previous: PostgreSqlColumn;
  readonly next: PostgreSqlColumn;
  readonly renamed: boolean;
}

interface PendingStep {
  readonly kind: PostgreSqlMigrationStepKind;
  readonly semanticId: string;
  readonly classification: PostgreSqlMigrationClassification;
  readonly sql: string;
}

const STEP_ORDER: Readonly<Record<PostgreSqlMigrationStepKind, number>> = {
  renameTable: 10,
  createTable: 20,
  renameColumn: 30,
  dropConstraint: 35,
  dropIndex: 36,
  addColumn: 40,
  alterColumnType: 50,
  alterColumnGeneration: 60,
  alterColumnDefault: 70,
  alterColumnNullability: 80,
  addConstraint: 100,
  createIndex: 120,
  dropColumn: 130,
  dropTable: 140,
};

const CLASSIFICATION_ORDER: Readonly<
  Record<PostgreSqlMigrationClassification, number>
> = { safe: 0, unsafe: 1, destructive: 2 };

export function createPostgreSqlMigrationPlan(
  input: CreatePostgreSqlMigrationPlanInput,
): PostgreSqlMigrationPlan {
  validateStorageInputs(input.previous, input.next);
  const renames = normalizeRenames(input.renames);
  const tablePairs = pairTables(
    input.previous?.tables ?? [],
    input.next.tables,
    renames,
  );
  validateTableRenameCollisions(
    tablePairs,
    migrationManagedTables(input.previous?.tables ?? []),
  );
  validateColumnRenameTables(renames.columns, tablePairs);
  const pairedPreviousIds = new Set(
    tablePairs.map(({ previous }) => previous.semanticId),
  );
  const pairedNextIds = new Set(tablePairs.map(({ next }) => next.semanticId));
  const removedTables = migrationManagedTables(
    input.previous?.tables ?? [],
  ).filter(({ semanticId }) => !pairedPreviousIds.has(semanticId));
  const addedTables = migrationManagedTables(input.next.tables).filter(
    ({ semanticId }) => !pairedNextIds.has(semanticId),
  );

  const steps: PendingStep[] = [];
  for (const pair of tablePairs) {
    if (pair.renamed) {
      steps.push({
        kind: "renameTable",
        semanticId: `${pair.previous.semanticId}->${pair.next.semanticId}`,
        classification: "unsafe",
        sql: statement(
          `ALTER TABLE ${qualified(input.next.provider.namespace, pair.previous.name)} RENAME TO ${quotePostgreSqlIdentifier(pair.next.name)}`,
        ),
      });
    }
    diffPairedTable(pair, input.next.provider.namespace, renames, steps);
  }

  for (const table of addedTables) {
    steps.push({
      kind: "createTable",
      semanticId: table.semanticId,
      classification: "safe",
      sql: renderCreateTable(input.next.provider.namespace, table),
    });
    for (const constraint of sorted(table.constraints).filter(
      ({ kind }) => kind === "foreignKey",
    )) {
      steps.push(
        renderAddConstraint(
          input.next.provider.namespace,
          table,
          constraint,
          "safe",
        ),
      );
    }
    for (const index of sorted(table.indexes)) {
      steps.push(
        renderCreateIndex(input.next.provider.namespace, table, index, "safe"),
      );
    }
  }

  for (const table of removedTables) {
    for (const constraint of sorted(table.constraints).filter(
      ({ kind }) => kind === "foreignKey",
    )) {
      steps.push(
        renderDropConstraint(input.next.provider.namespace, table, constraint),
      );
    }
    steps.push({
      kind: "dropTable",
      semanticId: table.semanticId,
      classification: "destructive",
      sql: statement(
        `DROP TABLE ${qualified(input.next.provider.namespace, table.name)}`,
      ),
    });
  }

  const canonicalSteps = steps
    .sort(comparePendingSteps)
    .map<PostgreSqlMigrationStep>((step) => ({
      ...step,
      id: sha256(canonicalJson(step)),
    }));
  const sourceHash = hashStorageIr(input.previous);
  const targetHash = hashStorageIr(input.next);
  const sql = canonicalSteps.map(({ sql: value }) => value).join("\n");
  const classification = highestClassification(
    canonicalSteps.map(({ classification: value }) => value),
  );
  const content = {
    schema: "vane.postgresql-migration-plan" as const,
    version: POSTGRESQL_MIGRATION_PLAN_VERSION,
    sourceHash,
    targetHash,
    namespace: input.next.provider.namespace,
    classification,
    noOp: canonicalSteps.length === 0,
    renames,
    steps: canonicalSteps,
    sql,
  };
  return { ...content, hash: sha256(canonicalJson(content)) };
}

export function serializePostgreSqlMigrationPlan(
  plan: PostgreSqlMigrationPlan,
): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function hashPostgreSqlStorageIr(
  storageIr: PostgreSqlStorageIr | null,
): string {
  return hashStorageIr(storageIr);
}

export function verifyPostgreSqlMigrationPlanHash(
  plan: PostgreSqlMigrationPlan,
): boolean {
  const { hash, ...content } = plan;
  return sha256(canonicalJson(content)) === hash;
}

function validateStorageInputs(
  previous: PostgreSqlStorageIr | null,
  next: PostgreSqlStorageIr,
): void {
  const issues: string[] = [];
  if (
    next.schema !== "vane.postgresql-storage-ir" ||
    next.version !== POSTGRESQL_STORAGE_IR_VERSION
  ) {
    issues.push(
      `The next snapshot is not a supported PostgreSQL Storage IR v${POSTGRESQL_STORAGE_IR_VERSION}.`,
    );
  }
  if (
    next.provider.name !== "postgresql" ||
    next.provider.minimumVersion !== 16
  ) {
    issues.push(
      "The next snapshot does not target the supported PostgreSQL 16 profile.",
    );
  }
  if (previous) {
    if (previous.schema !== next.schema || previous.version !== next.version) {
      issues.push(
        "Previous and next snapshots must use the same Storage IR version.",
      );
    }
    if (
      previous.provider.name !== next.provider.name ||
      previous.provider.minimumVersion !== next.provider.minimumVersion
    ) {
      issues.push(
        "Previous and next snapshots must target the same PostgreSQL profile.",
      );
    }
    if (previous.provider.namespace !== next.provider.namespace) {
      issues.push(
        "Namespace changes require an explicit cross-namespace migration and are not inferred.",
      );
    }
  }
  validateUniqueSemanticIds(next.tables, "next tables", issues);
  validateUniqueSemanticIds(previous?.tables ?? [], "previous tables", issues);
  for (const table of [...(previous?.tables ?? []), ...next.tables]) {
    validateUniqueSemanticIds(
      table.columns,
      `columns of ${table.semanticId}`,
      issues,
    );
    validateUniqueSemanticIds(
      table.constraints,
      `constraints of ${table.semanticId}`,
      issues,
    );
    validateUniqueSemanticIds(
      table.indexes,
      `indexes of ${table.semanticId}`,
      issues,
    );
  }
  if (issues.length > 0)
    throw new PostgreSqlMigrationPlanningError(issues.sort(compare));
}

function validateUniqueSemanticIds(
  values: readonly { readonly semanticId: string }[],
  subject: string,
  issues: string[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.semanticId)) {
      issues.push(`Duplicate semanticId ${value.semanticId} in ${subject}.`);
    }
    seen.add(value.semanticId);
  }
}

function normalizeRenames(renameMap: PostgreSqlRenameMap | undefined): {
  readonly tables: readonly PostgreSqlTableRename[];
  readonly columns: readonly PostgreSqlColumnRename[];
} {
  return {
    tables: [...(renameMap?.tables ?? [])].sort((left, right) =>
      compare(
        `${left.fromSemanticId}\u0000${left.toSemanticId}`,
        `${right.fromSemanticId}\u0000${right.toSemanticId}`,
      ),
    ),
    columns: [...(renameMap?.columns ?? [])].sort((left, right) =>
      compare(columnRenameKey(left), columnRenameKey(right)),
    ),
  };
}

function pairTables(
  previousTables: readonly PostgreSqlTable[],
  nextTables: readonly PostgreSqlTable[],
  renames: ReturnType<typeof normalizeRenames>,
): readonly TablePair[] {
  const previousById = new Map(
    migrationManagedTables(previousTables).map((table) => [
      table.semanticId,
      table,
    ]),
  );
  const nextById = new Map(
    migrationManagedTables(nextTables).map((table) => [
      table.semanticId,
      table,
    ]),
  );
  const usedPrevious = new Set<string>();
  const usedNext = new Set<string>();
  const pairs: TablePair[] = [];
  const issues: string[] = [];

  for (const rename of renames.tables) {
    const previous = previousById.get(rename.fromSemanticId);
    const next = nextById.get(rename.toSemanticId);
    if (!previous)
      issues.push(`Unknown renamed source table ${rename.fromSemanticId}.`);
    if (!next)
      issues.push(`Unknown renamed target table ${rename.toSemanticId}.`);
    if (usedPrevious.has(rename.fromSemanticId)) {
      issues.push(`Table ${rename.fromSemanticId} is renamed more than once.`);
    }
    if (usedNext.has(rename.toSemanticId)) {
      issues.push(`Multiple tables rename to ${rename.toSemanticId}.`);
    }
    if (!previous || !next) continue;
    usedPrevious.add(rename.fromSemanticId);
    usedNext.add(rename.toSemanticId);
    pairs.push({ previous, next, renamed: previous.name !== next.name });
  }

  for (const previous of sorted(previousById.values())) {
    const next = nextById.get(previous.semanticId);
    if (
      !next ||
      usedPrevious.has(previous.semanticId) ||
      usedNext.has(next.semanticId)
    )
      continue;
    if (previous.name !== next.name) continue;
    usedPrevious.add(previous.semanticId);
    usedNext.add(next.semanticId);
    pairs.push({ previous, next, renamed: false });
  }
  if (issues.length > 0)
    throw new PostgreSqlMigrationPlanningError(issues.sort(compare));
  return pairs.sort((left, right) =>
    compare(left.next.semanticId, right.next.semanticId),
  );
}

function validateColumnRenameTables(
  columnRenames: readonly PostgreSqlColumnRename[],
  tablePairs: readonly TablePair[],
): void {
  const issues = columnRenames
    .filter(
      (rename) =>
        !tablePairs.some(
          (pair) =>
            pair.previous.semanticId === rename.fromTableSemanticId &&
            pair.next.semanticId === rename.toTableSemanticId,
        ),
    )
    .map(
      (rename) =>
        `Column rename ${columnRenameKey(rename)} does not follow a paired table rename.`,
    );
  if (issues.length > 0)
    throw new PostgreSqlMigrationPlanningError(issues.sort(compare));
}

function validateTableRenameCollisions(
  tablePairs: readonly TablePair[],
  previousTables: readonly PostgreSqlTable[],
): void {
  const previousNames = new Map(
    previousTables.map((table) => [table.name, table.semanticId] as const),
  );
  const issues = tablePairs.flatMap((pair) => {
    if (!pair.renamed) return [];
    const occupiedBy = previousNames.get(pair.next.name);
    return occupiedBy && occupiedBy !== pair.previous.semanticId
      ? [
          `Table rename ${pair.previous.semanticId}->${pair.next.semanticId} targets physical name ${pair.next.name} still occupied by ${occupiedBy}; rename swaps and cycles are not supported.`,
        ]
      : [];
  });
  if (issues.length > 0)
    throw new PostgreSqlMigrationPlanningError(issues.sort(compare));
}

function diffPairedTable(
  pair: TablePair,
  namespace: string,
  renames: ReturnType<typeof normalizeRenames>,
  steps: PendingStep[],
): void {
  const columnPairs = pairColumns(pair, renames);
  validateColumnRenameCollisions(pair, columnPairs);
  const pairedPrevious = new Set(
    columnPairs.map(({ previous }) => previous.semanticId),
  );
  const pairedNext = new Set(columnPairs.map(({ next }) => next.semanticId));

  for (const columnPair of columnPairs) {
    if (columnPair.renamed) {
      steps.push({
        kind: "renameColumn",
        semanticId: `${pair.next.semanticId}:${columnPair.previous.semanticId}->${columnPair.next.semanticId}`,
        classification: "unsafe",
        sql: statement(
          `ALTER TABLE ${qualified(namespace, pair.next.name)} RENAME COLUMN ${quotePostgreSqlIdentifier(columnPair.previous.name)} TO ${quotePostgreSqlIdentifier(columnPair.next.name)}`,
        ),
      });
    }
    diffColumn(
      namespace,
      pair.next,
      columnPair.previous,
      columnPair.next,
      steps,
    );
  }

  for (const column of sorted(pair.next.columns).filter(
    ({ semanticId }) => !pairedNext.has(semanticId),
  )) {
    steps.push({
      kind: "addColumn",
      semanticId: `${pair.next.semanticId}:${column.semanticId}`,
      classification:
        column.nullable && column.defaultSql === null ? "safe" : "unsafe",
      sql: statement(
        `ALTER TABLE ${qualified(namespace, pair.next.name)} ADD COLUMN ${renderColumn(column)}`,
      ),
    });
  }

  diffConstraints(namespace, pair, steps);
  diffIndexes(namespace, pair, steps);

  for (const column of sorted(pair.previous.columns).filter(
    ({ semanticId }) => !pairedPrevious.has(semanticId),
  )) {
    steps.push({
      kind: "dropColumn",
      semanticId: `${pair.previous.semanticId}:${column.semanticId}`,
      classification: "destructive",
      sql: statement(
        `ALTER TABLE ${qualified(namespace, pair.next.name)} DROP COLUMN ${quotePostgreSqlIdentifier(column.name)}`,
      ),
    });
  }
}

function validateColumnRenameCollisions(
  tablePair: TablePair,
  columnPairs: readonly ColumnPair[],
): void {
  const previousNames = new Map(
    tablePair.previous.columns.map(
      (column) => [column.name, column.semanticId] as const,
    ),
  );
  const issues = columnPairs.flatMap((pair) => {
    if (!pair.renamed) return [];
    const occupiedBy = previousNames.get(pair.next.name);
    return occupiedBy && occupiedBy !== pair.previous.semanticId
      ? [
          `Column rename ${pair.previous.semanticId}->${pair.next.semanticId} targets physical name ${pair.next.name} still occupied by ${occupiedBy}; rename swaps and cycles are not supported.`,
        ]
      : [];
  });
  if (issues.length > 0)
    throw new PostgreSqlMigrationPlanningError(issues.sort(compare));
}

function pairColumns(
  tablePair: TablePair,
  renames: ReturnType<typeof normalizeRenames>,
): readonly ColumnPair[] {
  const previousById = new Map(
    tablePair.previous.columns.map((column) => [column.semanticId, column]),
  );
  const nextById = new Map(
    tablePair.next.columns.map((column) => [column.semanticId, column]),
  );
  const usedPrevious = new Set<string>();
  const usedNext = new Set<string>();
  const pairs: ColumnPair[] = [];
  const issues: string[] = [];
  const relevant = renames.columns.filter(
    (rename) =>
      rename.fromTableSemanticId === tablePair.previous.semanticId ||
      rename.toTableSemanticId === tablePair.next.semanticId,
  );

  for (const rename of relevant) {
    if (
      rename.fromTableSemanticId !== tablePair.previous.semanticId ||
      rename.toTableSemanticId !== tablePair.next.semanticId
    ) {
      issues.push(
        `Column rename ${columnRenameKey(rename)} does not follow a paired table rename.`,
      );
      continue;
    }
    const previous = previousById.get(rename.fromColumnSemanticId);
    const next = nextById.get(rename.toColumnSemanticId);
    if (!previous)
      issues.push(
        `Unknown renamed source column ${rename.fromColumnSemanticId}.`,
      );
    if (!next)
      issues.push(
        `Unknown renamed target column ${rename.toColumnSemanticId}.`,
      );
    if (usedPrevious.has(rename.fromColumnSemanticId)) {
      issues.push(
        `Column ${rename.fromColumnSemanticId} is renamed more than once.`,
      );
    }
    if (usedNext.has(rename.toColumnSemanticId)) {
      issues.push(`Multiple columns rename to ${rename.toColumnSemanticId}.`);
    }
    if (!previous || !next) continue;
    usedPrevious.add(rename.fromColumnSemanticId);
    usedNext.add(rename.toColumnSemanticId);
    pairs.push({ previous, next, renamed: previous.name !== next.name });
  }

  for (const previous of sorted(previousById.values())) {
    const next = nextById.get(previous.semanticId);
    if (
      !next ||
      usedPrevious.has(previous.semanticId) ||
      usedNext.has(next.semanticId)
    )
      continue;
    if (previous.name !== next.name) continue;
    usedPrevious.add(previous.semanticId);
    usedNext.add(next.semanticId);
    pairs.push({ previous, next, renamed: false });
  }
  if (issues.length > 0)
    throw new PostgreSqlMigrationPlanningError(issues.sort(compare));
  return pairs.sort((left, right) =>
    compare(left.next.semanticId, right.next.semanticId),
  );
}

function diffColumn(
  namespace: string,
  table: PostgreSqlTable,
  previous: PostgreSqlColumn,
  next: PostgreSqlColumn,
  steps: PendingStep[],
): void {
  const prefix = `ALTER TABLE ${qualified(namespace, table.name)} ALTER COLUMN ${quotePostgreSqlIdentifier(next.name)}`;
  const semanticId = `${table.semanticId}:${next.semanticId}`;
  const dropsDefaultBeforeIdentity =
    previous.generated === null &&
    next.generated === "identity" &&
    previous.defaultSql !== null &&
    next.defaultSql === null;
  if (previous.type !== next.type) {
    steps.push({
      kind: "alterColumnType",
      semanticId,
      classification: "destructive",
      sql: statement(
        `${prefix} TYPE ${next.type} USING ${quotePostgreSqlIdentifier(next.name)}::${next.type}`,
      ),
    });
  }
  if (previous.generated !== next.generated) {
    steps.push({
      kind: "alterColumnGeneration",
      semanticId,
      classification: "destructive",
      sql: statement(
        next.generated === "identity"
          ? `${dropsDefaultBeforeIdentity ? `${prefix} DROP DEFAULT;\n` : ""}${prefix} ADD GENERATED BY DEFAULT AS IDENTITY`
          : `${prefix} DROP IDENTITY`,
      ),
    });
  }
  if (previous.defaultSql !== next.defaultSql && !dropsDefaultBeforeIdentity) {
    steps.push({
      kind: "alterColumnDefault",
      semanticId,
      classification: "unsafe",
      sql: statement(
        next.defaultSql === null
          ? `${prefix} DROP DEFAULT`
          : `${prefix} SET DEFAULT ${next.defaultSql}`,
      ),
    });
  }
  if (previous.nullable !== next.nullable) {
    steps.push({
      kind: "alterColumnNullability",
      semanticId,
      classification: "unsafe",
      sql: statement(`${prefix} ${next.nullable ? "DROP" : "SET"} NOT NULL`),
    });
  }
}

function diffConstraints(
  namespace: string,
  pair: TablePair,
  steps: PendingStep[],
): void {
  const previousById = new Map(
    pair.previous.constraints.map((constraint) => [
      constraint.semanticId,
      constraint,
    ]),
  );
  const nextById = new Map(
    pair.next.constraints.map((constraint) => [
      constraint.semanticId,
      constraint,
    ]),
  );
  for (const previous of sorted(pair.previous.constraints)) {
    const next = nextById.get(previous.semanticId);
    if (!next || !sameConstraint(previous, next)) {
      steps.push(renderDropConstraint(namespace, pair.next, previous));
    }
  }
  for (const next of sorted(pair.next.constraints)) {
    const previous = previousById.get(next.semanticId);
    if (!previous || !sameConstraint(previous, next)) {
      steps.push(renderAddConstraint(namespace, pair.next, next, "unsafe"));
    }
  }
}

function diffIndexes(
  namespace: string,
  pair: TablePair,
  steps: PendingStep[],
): void {
  const previousById = new Map(
    pair.previous.indexes.map((index) => [index.semanticId, index]),
  );
  const nextById = new Map(
    pair.next.indexes.map((index) => [index.semanticId, index]),
  );
  for (const previous of sorted(pair.previous.indexes)) {
    const next = nextById.get(previous.semanticId);
    if (!next || canonicalJson(previous) !== canonicalJson(next)) {
      steps.push({
        kind: "dropIndex",
        semanticId: `${pair.previous.semanticId}:${previous.semanticId}`,
        classification: "unsafe",
        sql: statement(`DROP INDEX ${qualified(namespace, previous.name)}`),
      });
    }
  }
  for (const next of sorted(pair.next.indexes)) {
    const previous = previousById.get(next.semanticId);
    if (!previous || canonicalJson(previous) !== canonicalJson(next)) {
      steps.push(renderCreateIndex(namespace, pair.next, next, "unsafe"));
    }
  }
}

function renderCreateTable(namespace: string, table: PostgreSqlTable): string {
  const definitions = [
    ...sorted(table.columns).map(renderColumn),
    ...sorted(table.constraints)
      .filter(({ kind }) => kind !== "foreignKey")
      .map((constraint) => renderConstraint(constraint, namespace)),
  ];
  return statement(
    `CREATE TABLE ${qualified(namespace, table.name)} (\n  ${definitions.join(",\n  ")}\n)`,
  );
}

function renderColumn(column: PostgreSqlColumn): string {
  return [
    quotePostgreSqlIdentifier(column.name),
    column.type,
    column.generated === "identity" ? "GENERATED BY DEFAULT AS IDENTITY" : null,
    column.defaultSql === null ? null : `DEFAULT ${column.defaultSql}`,
    column.nullable ? null : "NOT NULL",
  ]
    .filter((value): value is string => value !== null)
    .join(" ");
}

function renderConstraint(
  constraint: PostgreSqlConstraint,
  namespace: string,
): string {
  const prefix = `CONSTRAINT ${quotePostgreSqlIdentifier(constraint.name)}`;
  const columns = constraint.columns.map(quotePostgreSqlIdentifier).join(", ");
  switch (constraint.kind) {
    case "primaryKey":
      return `${prefix} PRIMARY KEY (${columns})`;
    case "unique":
      return `${prefix} UNIQUE (${columns})`;
    case "check":
      if (constraint.expression === null) {
        throw new PostgreSqlMigrationPlanningError([
          `CHECK constraint ${constraint.semanticId} has no expression.`,
        ]);
      }
      return `${prefix} CHECK (${constraint.expression})`;
    case "foreignKey":
      if (constraint.references === null) {
        throw new PostgreSqlMigrationPlanningError([
          `Foreign key ${constraint.semanticId} has no reference.`,
        ]);
      }
      return `${prefix} FOREIGN KEY (${columns}) REFERENCES ${qualified(namespace, constraint.references.table)} (${quotePostgreSqlIdentifier(constraint.references.column)}) ON DELETE ${constraint.references.onDelete} ON UPDATE ${constraint.references.onUpdate}`;
  }
}

function renderAddConstraint(
  namespace: string,
  table: PostgreSqlTable,
  constraint: PostgreSqlConstraint,
  classification: PostgreSqlMigrationClassification,
): PendingStep {
  return {
    kind: "addConstraint",
    semanticId: `${table.semanticId}:${constraint.semanticId}`,
    classification,
    sql: statement(
      `ALTER TABLE ${qualified(namespace, table.name)} ADD ${renderConstraint(constraint, namespace)}`,
    ),
  };
}

function renderDropConstraint(
  namespace: string,
  table: PostgreSqlTable,
  constraint: PostgreSqlConstraint,
): PendingStep {
  return {
    kind: "dropConstraint",
    semanticId: `${table.semanticId}:${constraint.semanticId}`,
    classification: "unsafe",
    sql: statement(
      `ALTER TABLE ${qualified(namespace, table.name)} DROP CONSTRAINT ${quotePostgreSqlIdentifier(constraint.name)}`,
    ),
  };
}

function renderCreateIndex(
  namespace: string,
  table: PostgreSqlTable,
  index: PostgreSqlIndex,
  classification: PostgreSqlMigrationClassification,
): PendingStep {
  const columns = index.columns.map(quotePostgreSqlIdentifier).join(", ");
  return {
    kind: "createIndex",
    semanticId: `${table.semanticId}:${index.semanticId}`,
    classification,
    sql: statement(
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quotePostgreSqlIdentifier(index.name)} ON ${qualified(namespace, table.name)} (${columns})${index.where === null ? "" : ` WHERE ${index.where}`}`,
    ),
  };
}

function sameConstraint(
  previous: PostgreSqlConstraint,
  next: PostgreSqlConstraint,
): boolean {
  return canonicalJson(previous) === canonicalJson(next);
}

function migrationManagedTables(
  tables: readonly PostgreSqlTable[],
): readonly PostgreSqlTable[] {
  return tables.filter(
    ({ semanticId }) => semanticId !== POSTGRESQL_MIGRATION_HISTORY_SEMANTIC_ID,
  );
}

function hashStorageIr(storageIr: PostgreSqlStorageIr | null): string {
  return sha256(
    canonicalJson(storageIr === null ? null : normalizeStorageIr(storageIr)),
  );
}

function normalizeStorageIr(
  storageIr: PostgreSqlStorageIr,
): PostgreSqlStorageIr {
  return {
    ...storageIr,
    tables: sorted(storageIr.tables).map((table) => ({
      ...table,
      columns: sorted(table.columns),
      constraints: sorted(table.constraints),
      indexes: sorted(table.indexes),
    })),
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function qualified(namespace: string, name: string): string {
  return `${quotePostgreSqlIdentifier(namespace)}.${quotePostgreSqlIdentifier(name)}`;
}

function statement(sql: string): string {
  return `${sql};`;
}

function columnRenameKey(rename: PostgreSqlColumnRename): string {
  return `${rename.fromTableSemanticId}\u0000${rename.fromColumnSemanticId}\u0000${rename.toTableSemanticId}\u0000${rename.toColumnSemanticId}`;
}

function highestClassification(
  values: readonly PostgreSqlMigrationClassification[],
): PostgreSqlMigrationClassification {
  return values.reduce<PostgreSqlMigrationClassification>(
    (highest, current) =>
      CLASSIFICATION_ORDER[current] > CLASSIFICATION_ORDER[highest]
        ? current
        : highest,
    "safe",
  );
}

function comparePendingSteps(left: PendingStep, right: PendingStep): number {
  const byKind = STEP_ORDER[left.kind] - STEP_ORDER[right.kind];
  if (byKind !== 0) return byKind;
  const bySemanticId = compare(left.semanticId, right.semanticId);
  if (bySemanticId !== 0) return bySemanticId;
  return compare(left.sql, right.sql);
}

function sorted<T extends { readonly semanticId: string }>(
  values: Iterable<T>,
): readonly T[] {
  return [...values].sort((left, right) => {
    const bySemanticId = compare(left.semanticId, right.semanticId);
    if (bySemanticId !== 0) return bySemanticId;
    return compare(JSON.stringify(left), JSON.stringify(right));
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
