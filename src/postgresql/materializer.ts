import type {
  ColumnType,
  EventOperationValueDeclaration,
  JsonValue,
  RuleExpressionDeclaration,
  RuleValueDeclaration,
} from "../declaration.js";
import type { Diagnostic } from "../diagnostic.js";
import {
  SEMANTIC_PROJECT_IR_VERSION,
  type SemanticColumn,
  type SemanticEntity,
  type SemanticModule,
  type SemanticProjectIr,
  type SemanticRule,
} from "../semantic-ir.js";
import {
  POSTGRESQL_IDENTIFIER_MAX_BYTES,
  quotePostgreSqlIdentifier,
  quotePostgreSqlString,
  toPostgreSqlIdentifier,
} from "./identifiers.js";
import {
  POSTGRESQL_STORAGE_IR_VERSION,
  type PostgreSqlColumn,
  type PostgreSqlConstraint,
  type PostgreSqlIndex,
  type PostgreSqlStorageIr,
  type PostgreSqlTable,
  type PostgreSqlType,
} from "./storage-ir.js";

export interface PostgreSqlMaterializerConfiguration {
  readonly namespace: string;
  readonly targetVersion: number;
}

export type PostgreSqlMaterializationResult =
  | {
      readonly success: true;
      readonly ir: PostgreSqlStorageIr;
      readonly diagnostics: readonly [];
    }
  | {
      readonly success: false;
      readonly diagnostics: readonly Diagnostic[];
    };

const TYPE_MAP: Readonly<Record<ColumnType, PostgreSqlType>> = {
  string: "text",
  integer: "bigint",
  decimal: "numeric",
  boolean: "boolean",
  date: "date",
  datetime: "timestamptz",
  uuid: "uuid",
  json: "jsonb",
};

export function materializePostgreSql(
  project: SemanticProjectIr,
  configuration: PostgreSqlMaterializerConfiguration,
): PostgreSqlMaterializationResult {
  const diagnostics: Diagnostic[] = [];
  validateConfiguration(configuration, diagnostics);
  if (
    project.schema !== "vane.semantic-project-ir" ||
    project.version !== SEMANTIC_PROJECT_IR_VERSION
  ) {
    diagnostics.push({
      code: "VANE_PG_SEMANTIC_IR_VERSION",
      path: ["semanticProjectIr"],
      message: `PostgreSQL materialization requires Semantic Project IR v${SEMANTIC_PROJECT_IR_VERSION}.`,
      correction:
        "Compile the source with the matching Vane compiler before materialization.",
    });
  }
  if (diagnostics.length > 0) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  const tableNames = new Map<string, string>();
  for (const module of project.modules) {
    for (const entity of module.entities) {
      const semanticId = entityId(module.name, entity.name);
      const name = toPostgreSqlIdentifier([module.name, entity.name]);
      tableNames.set(semanticId, name);
    }
  }

  const modulesByName = new Map(
    project.modules.map((module) => [module.name, module] as const),
  );
  const entityTables: PostgreSqlTable[] = [];
  for (const module of project.modules) {
    for (const entity of module.entities) {
      validateEventOperationLiterals(module, entity, diagnostics);
      const table = materializeEntity(
        module,
        entity,
        modulesByName,
        tableNames,
        diagnostics,
      );
      if (table) entityTables.push(table);
    }
  }

  const tables = [...technicalTables(), ...entityTables].sort((left, right) =>
    compare(left.semanticId, right.semanticId),
  );
  validatePhysicalIdentifiers(tables, diagnostics);

  if (diagnostics.length > 0) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  return {
    success: true,
    diagnostics: [],
    ir: {
      schema: "vane.postgresql-storage-ir",
      version: POSTGRESQL_STORAGE_IR_VERSION,
      provider: {
        name: "postgresql",
        minimumVersion: 16,
        namespace: configuration.namespace,
      },
      tables,
    },
  };
}

function validateConfiguration(
  configuration: PostgreSqlMaterializerConfiguration,
  diagnostics: Diagnostic[],
): void {
  if (
    configuration.namespace.length === 0 ||
    configuration.namespace.includes("\0") ||
    Buffer.byteLength(configuration.namespace, "utf8") >
      POSTGRESQL_IDENTIFIER_MAX_BYTES
  ) {
    diagnostics.push({
      code: "VANE_PG_NAMESPACE",
      path: ["serviceConfiguration", "postgresql", "namespace"],
      message:
        "PostgreSQL namespace must be a non-empty identifier of at most 63 UTF-8 bytes without NUL characters.",
      correction: "Configure an existing valid PostgreSQL schema name.",
    });
  }
  if (
    !Number.isSafeInteger(configuration.targetVersion) ||
    configuration.targetVersion < 16
  ) {
    diagnostics.push({
      code: "VANE_PG_VERSION",
      path: ["serviceConfiguration", "postgresql", "targetVersion"],
      message: `PostgreSQL ${String(configuration.targetVersion)} cannot guarantee the phase-2 storage contract.`,
      correction: "Target PostgreSQL 16 or newer.",
    });
  }
}

function validateEventOperationLiterals(
  module: SemanticModule,
  entity: SemanticEntity,
  diagnostics: Diagnostic[],
): void {
  const columns = new Map(
    entity.columns.map((column) => [column.name, column]),
  );
  const identity = columns.get(entity.identityColumn);
  const inspect = (
    eventName: string,
    value: EventOperationValueDeclaration,
    targetType: ColumnType,
    path: readonly string[],
  ): void => {
    if (value.kind === "literal" && typeof value.value === "string") {
      if (
        !isPostgreSqlTextCompatible(value.value) ||
        !isValidStringForType(value.value, targetType)
      ) {
        diagnostics.push({
          code: "VANE_PG_EVENT_LITERAL",
          path,
          message: `PostgreSQL cannot safely persist Event ${entity.name}.${eventName} literal ${JSON.stringify(value.value)} as ${targetType}.`,
          correction: `Use a canonical PostgreSQL-compatible ${targetType} literal.`,
        });
      }
      return;
    }
    if (value.kind === "arithmetic") {
      inspect(eventName, value.left, targetType, [...path, "left"]);
      inspect(eventName, value.right, targetType, [...path, "right"]);
    }
  };

  for (const event of entity.events) {
    const eventPath = [
      "postgresql",
      "modules",
      module.name,
      "entities",
      entity.name,
      "events",
      event.name,
      "operation",
    ];
    if ("identity" in event.operation && identity) {
      inspect(event.name, event.operation.identity, identity.type, [
        ...eventPath,
        "identity",
      ]);
    }
    if ("values" in event.operation) {
      for (const assignment of event.operation.values) {
        const column = columns.get(assignment.column);
        if (column)
          inspect(event.name, assignment.value, column.type, [
            ...eventPath,
            "values",
            assignment.column,
          ]);
      }
    }
  }
}

function materializeEntity(
  module: SemanticModule,
  entity: SemanticEntity,
  modulesByName: ReadonlyMap<string, SemanticModule>,
  tableNames: ReadonlyMap<string, string>,
  diagnostics: Diagnostic[],
): PostgreSqlTable | undefined {
  const semanticId = entityId(module.name, entity.name);
  const tableName = tableNames.get(semanticId);
  if (!tableName) return undefined;

  const columnNames = new Map<string, string>();
  for (const column of entity.columns) {
    const name = toPostgreSqlIdentifier([column.name]);
    columnNames.set(column.name, name);
  }

  const columns = entity.columns.map((column) =>
    materializeColumn(semanticId, column, columnNames.get(column.name) ?? ""),
  );
  for (const column of entity.columns) {
    validatePostgreSqlDefault(semanticId, column, diagnostics);
  }
  columns.push(...ownerTechnicalColumns(semanticId));

  const constraints: PostgreSqlConstraint[] = [];
  const identityName = columnNames.get(entity.identityColumn);
  if (identityName) {
    constraints.push(
      constraint(
        `${semanticId}.primaryKey`,
        toPostgreSqlIdentifier([tableName], "pk"),
        "primaryKey",
        [identityName],
      ),
    );
  }

  for (const column of entity.columns) {
    const physicalName = columnNames.get(column.name);
    if (!physicalName) continue;
    materializeColumnConstraints(
      semanticId,
      tableName,
      column,
      physicalName,
      constraints,
    );
    if (column.references) {
      materializeForeignKey(
        module,
        entity,
        column,
        physicalName,
        modulesByName,
        tableNames,
        tableName,
        constraints,
        diagnostics,
      );
    }
  }

  for (const rule of entity.rules) {
    const expression = materializeRule(
      semanticId,
      rule,
      entity,
      columnNames,
      diagnostics,
    );
    if (!expression) continue;
    constraints.push({
      semanticId: `${semanticId}.rule.${rule.name}`,
      name: toPostgreSqlIdentifier([tableName, rule.name], "ck"),
      kind: "check",
      columns: rule.columns
        .map((name) => columnNames.get(name))
        .filter((name): name is string => name !== undefined)
        .sort(compare),
      expression,
      references: null,
    });
  }

  return {
    semanticId,
    module: module.name,
    name: tableName,
    technical: false,
    columns: columns.sort((left, right) =>
      compare(left.semanticId, right.semanticId),
    ),
    constraints: constraints.sort(compareConstraints),
    indexes: [],
  };
}

function materializeColumn(
  tableSemanticId: string,
  column: SemanticColumn,
  physicalName: string,
): PostgreSqlColumn {
  return {
    semanticId: `${tableSemanticId}.${column.name}`,
    name: physicalName,
    type: TYPE_MAP[column.type],
    nullable: column.nullable,
    defaultSql: materializeDefault(column),
    generated: column.generated === "increment" ? "identity" : null,
    technical: false,
  };
}

function materializeDefault(column: SemanticColumn): string | null {
  if (column.generated === "uuid") return "gen_random_uuid()";
  if (!column.hasDefault) return null;
  if (column.default === null) return "NULL";
  return sqlLiteral(column.default, column.type);
}

function sqlLiteral(value: JsonValue, type: ColumnType): string {
  if (type === "json")
    return `${quotePostgreSqlString(JSON.stringify(value))}::jsonb`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return `${String(value)}::${TYPE_MAP[type]}`;
  return `${quotePostgreSqlString(value as string)}::${TYPE_MAP[type]}`;
}

function materializeColumnConstraints(
  tableSemanticId: string,
  tableName: string,
  column: SemanticColumn,
  physicalName: string,
  constraints: PostgreSqlConstraint[],
): void {
  if (column.unique && !column.identity) {
    constraints.push(
      constraint(
        `${tableSemanticId}.${column.name}.unique`,
        toPostgreSqlIdentifier([tableName, physicalName], "uq"),
        "unique",
        [physicalName],
      ),
    );
  }

  const quoted = quotePostgreSqlIdentifier(physicalName);
  const checks: readonly (readonly [string, string])[] = [
    ...(column.minLength === null
      ? []
      : ([
          ["minLength", `char_length(${quoted}) >= ${column.minLength}`],
        ] as const)),
    ...(column.maxLength === null
      ? []
      : ([
          ["maxLength", `char_length(${quoted}) <= ${column.maxLength}`],
        ] as const)),
    ...(column.minimum === null
      ? []
      : ([["minimum", `${quoted} >= ${String(column.minimum)}`]] as const)),
    ...(column.maximum === null
      ? []
      : ([["maximum", `${quoted} <= ${String(column.maximum)}`]] as const)),
  ];
  for (const [kind, expression] of checks) {
    constraints.push({
      semanticId: `${tableSemanticId}.${column.name}.${kind}`,
      name: toPostgreSqlIdentifier([tableName, physicalName, kind], "ck"),
      kind: "check",
      columns: [physicalName],
      expression,
      references: null,
    });
  }
}

function materializeForeignKey(
  ownerModule: SemanticModule,
  ownerEntity: SemanticEntity,
  column: SemanticColumn,
  physicalName: string,
  modulesByName: ReadonlyMap<string, SemanticModule>,
  tableNames: ReadonlyMap<string, string>,
  tableName: string,
  constraints: PostgreSqlConstraint[],
  diagnostics: Diagnostic[],
): void {
  const reference = column.references;
  if (!reference) return;
  const target = findVisibleEntity(
    ownerModule,
    reference.entity,
    modulesByName,
  );
  const path = [
    "postgresql",
    "tables",
    entityId(ownerModule.name, ownerEntity.name),
    "columns",
    column.name,
    "references",
  ];
  if (!target) {
    diagnostics.push({
      code: "VANE_PG_REFERENCE_TARGET",
      path,
      message: `PostgreSQL materialization cannot resolve referenced Entity ${reference.entity}.`,
      correction:
        "Reference one Entity visible through the owner Module import graph.",
    });
    return;
  }
  const targetColumn = target.entity.columns.find(
    (candidate) => candidate.name === reference.column,
  );
  if (!targetColumn) {
    diagnostics.push({
      code: "VANE_PG_REFERENCE_TARGET",
      path,
      message: `PostgreSQL materialization cannot resolve referenced Column ${reference.entity}.${reference.column}.`,
      correction: "Reference a Column declared by the target Entity.",
    });
    return;
  }
  if (!targetColumn.identity && !targetColumn.unique) {
    diagnostics.push({
      code: "VANE_PG_REFERENCE_UNIQUE",
      path,
      message: `PostgreSQL cannot enforce a foreign key to non-unique Column ${reference.entity}.${reference.column}.`,
      correction:
        "Reference the target identity Column or mark the target Column unique.",
    });
    return;
  }
  if (targetColumn.type !== column.type) {
    diagnostics.push({
      code: "VANE_PG_REFERENCE_TYPE",
      path,
      message: `PostgreSQL cannot enforce a foreign key from ${ownerEntity.name}.${column.name} (${column.type}) to ${reference.entity}.${reference.column} (${targetColumn.type}).`,
      correction: "Use the same semantic type on both sides of the reference.",
    });
    return;
  }
  const targetTableId = entityId(target.module.name, target.entity.name);
  const targetTable = tableNames.get(targetTableId);
  if (!targetTable) return;
  constraints.push({
    semanticId: `${entityId(ownerModule.name, ownerEntity.name)}.${column.name}.foreignKey`,
    name: toPostgreSqlIdentifier([tableName, physicalName], "fk"),
    kind: "foreignKey",
    columns: [physicalName],
    expression: null,
    references: {
      table: targetTable,
      column: toPostgreSqlIdentifier([targetColumn.name]),
      onDelete: "NO ACTION",
      onUpdate: "NO ACTION",
    },
  });
}

interface VisibleEntity {
  readonly module: SemanticModule;
  readonly entity: SemanticEntity;
}

function findVisibleEntity(
  owner: SemanticModule,
  name: string,
  modulesByName: ReadonlyMap<string, SemanticModule>,
): VisibleEntity | undefined {
  const pending = [owner.name];
  const visited = new Set<string>();
  const matches: VisibleEntity[] = [];
  while (pending.length > 0) {
    const moduleName = pending.shift();
    if (!moduleName || visited.has(moduleName)) continue;
    visited.add(moduleName);
    const module = modulesByName.get(moduleName);
    if (!module) continue;
    const entity = module.entities.find((candidate) => candidate.name === name);
    if (entity) matches.push({ module, entity });
    pending.push(...module.imports.slice().sort(compare));
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function materializeRule(
  tableSemanticId: string,
  rule: SemanticRule,
  entity: SemanticEntity,
  columnNames: ReadonlyMap<string, string>,
  diagnostics: Diagnostic[],
): string | undefined {
  const columns = new Map(
    entity.columns.map((column) => [column.name, column] as const),
  );
  const path = ["postgresql", "tables", tableSemanticId, "rules", rule.name];
  return compileRuleExpression(
    rule.expression,
    columns,
    columnNames,
    path,
    diagnostics,
  );
}

interface RuleOperand {
  readonly sql: string;
  readonly type: ColumnType | "number" | "null";
  readonly literal: boolean;
  readonly value?: boolean | number | string | null;
}

function compileRuleExpression(
  expression: RuleExpressionDeclaration,
  columns: ReadonlyMap<string, SemanticColumn>,
  columnNames: ReadonlyMap<string, string>,
  path: readonly string[],
  diagnostics: Diagnostic[],
): string | undefined {
  if (expression.kind === "not") {
    const operand = compileRuleExpression(
      expression.operand,
      columns,
      columnNames,
      [...path, "operand"],
      diagnostics,
    );
    return operand ? `(NOT ${operand})` : undefined;
  }
  if (expression.kind === "logical") {
    const operands = expression.operands.map((operand, index) =>
      compileRuleExpression(
        operand,
        columns,
        columnNames,
        [...path, String(index)],
        diagnostics,
      ),
    );
    if (operands.some((operand) => operand === undefined)) return undefined;
    return `(${(operands as string[]).join(` ${expression.operator.toUpperCase()} `)})`;
  }

  const left = resolveRuleOperand(
    expression.left,
    columns,
    columnNames,
    [...path, "left"],
    diagnostics,
  );
  const right = resolveRuleOperand(
    expression.right,
    columns,
    columnNames,
    [...path, "right"],
    diagnostics,
  );
  if (!left || !right) return undefined;

  if (left.type === "null" || right.type === "null") {
    if (expression.operator !== "eq" && expression.operator !== "neq") {
      incompatibleRule(
        path,
        expression.operator,
        left.type,
        right.type,
        diagnostics,
      );
      return undefined;
    }
    const value = left.type === "null" ? right : left;
    return `(${value.sql} IS${expression.operator === "neq" ? " NOT" : ""} NULL)`;
  }

  const commonType = compatibleRuleType(left, right);
  if (!commonType || !operatorSupportsType(expression.operator, commonType)) {
    incompatibleRule(
      path,
      expression.operator,
      left.type,
      right.type,
      diagnostics,
    );
    return undefined;
  }
  if (
    !validateRuleLiteral(left, commonType, [...path, "left"], diagnostics) ||
    !validateRuleLiteral(right, commonType, [...path, "right"], diagnostics)
  )
    return undefined;
  const leftSql = renderRuleOperand(left, commonType);
  const rightSql = renderRuleOperand(right, commonType);
  const operator = {
    eq: "=",
    neq: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  }[expression.operator];
  return `(${leftSql} ${operator} ${rightSql})`;
}

function resolveRuleOperand(
  value: RuleValueDeclaration,
  columns: ReadonlyMap<string, SemanticColumn>,
  columnNames: ReadonlyMap<string, string>,
  path: readonly string[],
  diagnostics: Diagnostic[],
): RuleOperand | undefined {
  if (value.kind === "column") {
    const column = columns.get(value.column);
    const physicalName = columnNames.get(value.column);
    if (column && physicalName) {
      return {
        sql: quotePostgreSqlIdentifier(physicalName),
        type: column.type,
        literal: false,
      };
    }
    diagnostics.push({
      code: "VANE_PG_RULE_COLUMN",
      path,
      message: `Rule references unknown Column ${value.column}.`,
      correction: "Reference a Column declared by the Rule owner Entity.",
    });
    return undefined;
  }
  const type =
    value.value === null
      ? "null"
      : typeof value.value === "number"
        ? "number"
        : typeof value.value === "boolean"
          ? "boolean"
          : "string";
  return { sql: "", type, literal: true, value: value.value };
}

function compatibleRuleType(
  left: RuleOperand,
  right: RuleOperand,
): ColumnType | undefined {
  if (
    left.type === right.type &&
    left.type !== "number" &&
    left.type !== "null"
  )
    return left.type;
  if (
    left.type === "number" &&
    (right.type === "integer" || right.type === "decimal")
  )
    return right.type;
  if (
    right.type === "number" &&
    (left.type === "integer" || left.type === "decimal")
  )
    return left.type;
  if (
    (left.type === "integer" || left.type === "decimal") &&
    (right.type === "integer" || right.type === "decimal")
  )
    return "decimal";
  if (
    left.literal &&
    left.type === "string" &&
    isStringLiteralTarget(right.type)
  )
    return right.type;
  if (
    right.literal &&
    right.type === "string" &&
    isStringLiteralTarget(left.type)
  )
    return left.type;
  return undefined;
}

function isStringLiteralTarget(
  type: RuleOperand["type"],
): type is "string" | "date" | "datetime" | "uuid" {
  return ["string", "date", "datetime", "uuid"].includes(type);
}

function operatorSupportsType(
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
  type: ColumnType,
): boolean {
  if (operator === "eq" || operator === "neq") return true;
  return ["string", "integer", "decimal", "date", "datetime"].includes(type);
}

function renderRuleOperand(
  operand: RuleOperand,
  targetType: ColumnType,
): string {
  if (!operand.literal) {
    if (
      targetType === "decimal" &&
      (operand.type === "integer" || operand.type === "decimal")
    )
      return `(${operand.sql})::numeric`;
    return operand.sql;
  }
  const value = operand.value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number")
    return `${String(value)}::${TYPE_MAP[targetType]}`;
  return `${quotePostgreSqlString(String(value))}::${TYPE_MAP[targetType]}`;
}

function validateRuleLiteral(
  operand: RuleOperand,
  targetType: ColumnType,
  path: readonly string[],
  diagnostics: Diagnostic[],
): boolean {
  if (!operand.literal || typeof operand.value !== "string") return true;
  if (operand.value.includes("\0")) {
    diagnostics.push({
      code: "VANE_PG_RULE_LITERAL",
      path,
      message:
        "PostgreSQL text and JSON values cannot contain a NUL character.",
      correction: "Remove the NUL character from the Rule literal.",
    });
    return false;
  }
  if (isValidStringForType(operand.value, targetType)) return true;
  diagnostics.push({
    code: "VANE_PG_RULE_LITERAL",
    path,
    message: `PostgreSQL cannot cast Rule literal ${JSON.stringify(operand.value)} to ${targetType}.`,
    correction: `Use a valid ${targetType} literal.`,
  });
  return false;
}

function incompatibleRule(
  path: readonly string[],
  operator: string,
  left: RuleOperand["type"],
  right: RuleOperand["type"],
  diagnostics: Diagnostic[],
): void {
  diagnostics.push({
    code: "VANE_PG_RULE_TYPE",
    path,
    message: `PostgreSQL cannot guarantee Rule operator ${operator} for ${left} and ${right}.`,
    correction:
      "Compare compatible Columns/literals with an operator supported by their semantic type.",
  });
}

function validatePostgreSqlDefault(
  tableSemanticId: string,
  column: SemanticColumn,
  diagnostics: Diagnostic[],
): void {
  if (containsPostgreSqlIncompatibleText(column.default)) {
    diagnostics.push({
      code: "VANE_PG_COLUMN_DEFAULT",
      path: [
        "postgresql",
        "tables",
        tableSemanticId,
        "columns",
        column.name,
        "default",
      ],
      message:
        "PostgreSQL text and JSON values cannot contain NUL or invalid Unicode surrogate data.",
      correction: "Use valid Unicode without NUL in the Column default.",
    });
    return;
  }
  if (
    !column.hasDefault ||
    typeof column.default !== "string" ||
    isValidStringForType(column.default, column.type)
  )
    return;
  diagnostics.push({
    code: "VANE_PG_COLUMN_DEFAULT",
    path: [
      "postgresql",
      "tables",
      tableSemanticId,
      "columns",
      column.name,
      "default",
    ],
    message: `PostgreSQL cannot safely materialize default ${JSON.stringify(column.default)} as ${column.type}.`,
    correction: `Use a canonical ${column.type} default.`,
  });
}

function containsPostgreSqlIncompatibleText(value: JsonValue): boolean {
  if (typeof value === "string") return !isPostgreSqlTextCompatible(value);
  if (Array.isArray(value))
    return value.some(containsPostgreSqlIncompatibleText);
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, nested]) =>
        !isPostgreSqlTextCompatible(key) ||
        containsPostgreSqlIncompatibleText(nested),
    );
  return false;
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

function isValidStringForType(value: string, type: ColumnType): boolean {
  if (type === "uuid")
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  if (type === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return isGregorianDate(year, month, day);
  }
  if (type === "datetime")
    return (
      isValidStringForType(value.slice(0, 10), "date") &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) &&
      Number.isFinite(Date.parse(value))
    );
  return true;
}

function isGregorianDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] as number);
}

function ownerTechnicalColumns(tableSemanticId: string): PostgreSqlColumn[] {
  return [
    technicalColumn(
      `${tableSemanticId}.__vane_revision`,
      "__vane_revision",
      "bigint",
      false,
      "0::bigint",
    ),
    technicalColumn(
      `${tableSemanticId}.__vane_created_at`,
      "__vane_created_at",
      "timestamptz",
      false,
      "transaction_timestamp()",
    ),
    technicalColumn(
      `${tableSemanticId}.__vane_updated_at`,
      "__vane_updated_at",
      "timestamptz",
      false,
      "transaction_timestamp()",
    ),
  ];
}

function technicalTables(): PostgreSqlTable[] {
  return [
    technicalTable(
      "migrations",
      [
        {
          ...technicalColumn("applied_order", "applied_order", "bigint", false),
          generated: "identity",
        },
        technicalColumn("plan_hash", "plan_hash", "text", false),
        technicalColumn("source_hash", "source_hash", "text", false),
        technicalColumn("target_hash", "target_hash", "text", false),
        technicalColumn("classification", "classification", "text", false),
        technicalColumn("sql_hash", "sql_hash", "text", false),
        technicalColumn("approval_reason", "approval_reason", "text", true),
        technicalColumn(
          "applied_at",
          "applied_at",
          "timestamptz",
          false,
          "clock_timestamp()",
        ),
      ],
      [technicalPrimaryKey("migrations", "plan_hash")],
    ),
    technicalTable(
      "mailbox",
      [
        technicalColumn("event_id", "event_id", "uuid", false),
        technicalColumn("fingerprint", "fingerprint", "text", false),
        technicalColumn("event_identity", "event_identity", "text", false),
        technicalColumn("payload", "payload", "text", false),
        technicalColumn(
          "status",
          "status",
          "text",
          false,
          "'processing'::text",
        ),
        technicalColumn("result", "result", "jsonb", true),
        technicalColumn("lease_owner", "lease_owner", "text", true),
        technicalColumn("lease_token", "lease_token", "uuid", true),
        technicalColumn("lease_until", "lease_until", "timestamptz", true),
        technicalColumn(
          "received_at",
          "received_at",
          "timestamptz",
          false,
          "transaction_timestamp()",
        ),
        technicalColumn("completed_at", "completed_at", "timestamptz", true),
      ],
      [
        technicalPrimaryKey("mailbox", "event_id"),
        technicalCheck(
          "mailbox",
          "status",
          `${quotePostgreSqlIdentifier("status")} IN ('processing', 'success', 'fail')`,
          ["status"],
        ),
      ],
      [technicalIndex("mailbox", "lease", ["status", "lease_until"])],
    ),
    technicalTable(
      "outbox",
      [
        technicalColumn(
          "message_id",
          "message_id",
          "uuid",
          false,
          "gen_random_uuid()",
        ),
        technicalColumn("event_id", "event_id", "uuid", false),
        technicalColumn("fingerprint", "fingerprint", "text", false),
        technicalColumn("event_identity", "event_identity", "text", false),
        technicalColumn("payload", "payload", "jsonb", false),
        technicalColumn("correlation_id", "correlation_id", "uuid", false),
        technicalColumn("causation_id", "causation_id", "uuid", true),
        technicalColumn("saga_id", "saga_id", "uuid", true),
        technicalColumn("status", "status", "text", false, "'pending'::text"),
        technicalColumn(
          "attempt_count",
          "attempt_count",
          "bigint",
          false,
          "0::bigint",
        ),
        technicalColumn(
          "available_at",
          "available_at",
          "timestamptz",
          false,
          "transaction_timestamp()",
        ),
        technicalColumn("lease_owner", "lease_owner", "text", true),
        technicalColumn("lease_token", "lease_token", "uuid", true),
        technicalColumn("lease_until", "lease_until", "timestamptz", true),
        technicalColumn("last_error", "last_error", "text", true),
        technicalColumn(
          "occurred_at",
          "occurred_at",
          "timestamptz",
          false,
          "transaction_timestamp()",
        ),
        technicalColumn("published_at", "published_at", "timestamptz", true),
      ],
      [
        technicalPrimaryKey("outbox", "message_id"),
        technicalCheck(
          "outbox",
          "status",
          `${quotePostgreSqlIdentifier("status")} IN ('pending', 'publishing', 'published', 'failed')`,
          ["status"],
        ),
      ],
      [
        technicalIndex("outbox", "claim", [
          "status",
          "available_at",
          "lease_until",
        ]),
        technicalIndex("outbox", "event", ["event_id"]),
      ],
    ),
    technicalTable(
      "sagas",
      [
        technicalColumn("saga_id", "saga_id", "uuid", false),
        technicalColumn("saga_identity", "saga_identity", "text", false),
        technicalColumn("state", "state", "jsonb", false),
        technicalColumn("revision", "revision", "bigint", false, "0::bigint"),
        technicalColumn(
          "created_at",
          "created_at",
          "timestamptz",
          false,
          "transaction_timestamp()",
        ),
        technicalColumn(
          "updated_at",
          "updated_at",
          "timestamptz",
          false,
          "transaction_timestamp()",
        ),
      ],
      [technicalPrimaryKey("sagas", "saga_id")],
      [
        {
          ...technicalIndex("sagas", "runnable", [
            "saga_identity",
            "updated_at",
            "saga_id",
          ]),
          where: "(state ->> 'status') IN ('running', 'compensating')",
        },
      ],
    ),
    technicalTable(
      "failures",
      [
        technicalColumn(
          "failure_id",
          "failure_id",
          "uuid",
          false,
          "gen_random_uuid()",
        ),
        technicalColumn("event_id", "event_id", "uuid", false),
        technicalColumn("event_identity", "event_identity", "text", false),
        technicalColumn("code", "code", "text", false),
        technicalColumn("safe_message", "safe_message", "text", false),
        technicalColumn("correlation_id", "correlation_id", "uuid", false),
        technicalColumn("causation_id", "causation_id", "uuid", true),
        technicalColumn("saga_id", "saga_id", "uuid", true),
        technicalColumn("details", "details", "jsonb", true),
        technicalColumn("status", "status", "text", false, "'pending'::text"),
        technicalColumn(
          "attempt_count",
          "attempt_count",
          "bigint",
          false,
          "0::bigint",
        ),
        technicalColumn(
          "available_at",
          "available_at",
          "timestamptz",
          false,
          "transaction_timestamp()",
        ),
        technicalColumn("lease_owner", "lease_owner", "text", true),
        technicalColumn("lease_token", "lease_token", "uuid", true),
        technicalColumn("lease_until", "lease_until", "timestamptz", true),
        technicalColumn(
          "occurred_at",
          "occurred_at",
          "timestamptz",
          false,
          "transaction_timestamp()",
        ),
        technicalColumn("resolved_at", "resolved_at", "timestamptz", true),
      ],
      [
        technicalPrimaryKey("failures", "failure_id"),
        technicalUnique("failures", "event_id"),
        technicalCheck(
          "failures",
          "status",
          `${quotePostgreSqlIdentifier("status")} IN ('pending', 'processing', 'resolved', 'dead')`,
          ["status"],
        ),
      ],
      [
        technicalIndex("failures", "claim", [
          "status",
          "available_at",
          "lease_until",
        ]),
      ],
    ),
  ];
}

function technicalTable(
  id: string,
  columns: readonly PostgreSqlColumn[],
  constraints: readonly PostgreSqlConstraint[],
  indexes: readonly PostgreSqlIndex[] = [],
): PostgreSqlTable {
  const semanticId = `vane.infrastructure.${id}`;
  return {
    semanticId,
    module: null,
    name: `__vane_${id}`,
    technical: true,
    columns: columns
      .map((column) => ({
        ...column,
        semanticId: `${semanticId}.${column.semanticId}`,
      }))
      .sort((left, right) => compare(left.semanticId, right.semanticId)),
    constraints: constraints
      .map((item) => ({
        ...item,
        semanticId: `${semanticId}.${item.semanticId}`,
      }))
      .sort(compareConstraints),
    indexes: indexes
      .map((index) => ({
        ...index,
        semanticId: `${semanticId}.${index.semanticId}`,
      }))
      .sort((left, right) => compare(left.semanticId, right.semanticId)),
  };
}

function technicalColumn(
  semanticId: string,
  name: string,
  type: PostgreSqlType,
  nullable: boolean,
  defaultSql: string | null = null,
): PostgreSqlColumn {
  return {
    semanticId,
    name,
    type,
    nullable,
    defaultSql,
    generated: null,
    technical: true,
  };
}

function technicalPrimaryKey(
  table: string,
  column: string,
): PostgreSqlConstraint {
  return constraint(
    "primaryKey",
    toPostgreSqlIdentifier([`__vane_${table}`], "pk"),
    "primaryKey",
    [column],
  );
}

function technicalCheck(
  table: string,
  id: string,
  expression: string,
  columns: readonly string[],
): PostgreSqlConstraint {
  return {
    semanticId: `check.${id}`,
    name: toPostgreSqlIdentifier([`__vane_${table}`, id], "ck"),
    kind: "check",
    columns,
    expression,
    references: null,
  };
}

function technicalUnique(table: string, column: string): PostgreSqlConstraint {
  return constraint(
    `unique.${column}`,
    toPostgreSqlIdentifier([`__vane_${table}`, column], "uq"),
    "unique",
    [column],
  );
}

function technicalIndex(
  table: string,
  id: string,
  columns: readonly string[],
): PostgreSqlIndex {
  return {
    semanticId: `index.${id}`,
    name: toPostgreSqlIdentifier([`__vane_${table}`, id], "ix"),
    unique: false,
    columns,
    where: null,
  };
}

function constraint(
  semanticId: string,
  name: string,
  kind: PostgreSqlConstraint["kind"],
  columns: readonly string[],
): PostgreSqlConstraint {
  return {
    semanticId,
    name,
    kind,
    columns,
    expression: null,
    references: null,
  };
}

function entityId(moduleName: string, entityName: string): string {
  return `${moduleName}.${entityName}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareConstraints(
  left: PostgreSqlConstraint,
  right: PostgreSqlConstraint,
): number {
  return (
    compare(left.semanticId, right.semanticId) || compare(left.kind, right.kind)
  );
}

function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      compare(left.path.join("."), right.path.join(".")) ||
      compare(left.code, right.code) ||
      compare(left.message, right.message),
  );
}

function validatePhysicalIdentifiers(
  tables: readonly PostgreSqlTable[],
  diagnostics: Diagnostic[],
): void {
  validateIdentifierGroup(
    tables.map(({ semanticId, name }) => ({ semanticId, name })),
    ["postgresql", "tables"],
    "table",
    diagnostics,
  );
  const schemaIndexes: {
    readonly semanticId: string;
    readonly name: string;
  }[] = [];
  for (const table of tables) {
    validateIdentifierGroup(
      table.columns,
      ["postgresql", "tables", table.semanticId, "columns"],
      "column",
      diagnostics,
    );
    validateIdentifierGroup(
      table.constraints,
      ["postgresql", "tables", table.semanticId, "constraints"],
      "constraint",
      diagnostics,
    );
    schemaIndexes.push(...table.indexes);
    schemaIndexes.push(
      ...table.constraints.filter(
        ({ kind }) => kind === "primaryKey" || kind === "unique",
      ),
    );
  }
  validateIdentifierGroup(
    schemaIndexes,
    ["postgresql", "indexes"],
    "index",
    diagnostics,
  );
}

function validateIdentifierGroup(
  values: readonly { readonly semanticId: string; readonly name: string }[],
  path: readonly string[],
  subject: string,
  diagnostics: Diagnostic[],
): void {
  const owners = new Map<string, string>();
  for (const value of values) {
    const previous = owners.get(value.name);
    if (previous && previous !== value.semanticId) {
      diagnostics.push({
        code: "VANE_PG_IDENTIFIER_COLLISION",
        path: [...path, value.semanticId],
        message: `PostgreSQL ${subject} identifiers ${previous} and ${value.semanticId} both map to ${value.name}.`,
        correction: `Rename one semantic object so its physical ${subject} identifier is unique.`,
      });
    }
    owners.set(value.name, value.semanticId);
  }
}
