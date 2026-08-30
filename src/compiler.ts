import type {
  EntityDeclaration,
  ModuleDeclaration,
  RuleExpressionDeclaration,
  RuleValueDeclaration,
} from "./declaration.js";
import type { Diagnostic } from "./diagnostic.js";
import {
  SEMANTIC_IR_VERSION,
  type SemanticEntity,
  type SemanticIr,
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

  const entitiesByName = new Map(
    declaration.entities.map((entity) => [entity.name, entity] as const),
  );
  for (const entity of declaration.entities) {
    validateEntity(entity, entitiesByName, diagnostics);
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
