import type {
  ColumnType,
  JsonValue,
  ViewExpressionDeclaration,
  ViewPaginationValueDeclaration,
  ViewValueDeclaration,
} from "../declaration.js";
import type { SemanticModule, SemanticView } from "../semantic-ir.js";
import { quotePostgreSqlIdentifier } from "./identifiers.js";
import type { PostgreSqlPoolLike } from "./runtime.js";
import type { PostgreSqlStorageIr, PostgreSqlTable } from "./storage-ir.js";

export interface ExecuteViewInput {
  readonly view: string;
  readonly input: Readonly<Record<string, JsonValue>>;
}

export interface ViewExecutionResult {
  readonly kind: "view";
  readonly view: string;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export class PostgreSqlViewNotFoundError extends Error {
  readonly code = "VANE_VIEW_NOT_FOUND" as const;
  constructor(readonly view: string) {
    super(`View ${JSON.stringify(view)} is not declared by this Module.`);
    this.name = "PostgreSqlViewNotFoundError";
  }
}

export class ViewInputError extends Error {
  readonly code = "VANE_VIEW_INPUT_INVALID" as const;
  constructor(readonly problems: readonly string[]) {
    super(`The View input is invalid: ${problems.join(", ")}.`);
    this.name = "ViewInputError";
  }
}

export class PostgreSqlViewRuntimeConfigurationError extends Error {
  readonly code = "VANE_VIEW_RUNTIME_CONFIGURATION" as const;
  constructor(message: string) {
    super(message);
    this.name = "PostgreSqlViewRuntimeConfigurationError";
  }
}

export class PostgreSqlViewRuntime {
  readonly #module: SemanticModule;
  readonly #pool: PostgreSqlPoolLike;
  readonly #storage: PostgreSqlStorageIr;
  readonly #modules: readonly SemanticModule[];

  constructor(
    module: SemanticModule,
    pool: PostgreSqlPoolLike,
    storage: PostgreSqlStorageIr,
    modules: readonly SemanticModule[] = [module],
  ) {
    this.#module = module;
    this.#pool = pool;
    this.#storage = storage;
    this.#modules = modules;
  }

  async execute(request: ExecuteViewInput): Promise<ViewExecutionResult> {
    const view = this.#module.views.find(
      (candidate) => candidate.name === request.view,
    );
    if (!view) throw new PostgreSqlViewNotFoundError(request.view);
    validateViewInput(view, request.input);
    const query = buildViewSql(
      this.#module,
      view,
      request.input,
      this.#storage,
      this.#modules,
    );
    const client = await this.#pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        query.text,
        query.values,
      );
      return {
        kind: "view",
        view: view.name,
        rows: result.rows.map((row) => normalizeViewRow(view, row)),
      };
    } finally {
      client.release();
    }
  }
}

interface BuiltViewSql {
  readonly text: string;
  readonly values: unknown[];
}

function buildViewSql(
  module: SemanticModule,
  view: SemanticView,
  input: Readonly<Record<string, JsonValue>>,
  storage: PostgreSqlStorageIr,
  modules: readonly SemanticModule[],
): BuiltViewSql {
  const entityModules = resolveVisibleEntityModules(module, modules);
  const aliases = new Map<string, string>([[view.query.root, "v0"]]);
  const root = entityTable(
    entityModule(view.query.root, entityModules),
    view.query.root,
    storage,
  );
  const joins: string[] = [];
  const pending = [...view.query.relations];
  while (pending.length > 0) {
    const index = pending.findIndex(
      (relation) =>
        aliases.has(relation.from.entity) || aliases.has(relation.to.entity),
    );
    if (index < 0) {
      throw new PostgreSqlViewRuntimeConfigurationError(
        `View ${view.name} contains a disconnected relation graph.`,
      );
    }
    const [relation] = pending.splice(index, 1);
    if (!relation) break;
    const fromKnown = aliases.has(relation.from.entity);
    const known = fromKnown ? relation.from : relation.to;
    const added = fromKnown ? relation.to : relation.from;
    if (aliases.has(added.entity)) {
      throw new PostgreSqlViewRuntimeConfigurationError(
        `View ${view.name} relation ${relation.name} creates a cycle or duplicate Entity alias.`,
      );
    }
    const alias = `v${aliases.size}`;
    aliases.set(added.entity, alias);
    const table = entityTable(
      entityModule(added.entity, entityModules),
      added.entity,
      storage,
    );
    joins.push(
      `JOIN ${qualified(storage, table)} AS ${quotePostgreSqlIdentifier(alias)} ON ` +
        `${columnSql(entityModules, known.entity, known.column, aliases, storage)} = ` +
        `${columnSql(entityModules, added.entity, added.column, aliases, storage)}`,
    );
  }

  const values: unknown[] = [];
  const select = view.output.map((output) => {
    const expression = output.expression;
    const column = expression.kind === "column" ? expression : expression.value;
    const sql = columnSql(
      entityModules,
      column.entity,
      column.column,
      aliases,
      storage,
    );
    const projected =
      expression.kind === "aggregate"
        ? `${expression.function.toUpperCase()}(${sql})`
        : sql;
    return `${projected} AS ${quotePostgreSqlIdentifier(output.name)}`;
  });
  const where = view.query.where
    ? ` WHERE ${expressionSql(view.query.where, view, entityModules, aliases, storage, input, values)}`
    : "";
  const order =
    view.query.orderBy.length > 0
      ? ` ORDER BY ${view.query.orderBy
          .map(
            (item) =>
              `${columnSql(entityModules, item.value.entity, item.value.column, aliases, storage)} ${item.direction.toUpperCase()}`,
          )
          .join(", ")}`
      : "";
  const pagination = view.query.pagination
    ? paginationSql(
        view,
        view.query.pagination.limit,
        view.query.pagination.offset,
        input,
        values,
      )
    : "";
  return {
    text: `SELECT ${select.join(", ")} FROM ${qualified(storage, root)} AS ${quotePostgreSqlIdentifier("v0")} ${joins.join(" ")}${where}${order}${pagination}`
      .replace(/\s+/gu, " ")
      .trim(),
    values,
  };
}

function expressionSql(
  expression: ViewExpressionDeclaration,
  view: SemanticView,
  entityModules: ReadonlyMap<string, string>,
  aliases: ReadonlyMap<string, string>,
  storage: PostgreSqlStorageIr,
  input: Readonly<Record<string, JsonValue>>,
  values: unknown[],
): string {
  if (expression.kind === "not") {
    return `(NOT ${expressionSql(expression.operand, view, entityModules, aliases, storage, input, values)})`;
  }
  if (expression.kind === "logical") {
    return `(${expression.operands
      .map((operand) =>
        expressionSql(
          operand,
          view,
          entityModules,
          aliases,
          storage,
          input,
          values,
        ),
      )
      .join(expression.operator === "and" ? " AND " : " OR ")})`;
  }
  const nullOnLeft =
    expression.left.kind === "literal" && expression.left.value === null;
  const nullOnRight =
    expression.right.kind === "literal" && expression.right.value === null;
  if (nullOnLeft || nullOnRight) {
    if (nullOnLeft && nullOnRight) {
      return expression.operator === "eq" ? "(TRUE)" : "(FALSE)";
    }
    const value = nullOnLeft ? expression.right : expression.left;
    const sql = valueSql(
      value,
      view,
      entityModules,
      aliases,
      storage,
      input,
      values,
    );
    return `(${sql} IS ${expression.operator === "neq" ? "NOT " : ""}NULL)`;
  }
  const left = valueSql(
    expression.left,
    view,
    entityModules,
    aliases,
    storage,
    input,
    values,
  );
  const right = valueSql(
    expression.right,
    view,
    entityModules,
    aliases,
    storage,
    input,
    values,
  );
  const operator = {
    eq: "=",
    neq: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  }[expression.operator];
  return `(${left} ${operator} ${right})`;
}

function valueSql(
  value: ViewValueDeclaration,
  view: SemanticView,
  entityModules: ReadonlyMap<string, string>,
  aliases: ReadonlyMap<string, string>,
  storage: PostgreSqlStorageIr,
  input: Readonly<Record<string, JsonValue>>,
  values: unknown[],
): string {
  if (value.kind === "column")
    return columnSql(
      entityModules,
      value.entity,
      value.column,
      aliases,
      storage,
    );
  values.push(value.kind === "input" ? input[value.input] : value.value);
  if (value.kind === "input") {
    const type = view.input.find((field) => field.name === value.input)?.type;
    if (!type)
      throw new PostgreSqlViewRuntimeConfigurationError(
        `View ${view.name} query references undeclared input ${value.input}.`,
      );
    return `$${values.length}::${postgresType(type)}`;
  }
  if (value.value === null) return `$${values.length}`;
  const type =
    typeof value.value === "boolean"
      ? "boolean"
      : typeof value.value === "number"
        ? "numeric"
        : "text";
  return `$${values.length}::${type}`;
}

function postgresType(type: ColumnType): string {
  return {
    string: "text",
    integer: "bigint",
    decimal: "numeric",
    boolean: "boolean",
    date: "date",
    datetime: "timestamptz",
    uuid: "uuid",
    json: "jsonb",
  }[type];
}

function paginationSql(
  view: SemanticView,
  limit: ViewPaginationValueDeclaration | undefined,
  offset: ViewPaginationValueDeclaration | undefined,
  input: Readonly<Record<string, JsonValue>>,
  values: unknown[],
): string {
  let sql = "";
  for (const [keyword, value] of [
    ["LIMIT", limit],
    ["OFFSET", offset],
  ] as const) {
    if (!value) continue;
    const resolved = value.kind === "input" ? input[value.input] : value.value;
    if (
      resolved === undefined &&
      value.kind === "input" &&
      view.input.find((field) => field.name === value.input)?.optional
    ) {
      continue;
    }
    if (
      !Number.isSafeInteger(resolved) ||
      (resolved as number) < 0 ||
      (keyword === "LIMIT" && resolved === 0)
    ) {
      throw new ViewInputError([
        keyword === "LIMIT"
          ? "limit must be a positive integer"
          : "offset must be a non-negative integer",
      ]);
    }
    values.push(resolved);
    sql += ` ${keyword} $${values.length}::bigint`;
  }
  return sql;
}

function columnSql(
  entityModules: ReadonlyMap<string, string>,
  entity: string,
  column: string,
  aliases: ReadonlyMap<string, string>,
  storage: PostgreSqlStorageIr,
): string {
  const alias = aliases.get(entity);
  if (!alias)
    throw new PostgreSqlViewRuntimeConfigurationError(
      `View Column references unreachable Entity ${entity}.`,
    );
  const module = entityModule(entity, entityModules);
  const table = entityTable(module, entity, storage);
  const definition = table.columns.find(
    (candidate) => candidate.semanticId === `${module}.${entity}.${column}`,
  );
  if (!definition)
    throw new PostgreSqlViewRuntimeConfigurationError(
      `Storage IR has no Column ${module}.${entity}.${column}.`,
    );
  return `${quotePostgreSqlIdentifier(alias)}.${quotePostgreSqlIdentifier(definition.name)}`;
}

function resolveVisibleEntityModules(
  owner: SemanticModule,
  modules: readonly SemanticModule[],
): ReadonlyMap<string, string> {
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  modulesByName.set(owner.name, owner);
  const visible = new Set<string>();
  const visit = (name: string): void => {
    if (visible.has(name)) return;
    const module = modulesByName.get(name);
    if (!module) {
      throw new PostgreSqlViewRuntimeConfigurationError(
        `View runtime is missing imported Module ${name}.`,
      );
    }
    visible.add(name);
    for (const imported of module.imports) visit(imported);
  };
  visit(owner.name);
  const entityModules = new Map<string, string>();
  for (const moduleName of visible) {
    const module = modulesByName.get(moduleName);
    if (!module) continue;
    for (const entity of module.entities) {
      const previous = entityModules.get(entity.name);
      if (previous && previous !== module.name) {
        throw new PostgreSqlViewRuntimeConfigurationError(
          `Entity ${entity.name} is ambiguous across visible Modules ${previous} and ${module.name}.`,
        );
      }
      entityModules.set(entity.name, module.name);
    }
  }
  return entityModules;
}

function entityModule(
  entity: string,
  entityModules: ReadonlyMap<string, string>,
): string {
  const module = entityModules.get(entity);
  if (!module) {
    throw new PostgreSqlViewRuntimeConfigurationError(
      `View references Entity ${entity} outside its visible Module import graph.`,
    );
  }
  return module;
}

function entityTable(
  module: string,
  entity: string,
  storage: PostgreSqlStorageIr,
): PostgreSqlTable {
  const table = storage.tables.find(
    (candidate) =>
      candidate.semanticId === `${module}.${entity}` && !candidate.technical,
  );
  if (!table)
    throw new PostgreSqlViewRuntimeConfigurationError(
      `Storage IR has no Entity table ${module}.${entity}.`,
    );
  return table;
}

function qualified(
  storage: PostgreSqlStorageIr,
  table: PostgreSqlTable,
): string {
  return `${quotePostgreSqlIdentifier(storage.provider.namespace)}.${quotePostgreSqlIdentifier(table.name)}`;
}

function validateViewInput(
  view: SemanticView,
  input: Readonly<Record<string, JsonValue>>,
): void {
  const fields = new Map(view.input.map((field) => [field.name, field]));
  const problems: string[] = [];
  for (const field of view.input) {
    if (!Object.hasOwn(input, field.name)) {
      if (!field.optional) problems.push(`missing ${field.name}`);
      continue;
    }
    if (!matchesType(input[field.name], field.type))
      problems.push(`${field.name} must be ${field.type}`);
  }
  for (const name of Object.keys(input))
    if (!fields.has(name)) problems.push(`undeclared ${name}`);
  if (problems.length > 0) throw new ViewInputError(problems.sort());
}

function matchesType(value: JsonValue | undefined, type: ColumnType): boolean {
  if (value === null || value === undefined) return false;
  if (type === "string")
    return typeof value === "string" && isPostgreSqlTextCompatible(value);
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
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      ) &&
      isIsoDate(value.slice(0, 10)) &&
      Number.isFinite(Date.parse(value))
    );
  return type === "json" && isPostgreSqlJsonCompatible(value);
}

function isPostgreSqlTextCompatible(value: string): boolean {
  return !value.includes("\0");
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

function normalizeViewRow(
  view: SemanticView,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    view.output.map((field) => {
      const value = row[field.name];
      if (value === null && field.nullable) return [field.name, null];
      if (value === null || value === undefined) {
        throw new PostgreSqlViewRuntimeConfigurationError(
          `View ${view.name} output ${field.name} violated its non-null public contract.`,
        );
      }
      if (field.type === "integer" && typeof value === "string") {
        const integer = Number(value);
        if (!Number.isSafeInteger(integer)) {
          throw new PostgreSqlViewRuntimeConfigurationError(
            `View ${view.name} output ${field.name} exceeds the public safe integer range.`,
          );
        }
        return [field.name, integer];
      }
      if (field.type === "decimal" && typeof value === "string") {
        const decimal = Number(value);
        if (!Number.isFinite(decimal)) {
          throw new PostgreSqlViewRuntimeConfigurationError(
            `View ${view.name} output ${field.name} is not a finite public decimal.`,
          );
        }
        return [field.name, decimal];
      }
      if (field.type === "datetime" && value instanceof Date) {
        return [field.name, value.toISOString()];
      }
      if (!matchesType(value as JsonValue, field.type)) {
        throw new PostgreSqlViewRuntimeConfigurationError(
          `View ${view.name} output ${field.name} does not match public type ${field.type}.`,
        );
      }
      return [field.name, value];
    }),
  );
}

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
