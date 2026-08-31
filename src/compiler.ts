import type {
  AntiCorruptionLayerDeclaration,
  ColumnType,
  EntityColumnReferenceDeclaration,
  EntityDeclaration,
  EventReferenceDeclaration,
  JsonValue,
  ModuleDeclaration,
  RuleExpressionDeclaration,
  RuleValueDeclaration,
  SagaDeclaration,
  ViewDeclaration,
  ViewExpressionDeclaration,
  ViewOutputExpressionDeclaration,
  ViewPaginationValueDeclaration,
  ViewRelationDeclaration,
  ViewValueDeclaration,
} from "./declaration.js";
import type { Diagnostic } from "./diagnostic.js";
import {
  SEMANTIC_IR_VERSION,
  SEMANTIC_PROJECT_IR_VERSION,
  type SemanticAntiCorruptionLayer,
  type SemanticEntity,
  type SemanticIr,
  type SemanticModule,
  type SemanticProjectIr,
  type SemanticSaga,
  type SemanticView,
} from "./semantic-ir.js";

export type SemanticCompilationResult =
  | {
      readonly success: true;
      readonly ir: SemanticIr;
      readonly diagnostics: readonly [];
    }
  | { readonly success: false; readonly diagnostics: readonly Diagnostic[] };

export type SemanticProjectCompilationResult =
  | {
      readonly success: true;
      readonly ir: SemanticProjectIr;
      readonly diagnostics: readonly [];
    }
  | { readonly success: false; readonly diagnostics: readonly Diagnostic[] };

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

export function compileSemanticIr(
  declaration: ModuleDeclaration,
): SemanticCompilationResult {
  if ((declaration.imports?.length ?? 0) > 0) {
    return {
      success: false,
      diagnostics: [
        {
          code: "VANE_SEM_IMPORT_CONTEXT",
          path: ["module", "imports"],
          message: `Module ${declaration.name} declares imports that cannot be resolved in isolation.`,
          correction:
            "Compile every participating Module together with compileSemanticProject.",
        },
      ],
    };
  }
  return compileSemanticIrInternal(declaration);
}

function compileSemanticIrInternal(
  declaration: ModuleDeclaration,
  visibleDeclaration: ModuleDeclaration = declaration,
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
  validateUniqueNames(
    declaration.antiCorruptionLayers ?? [],
    ["module", "antiCorruptionLayers"],
    "Anti-Corruption Layer",
    diagnostics,
  );
  validateUniqueNames(
    declaration.sagas ?? [],
    ["module", "sagas"],
    "Saga",
    diagnostics,
  );
  validateEventOwnerNames(declaration, diagnostics);

  const entitiesByName = new Map(
    visibleDeclaration.entities.map((entity) => [entity.name, entity] as const),
  );
  for (const entity of declaration.entities) {
    validateEntity(entity, entitiesByName, diagnostics);
  }
  for (const view of declaration.views ?? []) {
    validateView(view, entitiesByName, diagnostics);
  }
  for (const antiCorruptionLayer of declaration.antiCorruptionLayers ?? []) {
    validateAntiCorruptionLayer(antiCorruptionLayer, diagnostics);
  }
  const eventIdentities = collectEventIdentities(visibleDeclaration);
  const viewNames = new Set(
    (visibleDeclaration.views ?? []).map(({ name }) => name),
  );
  for (const saga of declaration.sagas ?? []) {
    validateSaga(saga, eventIdentities, viewNames, diagnostics);
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
        imports: [...(declaration.imports ?? [])].sort(compare),
        entities: declaration.entities
          .map(toSemanticEntity)
          .sort((left, right) => compare(left.name, right.name)),
        views: (declaration.views ?? [])
          .map((view) => toSemanticView(view, entitiesByName))
          .sort((left, right) => compare(left.name, right.name)),
        antiCorruptionLayers: (declaration.antiCorruptionLayers ?? [])
          .map(toSemanticAntiCorruptionLayer)
          .sort((left, right) => compare(left.name, right.name)),
        sagas: (declaration.sagas ?? [])
          .map(toSemanticSaga)
          .sort((left, right) => compare(left.name, right.name)),
      },
    },
  };
}

export function compileSemanticProject(
  declarations: readonly ModuleDeclaration[],
): SemanticProjectCompilationResult {
  const diagnostics: Diagnostic[] = [];
  if (declarations.length === 0) {
    return {
      success: false,
      diagnostics: [
        {
          code: "VANE_SEM_PROJECT_EMPTY",
          path: ["project", "modules"],
          message: "A semantic project must contain at least one Module.",
          correction: "Compile one or more explicit Module declarations.",
        },
      ],
    };
  }
  validateUniqueNames(
    declarations,
    ["project", "modules"],
    "Module",
    diagnostics,
  );
  const modulesByName = new Map(
    declarations.map((declaration) => [declaration.name, declaration] as const),
  );

  for (const declaration of declarations) {
    validateName(
      declaration.name,
      ["project", "modules", declaration.name, "name"],
      "Module",
      diagnostics,
    );
    const seen = new Set<string>();
    for (const imported of declaration.imports ?? []) {
      const path = [
        "project",
        "modules",
        declaration.name,
        "imports",
        imported,
      ];
      if (seen.has(imported)) {
        diagnostics.push({
          code: "VANE_SEM_IMPORT_DUPLICATE",
          path,
          message: `Module ${declaration.name} imports Module ${imported} more than once.`,
          correction: "Keep each Module import once.",
        });
      }
      seen.add(imported);
      if (imported === declaration.name) {
        diagnostics.push({
          code: "VANE_SEM_IMPORT_SELF",
          path,
          message: `Module ${declaration.name} imports itself.`,
          correction: "Remove the self import.",
        });
      } else if (!modulesByName.has(imported)) {
        diagnostics.push({
          code: "VANE_SEM_IMPORT_UNKNOWN",
          path,
          message: `Module ${declaration.name} imports unknown Module ${imported}.`,
          correction:
            "Compile the imported Module in the same project or fix its name.",
        });
      }
    }
  }
  validateModuleImportCycles(declarations, modulesByName, diagnostics);
  if (diagnostics.length > 0) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  const modules: SemanticModule[] = [];
  for (const declaration of declarations) {
    const visible = collectVisibleModules(declaration, modulesByName);
    const combined: ModuleDeclaration = {
      name: declaration.name,
      ...(declaration.imports ? { imports: declaration.imports } : {}),
      entities: visible.flatMap((module) => module.entities),
      views: visible.flatMap((module) => module.views ?? []),
      antiCorruptionLayers: visible.flatMap(
        (module) => module.antiCorruptionLayers ?? [],
      ),
      sagas: visible.flatMap((module) => module.sagas ?? []),
    };
    const visibilityDiagnostics: Diagnostic[] = [];
    validateVisibleImportAmbiguities(visible, visibilityDiagnostics);
    if (visibilityDiagnostics.length > 0) {
      diagnostics.push(
        ...visibilityDiagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: [
            "project",
            "modules",
            declaration.name,
            ...diagnostic.path.slice(1),
          ],
        })),
      );
      continue;
    }

    const compiled = compileSemanticIrInternal(declaration, combined);
    if (!compiled.success) {
      diagnostics.push(
        ...compiled.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: [
            "project",
            "modules",
            declaration.name,
            ...diagnostic.path.slice(1),
          ],
        })),
      );
      continue;
    }

    modules.push({
      ...compiled.ir.module,
      imports: [...(declaration.imports ?? [])].sort(compare),
    });
  }

  if (diagnostics.length > 0) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }
  return {
    success: true,
    diagnostics: [],
    ir: {
      schema: "vane.semantic-project-ir",
      version: SEMANTIC_PROJECT_IR_VERSION,
      modules: modules.sort((left, right) => compare(left.name, right.name)),
    },
  };
}

function validateVisibleImportAmbiguities(
  visible: readonly ModuleDeclaration[],
  diagnostics: Diagnostic[],
): void {
  const validateAcrossModules = (
    property: "entities" | "views" | "antiCorruptionLayers" | "sagas",
    subject: string,
  ): void => {
    const modulesByConceptName = new Map<string, Set<string>>();
    for (const module of visible) {
      for (const concept of module[property] ?? []) {
        const owners = modulesByConceptName.get(concept.name) ?? new Set();
        owners.add(module.name);
        modulesByConceptName.set(concept.name, owners);
      }
    }
    for (const [name, owners] of modulesByConceptName) {
      if (owners.size < 2) continue;
      diagnostics.push({
        code: "VANE_SEM_DUPLICATE_NAME",
        path: ["module", property, name],
        message: `${subject} name ${name} is ambiguous across visible Modules ${[...owners].sort(compare).join(", ")}.`,
        correction: `Rename or stop importing one of the conflicting ${subject} declarations.`,
      });
    }
  };

  validateAcrossModules("entities", "Entity");
  validateAcrossModules("views", "View");
  validateAcrossModules("antiCorruptionLayers", "Anti-Corruption Layer");
  validateAcrossModules("sagas", "Saga");

  const entityOwners = new Map<string, Set<string>>();
  const layerOwners = new Map<string, Set<string>>();
  for (const module of visible) {
    for (const entity of module.entities) {
      const owners = entityOwners.get(entity.name) ?? new Set();
      owners.add(module.name);
      entityOwners.set(entity.name, owners);
    }
    for (const layer of module.antiCorruptionLayers ?? []) {
      const owners = layerOwners.get(layer.name) ?? new Set();
      owners.add(module.name);
      layerOwners.set(layer.name, owners);
    }
  }
  for (const [name, entities] of entityOwners) {
    const layers = layerOwners.get(name);
    if (!layers) continue;
    const owners = new Set([...entities, ...layers]);
    if (owners.size < 2) continue;
    diagnostics.push({
      code: "VANE_SEM_EVENT_OWNER",
      path: ["module", "antiCorruptionLayers", name, "name"],
      message: `Event owner name ${name} is ambiguous across visible Modules ${[...owners].sort(compare).join(", ")}.`,
      correction:
        "Give every visible Entity and Anti-Corruption Layer a distinct owner name.",
    });
  }
}

function collectVisibleModules(
  declaration: ModuleDeclaration,
  modulesByName: ReadonlyMap<string, ModuleDeclaration>,
): readonly ModuleDeclaration[] {
  const visible = new Map<string, ModuleDeclaration>([
    [declaration.name, declaration],
  ]);
  const visit = (name: string): void => {
    if (visible.has(name)) return;
    const imported = modulesByName.get(name);
    if (!imported) return;
    visible.set(name, imported);
    for (const transitive of imported.imports ?? []) visit(transitive);
  };
  for (const imported of declaration.imports ?? []) visit(imported);
  return [...visible.values()].sort((left, right) =>
    compare(left.name, right.name),
  );
}

function validateModuleImportCycles(
  declarations: readonly ModuleDeclaration[],
  modulesByName: ReadonlyMap<string, ModuleDeclaration>,
  diagnostics: Diagnostic[],
): void {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string, path: readonly string[]): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      diagnostics.push({
        code: "VANE_SEM_IMPORT_CYCLE",
        path: ["project", "modules", name, "imports"],
        message: `Module import cycle detected: ${[...path, name].join(" -> ")}.`,
        correction: "Make Module composition acyclic.",
      });
      return;
    }
    visiting.add(name);
    for (const imported of modulesByName.get(name)?.imports ?? []) {
      if (modulesByName.has(imported)) visit(imported, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const declaration of declarations) visit(declaration.name, []);
}

function collectEventIdentities(declaration: ModuleDeclaration): Set<string> {
  return new Set([
    ...declaration.entities.flatMap((entity) =>
      (entity.events ?? []).map((event) => `${entity.name}.${event.name}`),
    ),
    ...(declaration.antiCorruptionLayers ?? []).flatMap((layer) =>
      layer.events.map((event) => `${layer.name}.${event.name}`),
    ),
  ]);
}

function validateEventOwnerNames(
  declaration: ModuleDeclaration,
  diagnostics: Diagnostic[],
): void {
  const entityNames = new Set(declaration.entities.map(({ name }) => name));
  for (const antiCorruptionLayer of declaration.antiCorruptionLayers ?? []) {
    if (!entityNames.has(antiCorruptionLayer.name)) continue;
    diagnostics.push({
      code: "VANE_SEM_EVENT_OWNER",
      path: [
        "module",
        "antiCorruptionLayers",
        antiCorruptionLayer.name,
        "name",
      ],
      message: `Event owner name ${antiCorruptionLayer.name} is used by both an Entity and an Anti-Corruption Layer.`,
      correction:
        "Give every Entity and Anti-Corruption Layer a distinct owner name so Owner.Event identities remain unambiguous.",
    });
  }
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
    validateColumnConstraints(entity.name, column, entityPath, diagnostics);
    if (column.references && !entitiesByName.has(column.references.entity)) {
      diagnostics.push({
        code: "VANE_SEM_REFERENCE_ENTITY",
        path: [...entityPath, "columns", column.name, "references", "entity"],
        message: `Column ${entity.name}.${column.name} references unknown Entity ${column.references.entity}.`,
        correction:
          "Reference an Entity declared by this Module or one of its imports.",
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

function validateColumnConstraints(
  entityName: string,
  column: EntityDeclaration["columns"][number],
  entityPath: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const path = [...entityPath, "columns", column.name];
  const issue = (suffix: string, message: string, correction: string): void => {
    diagnostics.push({
      code: "VANE_SEM_COLUMN_CONSTRAINT",
      path: [...path, suffix],
      message: `Column ${entityName}.${column.name} ${message}`,
      correction,
    });
  };
  if (column.identity && column.nullable) {
    issue(
      "nullable",
      "cannot be both identity and nullable.",
      "Make the identity Column non-nullable.",
    );
  }
  if (column.generated && column.default !== undefined) {
    issue(
      "default",
      "cannot combine generated and default values.",
      "Choose generation or a default value, not both.",
    );
  }
  if (column.generated === "uuid" && column.type !== "uuid") {
    issue(
      "generated",
      "uses uuid generation with a non-uuid type.",
      "Use type uuid or remove uuid generation.",
    );
  }
  if (column.generated === "increment" && column.type !== "integer") {
    issue(
      "generated",
      "uses increment generation with a non-integer type.",
      "Use type integer or remove increment generation.",
    );
  }
  if (
    (column.minLength !== undefined || column.maxLength !== undefined) &&
    column.type !== "string"
  ) {
    issue(
      "minLength",
      "declares length constraints for a non-string type.",
      "Use length constraints only on string Columns.",
    );
  }
  for (const [name, value] of [
    ["minLength", column.minLength],
    ["maxLength", column.maxLength],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      issue(
        name,
        `declares invalid ${name} ${value}.`,
        `Use a non-negative safe integer for ${name}.`,
      );
    }
  }
  if (
    column.minLength !== undefined &&
    column.maxLength !== undefined &&
    column.minLength > column.maxLength
  ) {
    issue(
      "minLength",
      "declares minLength greater than maxLength.",
      "Make minLength less than or equal to maxLength.",
    );
  }
  if (
    (column.minimum !== undefined || column.maximum !== undefined) &&
    column.type !== "integer" &&
    column.type !== "decimal"
  ) {
    issue(
      "minimum",
      "declares numeric bounds for a non-numeric type.",
      "Use numeric bounds only on integer or decimal Columns.",
    );
  }
  for (const [name, value] of [
    ["minimum", column.minimum],
    ["maximum", column.maximum],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      issue(
        name,
        `declares non-finite ${name} ${String(value)}.`,
        `Use a finite number for ${name}.`,
      );
    }
    if (
      value !== undefined &&
      column.type === "integer" &&
      !Number.isSafeInteger(value)
    ) {
      issue(
        name,
        `declares non-integer ${name} ${value} for an integer Column.`,
        `Use a safe integer for ${name}.`,
      );
    }
  }
  if (
    column.minimum !== undefined &&
    column.maximum !== undefined &&
    column.minimum > column.maximum
  ) {
    issue(
      "minimum",
      "declares minimum greater than maximum.",
      "Make minimum less than or equal to maximum.",
    );
  }
  if (column.default === null && !column.nullable) {
    issue(
      "default",
      "uses null as the default while nullable is false.",
      "Make the Column nullable or choose a non-null default.",
    );
  } else if (
    column.default !== undefined &&
    column.default !== null &&
    !columnDefaultMatchesType(column.type, column.default)
  ) {
    issue(
      "default",
      `uses a default incompatible with type ${column.type}.`,
      "Use a default value compatible with the Column type.",
    );
  }
  if (column.default !== undefined) {
    for (const issue of collectJsonDefaultIssues(column.default)) {
      diagnostics.push({
        code: "VANE_SEM_COLUMN_CONSTRAINT",
        path: [...path, "default", ...issue.path],
        message:
          issue.kind === "cycle"
            ? `Column ${entityName}.${column.name} contains a cycle in its default value.`
            : issue.kind === "sparseArray"
              ? `Column ${entityName}.${column.name} contains a sparse array in its default value.`
              : `Column ${entityName}.${column.name} contains a non-finite number in its default value.`,
        correction:
          issue.kind === "cycle"
            ? "Use an acyclic JSON value so it can be materialized and serialized deterministically."
            : issue.kind === "sparseArray"
              ? "Fill every JSON array position explicitly so the in-memory and serialized defaults are identical."
              : "Use only finite JSON numbers so serialization preserves the default exactly.",
      });
    }
  }
  if (typeof column.default === "string" && column.type === "string") {
    if (
      column.minLength !== undefined &&
      column.default.length < column.minLength
    ) {
      issue(
        "default",
        "uses a default shorter than minLength.",
        "Choose a default that satisfies the Column length constraints.",
      );
    }
    if (
      column.maxLength !== undefined &&
      column.default.length > column.maxLength
    ) {
      issue(
        "default",
        "uses a default longer than maxLength.",
        "Choose a default that satisfies the Column length constraints.",
      );
    }
  }
  if (
    typeof column.default === "number" &&
    (column.type === "integer" || column.type === "decimal")
  ) {
    if (column.minimum !== undefined && column.default < column.minimum) {
      issue(
        "default",
        "uses a default below minimum.",
        "Choose a default inside the declared numeric bounds.",
      );
    }
    if (column.maximum !== undefined && column.default > column.maximum) {
      issue(
        "default",
        "uses a default above maximum.",
        "Choose a default inside the declared numeric bounds.",
      );
    }
  }
}

interface JsonDefaultIssue {
  readonly kind: "cycle" | "nonFinite" | "sparseArray";
  readonly path: readonly string[];
}

function collectJsonDefaultIssues(
  value: JsonValue,
  path: readonly string[] = [],
  activeContainers: ReadonlySet<object> = new Set(),
): readonly JsonDefaultIssue[] {
  if (typeof value === "number") {
    return Number.isFinite(value) ? [] : [{ kind: "nonFinite", path }];
  }
  if (value && typeof value === "object") {
    if (activeContainers.has(value)) return [{ kind: "cycle", path }];
    const nestedActiveContainers = new Set(activeContainers).add(value);
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) =>
        Object.hasOwn(value, index)
          ? collectJsonDefaultIssues(
              value[index] as JsonValue,
              [...path, String(index)],
              nestedActiveContainers,
            )
          : [
              {
                kind: "sparseArray" as const,
                path: [...path, String(index)],
              },
            ],
      ).flat();
    }
    return Object.entries(value).flatMap(([key, nested]) =>
      collectJsonDefaultIssues(nested, [...path, key], nestedActiveContainers),
    );
  }
  return [];
}

function columnDefaultMatchesType(
  type: ColumnType,
  value: Exclude<JsonValue, null>,
): boolean {
  if (type === "json") return true;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer")
    return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "decimal")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string";
}

function validateAntiCorruptionLayer(
  antiCorruptionLayer: AntiCorruptionLayerDeclaration,
  diagnostics: Diagnostic[],
): void {
  const layerPath = [
    "module",
    "antiCorruptionLayers",
    antiCorruptionLayer.name,
  ];
  validateName(
    antiCorruptionLayer.name,
    [...layerPath, "name"],
    "Anti-Corruption Layer",
    diagnostics,
  );
  validateUniqueNames(
    antiCorruptionLayer.events,
    [...layerPath, "events"],
    "ACL Event",
    diagnostics,
  );

  for (const event of antiCorruptionLayer.events) {
    const eventPath = [...layerPath, "events", event.name];
    validateName(event.name, [...eventPath, "name"], "ACL Event", diagnostics);
    validateUniqueNames(
      event.input ?? [],
      [...eventPath, "input"],
      "ACL Event input",
      diagnostics,
    );
    validateUniqueNames(
      event.results,
      [...eventPath, "results"],
      "ACL Event result",
      diagnostics,
    );
    for (const input of event.input ?? []) {
      validateName(
        input.name,
        [...eventPath, "input", input.name],
        "ACL Event input",
        diagnostics,
      );
    }
    for (const result of event.results) {
      const resultPath = [...eventPath, "results", result.name];
      validateName(
        result.name,
        [...resultPath, "name"],
        "ACL Event result",
        diagnostics,
      );
      validateUniqueNames(
        result.data,
        [...resultPath, "data"],
        "ACL Event result data",
        diagnostics,
      );
      for (const field of result.data) {
        validateName(
          field.name,
          [...resultPath, "data", field.name],
          "ACL Event result data",
          diagnostics,
        );
      }
    }

    const outcomes = new Set(event.results.map(({ outcome }) => outcome));
    for (const required of ["success", "fail"] as const) {
      if (outcomes.has(required)) continue;
      diagnostics.push({
        code: "VANE_SEM_ACL_EVENT_OUTCOME",
        path: [...eventPath, "results"],
        message: `ACL Event ${antiCorruptionLayer.name}.${event.name} does not interpret any external result as ${required}.`,
        correction: `Declare at least one ${required}(...) result interpretation.`,
      });
    }
  }
}

function validateSaga(
  saga: SagaDeclaration,
  eventIdentities: ReadonlySet<string>,
  viewNames: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): void {
  const sagaPath = ["module", "sagas", saga.name];
  validateName(saga.name, [...sagaPath, "name"], "Saga", diagnostics);
  validateUniqueNames(
    saga.input,
    [...sagaPath, "input"],
    "Saga input",
    diagnostics,
  );
  validateUniqueNames(
    saga.steps,
    [...sagaPath, "steps"],
    "Saga step",
    diagnostics,
  );
  for (const input of saga.input) {
    validateName(
      input.name,
      [...sagaPath, "input", input.name],
      "Saga input",
      diagnostics,
    );
  }

  if (saga.steps.length === 0) {
    diagnostics.push({
      code: "VANE_SEM_SAGA_STEPS",
      path: [...sagaPath, "steps"],
      message: `Saga ${saga.name} has no Event steps.`,
      correction: "Declare at least one Event step in the Saga.",
    });
  }

  const stepNames = new Set(saga.steps.map(({ name }) => name));
  for (const step of saga.steps) {
    const stepPath = [...sagaPath, "steps", step.name];
    validateName(step.name, [...stepPath, "name"], "Saga step", diagnostics);
    validateSagaEventReference(
      step.event,
      eventIdentities,
      [...stepPath, "event"],
      diagnostics,
    );
    if (step.compensateWith) {
      validateSagaEventReference(
        step.compensateWith,
        eventIdentities,
        [...stepPath, "compensateWith"],
        diagnostics,
      );
    }

    const seenCauses = new Set<string>();
    for (const cause of step.causedBy) {
      if (seenCauses.has(cause)) {
        diagnostics.push({
          code: "VANE_SEM_SAGA_CAUSE_DUPLICATE",
          path: [...stepPath, "causedBy", cause],
          message: `Saga step ${step.name} declares causal predecessor ${cause} more than once.`,
          correction: "Keep each causal predecessor once.",
        });
      }
      seenCauses.add(cause);
      if (!stepNames.has(cause)) {
        diagnostics.push({
          code: "VANE_SEM_SAGA_CAUSE",
          path: [...stepPath, "causedBy", cause],
          message: `Saga step ${step.name} references unknown causal predecessor ${cause}.`,
          correction: "Reference a step declared in the same Saga.",
        });
      }
    }
  }

  validateSagaAcyclic(saga, diagnostics);

  if (!stepNames.has(saga.terminal.step)) {
    diagnostics.push({
      code: "VANE_SEM_SAGA_TERMINAL_STEP",
      path: [...sagaPath, "terminal", "step"],
      message: `Saga ${saga.name} references unknown terminal step ${saga.terminal.step}.`,
      correction: "Choose a step declared in this Saga as the terminal step.",
    });
  }
  if (!viewNames.has(saga.terminal.view)) {
    diagnostics.push({
      code: "VANE_SEM_SAGA_TERMINAL_VIEW",
      path: [...sagaPath, "terminal", "view"],
      message: `Saga ${saga.name} references unknown terminal View ${saga.terminal.view}.`,
      correction: "Use a View declared by this Module or one of its imports.",
    });
  }

  const stepsWithSuccessors = new Set(
    saga.steps.flatMap(({ causedBy }) => causedBy),
  );
  const sinks = saga.steps
    .map(({ name }) => name)
    .filter((name) => !stepsWithSuccessors.has(name))
    .sort(compare);
  if (sinks.length !== 1 || sinks[0] !== saga.terminal.step) {
    diagnostics.push({
      code: "VANE_SEM_SAGA_TERMINAL_GRAPH",
      path: [...sagaPath, "terminal", "step"],
      message: `Saga ${saga.name} terminal step must be the graph's only sink; found ${sinks.length === 0 ? "none" : sinks.join(", ")}.`,
      correction:
        "Connect every causal branch to one final step and select that step as terminal.",
    });
  }
}

function validateSagaEventReference(
  reference: EventReferenceDeclaration,
  eventIdentities: ReadonlySet<string>,
  path: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const identity = `${reference.owner}.${reference.event}`;
  if (eventIdentities.has(identity)) return;
  diagnostics.push({
    code: "VANE_SEM_SAGA_EVENT",
    path,
    message: `Saga references unknown Event ${identity}.`,
    correction:
      "Reference an Event visible through this Module's explicit import graph.",
  });
}

function validateSagaAcyclic(
  saga: SagaDeclaration,
  diagnostics: Diagnostic[],
): void {
  const known = new Set(saga.steps.map(({ name }) => name));
  const causesByStep = new Map(
    saga.steps.map((step) => [
      step.name,
      step.causedBy.filter((cause) => known.has(cause)),
    ]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycle: readonly string[] | undefined;

  const visit = (step: string, path: readonly string[]): void => {
    if (cycle || visited.has(step)) return;
    if (visiting.has(step)) {
      cycle = [...path, step];
      return;
    }
    visiting.add(step);
    for (const cause of causesByStep.get(step) ?? []) {
      visit(cause, [...path, step]);
    }
    visiting.delete(step);
    visited.add(step);
  };
  for (const step of [...known].sort(compare)) visit(step, []);
  if (!cycle) return;
  diagnostics.push({
    code: "VANE_SEM_SAGA_CYCLE",
    path: ["module", "sagas", saga.name, "steps"],
    message: `Saga ${saga.name} contains a causal cycle: ${cycle.join(" -> ")}.`,
    correction: "Remove the cycle so the Saga forms a directed acyclic graph.",
  });
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
  validateUniqueNames(
    view.query.relations ?? [],
    [...viewPath, "query", "relations"],
    "View relation",
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
        "Use only aggregate outputs without grouping, or split scalar projections into another View.",
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
      correction:
        "Use an Entity visible through the View owner's explicit import graph.",
    });
  }
  const reachableEntities = validateViewRelations(
    view.query.root,
    view.query.relations ?? [],
    entitiesByName,
    viewPath,
    diagnostics,
  );

  for (const output of view.output) {
    validateName(
      output.name,
      [...viewPath, "output", output.name],
      "View output",
      diagnostics,
    );
    resolveViewOutputType(
      output.expression,
      reachableEntities,
      entitiesByName,
      [...viewPath, "output", output.name],
      diagnostics,
    );
  }

  if (view.query.where) {
    validateViewExpression(
      view.query.where,
      reachableEntities,
      entitiesByName,
      inputsByName,
      [...viewPath, "query", "where"],
      diagnostics,
    );
  }

  for (const [index, order] of (view.query.orderBy ?? []).entries()) {
    resolveViewColumnType(
      order.value,
      reachableEntities,
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

function validateViewRelations(
  root: string,
  relations: readonly ViewRelationDeclaration[],
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
  viewPath: readonly string[],
  diagnostics: Diagnostic[],
): ReadonlySet<string> {
  const reachable = new Set<string>([root]);
  const pending = [...relations];
  for (const relation of relations) {
    validateName(
      relation.name,
      [...viewPath, "query", "relations", relation.name],
      "View relation",
      diagnostics,
    );
    resolveViewColumnType(
      relation.from,
      new Set(entitiesByName.keys()),
      entitiesByName,
      [...viewPath, "query", "relations", relation.name, "from"],
      diagnostics,
    );
    resolveViewColumnType(
      relation.to,
      new Set(entitiesByName.keys()),
      entitiesByName,
      [...viewPath, "query", "relations", relation.name, "to"],
      diagnostics,
    );
    const fromType = entitiesByName
      .get(relation.from.entity)
      ?.columns.find(({ name }) => name === relation.from.column)?.type;
    const toType = entitiesByName
      .get(relation.to.entity)
      ?.columns.find(({ name }) => name === relation.to.column)?.type;
    const fromColumn = entitiesByName
      .get(relation.from.entity)
      ?.columns.find(({ name }) => name === relation.from.column);
    const toColumn = entitiesByName
      .get(relation.to.entity)
      ?.columns.find(({ name }) => name === relation.to.column);
    if (fromType && toType && fromType !== toType) {
      diagnostics.push({
        code: "VANE_SEM_VIEW_RELATION_TYPE",
        path: [...viewPath, "query", "relations", relation.name],
        message: `View relation ${relation.name} joins incompatible ${fromType} and ${toType} Columns.`,
        correction: "Join Columns with compatible semantic types.",
      });
    }
    const declaredReference =
      (fromColumn?.references?.entity === relation.to.entity &&
        fromColumn.references.column === relation.to.column) ||
      (toColumn?.references?.entity === relation.from.entity &&
        toColumn.references.column === relation.from.column);
    if (fromColumn && toColumn && !declaredReference) {
      diagnostics.push({
        code: "VANE_SEM_VIEW_RELATION_REFERENCE",
        path: [...viewPath, "query", "relations", relation.name],
        message: `View relation ${relation.name} does not follow a declared Column reference.`,
        correction:
          "Join the referencing Column to the exact referenced Column.",
      });
    }
  }
  const parents = new Map<string, string>();
  const find = (entity: string): string => {
    const parent = parents.get(entity);
    if (!parent) {
      parents.set(entity, entity);
      return entity;
    }
    if (parent === entity) return entity;
    const rootParent = find(parent);
    parents.set(entity, rootParent);
    return rootParent;
  };
  for (const relation of [...relations].sort((left, right) =>
    compare(left.name, right.name),
  )) {
    const fromRoot = find(relation.from.entity);
    const toRoot = find(relation.to.entity);
    if (fromRoot === toRoot) {
      diagnostics.push({
        code: "VANE_SEM_VIEW_RELATION_AMBIGUOUS",
        path: [...viewPath, "query", "relations", relation.name],
        message: `View relation ${relation.name} creates an ambiguous path between Entity instances.`,
        correction:
          "Keep one acyclic relation path from the View root to each Entity; relation aliases are not implicit.",
      });
      continue;
    }
    parents.set(toRoot, fromRoot);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of pending) {
      if (
        reachable.has(relation.from.entity) &&
        !reachable.has(relation.to.entity)
      ) {
        reachable.add(relation.to.entity);
        changed = true;
      } else if (
        reachable.has(relation.to.entity) &&
        !reachable.has(relation.from.entity)
      ) {
        reachable.add(relation.from.entity);
        changed = true;
      }
    }
  }
  for (const relation of relations) {
    if (
      reachable.has(relation.from.entity) &&
      reachable.has(relation.to.entity)
    )
      continue;
    diagnostics.push({
      code: "VANE_SEM_VIEW_RELATION_PATH",
      path: [...viewPath, "query", "relations", relation.name],
      message: `View relation ${relation.name} is not connected to root Entity ${root}.`,
      correction:
        "Declare an explicit relation chain beginning at the View root.",
    });
  }
  return reachable;
}

type ResolvedViewType = ColumnType | "number" | "null";

function validateViewExpression(
  expression: ViewExpressionDeclaration,
  reachableEntities: ReadonlySet<string>,
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
      reachableEntities,
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
        reachableEntities,
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
    reachableEntities,
    entitiesByName,
    inputsByName,
    [...path, "left"],
    diagnostics,
  );
  const right = resolveViewValueType(
    expression.right,
    reachableEntities,
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
  reachableEntities: ReadonlySet<string>,
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
      reachableEntities,
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
  reachableEntities: ReadonlySet<string>,
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
      correction:
        "Reference an Entity declared by this Module or one of its imports.",
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
  if (!reachableEntities.has(reference.entity)) {
    diagnostics.push({
      code: "VANE_SEM_VIEW_ROOT_SCOPE",
      path,
      message: `View cannot reach ${reference.entity}.${reference.column} from its root without an explicit relation path.`,
      correction:
        "Declare a validated relation chain from the View root to this Entity.",
    });
  }
  return column.type;
}

function resolveViewOutputType(
  expression: ViewOutputExpressionDeclaration,
  reachableEntities: ReadonlySet<string>,
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
  path: readonly string[],
  diagnostics: Diagnostic[],
): ColumnType | undefined {
  if (expression.kind === "column") {
    return resolveViewColumnType(
      expression,
      reachableEntities,
      entitiesByName,
      path,
      diagnostics,
    );
  }
  const type = resolveViewColumnType(
    expression.value,
    reachableEntities,
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
      .map((output) => {
        const contract = inferViewOutputContract(
          output.expression,
          entitiesByName,
        );
        return {
          name: output.name,
          ...contract,
          expression: canonicalizeViewOutput(output.expression),
        };
      })
      .sort((left, right) => compare(left.name, right.name)),
    query: {
      root: view.query.root,
      relations: (view.query.relations ?? [])
        .map((relation) => ({
          name: relation.name,
          from: {
            entity: relation.from.entity,
            column: relation.from.column,
          },
          to: { entity: relation.to.entity, column: relation.to.column },
        }))
        .sort((left, right) => compare(left.name, right.name)),
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

function inferViewOutputContract(
  expression: ViewOutputExpressionDeclaration,
  entitiesByName: ReadonlyMap<string, EntityDeclaration>,
): { readonly type: ColumnType; readonly nullable: boolean } {
  const reference =
    expression.kind === "column" ? expression : expression.value;
  const column = entitiesByName
    .get(reference.entity)
    ?.columns.find((candidate) => candidate.name === reference.column);
  if (!column)
    throw new Error("Validated View output has no resolvable Column type.");
  if (expression.kind === "column") {
    return { type: column.type, nullable: column.nullable ?? false };
  }
  if (expression.function === "count") {
    return { type: "integer", nullable: false };
  }
  return {
    type: expression.function === "avg" ? "decimal" : column.type,
    nullable: true,
  };
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
        minLength: column.minLength ?? null,
        maxLength: column.maxLength ?? null,
        minimum: column.minimum ?? null,
        maximum: column.maximum ?? null,
        default:
          column.default === undefined
            ? null
            : canonicalizeJsonValue(column.default),
        hasDefault: column.default !== undefined,
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
        publicResult: {
          success: "viewOnly" as const,
          fail: {
            code: "stable" as const,
            message: "safe" as const,
            correlationId: true as const,
          },
        },
      }))
      .sort((left, right) => compare(left.identity, right.identity)),
  };
}

function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, nested]) => [key, canonicalizeJsonValue(nested)]),
    );
  }
  return value;
}

function toSemanticAntiCorruptionLayer(
  antiCorruptionLayer: AntiCorruptionLayerDeclaration,
): SemanticAntiCorruptionLayer {
  return {
    name: antiCorruptionLayer.name,
    events: antiCorruptionLayer.events
      .map((event) => ({
        identity: `${antiCorruptionLayer.name}.${event.name}`,
        name: event.name,
        owner: {
          kind: "antiCorruptionLayer" as const,
          antiCorruptionLayer: antiCorruptionLayer.name,
        },
        input: toSemanticEventFields(event.input ?? []),
        results: event.results
          .map((result) => ({
            name: result.name,
            outcome: result.outcome,
            data: toSemanticEventFields(result.data),
          }))
          .sort((left, right) => compare(left.name, right.name)),
        publicResult: {
          success: "viewOnly" as const,
          fail: {
            code: "stable" as const,
            message: "safe" as const,
            correlationId: true as const,
          },
        },
      }))
      .sort((left, right) => compare(left.identity, right.identity)),
  };
}

function toSemanticSaga(saga: SagaDeclaration): SemanticSaga {
  return {
    name: saga.name,
    input: toSemanticEventFields(saga.input),
    steps: saga.steps
      .map((step) => ({
        name: step.name,
        event: { owner: step.event.owner, event: step.event.event },
        causedBy: [...step.causedBy].sort(compare),
        compensateWith: step.compensateWith
          ? {
              owner: step.compensateWith.owner,
              event: step.compensateWith.event,
            }
          : null,
      }))
      .sort((left, right) => compare(left.name, right.name)),
    terminal: {
      step: saga.terminal.step,
      success: { kind: "view", view: saga.terminal.view },
      fail: { kind: "fail" },
    },
    guarantees: {
      causalMetadata: ["eventId", "sagaId", "causationId", "correlationId"],
      durableState: true,
      intermediateResults: "internal",
      streamVisibility: "terminalOnly",
    },
  };
}

function toSemanticEventFields(
  fields: readonly {
    readonly name: string;
    readonly type: ColumnType;
    readonly optional?: boolean;
  }[],
): readonly {
  readonly name: string;
  readonly type: ColumnType;
  readonly optional: boolean;
}[] {
  return fields
    .map((field) => ({
      name: field.name,
      type: field.type,
      optional: field.optional ?? false,
    }))
    .sort((left, right) => compare(left.name, right.name));
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
