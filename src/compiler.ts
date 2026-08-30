import type {
  ColumnType,
  EntityColumnReferenceDeclaration,
  EntityDeclaration,
  ModuleDeclaration,
  RuleExpressionDeclaration,
  RuleValueDeclaration,
  ViewDeclaration,
  ViewExpressionDeclaration,
  ViewOutputExpressionDeclaration,
  ViewPaginationValueDeclaration,
  ViewValueDeclaration,
} from "./declaration.js";
import type { Diagnostic } from "./diagnostic.js";
import {
  SEMANTIC_IR_VERSION,
  type SemanticEntity,
  type SemanticIr,
  type SemanticView,
} from "./semantic-ir.js";

export type SemanticCompilationResult =
  | {
      readonly success: true;
      readonly ir: SemanticIr;
      readonly diagnostics: readonly [];
    }
  | { readonly success: false; readonly diagnostics: readonly Diagnostic[] };

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

export function compileSemanticIr(
  declaration: ModuleDeclaration,
): SemanticCompilationResult {
  const diagnostics: Diagnostic[] = [];

  validateName(declaration.name, ["module", "name"], "Module", diagnostics);
  validateUniqueNames(
    declaration.entities,
    ["module", "entities"],
    "Entity",
    diagnostics,
  );
  validateUniqueNames(
    declaration.views ?? [],
    ["module", "views"],
    "View",
    diagnostics,
  );

  const entitiesByName = new Map(
    declaration.entities.map((entity) => [entity.name, entity] as const),
  );
  for (const entity of declaration.entities) {
    validateEntity(entity, entitiesByName, diagnostics);
  }
  for (const view of declaration.views ?? []) {
    validateView(view, entitiesByName, diagnostics);
  }

  if (diagnostics.length > 0) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  return {
    success: true,
    diagnostics: [],
    ir: {
      schema: "vane.semantic-ir",
      version: SEMANTIC_IR_VERSION,
      module: {
        name: declaration.name,
        entities: declaration.entities
          .map(toSemanticEntity)
          .sort((left, right) => compare(left.name, right.name)),
        views: (declaration.views ?? [])
          .map((view) => toSemanticView(view, entitiesByName))
          .sort((left, right) => compare(left.name, right.name)),
      },
    },
  };
}

function validateEntity(
  entity: EntityDeclaration,
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
  diagnostics: Diagnostic[],
): void {
  const entityPath = ["module", "entities", entity.name];
  validateName(entity.name, [...entityPath, "name"], "Entity", diagnostics);
  validateUniqueNames(
    entity.columns,
    [...entityPath, "columns"],
    "Column",
    diagnostics,
  );
  validateUniqueNames(
    entity.rules ?? [],
    [...entityPath, "rules"],
    "Rule",
    diagnostics,
  );
  validateUniqueNames(
    entity.events ?? [],
    [...entityPath, "events"],
    "Event",
    diagnostics,
  );

  const identityColumns = entity.columns.filter((column) => column.identity);
  if (identityColumns.length !== 1) {
    diagnostics.push({
      code: "VANE_SEM_ENTITY_IDENTITY",
      path: [...entityPath, "columns"],
      message: `Entity ${entity.name} must declare exactly one identity Column; found ${identityColumns.length}.`,
      correction: "Mark exactly one Column with identity: true.",
    });
  }

  const columnNames = new Set(entity.columns.map((column) => column.name));
  for (const column of entity.columns) {
    validateName(
      column.name,
      [...entityPath, "columns", column.name],
      "Column",
      diagnostics,
    );
    if (column.references && !entitiesByName.has(column.references.entity)) {
      diagnostics.push({
        code: "VANE_SEM_REFERENCE_ENTITY",
        path: [...entityPath, "columns", column.name, "references", "entity"],
        message: `Column ${entity.name}.${column.name} references unknown Entity ${column.references.entity}.`,
        correction: "Reference an Entity declared in the same Module.",
      });
    } else if (column.references) {
      const referencedEntity = entitiesByName.get(column.references.entity);
      const referencedColumn = referencedEntity?.columns.find(
        (candidate) => candidate.name === column.references?.column,
      );
      if (!referencedColumn) {
        diagnostics.push({
          code: "VANE_SEM_REFERENCE_COLUMN",
          path: [...entityPath, "columns", column.name, "references", "column"],
          message: `Column ${entity.name}.${column.name} references unknown Column ${column.references.entity}.${column.references.column}.`,
          correction: "Reference a Column declared by the target Entity.",
        });
      } else if (referencedColumn.type !== column.type) {
        diagnostics.push({
          code: "VANE_SEM_REFERENCE_TYPE",
          path: [...entityPath, "columns", column.name, "references"],
          message: `Column ${entity.name}.${column.name} has type ${column.type}, but ${column.references.entity}.${column.references.column} has type ${referencedColumn.type}.`,
          correction:
            "Use compatible types for both sides of a Column reference.",
        });
      }
    }
  }

  for (const rule of entity.rules ?? []) {
    validateName(
      rule.name,
      [...entityPath, "rules", rule.name],
      "Rule",
      diagnostics,
    );
    const referencedColumns = collectRuleColumns(rule.expression);
    const unknownColumns = [...referencedColumns].filter(
      (column) => !columnNames.has(column),
    );

    for (const column of unknownColumns) {
      diagnostics.push({
        code: "VANE_SEM_RULE_COLUMN",
        path: [...entityPath, "rules", rule.name, "expression"],
        message: `Rule ${entity.name}.${rule.name} references unknown Column ${column}.`,
        correction: "Reference only Columns declared by the Rule owner Entity.",
      });
    }

    const nonFiniteLiterals = collectNonFiniteRuleLiterals(rule.expression);
    for (const literal of nonFiniteLiterals) {
      diagnostics.push({
        code: "VANE_SEM_RULE_LITERAL",
        path: [...entityPath, "rules", rule.name, "expression"],
        message: `Rule ${entity.name}.${rule.name} contains the non-finite numeric literal ${String(literal)}.`,
        correction:
          "Use a finite number so serialization preserves the Rule meaning.",
      });
    }

    if (referencedColumns.size < 2) {
      diagnostics.push({
        code: "VANE_SEM_RULE_ARITY",
        path: [...entityPath, "rules", rule.name, "expression"],
        message: `Rule ${entity.name}.${rule.name} references ${referencedColumns.size} distinct Column(s); at least two are required.`,
        correction: "Move single-Column constraints to the Column declaration.",
      });
    }
  }

  for (const event of entity.events ?? []) {
    validateName(
      event.name,
      [...entityPath, "events", event.name],
      "Event",
      diagnostics,
    );
    validateUniqueNames(
      event.input ?? [],
      [...entityPath, "events", event.name, "input"],
      "Event input",
      diagnostics,
    );
    for (const input of event.input ?? []) {
      validateName(
        input.name,
        [...entityPath, "events", event.name, "input", input.name],
        "Event input",
        diagnostics,
      );
    }
  }
}

function validateView(
  view: ViewDeclaration,
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
  diagnostics: Diagnostic[],
): void {
  const viewPath = ["module", "views", view.name];
  validateName(view.name, [...viewPath, "name"], "View", diagnostics);
  validateUniqueNames(
    view.input,
    [...viewPath, "input"],
    "View input",
    diagnostics,
  );
  validateUniqueNames(
    view.output,
    [...viewPath, "output"],
    "View output",
    diagnostics,
  );

  if (view.output.length === 0) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_OUTPUT",
      path: [...viewPath, "output"],
      message: `View ${view.name} must expose at least one output field.`,
      correction:
        "Project at least one Column or aggregate in the View output.",
    });
  }
  const hasAggregateOutput = view.output.some(
    ({ expression }) => expression.kind === "aggregate",
  );
  const hasColumnOutput = view.output.some(
    ({ expression }) => expression.kind === "column",
  );
  if (hasAggregateOutput && hasColumnOutput) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_AGGREGATE_MIX",
      path: [...viewPath, "output"],
      message: `View ${view.name} mixes aggregate and scalar projections without grouping semantics.`,
      correction:
        "Use only aggregate outputs in this slice, or split scalar projections into another View.",
    });
  }
  if (hasAggregateOutput && (view.query.orderBy?.length ?? 0) > 0) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_AGGREGATE_ORDER",
      path: [...viewPath, "query", "orderBy"],
      message: `Aggregate View ${view.name} cannot order by ungrouped Columns.`,
      correction:
        "Remove orderBy from the aggregate View until explicit grouping semantics are available.",
    });
  }

  const inputsByName = new Map(
    view.input.map((input) => [input.name, input] as const),
  );
  for (const input of view.input) {
    validateName(
      input.name,
      [...viewPath, "input", input.name],
      "View input",
      diagnostics,
    );
  }

  const root = entitiesByName.get(view.query.root);
  if (!root) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_ROOT",
      path: [...viewPath, "query", "root"],
      message: `View ${view.name} references unknown root Entity ${view.query.root}.`,
      correction: "Use an Entity declared in the same Module as the View root.",
    });
  }

  for (const output of view.output) {
    validateName(
      output.name,
      [...viewPath, "output", output.name],
      "View output",
      diagnostics,
    );
    resolveViewOutputType(
      output.expression,
      view.query.root,
      entitiesByName,
      [...viewPath, "output", output.name],
      diagnostics,
    );
  }

  if (view.query.where) {
    validateViewExpression(
      view.query.where,
      view.query.root,
      entitiesByName,
      inputsByName,
      [...viewPath, "query", "where"],
      diagnostics,
    );
  }

  for (const [index, order] of (view.query.orderBy ?? []).entries()) {
    resolveViewColumnType(
      order.value,
      view.query.root,
      entitiesByName,
      [...viewPath, "query", "orderBy", String(index)],
      diagnostics,
    );
  }

  if (view.query.pagination) {
    const { limit, offset } = view.query.pagination;
    if (!limit && !offset) {
      diagnostics.push({
        code: "VANE_SEM_VIEW_PAGINATION",
        path: [...viewPath, "query", "pagination"],
        message: `View ${view.name} declares empty pagination.`,
        correction: "Declare a limit, an offset, or remove pagination.",
      });
    }
    if (limit) {
      validatePaginationValue(
        limit,
        "limit",
        inputsByName,
        [...viewPath, "query", "pagination", "limit"],
        diagnostics,
      );
    }
    if (offset) {
      validatePaginationValue(
        offset,
        "offset",
        inputsByName,
        [...viewPath, "query", "pagination", "offset"],
        diagnostics,
      );
    }
  }
}

type ResolvedViewType = ColumnType | "number" | "null";

function validateViewExpression(
  expression: ViewExpressionDeclaration,
  rootEntity: string,
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
  inputsByName: ReadonlyMap<
    string,
    { readonly name: string; readonly type: ColumnType }
  >,
  path: readonly string[],
  diagnostics: Diagnostic[],
): void {
  if (expression.kind === "not") {
    validateViewExpression(
      expression.operand,
      rootEntity,
      entitiesByName,
      inputsByName,
      [...path, "operand"],
      diagnostics,
    );
    return;
  }
  if (expression.kind === "logical") {
    if (expression.operands.length < 2) {
      diagnostics.push({
        code: "VANE_SEM_VIEW_LOGICAL_ARITY",
        path,
        message: `View logical operator ${expression.operator} has ${expression.operands.length} operand(s).`,
        correction: "Use at least two filter expressions with and or or.",
      });
    }
    for (const [index, operand] of expression.operands.entries()) {
      validateViewExpression(
        operand,
        rootEntity,
        entitiesByName,
        inputsByName,
        [...path, String(index)],
        diagnostics,
      );
    }
    return;
  }

  const left = resolveViewValueType(
    expression.left,
    rootEntity,
    entitiesByName,
    inputsByName,
    [...path, "left"],
    diagnostics,
  );
  const right = resolveViewValueType(
    expression.right,
    rootEntity,
    entitiesByName,
    inputsByName,
    [...path, "right"],
    diagnostics,
  );
  if (
    (left === "null" || right === "null") &&
    expression.operator !== "eq" &&
    expression.operator !== "neq"
  ) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_TYPE",
      path,
      message: `View operator ${expression.operator} cannot order null.`,
      correction: "Use eq or neq when comparing with null.",
    });
    return;
  }
  if (left && right && !viewTypesCompatible(left, right)) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_TYPE",
      path,
      message: `View comparison uses incompatible values of type ${left} and ${right}.`,
      correction:
        "Compare a Column with an input or literal of a compatible type.",
    });
  }
}

function resolveViewValueType(
  value: ViewValueDeclaration,
  rootEntity: string,
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
  inputsByName: ReadonlyMap<
    string,
    { readonly name: string; readonly type: ColumnType }
  >,
  path: readonly string[],
  diagnostics: Diagnostic[],
): ResolvedViewType | undefined {
  if (value.kind === "column") {
    return resolveViewColumnType(
      value,
      rootEntity,
      entitiesByName,
      path,
      diagnostics,
    );
  }
  if (value.kind === "input") {
    const input = inputsByName.get(value.input);
    if (input) return input.type;
    diagnostics.push({
      code: "VANE_SEM_VIEW_INPUT",
      path,
      message: `View query references unknown input ${value.input}.`,
      correction: "Declare the input in the View input object.",
    });
    return undefined;
  }
  if (typeof value.value === "number") {
    if (!Number.isFinite(value.value)) {
      diagnostics.push({
        code: "VANE_SEM_VIEW_LITERAL",
        path,
        message: `View query contains the non-finite numeric literal ${String(value.value)}.`,
        correction:
          "Use a finite number so serialization preserves the query meaning.",
      });
    }
    return "number";
  }
  if (value.value === null) return "null";
  return typeof value.value === "boolean" ? "boolean" : "string";
}

function resolveViewColumnType(
  reference: EntityColumnReferenceDeclaration,
  rootEntity: string,
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
  path: readonly string[],
  diagnostics: Diagnostic[],
): ColumnType | undefined {
  const entity = entitiesByName.get(reference.entity);
  if (!entity) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_ENTITY",
      path,
      message: `View references unknown Entity ${reference.entity}.`,
      correction: "Reference an Entity declared in the same Module.",
    });
    return undefined;
  }
  const column = entity.columns.find(
    (candidate) => candidate.name === reference.column,
  );
  if (!column) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_COLUMN",
      path,
      message: `View references unknown Column ${reference.entity}.${reference.column}.`,
      correction: "Reference a Column declared by the selected Entity.",
    });
    return undefined;
  }
  if (reference.entity !== rootEntity) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_ROOT_SCOPE",
      path,
      message: `View rooted at ${rootEntity} cannot yet project ${reference.entity}.${reference.column} without an explicit relation path.`,
      correction:
        "Reference a root Entity Column in this slice; relation navigation will require a validated relation declaration.",
    });
  }
  return column.type;
}

function resolveViewOutputType(
  expression: ViewOutputExpressionDeclaration,
  rootEntity: string,
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
  path: readonly string[],
  diagnostics: Diagnostic[],
): ColumnType | undefined {
  if (expression.kind === "column") {
    return resolveViewColumnType(
      expression,
      rootEntity,
      entitiesByName,
      path,
      diagnostics,
    );
  }
  const type = resolveViewColumnType(
    expression.value,
    rootEntity,
    entitiesByName,
    path,
    diagnostics,
  );
  if (!type) return undefined;
  if (expression.function === "count") return "integer";
  if (
    (expression.function === "sum" || expression.function === "avg") &&
    type !== "integer" &&
    type !== "decimal"
  ) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_AGGREGATE",
      path,
      message: `${expression.function} cannot aggregate a ${type} Column.`,
      correction: "Use sum or avg with an integer or decimal Column.",
    });
    return undefined;
  }
  return expression.function === "avg" ? "decimal" : type;
}

function validatePaginationValue(
  value: ViewPaginationValueDeclaration,
  subject: "limit" | "offset",
  inputsByName: ReadonlyMap<
    string,
    { readonly name: string; readonly type: ColumnType }
  >,
  path: readonly string[],
  diagnostics: Diagnostic[],
): void {
  if (value.kind === "input") {
    const input = inputsByName.get(value.input);
    if (!input) {
      diagnostics.push({
        code: "VANE_SEM_VIEW_INPUT",
        path,
        message: `View pagination references unknown input ${value.input}.`,
        correction: "Declare the pagination input in the View input object.",
      });
    } else if (input.type !== "integer") {
      diagnostics.push({
        code: "VANE_SEM_VIEW_PAGINATION_TYPE",
        path,
        message: `View pagination ${subject} input ${value.input} has type ${input.type}.`,
        correction: "Use an integer input for pagination.",
      });
    }
    return;
  }

  const valid =
    Number.isSafeInteger(value.value) &&
    (subject === "limit" ? value.value > 0 : value.value >= 0);
  if (!valid) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_PAGINATION_VALUE",
      path,
      message: `View pagination ${subject} has invalid value ${value.value}.`,
      correction:
        subject === "limit"
          ? "Use a positive safe integer limit."
          : "Use a non-negative safe integer offset.",
    });
  }
}

function viewTypesCompatible(
  left: ResolvedViewType,
  right: ResolvedViewType,
): boolean {
  if (left === "null" || right === "null") return true;
  if (left === right) return true;
  const numeric = new Set<ResolvedViewType>(["integer", "decimal", "number"]);
  return numeric.has(left) && numeric.has(right);
}

function toSemanticView(
  view: ViewDeclaration,
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
): SemanticView {
  return {
    name: view.name,
    input: view.input
      .map((input) => ({
        name: input.name,
        type: input.type,
        optional: input.optional ?? false,
      }))
      .sort((left, right) => compare(left.name, right.name)),
    output: view.output
      .map((output) => ({
        name: output.name,
        type: inferViewOutputType(output.expression, entitiesByName),
        expression: canonicalizeViewOutput(output.expression),
      }))
      .sort((left, right) => compare(left.name, right.name)),
    query: {
      root: view.query.root,
      where: view.query.where
        ? canonicalizeViewExpression(view.query.where)
        : null,
      orderBy: (view.query.orderBy ?? []).map((order) => ({
        value: { entity: order.value.entity, column: order.value.column },
        direction: order.direction,
      })),
      pagination: view.query.pagination
        ? canonicalizePagination(view.query.pagination)
        : null,
    },
    persistence: { allowed: false },
    publicResult: { kind: "view" },
  };
}

function inferViewOutputType(
  expression: ViewOutputExpressionDeclaration,
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
): ColumnType {
  const reference =
    expression.kind === "column" ? expression : expression.value;
  const type = entitiesByName
    .get(reference.entity)
    ?.columns.find((column) => column.name === reference.column)?.type;
  if (!type)
    throw new Error("Validated View output has no resolvable Column type.");
  if (expression.kind === "column") return type;
  if (expression.function === "count") return "integer";
  return expression.function === "avg" ? "decimal" : type;
}

function canonicalizeViewOutput(
  expression: ViewOutputExpressionDeclaration,
): ViewOutputExpressionDeclaration {
  return expression.kind === "column"
    ? { kind: "column", entity: expression.entity, column: expression.column }
    : {
        kind: "aggregate",
        function: expression.function,
        value: {
          entity: expression.value.entity,
          column: expression.value.column,
        },
      };
}

function canonicalizeViewExpression(
  expression: ViewExpressionDeclaration,
): ViewExpressionDeclaration {
  if (expression.kind === "comparison") {
    return {
      kind: "comparison",
      operator: expression.operator,
      left: canonicalizeViewValue(expression.left),
      right: canonicalizeViewValue(expression.right),
    };
  }
  if (expression.kind === "not") {
    return {
      kind: "not",
      operand: canonicalizeViewExpression(expression.operand),
    };
  }
  return {
    kind: "logical",
    operator: expression.operator,
    operands: expression.operands
      .map(canonicalizeViewExpression)
      .sort((left, right) =>
        compare(JSON.stringify(left), JSON.stringify(right)),
      ),
  };
}

function canonicalizeViewValue(
  value: ViewValueDeclaration,
): ViewValueDeclaration {
  if (value.kind === "column") {
    return { kind: "column", entity: value.entity, column: value.column };
  }
  return value.kind === "input"
    ? { kind: "input", input: value.input }
    : { kind: "literal", value: value.value };
}

function canonicalizePagination(
  pagination: NonNullable<ViewDeclaration["query"]["pagination"]>,
): NonNullable<ViewDeclaration["query"]["pagination"]> {
  return {
    ...(pagination.limit ? { limit: { ...pagination.limit } } : {}),
    ...(pagination.offset ? { offset: { ...pagination.offset } } : {}),
  };
}

function toSemanticEntity(entity: EntityDeclaration): SemanticEntity {
  const identityColumn = entity.columns.find((column) => column.identity);
  if (!identityColumn) {
    throw new Error("Validated Entity has no identity Column.");
  }

  return {
    name: entity.name,
    identityColumn: identityColumn.name,
    columns: entity.columns
      .map((column) => ({
        name: column.name,
        type: column.type,
        identity: column.identity ?? false,
        nullable: column.nullable ?? false,
        unique: column.unique ?? false,
        generated: column.generated ?? null,
        references: column.references
          ? {
              entity: column.references.entity,
              column: column.references.column,
            }
          : null,
      }))
      .sort((left, right) => compare(left.name, right.name)),
    rules: (entity.rules ?? [])
      .map((rule) => ({
        name: rule.name,
        columns: [...collectRuleColumns(rule.expression)].sort(compare),
        expression: canonicalizeExpression(rule.expression),
      }))
      .sort((left, right) => compare(left.name, right.name)),
    events: (entity.events ?? [])
      .map((event) => ({
        identity: `${entity.name}.${event.name}`,
        name: event.name,
        owner: { kind: "entity" as const, entity: entity.name },
        persistence: { target: "owner" as const, required: true as const },
        input: (event.input ?? [])
          .map((input) => ({
            name: input.name,
            type: input.type,
            optional: input.optional ?? false,
          }))
          .sort((left, right) => compare(left.name, right.name)),
      }))
      .sort((left, right) => compare(left.identity, right.identity)),
  };
}

function collectRuleColumns(
  expression: RuleExpressionDeclaration,
): Set<string> {
  const columns = new Set<string>();

  const collectValue = (value: RuleValueDeclaration): void => {
    if (value.kind === "column") columns.add(value.column);
  };

  if (expression.kind === "comparison") {
    collectValue(expression.left);
    collectValue(expression.right);
  } else if (expression.kind === "not") {
    for (const column of collectRuleColumns(expression.operand))
      columns.add(column);
  } else {
    for (const operand of expression.operands) {
      for (const column of collectRuleColumns(operand)) columns.add(column);
    }
  }

  return columns;
}

function collectNonFiniteRuleLiterals(
  expression: RuleExpressionDeclaration,
): number[] {
  if (expression.kind === "comparison") {
    return [expression.left, expression.right]
      .filter(
        (value): value is Extract<RuleValueDeclaration, { kind: "literal" }> =>
          value.kind === "literal",
      )
      .map(({ value }) => value)
      .filter(
        (value): value is number =>
          typeof value === "number" && !Number.isFinite(value),
      );
  }

  if (expression.kind === "not") {
    return collectNonFiniteRuleLiterals(expression.operand);
  }

  return expression.operands.flatMap(collectNonFiniteRuleLiterals);
}

function canonicalizeExpression(
  expression: RuleExpressionDeclaration,
): RuleExpressionDeclaration {
  if (expression.kind === "comparison") {
    return {
      kind: "comparison",
      operator: expression.operator,
      left: canonicalizeRuleValue(expression.left),
      right: canonicalizeRuleValue(expression.right),
    };
  }
  if (expression.kind === "not") {
    return { kind: "not", operand: canonicalizeExpression(expression.operand) };
  }

  return {
    kind: "logical",
    operator: expression.operator,
    operands: expression.operands
      .map(canonicalizeExpression)
      .sort((left, right) =>
        compare(JSON.stringify(left), JSON.stringify(right)),
      ),
  };
}

function canonicalizeRuleValue(
  value: RuleValueDeclaration,
): RuleValueDeclaration {
  return value.kind === "column"
    ? { kind: "column", column: value.column }
    : { kind: "literal", value: value.value };
}

function validateName(
  name: string,
  path: readonly string[],
  subject: string,
  diagnostics: Diagnostic[],
): void {
  if (NAME_PATTERN.test(name)) return;
  diagnostics.push({
    code: "VANE_SEM_NAME",
    path,
    message: `${subject} name ${JSON.stringify(name)} is not a valid semantic identifier.`,
    correction:
      "Use ASCII letters and numbers, starting with a letter and without separators.",
  });
}

function validateUniqueNames(
  values: readonly { readonly name: string }[],
  path: readonly string[],
  subject: string,
  diagnostics: Diagnostic[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.name)) {
      diagnostics.push({
        code: "VANE_SEM_DUPLICATE_NAME",
        path: [...path, value.name],
        message: `${subject} name ${value.name} is duplicated.`,
        correction: `Give every ${subject} a unique name within its owner.`,
      });
    }
    seen.add(value.name);
  }
}

function sortDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const byPath = compare(left.path.join("."), right.path.join("."));
    return byPath === 0 ? compare(left.code, right.code) : byPath;
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
