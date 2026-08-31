import { posix as path } from "node:path";
import ts from "typescript";
import { compileSemanticIr, compileSemanticProject } from "./compiler.js";
import {
  type AntiCorruptionLayerDeclaration,
  type AntiCorruptionLayerEventDeclaration,
  type AntiCorruptionLayerEventResultDeclaration,
  COLUMN_TYPES,
  type ColumnDeclaration,
  type ColumnReferenceDeclaration,
  type ColumnType,
  type EntityColumnReferenceDeclaration,
  type EntityDeclaration,
  type EntityEventDeclaration,
  type EntityEventOperationDeclaration,
  type EventInputDeclaration,
  type EventOperationAssignmentDeclaration,
  type EventOperationValueDeclaration,
  type JsonValue,
  type ModuleDeclaration,
  type RuleDeclaration,
  type RuleExpressionDeclaration,
  type RuleValueDeclaration,
  type SagaDeclaration,
  type SagaStepDeclaration,
  type SagaTerminalDeclaration,
  type ViewDeclaration,
  type ViewExpressionDeclaration,
  type ViewOrderDeclaration,
  type ViewOutputDeclaration,
  type ViewOutputExpressionDeclaration,
  type ViewPaginationDeclaration,
  type ViewPaginationValueDeclaration,
  type ViewQueryDeclaration,
  type ViewRelationDeclaration,
  type ViewValueDeclaration,
} from "./declaration.js";
import type { Diagnostic, SourceLocation } from "./diagnostic.js";
import type { SemanticIr } from "./semantic-ir.js";
import type { SemanticProjectIr } from "./semantic-ir.js";

const VANE_MODULE = "@lilka/vane";
const DSL_SYMBOLS = new Set([
  "Module",
  "ACL",
  "ACLEvent",
  "Saga",
  "Entity",
  "Column",
  "Rule",
  "Event",
  "create",
  "update",
  "remove",
  "upsert",
  "add",
  "subtract",
  "View",
  "column",
  "literal",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "and",
  "or",
  "not",
  "optional",
  "input",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "asc",
  "desc",
  "success",
  "fail",
  "event",
  "eventRef",
  "field",
  "reference",
  "relation",
]);
const COMPARISON_OPERATORS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
const VIEW_AGGREGATES = new Set(["count", "sum", "avg", "min", "max"]);
const COLUMN_TYPE_SET = new Set<string>(COLUMN_TYPES);

export interface ModuleSourceParserInput {
  readonly fileName: string;
  readonly sourceText: string;
}

export type ModuleSourceParseResult =
  | {
      readonly success: true;
      readonly declaration: ModuleDeclaration;
      readonly diagnostics: readonly [];
    }
  | { readonly success: false; readonly diagnostics: readonly Diagnostic[] };

export type ModuleSourceCompilationResult =
  | {
      readonly success: true;
      readonly ir: SemanticIr;
      readonly diagnostics: readonly [];
    }
  | { readonly success: false; readonly diagnostics: readonly Diagnostic[] };

export type ProjectSourceCompilationResult =
  | {
      readonly success: true;
      readonly ir: SemanticProjectIr;
      readonly diagnostics: readonly [];
    }
  | { readonly success: false; readonly diagnostics: readonly Diagnostic[] };

interface ParserContext {
  readonly sourceFile: ts.SourceFile;
  readonly bindings: ReadonlyMap<string, string>;
  readonly semanticBindings: ReadonlyMap<string, string>;
  readonly semanticImportBindings: ReadonlyMap<string, SemanticImportBinding>;
  readonly usedSemanticImports: Map<string, (readonly SemanticClassKind[])[]>;
  readonly usedLocalSemanticClasses: Map<
    string,
    (readonly SemanticClassKind[])[]
  >;
  readonly localSemanticClassKinds: ReadonlyMap<
    string,
    ReadonlySet<SemanticClassKind>
  >;
  readonly diagnostics: Diagnostic[];
  readonly sourceLocations: Map<string, SourceLocation>;
}

interface SemanticImportBinding {
  readonly localName: string;
  readonly semanticName: string;
  readonly moduleSpecifier: string;
  readonly location: SourceLocation;
}

interface SemanticImportUse extends SemanticImportBinding {
  readonly expectations: readonly (readonly SemanticClassKind[])[];
}

function semanticImportReferenceName(binding: SemanticImportBinding): string {
  return `@vane-import:${binding.localName}`;
}

type SemanticClassKind = "module" | "entity" | "view" | "acl" | "saga";
const SEMANTIC_CLASS_DECORATORS = [
  ["Module", "module"],
  ["Entity", "entity"],
  ["View", "view"],
  ["ACL", "acl"],
  ["Saga", "saga"],
] as const satisfies readonly (readonly [string, SemanticClassKind])[];

export function parseModuleSource(
  input: ModuleSourceParserInput,
): ModuleSourceParseResult {
  const parsed = parseModuleSourceInternal(input);
  if (!parsed.success) return parsed;
  const aliases = unlinkedSemanticImportAliases(parsed.semanticImportUses);
  return {
    success: true,
    declaration: remapSemanticDeclaration(parsed.declaration, aliases),
    diagnostics: [],
  };
}

function parseModuleSourceInternal(input: ModuleSourceParserInput):
  | {
      readonly success: true;
      readonly declaration: ModuleDeclaration;
      readonly diagnostics: readonly [];
      readonly sourceLocations: ReadonlyMap<string, SourceLocation>;
      readonly fileName: string;
      readonly semanticImportUses: readonly SemanticImportUse[];
      readonly exportedClassBindings: ReadonlyMap<string, string>;
    }
  | { readonly success: false; readonly diagnostics: readonly Diagnostic[] } {
  const sourceFile = ts.createSourceFile(
    input.fileName,
    input.sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics: Diagnostic[] = [];
  appendSyntaxDiagnostics(sourceFile, diagnostics);
  appendRuntimeBindingDiagnostics(sourceFile, diagnostics);

  const bindings = collectDslBindings(sourceFile, diagnostics);
  const classes = sourceFile.statements.filter(ts.isClassDeclaration);
  const semanticImportBindings = collectSemanticImportBindings(sourceFile);
  const localSemanticClassKinds = new Map<string, Set<SemanticClassKind>>();
  const context: ParserContext = {
    sourceFile,
    bindings,
    semanticBindings: new Map(
      [...semanticImportBindings].map(([localName, binding]) => [
        localName,
        semanticImportReferenceName(binding),
      ]),
    ),
    semanticImportBindings,
    usedSemanticImports: new Map(),
    usedLocalSemanticClasses: new Map(),
    localSemanticClassKinds,
    diagnostics,
    sourceLocations: new Map(),
  };
  collectLocalSemanticClassKinds(context, classes, localSemanticClassKinds);
  const moduleClasses = classes.filter((node) =>
    hasDecorator(context, node, "Module"),
  );

  if (moduleClasses.length !== 1) {
    diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_MODULE_COUNT",
        ["module"],
        `Source must declare exactly one @Module class; found ${moduleClasses.length}.`,
        "Decorate exactly one named class with @Module({ entities: [...] }).",
        sourceFile,
      ),
    );
  }

  const moduleClass = moduleClasses[0];
  const declaration = moduleClass
    ? parseModuleClass(context, moduleClass, classes)
    : undefined;
  if (declaration) {
    appendLocalSemanticRegistrationDiagnostics(context, declaration, classes);
  }
  const exportedClassBindings = collectExportedClassBindings(
    sourceFile,
    classes,
    diagnostics,
  );

  if (diagnostics.length > 0 || !declaration) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  return {
    success: true,
    declaration,
    diagnostics: [],
    sourceLocations: context.sourceLocations,
    fileName: input.fileName,
    semanticImportUses: [...context.usedSemanticImports].flatMap(
      ([localName, expectations]) => {
        const binding = context.semanticImportBindings.get(localName);
        return binding ? [{ ...binding, expectations }] : [];
      },
    ),
    exportedClassBindings,
  };
}

function collectSemanticImportBindings(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, SemanticImportBinding> {
  const bindings = new Map<string, SemanticImportBinding>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly ||
      (ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === VANE_MODULE)
    ) {
      continue;
    }
    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue;
      bindings.set(element.name.text, {
        localName: element.name.text,
        semanticName: (element.propertyName ?? element.name).text,
        moduleSpecifier: statement.moduleSpecifier.text,
        location: locationOf(sourceFile, element),
      });
    }
  }
  return bindings;
}

function appendRuntimeBindingDiagnostics(
  sourceFile: ts.SourceFile,
  diagnostics: Diagnostic[],
): void {
  type LocalBindingKind =
    | "function"
    | "class"
    | "enum"
    | "variable"
    | "namespace";
  const localBindings = new Map<string, Set<LocalBindingKind>>();
  const importBindings = new Set<string>();
  const register = (name: string, node: ts.Node): void => {
    if (!localBindings.has(name) && !importBindings.has(name)) {
      importBindings.add(name);
      return;
    }
    diagnostics.push({
      code: "VANE_PARSE_IMPORT",
      path: ["source", "imports", name],
      message: `Runtime binding ${name} conflicts with another local runtime binding in this source file.`,
      correction:
        "Give every runtime import or declaration a unique local name and update its semantic references.",
      location: locationOf(sourceFile, node),
    });
  };
  const registerLocal = (
    name: string,
    node: ts.Node,
    kind: LocalBindingKind,
  ): void => {
    const previous = localBindings.get(name);
    if (!previous) {
      localBindings.set(name, new Set([kind]));
      return;
    }
    const mergeableWithNamespace = new Set<LocalBindingKind>([
      "function",
      "class",
      "enum",
      "namespace",
    ]);
    if (
      (kind === "function" && previous.has("function")) ||
      (kind === "namespace" &&
        [...previous].every((entry) => mergeableWithNamespace.has(entry))) ||
      (previous.has("namespace") && mergeableWithNamespace.has(kind))
    ) {
      previous.add(kind);
      return;
    }
    diagnostics.push({
      code: "VANE_PARSE_BINDING",
      path: ["source", "bindings", name],
      message: `Local runtime binding ${name} is declared more than once in this source file.`,
      correction: "Give every local runtime declaration a unique name.",
      location: locationOf(sourceFile, node),
    });
  };
  const registerBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      registerLocal(name.text, name, "variable");
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) registerBindingName(element.name);
    }
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      registerLocal(statement.name.text, statement.name, "function");
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      registerLocal(statement.name.text, statement.name, "class");
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      registerLocal(statement.name.text, statement.name, "enum");
      continue;
    }
    if (
      ts.isModuleDeclaration(statement) &&
      ts.isIdentifier(statement.name) &&
      !statement.modifiers?.some(
        ({ kind }) => kind === ts.SyntaxKind.DeclareKeyword,
      )
    ) {
      registerLocal(statement.name.text, statement.name, "namespace");
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        registerBindingName(declaration.name);
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) register(clause.name.text, clause.name);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      register(clause.namedBindings.name.text, clause.namedBindings.name);
    } else if (clause.namedBindings) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) register(element.name.text, element.name);
      }
    }
  }
}

function semanticName(
  context: ParserContext,
  localName: string,
  expectedKinds: readonly SemanticClassKind[],
): string {
  if (context.semanticImportBindings.has(localName)) {
    const expectations = context.usedSemanticImports.get(localName) ?? [];
    expectations.push(expectedKinds);
    context.usedSemanticImports.set(localName, expectations);
  } else if (context.localSemanticClassKinds.has(localName)) {
    const expectations = context.usedLocalSemanticClasses.get(localName) ?? [];
    expectations.push(expectedKinds);
    context.usedLocalSemanticClasses.set(localName, expectations);
  }
  return context.semanticBindings.get(localName) ?? localName;
}

function appendLocalSemanticRegistrationDiagnostics(
  context: ParserContext,
  declaration: ModuleDeclaration,
  classes: readonly ts.ClassDeclaration[],
): void {
  for (const [localName, expectations] of context.usedLocalSemanticClasses) {
    const registeredKinds = semanticClassKinds(declaration, localName);
    if (
      expectations.every((expectedKinds) =>
        expectedKinds.some((kind) => registeredKinds.has(kind)),
      )
    ) {
      continue;
    }
    const localClass = classes.find(
      (candidate) => candidate.name?.text === localName,
    );
    context.diagnostics.push({
      code: "VANE_PARSE_SEMANTIC_REGISTRATION",
      path: ["module", "registrations", localName],
      message: `Local semantic class ${localName} is referenced but is not registered in the matching @Module collection.`,
      correction:
        "Add the class to the matching entities, views, antiCorruptionLayers, or sagas collection, or remove the reference.",
      location: locationOf(
        context.sourceFile,
        localClass?.name ?? localClass ?? context.sourceFile,
      ),
    });
  }
}

function collectLocalSemanticClassKinds(
  context: ParserContext,
  classes: readonly ts.ClassDeclaration[],
  target: Map<string, Set<SemanticClassKind>>,
): void {
  for (const candidate of classes) {
    if (!candidate.name) continue;
    for (const [decorator, kind] of SEMANTIC_CLASS_DECORATORS) {
      if (!hasDecorator(context, candidate, decorator)) continue;
      const kinds = target.get(candidate.name.text) ?? new Set();
      kinds.add(kind);
      target.set(candidate.name.text, kinds);
    }
  }
}

function collectExportedClassBindings(
  sourceFile: ts.SourceFile,
  classes: readonly ts.ClassDeclaration[],
  diagnostics: Diagnostic[],
): ReadonlyMap<string, string> {
  const classNames = new Set(
    classes.flatMap((candidate) =>
      candidate.name ? [candidate.name.text] : [],
    ),
  );
  const exported = new Map<string, string>();
  const registerExport = (
    exportedName: string,
    localName: string,
    node: ts.Node,
  ): void => {
    const previous = exported.get(exportedName);
    if (previous !== undefined) {
      diagnostics.push({
        code: "VANE_PARSE_EXPORT",
        path: ["source", "exports", exportedName],
        message: `Runtime export ${exportedName} is declared more than once (${previous} and ${localName}).`,
        correction: "Give every exported runtime class a unique exported name.",
        location: locationOf(sourceFile, node),
      });
      return;
    }
    exported.set(exportedName, localName);
  };
  for (const candidate of classes) {
    if (
      candidate.name &&
      candidate.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) &&
      !candidate.modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      )
    ) {
      registerExport(candidate.name.text, candidate.name.text, candidate.name);
    }
  }
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      statement.moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const localName = (element.propertyName ?? element.name).text;
      if (classNames.has(localName)) {
        registerExport(element.name.text, localName, element);
      }
    }
  }
  return exported;
}

function hasRuntimeClassBinding(
  context: ParserContext,
  localName: string,
  expectedKinds: readonly SemanticClassKind[],
): boolean {
  if (context.semanticBindings.has(localName)) return true;
  const actualKinds = context.localSemanticClassKinds.get(localName);
  return expectedKinds.some((kind) => actualKinds?.has(kind));
}

export function compileModuleSource(
  input: ModuleSourceParserInput,
): ModuleSourceCompilationResult {
  const parsed = parseModuleSourceInternal(input);
  if (!parsed.success) return parsed;
  const aliases = unlinkedSemanticImportAliases(parsed.semanticImportUses);
  const declaration = remapSemanticDeclaration(parsed.declaration, aliases);
  const sourceLocations = remapSourceLocations(parsed.sourceLocations, aliases);
  const compiled = compileSemanticIr(declaration);
  if (compiled.success) return compiled;
  return {
    success: false,
    diagnostics: compiled.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...locationForPath(sourceLocations, diagnostic.path),
    })),
  };
}

export function compileProjectSources(
  inputs: readonly ModuleSourceParserInput[],
): ProjectSourceCompilationResult {
  const parsed = inputs.map(parseModuleSourceInternal);
  const parseDiagnostics = parsed.flatMap((result) =>
    result.success ? [] : result.diagnostics,
  );
  if (parseDiagnostics.length > 0) {
    return { success: false, diagnostics: sortDiagnostics(parseDiagnostics) };
  }
  const successful = parsed.filter(
    (result): result is Extract<typeof result, { readonly success: true }> =>
      result.success,
  );
  const duplicateSourceDiagnostics =
    duplicateNormalizedSourceDiagnostics(successful);
  if (duplicateSourceDiagnostics.length > 0) {
    return {
      success: false,
      diagnostics: sortDiagnostics(duplicateSourceDiagnostics),
    };
  }
  const duplicateModuleDiagnostics: Diagnostic[] = [];
  const seenModuleNames = new Set<string>();
  for (const source of successful) {
    const name = source.declaration.name;
    if (seenModuleNames.has(name)) {
      duplicateModuleDiagnostics.push({
        code: "VANE_SEM_DUPLICATE_NAME",
        path: ["project", "modules", name],
        message: `Module name ${name} is duplicated.`,
        correction: "Give every Module a unique name within the project.",
        ...locationForPath(source.sourceLocations, ["module", "name"]),
      });
    }
    seenModuleNames.add(name);
  }
  if (duplicateModuleDiagnostics.length > 0) {
    return {
      success: false,
      diagnostics: sortDiagnostics(duplicateModuleDiagnostics),
    };
  }
  const resolved = resolveSemanticImportAliases(successful);
  const semanticImportDiagnostics = validateSemanticImportSources(resolved);
  if (semanticImportDiagnostics.length > 0) {
    return {
      success: false,
      diagnostics: sortDiagnostics(semanticImportDiagnostics),
    };
  }
  const compiled = compileSemanticProject(
    resolved.map(({ declaration }) => declaration),
  );
  if (compiled.success) return compiled;
  return {
    success: false,
    diagnostics: compiled.diagnostics.map((diagnostic) => {
      const moduleName = diagnostic.path[2];
      const source = resolved.find(
        ({ declaration }) => declaration.name === moduleName,
      );
      const localPath = ["module", ...diagnostic.path.slice(3)];
      return source
        ? {
            ...diagnostic,
            ...locationForPath(source.sourceLocations, localPath),
          }
        : diagnostic;
    }),
  };
}

function duplicateNormalizedSourceDiagnostics(
  sources: readonly {
    readonly fileName: string;
    readonly sourceLocations: ReadonlyMap<string, SourceLocation>;
  }[],
): readonly Diagnostic[] {
  const byFileName = new Map<string, typeof sources>();
  for (const source of sources) {
    const normalized = normalizeSourceFileName(source.fileName);
    const matches = byFileName.get(normalized) ?? [];
    byFileName.set(normalized, [...matches, source]);
  }
  return [...byFileName].flatMap(([normalized, matches]) =>
    matches.length < 2
      ? []
      : matches.map((source) => ({
          code: "VANE_PARSE_SOURCE_FILE",
          path: ["project", "sources", normalized],
          message: `Project source file ${source.fileName} duplicates normalized path ${normalized}.`,
          correction:
            "Supply each normalized source filename exactly once per compilation.",
          ...locationForPath(source.sourceLocations, ["module", "name"]),
        })),
  );
}

function validateSemanticImportSources(
  sources: readonly {
    readonly fileName: string;
    readonly declaration: ModuleDeclaration;
    readonly semanticImportUses: readonly SemanticImportUse[];
    readonly exportedClassBindings: ReadonlyMap<string, string>;
  }[],
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const sourcesByFileName = new Map(
    sources.map((source) => [normalizeSourceFileName(source.fileName), source]),
  );
  const modulesByName = new Map(
    sources.map((source) => [source.declaration.name, source]),
  );

  for (const source of sources) {
    const visibleModules = collectVisibleModuleNames(
      source.declaration.name,
      modulesByName,
    );
    for (const binding of source.semanticImportUses) {
      const target = resolveSemanticImportSource(
        source.fileName,
        binding.moduleSpecifier,
        sourcesByFileName,
      );
      const targetSemanticName = target?.exportedClassBindings.get(
        binding.semanticName,
      );
      const targetKinds =
        target && targetSemanticName
          ? semanticClassKinds(target.declaration, targetSemanticName)
          : new Set<SemanticClassKind>();
      if (
        target &&
        targetSemanticName &&
        binding.expectations.every((expectedKinds) =>
          expectedKinds.some((kind) => targetKinds.has(kind)),
        ) &&
        visibleModules.has(target.declaration.name)
      ) {
        continue;
      }
      diagnostics.push({
        code: "VANE_PARSE_SEMANTIC_IMPORT_SOURCE",
        path: ["module", "imports", binding.semanticName],
        message: `Semantic class ${binding.localName} does not resolve to an exported ${binding.semanticName} declaration from a visible supplied Module source.`,
        correction:
          "Import the class from the source that exports its semantic declaration, and include that source's Module in @Module imports.",
        location: binding.location,
      });
    }
  }
  return diagnostics;
}

function resolveSemanticImportAliases<
  Source extends {
    readonly fileName: string;
    readonly declaration: ModuleDeclaration;
    readonly semanticImportUses: readonly SemanticImportUse[];
    readonly exportedClassBindings: ReadonlyMap<string, string>;
    readonly sourceLocations: ReadonlyMap<string, SourceLocation>;
  },
>(sources: readonly Source[]): readonly Source[] {
  const sourcesByFileName = new Map(
    sources.map((source) => [normalizeSourceFileName(source.fileName), source]),
  );
  return sources.map((source) => {
    const aliases = new Map<string, string>();
    const conflicts = new Set<string>();
    for (const binding of source.semanticImportUses) {
      const target = resolveSemanticImportSource(
        source.fileName,
        binding.moduleSpecifier,
        sourcesByFileName,
      );
      const localSemanticName = target?.exportedClassBindings.get(
        binding.semanticName,
      );
      const referenceName = semanticImportReferenceName(binding);
      if (!localSemanticName || conflicts.has(referenceName)) continue;
      const previous = aliases.get(referenceName);
      if (previous && previous !== localSemanticName) {
        aliases.delete(referenceName);
        conflicts.add(referenceName);
      } else {
        aliases.set(referenceName, localSemanticName);
      }
    }
    return {
      ...source,
      declaration: remapSemanticDeclaration(source.declaration, aliases),
      sourceLocations: remapSourceLocations(source.sourceLocations, aliases),
    };
  });
}

function unlinkedSemanticImportAliases(
  imports: readonly SemanticImportUse[],
): ReadonlyMap<string, string> {
  return new Map(
    imports.map((binding) => [
      semanticImportReferenceName(binding),
      binding.semanticName,
    ]),
  );
}

function remapSourceLocations(
  sourceLocations: ReadonlyMap<string, SourceLocation>,
  aliases: ReadonlyMap<string, string>,
): ReadonlyMap<string, SourceLocation> {
  return new Map(
    [...sourceLocations].map(([pathKey, location]) => [
      pathKey
        .split(".")
        .map((segment) => aliases.get(segment) ?? segment)
        .join("."),
      location,
    ]),
  );
}

function remapSemanticDeclaration(
  declaration: ModuleDeclaration,
  aliases: ReadonlyMap<string, string>,
): ModuleDeclaration {
  const semanticNameKeys = new Set(["entity", "owner", "root", "view"]);
  const visit = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      return key && semanticNameKeys.has(key)
        ? (aliases.get(value) ?? value)
        : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) =>
        key === "imports" && typeof item === "string"
          ? (aliases.get(item) ?? item)
          : visit(item),
      );
    }
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        visit(entryValue, entryKey),
      ]),
    );
  };
  return visit(declaration) as ModuleDeclaration;
}

function normalizeSourceFileName(fileName: string): string {
  return path.normalize(fileName.replaceAll("\\", "/"));
}

function resolveSemanticImportSource<T>(
  importerFileName: string,
  moduleSpecifier: string,
  sourcesByFileName: ReadonlyMap<string, T>,
): T | undefined {
  if (!moduleSpecifier.startsWith(".")) return undefined;
  const resolved = path.normalize(
    path.join(
      path.dirname(normalizeSourceFileName(importerFileName)),
      moduleSpecifier,
    ),
  );
  const candidates = new Set([resolved]);
  if (resolved.endsWith(".js")) candidates.add(`${resolved.slice(0, -3)}.ts`);
  if (resolved.endsWith(".mjs")) candidates.add(`${resolved.slice(0, -4)}.mts`);
  if (resolved.endsWith(".cjs")) candidates.add(`${resolved.slice(0, -4)}.cts`);
  if (!path.extname(resolved)) {
    candidates.add(`${resolved}.ts`);
    candidates.add(path.join(resolved, "index.ts"));
  }
  for (const candidate of candidates) {
    const source = sourcesByFileName.get(candidate);
    if (source) return source;
  }
  return undefined;
}

function semanticClassKinds(
  declaration: ModuleDeclaration,
  name: string,
): ReadonlySet<SemanticClassKind> {
  const kinds = new Set<SemanticClassKind>();
  if (declaration.name === name) kinds.add("module");
  if (declaration.entities.some((candidate) => candidate.name === name)) {
    kinds.add("entity");
  }
  if (declaration.views?.some((candidate) => candidate.name === name)) {
    kinds.add("view");
  }
  if (
    declaration.antiCorruptionLayers?.some(
      (candidate) => candidate.name === name,
    )
  ) {
    kinds.add("acl");
  }
  if (declaration.sagas?.some((candidate) => candidate.name === name)) {
    kinds.add("saga");
  }
  return kinds;
}

function collectVisibleModuleNames(
  moduleName: string,
  modulesByName: ReadonlyMap<
    string,
    { readonly declaration: ModuleDeclaration }
  >,
): ReadonlySet<string> {
  const visible = new Set<string>();
  const visit = (name: string): void => {
    if (visible.has(name)) return;
    visible.add(name);
    const source = modulesByName.get(name);
    for (const importedName of source?.declaration.imports ?? []) {
      visit(importedName);
    }
  };
  visit(moduleName);
  return visible;
}

function collectDslBindings(
  sourceFile: ts.SourceFile,
  diagnostics: Diagnostic[],
): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== VANE_MODULE
    ) {
      continue;
    }

    const clause = statement.importClause;
    if (
      !clause?.namedBindings ||
      clause.isTypeOnly ||
      !ts.isNamedImports(clause.namedBindings)
    ) {
      diagnostics.push({
        code: "VANE_PARSE_IMPORT",
        path: ["source", "imports"],
        message: `The ${VANE_MODULE} DSL must be imported with named imports.`,
        correction: 'Use import { Module, Entity } from "@lilka/vane".',
        location: locationOf(sourceFile, statement),
      });
      continue;
    }

    for (const element of clause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = (element.propertyName ?? element.name).text;
      if (DSL_SYMBOLS.has(importedName)) {
        bindings.set(element.name.text, importedName);
      }
    }
  }

  if (bindings.size === 0) {
    diagnostics.push({
      code: "VANE_PARSE_IMPORT",
      path: ["source", "imports"],
      message: `No Vane DSL symbols were imported from ${VANE_MODULE}.`,
      correction: 'Import the decorators and helpers from "@lilka/vane".',
      location: locationOf(sourceFile, sourceFile),
    });
  }

  return bindings;
}

function parseModuleClass(
  context: ParserContext,
  node: ts.ClassDeclaration,
  classes: readonly ts.ClassDeclaration[],
): ModuleDeclaration | undefined {
  const name = className(context, node, ["module", "name"], "Module");
  const decorator = oneDecorator(context, node, "Module", ["module"]);
  if (!name || !decorator) return undefined;
  recordLocation(context, ["module", "name"], node.name ?? node);

  const options = decoratorObject(context, decorator, ["module"], "Module");
  if (options) {
    rejectUnknownOptions(
      context,
      options,
      new Set([
        "imports",
        "entities",
        "views",
        "antiCorruptionLayers",
        "sagas",
      ]),
      ["module"],
    );
  }
  const importsExpression = options?.get("imports");
  const imports = importsExpression
    ? parseStaticIdentifierArray(
        context,
        importsExpression,
        ["module", "imports"],
        "Module imports",
      )
    : [];
  if (importsExpression && !imports) return undefined;
  if (importsExpression && ts.isArrayLiteralExpression(importsExpression)) {
    recordLocation(context, ["module", "imports"], importsExpression);
    for (const element of importsExpression.elements) {
      if (ts.isIdentifier(element)) {
        recordLocation(
          context,
          [
            "module",
            "imports",
            semanticName(context, element.text, ["module"]),
          ],
          element,
        );
      }
    }
  }
  const entitiesExpression = options?.get("entities");
  if (!entitiesExpression || !ts.isArrayLiteralExpression(entitiesExpression)) {
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_MODULE_ENTITIES",
        ["module", "entities"],
        "@Module entities must be a static array of Entity class identifiers.",
        "Use @Module({ entities: [Customer, Order] }).",
        entitiesExpression ?? decorator,
      ),
    );
    return undefined;
  }
  recordLocation(context, ["module", "entities"], entitiesExpression);

  const entityClasses = new Map(
    classes
      .filter((candidate) => hasDecorator(context, candidate, "Entity"))
      .flatMap((candidate) =>
        candidate.name ? [[candidate.name.text, candidate] as const] : [],
      ),
  );
  const entities: EntityDeclaration[] = [];

  for (const element of entitiesExpression.elements) {
    if (!ts.isIdentifier(element)) {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          ["module", "entities"],
          "Module Entity references",
          element,
          "Use a class identifier from this source file.",
        ),
      );
      continue;
    }

    const entityClass = entityClasses.get(element.text);
    if (!entityClass) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_MODULE_ENTITY",
          ["module", "entities", element.text],
          `@Module references ${element.text}, but no matching @Entity class exists in this source file.`,
          "Declare and decorate the Entity in the same source file.",
          element,
        ),
      );
      continue;
    }

    const entity = parseEntityClass(context, entityClass);
    if (entity) entities.push(entity);
  }

  const views: ViewDeclaration[] = [];
  const viewsExpression = options?.get("views");
  if (viewsExpression) {
    if (!ts.isArrayLiteralExpression(viewsExpression)) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_MODULE_VIEWS",
          ["module", "views"],
          "@Module views must be a static array of View class identifiers.",
          "Use @Module({ entities: [...], views: [OrderDetails] }).",
          viewsExpression,
        ),
      );
    } else {
      recordLocation(context, ["module", "views"], viewsExpression);
      const viewClasses = new Map(
        classes
          .filter((candidate) => hasDecorator(context, candidate, "View"))
          .flatMap((candidate) =>
            candidate.name ? [[candidate.name.text, candidate] as const] : [],
          ),
      );
      for (const element of viewsExpression.elements) {
        if (!ts.isIdentifier(element)) {
          context.diagnostics.push(
            staticDiagnostic(
              context,
              ["module", "views"],
              "Module View references",
              element,
              "Use a class identifier from this source file.",
            ),
          );
          continue;
        }
        const viewClass = viewClasses.get(element.text);
        if (!viewClass) {
          context.diagnostics.push(
            createDiagnostic(
              context,
              "VANE_PARSE_MODULE_VIEW",
              ["module", "views", element.text],
              `@Module references ${element.text}, but no matching @View class exists in this source file.`,
              "Declare and decorate the View in the same source file.",
              element,
            ),
          );
          continue;
        }
        const view = parseViewClass(context, viewClass);
        if (view) views.push(view);
      }
    }
  }

  const antiCorruptionLayers: AntiCorruptionLayerDeclaration[] = [];
  const layersExpression = options?.get("antiCorruptionLayers");
  if (layersExpression) {
    if (!ts.isArrayLiteralExpression(layersExpression)) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_MODULE_ACLS",
          ["module", "antiCorruptionLayers"],
          "@Module antiCorruptionLayers must be a static array of @ACL class identifiers.",
          "Use @Module({ entities: [...], antiCorruptionLayers: [PaymentGateway] }).",
          layersExpression,
        ),
      );
    } else {
      recordLocation(
        context,
        ["module", "antiCorruptionLayers"],
        layersExpression,
      );
      const layerClasses = new Map(
        classes
          .filter((candidate) => hasDecorator(context, candidate, "ACL"))
          .flatMap((candidate) =>
            candidate.name ? [[candidate.name.text, candidate] as const] : [],
          ),
      );
      for (const element of layersExpression.elements) {
        if (!ts.isIdentifier(element)) {
          context.diagnostics.push(
            staticDiagnostic(
              context,
              ["module", "antiCorruptionLayers"],
              "Module Anti-Corruption Layer references",
              element,
              "Use an @ACL class identifier from this source file.",
            ),
          );
          continue;
        }
        const layerClass = layerClasses.get(element.text);
        if (!layerClass) {
          context.diagnostics.push(
            createDiagnostic(
              context,
              "VANE_PARSE_MODULE_ACL",
              ["module", "antiCorruptionLayers", element.text],
              `@Module references ${element.text}, but no matching @ACL class exists in this source file.`,
              "Declare and decorate the Anti-Corruption Layer in the same source file.",
              element,
            ),
          );
          continue;
        }
        const layer = parseAntiCorruptionLayerClass(context, layerClass);
        if (layer) antiCorruptionLayers.push(layer);
      }
    }
  }

  const sagas: SagaDeclaration[] = [];
  const sagasExpression = options?.get("sagas");
  if (sagasExpression) {
    if (!ts.isArrayLiteralExpression(sagasExpression)) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_MODULE_SAGAS",
          ["module", "sagas"],
          "@Module sagas must be a static array of @Saga class identifiers.",
          "Use @Module({ entities: [...], sagas: [PlaceOrder] }).",
          sagasExpression,
        ),
      );
    } else {
      recordLocation(context, ["module", "sagas"], sagasExpression);
      const sagaClasses = new Map(
        classes
          .filter((candidate) => hasDecorator(context, candidate, "Saga"))
          .flatMap((candidate) =>
            candidate.name ? [[candidate.name.text, candidate] as const] : [],
          ),
      );
      for (const element of sagasExpression.elements) {
        if (!ts.isIdentifier(element)) {
          context.diagnostics.push(
            staticDiagnostic(
              context,
              ["module", "sagas"],
              "Module Saga references",
              element,
              "Use a @Saga class identifier from this source file.",
            ),
          );
          continue;
        }
        const sagaClass = sagaClasses.get(element.text);
        if (!sagaClass) {
          context.diagnostics.push(
            createDiagnostic(
              context,
              "VANE_PARSE_MODULE_SAGA",
              ["module", "sagas", element.text],
              `@Module references ${element.text}, but no matching @Saga class exists in this source file.`,
              "Declare and decorate the Saga in the same source file.",
              element,
            ),
          );
          continue;
        }
        const saga = parseSagaClass(context, sagaClass);
        if (saga) sagas.push(saga);
      }
    }
  }

  return {
    name,
    ...(imports && imports.length > 0 ? { imports } : {}),
    entities,
    views,
    antiCorruptionLayers,
    sagas,
  };
}

function parseEntityClass(
  context: ParserContext,
  node: ts.ClassDeclaration,
): EntityDeclaration | undefined {
  const name = className(context, node, ["entity", "name"], "Entity");
  const decorator = oneDecorator(context, node, "Entity", [
    "entity",
    name ?? "unknown",
  ]);
  if (!name || !decorator) return undefined;
  requireArgumentCount(context, decorator, 0, ["entity", name], "Entity");
  const semanticPath = ["module", "entities", name];
  recordLocation(context, semanticPath, node);
  recordLocation(context, [...semanticPath, "name"], node.name ?? node);
  recordLocation(context, [...semanticPath, "columns"], node);
  recordLocation(context, [...semanticPath, "rules"], node);
  recordLocation(context, [...semanticPath, "events"], node);

  const columns: ColumnDeclaration[] = [];
  const rules: RuleDeclaration[] = [];
  const events: EntityEventDeclaration[] = [];
  for (const member of node.members) {
    const memberDecorators = ["Column", "Rule", "Event", "ACLEvent"].filter(
      (symbol) => hasSemanticMemberMarker(context, member, symbol),
    );
    if (memberDecorators.length === 0) continue;
    if (memberDecorators.length > 1) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_DECORATOR_TARGET",
          ["entity", name, "members"],
          `Entity member combines incompatible DSL decorators: ${memberDecorators.map((symbol) => `@${symbol}`).join(", ")}.`,
          "Use one semantic member declaration at a time: Column(...) or Event(...) in @Entity; ACLEvent(...) is reserved for @ACL classes.",
          member,
        ),
      );
      continue;
    }

    const memberDecorator = memberDecorators[0];
    if (
      memberDecorator === "Column" &&
      ts.isPropertyDeclaration(member) &&
      hasDslInitializer(context, member, "Column")
    ) {
      if (
        requireSemanticInitializerDeclaration(context, member, [
          "entity",
          name,
          "columns",
        ])
      ) {
        const column = parseColumn(context, name, member);
        if (column) columns.push(column);
      }
    } else if (memberDecorator === "Rule" && ts.isMethodDeclaration(member)) {
      const rule = parseRule(context, name, member);
      if (rule) rules.push(rule);
    } else if (
      memberDecorator === "Event" &&
      ts.isPropertyDeclaration(member) &&
      hasDslInitializer(context, member, "Event")
    ) {
      if (
        requireSemanticInitializerDeclaration(context, member, [
          "entity",
          name,
          "events",
        ])
      ) {
        const event = parseEvent(context, name, member);
        if (event) events.push(event);
      }
    } else if (memberDecorator) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_DECORATOR_TARGET",
          ["entity", name, "members"],
          `@${memberDecorator} cannot decorate this kind of Entity member.`,
          memberDecorator === "Column"
            ? "Declare a Column property with `name = Column(options)`."
            : memberDecorator === "Event"
              ? "Declare an Event property with `name = Event(options)`."
              : `Apply @${memberDecorator} to a method declaration.`,
          member,
        ),
      );
    }
  }

  return { name, columns, rules, events };
}

function parseAntiCorruptionLayerClass(
  context: ParserContext,
  node: ts.ClassDeclaration,
): AntiCorruptionLayerDeclaration | undefined {
  const name = className(context, node, ["antiCorruptionLayer", "name"], "ACL");
  const path = ["antiCorruptionLayer", name ?? "unknown"];
  const decorator = oneDecorator(context, node, "ACL", path);
  if (!name || !decorator) return undefined;
  requireArgumentCount(context, decorator, 0, path, "ACL");

  const semanticPath = ["module", "antiCorruptionLayers", name];
  recordLocation(context, semanticPath, node);
  recordLocation(context, [...semanticPath, "name"], node.name ?? node);
  recordLocation(context, [...semanticPath, "events"], node);

  const events: AntiCorruptionLayerEventDeclaration[] = [];
  for (const member of node.members) {
    const decorators = ["Column", "Rule", "Event", "ACLEvent"].filter(
      (symbol) => hasSemanticMemberMarker(context, member, symbol),
    );
    if (decorators.length === 0) continue;
    if (
      decorators.length === 1 &&
      decorators[0] === "ACLEvent" &&
      ts.isPropertyDeclaration(member) &&
      hasDslInitializer(context, member, "ACLEvent")
    ) {
      if (
        requireSemanticInitializerDeclaration(context, member, [
          "antiCorruptionLayer",
          name,
          "events",
        ])
      ) {
        const event = parseAntiCorruptionLayerEvent(context, name, member);
        if (event) events.push(event);
      }
      continue;
    }
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_DECORATOR_TARGET",
        [...path, "members"],
        `@ACL members may only be ACLEvent properties; found ${decorators.join(", ")}.`,
        "Declare the property with `name = ACLEvent(options)`.",
        member,
      ),
    );
  }

  return { name, events };
}

function requireSemanticInitializerDeclaration(
  context: ParserContext,
  node: ts.PropertyDeclaration,
  path: readonly string[],
): boolean {
  const forbiddenDecorator = decoratorsOf(node).find((decorator) => {
    const expression = decorator.expression;
    if (
      !ts.isCallExpression(expression) ||
      !ts.isIdentifier(expression.expression)
    ) {
      return false;
    }
    const symbol = context.bindings.get(expression.expression.text);
    return symbol === "Column" || symbol === "Event" || symbol === "ACLEvent";
  });
  const forbiddenModifier = node.modifiers?.find(
    ({ kind }) =>
      kind === ts.SyntaxKind.StaticKeyword ||
      kind === ts.SyntaxKind.PrivateKeyword ||
      kind === ts.SyntaxKind.ProtectedKeyword,
  );
  if (
    forbiddenDecorator ||
    forbiddenModifier ||
    node.questionToken ||
    node.exclamationToken ||
    node.type
  ) {
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_MEMBER_DECLARATION",
        [...path, staticPropertyName(node.name) ?? "unknown"],
        "A semantic member initializer must be inferred, undecorated, required, public, and on an instance property.",
        "Remove DSL member decorators, static, private, protected, optional, definite-assignment, and explicit type annotations from the property.",
        forbiddenDecorator ??
          forbiddenModifier ??
          node.questionToken ??
          node.exclamationToken ??
          node.type ??
          node.name,
      ),
    );
    return false;
  }
  return true;
}

function parseSagaClass(
  context: ParserContext,
  node: ts.ClassDeclaration,
): SagaDeclaration | undefined {
  const name = className(context, node, ["saga", "name"], "Saga");
  const path = ["saga", name ?? "unknown"];
  const decorator = oneDecorator(context, node, "Saga", path);
  if (!name || !decorator) return undefined;

  for (const member of node.members) {
    const forbidden = ["Column", "Rule", "Event", "ACLEvent"].filter((symbol) =>
      hasSemanticMemberMarker(context, member, symbol),
    );
    if (forbidden.length === 0) continue;
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_DECORATOR_TARGET",
        [...path, "members"],
        `@Saga cannot contain ${forbidden.map((symbol) => `@${symbol}`).join(", ")} members.`,
        "Declare Saga input, causal steps, compensation, and terminal View in @Saga.",
        member,
      ),
    );
  }

  const semanticPath = ["module", "sagas", name];
  recordLocation(context, semanticPath, node);
  recordLocation(context, [...semanticPath, "name"], node.name ?? node);
  const options = decoratorObject(context, decorator, path, "Saga");
  if (!options) return undefined;
  rejectUnknownOptions(
    context,
    options,
    new Set(["input", "steps", "terminal"]),
    path,
  );

  const inputExpression = options.get("input");
  const stepsExpression = options.get("steps");
  const terminalExpression = options.get("terminal");
  if (!stepsExpression || !terminalExpression) {
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_SAGA_OPTIONS",
        path,
        "@Saga requires static steps and terminal properties.",
        'Use @Saga({ steps: {...}, terminal: { step: "final", view: ResultView } }).',
        decorator,
      ),
    );
    return undefined;
  }

  const input = inputExpression
    ? parseTypedInputs(
        context,
        inputExpression,
        [...path, "input"],
        "Saga input",
      )
    : [];
  const steps = parseSagaSteps(context, stepsExpression, [...path, "steps"]);
  const terminal = parseSagaTerminal(context, terminalExpression, [
    ...path,
    "terminal",
  ]);
  if (inputExpression)
    recordLocation(context, [...semanticPath, "input"], inputExpression);
  recordLocation(context, [...semanticPath, "steps"], stepsExpression);
  recordLocation(context, [...semanticPath, "terminal"], terminalExpression);
  return input && steps && terminal
    ? { name, input, steps, terminal }
    : undefined;
}

function parseSagaSteps(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): readonly SagaStepDeclaration[] | undefined {
  const object = staticObject(context, node, path, "Saga steps");
  if (!object) return undefined;
  const steps: SagaStepDeclaration[] = [];

  for (const [name, expression] of object) {
    const stepPath = [...path, name];
    const call = dslCall(context, expression);
    if (!call || call.symbol !== "event") {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          stepPath,
          "Saga steps",
          expression,
          'Use event(Owner, "Event") or the legacy event(Owner.Event) form.',
        ),
      );
      continue;
    }
    const [ownerOrReference, eventNameOrOptions, typedOptions] =
      call.expression.arguments;
    const typedSyntax =
      ownerOrReference &&
      ts.isIdentifier(ownerOrReference) &&
      eventNameOrOptions &&
      ts.isStringLiteral(eventNameOrOptions);
    const validArgumentCount = typedSyntax
      ? call.expression.arguments.length === 2 ||
        call.expression.arguments.length === 3
      : call.expression.arguments.length === 1 ||
        call.expression.arguments.length === 2;
    if (!validArgumentCount) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_ARGUMENTS",
          stepPath,
          `${typedSyntax ? "Typed" : "Legacy"} event expects ${typedSyntax ? "two or three" : "one or two"} arguments; found ${call.expression.arguments.length}.`,
          typedSyntax
            ? 'Use event(Owner, "Event") or event(Owner, "Event", options).'
            : "Use event(Owner.Event) or event(Owner.Event, options).",
          call.expression,
        ),
      );
      continue;
    }
    const typedForm =
      typedSyntax &&
      ownerOrReference &&
      ts.isIdentifier(ownerOrReference) &&
      hasRuntimeClassBinding(context, ownerOrReference.text, ["entity", "acl"]);
    const eventReference = typedForm
      ? {
          owner: semanticName(context, ownerOrReference.text, [
            "entity",
            "acl",
          ]),
          event: eventNameOrOptions.text,
        }
      : ownerOrReference
        ? parseEventReference(context, ownerOrReference)
        : undefined;
    if (!eventReference) {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          [...stepPath, "event"],
          "Saga Event references",
          ownerOrReference ?? expression,
          'Use an Owner.Event reference or event(Owner, "Event").',
        ),
      );
      continue;
    }

    let causedBy: readonly string[] = [];
    let compensateWith: SagaStepDeclaration["compensateWith"];
    const optionsExpression = typedForm ? typedOptions : eventNameOrOptions;
    if (optionsExpression) {
      const options = staticObject(
        context,
        optionsExpression,
        stepPath,
        "Saga step options",
      );
      if (!options) continue;
      rejectUnknownOptions(
        context,
        options,
        new Set(["causedBy", "compensateWith"]),
        stepPath,
      );
      const causedByExpression = options.get("causedBy");
      if (causedByExpression) {
        const parsed = parseStaticStringArray(
          context,
          causedByExpression,
          [...stepPath, "causedBy"],
          "Saga causal predecessors",
        );
        if (!parsed) continue;
        causedBy = parsed;
      }
      const compensationExpression = options.get("compensateWith");
      if (compensationExpression) {
        compensateWith = parseEventReference(context, compensationExpression);
        if (!compensateWith) {
          context.diagnostics.push(
            staticDiagnostic(
              context,
              [...stepPath, "compensateWith"],
              "Saga compensation Event references",
              compensationExpression,
              'Use eventRef(Owner, "Event") or an Owner.Event property reference.',
            ),
          );
          continue;
        }
      }
    }
    steps.push({
      name,
      event: eventReference,
      causedBy,
      ...(compensateWith ? { compensateWith } : {}),
    });
  }
  return steps;
}

function parseSagaTerminal(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): SagaTerminalDeclaration | undefined {
  const object = staticObject(context, node, path, "Saga terminal");
  if (!object) return undefined;
  rejectUnknownOptions(context, object, new Set(["step", "view"]), path);
  const stepExpression = object.get("step");
  const viewExpression = object.get("view");
  if (
    !stepExpression ||
    !ts.isStringLiteral(stepExpression) ||
    !viewExpression ||
    !ts.isIdentifier(viewExpression) ||
    !hasRuntimeClassBinding(context, viewExpression.text, ["view"])
  ) {
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_SAGA_TERMINAL",
        path,
        "Saga terminal must reference a static step name and View class.",
        'Use terminal: { step: "finalStep", view: ResultView }.',
        node,
      ),
    );
    return undefined;
  }
  return {
    step: stepExpression.text,
    view: semanticName(context, viewExpression.text, ["view"]),
  };
}

function parseViewClass(
  context: ParserContext,
  node: ts.ClassDeclaration,
): ViewDeclaration | undefined {
  const name = className(context, node, ["view", "name"], "View");
  const path = ["view", name ?? "unknown"];
  const decorator = oneDecorator(context, node, "View", path);
  if (!name || !decorator) return undefined;

  for (const member of node.members) {
    const forbidden = ["Column", "Rule", "Event", "ACLEvent"].filter((symbol) =>
      hasSemanticMemberMarker(context, member, symbol),
    );
    if (forbidden.length === 0) continue;
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_DECORATOR_TARGET",
        [...path, "members"],
        `@View cannot contain ${forbidden.map((symbol) => `@${symbol}`).join(", ")} members.`,
        "Declare View input, output, and query in @View; Views do not persist or own Events.",
        member,
      ),
    );
  }

  const semanticPath = ["module", "views", name];
  recordLocation(context, semanticPath, node);
  recordLocation(context, [...semanticPath, "name"], node.name ?? node);
  const options = decoratorObject(context, decorator, path, "View");
  if (!options) return undefined;
  rejectUnknownOptions(
    context,
    options,
    new Set(["input", "output", "query"]),
    path,
  );

  const inputExpression = options.get("input");
  const outputExpression = options.get("output");
  const queryExpression = options.get("query");
  if (!inputExpression || !outputExpression || !queryExpression) {
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_VIEW_OPTIONS",
        path,
        "@View requires static input, output, and query properties.",
        "Use @View({ input: {...}, output: {...}, query: {...} }).",
        decorator,
      ),
    );
    return undefined;
  }

  recordLocation(context, [...semanticPath, "input"], inputExpression);
  recordLocation(context, [...semanticPath, "output"], outputExpression);
  recordLocation(context, [...semanticPath, "query"], queryExpression);
  const input = parseTypedInputs(
    context,
    inputExpression,
    [...path, "input"],
    "View input",
  );
  const output = parseViewOutput(context, outputExpression, [
    ...path,
    "output",
  ]);
  const query = parseViewQuery(context, queryExpression, [...path, "query"]);
  return input && output && query ? { name, input, output, query } : undefined;
}

function parseViewOutput(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): readonly ViewOutputDeclaration[] | undefined {
  const object = staticObject(context, node, path, "View output");
  if (!object) return undefined;
  const output: ViewOutputDeclaration[] = [];
  for (const [name, expression] of object) {
    const parsed = parseViewOutputExpression(context, expression, [
      ...path,
      name,
    ]);
    if (parsed) output.push({ name, expression: parsed });
  }
  return output;
}

function parseViewOutputExpression(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): ViewOutputExpressionDeclaration | undefined {
  const column = parseTypedColumnReference(context, node);
  if (column) return { kind: "column", ...column };

  const call = dslCall(context, node);
  if (call && VIEW_AGGREGATES.has(call.symbol)) {
    if (!requireArgumentCount(context, call.expression, 1, path, call.symbol)) {
      return undefined;
    }
    const argument = call.expression.arguments[0];
    const value = argument
      ? parseTypedColumnReference(context, argument)
      : undefined;
    if (value) {
      return {
        kind: "aggregate",
        function: call.symbol as "count" | "sum" | "avg" | "min" | "max",
        value,
      };
    }
  }

  context.diagnostics.push(
    staticDiagnostic(
      context,
      path,
      "View output expressions",
      node,
      "Use Entity.column or count/sum/avg/min/max(Entity.column).",
    ),
  );
  return undefined;
}

function parseViewQuery(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): ViewQueryDeclaration | undefined {
  const object = staticObject(context, node, path, "View query");
  if (!object) return undefined;
  rejectUnknownOptions(
    context,
    object,
    new Set(["root", "relations", "where", "orderBy", "pagination"]),
    path,
  );

  const rootExpression = object.get("root");
  if (
    !rootExpression ||
    !ts.isIdentifier(rootExpression) ||
    !hasRuntimeClassBinding(context, rootExpression.text, ["entity"])
  ) {
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_VIEW_ROOT",
        [...path, "root"],
        "View query root must be an Entity class identifier.",
        "Use query: { root: Order, ... }.",
        rootExpression ?? node,
      ),
    );
    return undefined;
  }

  const whereExpression = object.get("where");
  const where = whereExpression
    ? parseViewExpression(context, whereExpression, [...path, "where"])
    : undefined;
  const relationsExpression = object.get("relations");
  const relations = relationsExpression
    ? parseViewRelations(context, relationsExpression, [...path, "relations"])
    : [];
  const orderByExpression = object.get("orderBy");
  const parsedOrderBy = orderByExpression
    ? parseViewOrderBy(context, orderByExpression, [...path, "orderBy"])
    : [];
  const paginationExpression = object.get("pagination");
  const pagination = paginationExpression
    ? parseViewPagination(context, paginationExpression, [
        ...path,
        "pagination",
      ])
    : undefined;

  if (
    (whereExpression && !where) ||
    (relationsExpression && !relations) ||
    (orderByExpression && !parsedOrderBy) ||
    (paginationExpression && !pagination)
  ) {
    return undefined;
  }
  const orderBy = parsedOrderBy ?? [];
  return {
    root: semanticName(context, rootExpression.text, ["entity"]),
    ...(relations && relations.length > 0 ? { relations } : {}),
    ...(where ? { where } : {}),
    ...(orderBy.length > 0 ? { orderBy } : {}),
    ...(pagination ? { pagination } : {}),
  };
}

function parseViewRelations(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): readonly ViewRelationDeclaration[] | undefined {
  const object = staticObject(context, node, path, "View relations");
  if (!object) return undefined;
  const relations: ViewRelationDeclaration[] = [];
  for (const [name, expression] of object) {
    const call = dslCall(context, expression);
    if (
      !call ||
      call.symbol !== "relation" ||
      call.expression.arguments.length !== 2
    ) {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          [...path, name],
          "View relation",
          expression,
          'Use relation(field(Entity, "column"), field(Related, "column")).',
        ),
      );
      continue;
    }
    const [fromExpression, toExpression] = call.expression.arguments;
    const from = fromExpression
      ? parseTypedColumnReference(context, fromExpression)
      : undefined;
    const to = toExpression
      ? parseTypedColumnReference(context, toExpression)
      : undefined;
    if (!from || !to) {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          [...path, name],
          "View relation Columns",
          expression,
          "Pass two static Column references to relation(...).",
        ),
      );
      continue;
    }
    relations.push({ name, from, to });
  }
  return relations;
}

function parseViewExpression(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): ViewExpressionDeclaration | undefined {
  const call = dslCall(context, node);
  if (!call) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        path,
        "View filter expressions",
        node,
        "Use Vane comparison and logical helper calls only.",
      ),
    );
    return undefined;
  }
  const { symbol, expression } = call;
  if (COMPARISON_OPERATORS.has(symbol)) {
    if (!requireArgumentCount(context, expression, 2, path, symbol)) {
      return undefined;
    }
    const left = parseViewValue(context, expression.arguments[0], [
      ...path,
      "left",
    ]);
    const right = parseViewValue(context, expression.arguments[1], [
      ...path,
      "right",
    ]);
    if (!left || !right) return undefined;
    return {
      kind: "comparison",
      operator: symbol as "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
      left,
      right,
    };
  }
  if (symbol === "and" || symbol === "or") {
    if (expression.arguments.length < 2) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_ARGUMENTS",
          path,
          `${symbol} requires at least two operands.`,
          `Pass two or more View filter expressions to ${symbol}(...).`,
          expression,
        ),
      );
      return undefined;
    }
    const operands = expression.arguments.flatMap((argument, index) => {
      const operand = parseViewExpression(context, argument, [
        ...path,
        String(index),
      ]);
      return operand ? [operand] : [];
    });
    return operands.length === expression.arguments.length
      ? { kind: "logical", operator: symbol, operands }
      : undefined;
  }
  if (symbol === "not") {
    if (!requireArgumentCount(context, expression, 1, path, symbol)) {
      return undefined;
    }
    const argument = expression.arguments[0];
    if (!argument) return undefined;
    const operand = parseViewExpression(context, argument, [
      ...path,
      "operand",
    ]);
    return operand ? { kind: "not", operand } : undefined;
  }
  context.diagnostics.push(
    createDiagnostic(
      context,
      "VANE_PARSE_VIEW_EXPRESSION",
      path,
      `${symbol} is not a View filter operator.`,
      "Use eq, neq, gt, gte, lt, lte, and, or, or not.",
      node,
    ),
  );
  return undefined;
}

function parseViewValue(
  context: ParserContext,
  node: ts.Expression | undefined,
  path: readonly string[],
): ViewValueDeclaration | undefined {
  if (!node) return undefined;
  const column = parseTypedColumnReference(context, node);
  if (column) return { kind: "column", ...column };

  const call = dslCall(context, node);
  if (!call || (call.symbol !== "input" && call.symbol !== "literal")) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        path,
        "View filter values",
        node,
        'Use Entity.column, input("name"), or literal(value).',
      ),
    );
    return undefined;
  }
  if (!requireArgumentCount(context, call.expression, 1, path, call.symbol)) {
    return undefined;
  }
  const argument = call.expression.arguments[0];
  if (call.symbol === "input" && argument && ts.isStringLiteral(argument)) {
    return { kind: "input", input: argument.text };
  }
  if (call.symbol === "literal" && argument) {
    const literal = parseLiteral(argument);
    if (literal.matched) return { kind: "literal", value: literal.value };
  }
  context.diagnostics.push(
    staticDiagnostic(
      context,
      path,
      call.symbol === "input" ? "View input references" : "View literals",
      argument ?? node,
      call.symbol === "input"
        ? "Pass a string literal to input(...)."
        : "Pass null, a boolean, a finite number, or a string to literal(...).",
    ),
  );
  return undefined;
}

function parseViewOrderBy(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): readonly ViewOrderDeclaration[] | undefined {
  if (!ts.isArrayLiteralExpression(node)) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        path,
        "View ordering",
        node,
        "Use an array such as [asc(Order.createdAt)].",
      ),
    );
    return undefined;
  }
  const orders: ViewOrderDeclaration[] = [];
  for (const [index, element] of node.elements.entries()) {
    const itemPath = [...path, String(index)];
    const call = dslCall(context, element);
    if (!call || (call.symbol !== "asc" && call.symbol !== "desc")) {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          itemPath,
          "View ordering",
          element,
          "Use asc(Entity.column) or desc(Entity.column).",
        ),
      );
      continue;
    }
    if (
      !requireArgumentCount(context, call.expression, 1, itemPath, call.symbol)
    ) {
      continue;
    }
    const argument = call.expression.arguments[0];
    const value = argument
      ? parseTypedColumnReference(context, argument)
      : undefined;
    if (!value) {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          itemPath,
          "View ordering Columns",
          argument ?? element,
          "Pass an Entity.column reference to asc or desc.",
        ),
      );
      continue;
    }
    orders.push({ value, direction: call.symbol });
  }
  return orders;
}

function parseViewPagination(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): ViewPaginationDeclaration | undefined {
  const object = staticObject(context, node, path, "View pagination");
  if (!object) return undefined;
  rejectUnknownOptions(context, object, new Set(["limit", "offset"]), path);
  const limitExpression = object.get("limit");
  const offsetExpression = object.get("offset");
  const limit = limitExpression
    ? parsePaginationValue(context, limitExpression, [...path, "limit"])
    : undefined;
  const offset = offsetExpression
    ? parsePaginationValue(context, offsetExpression, [...path, "offset"])
    : undefined;
  if ((limitExpression && !limit) || (offsetExpression && !offset)) {
    return undefined;
  }
  return {
    ...(limit ? { limit } : {}),
    ...(offset ? { offset } : {}),
  };
}

function parsePaginationValue(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): ViewPaginationValueDeclaration | undefined {
  const literal = parseLiteral(node);
  if (literal.matched && typeof literal.value === "number") {
    return { kind: "literal", value: literal.value };
  }
  const call = dslCall(context, node);
  if (call?.symbol === "input") {
    if (!requireArgumentCount(context, call.expression, 1, path, "input")) {
      return undefined;
    }
    const argument = call.expression.arguments[0];
    if (argument && ts.isStringLiteral(argument)) {
      return { kind: "input", input: argument.text };
    }
  }
  context.diagnostics.push(
    staticDiagnostic(
      context,
      path,
      "View pagination values",
      node,
      'Use an integer literal or input("name").',
    ),
  );
  return undefined;
}

function parseEntityColumnReference(
  context: ParserContext,
  node: ts.Expression,
): EntityColumnReferenceDeclaration | undefined {
  return ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ts.isIdentifier(node.name) &&
    hasRuntimeClassBinding(context, node.expression.text, ["entity"])
    ? {
        entity: semanticName(context, node.expression.text, ["entity"]),
        column: node.name.text,
      }
    : undefined;
}

function parseTypedColumnReference(
  context: ParserContext,
  node: ts.Expression,
): EntityColumnReferenceDeclaration | undefined {
  const legacy = parseEntityColumnReference(context, node);
  if (legacy) return legacy;
  const call = dslCall(context, node);
  if (
    call &&
    (call.symbol === "field" || call.symbol === "reference") &&
    call.expression.arguments.length === 2
  ) {
    const [entity, column] = call.expression.arguments;
    if (
      entity &&
      ts.isIdentifier(entity) &&
      hasRuntimeClassBinding(context, entity.text, ["entity"]) &&
      column &&
      ts.isStringLiteral(column)
    ) {
      return {
        entity: semanticName(context, entity.text, ["entity"]),
        column: column.text,
      };
    }
  }
  return undefined;
}

function parseEventReference(
  context: ParserContext,
  node: ts.Expression,
): SagaStepDeclaration["event"] | undefined {
  const legacy =
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ts.isIdentifier(node.name) &&
    hasRuntimeClassBinding(context, node.expression.text, ["entity", "acl"])
      ? {
          owner: semanticName(context, node.expression.text, ["entity", "acl"]),
          event: node.name.text,
        }
      : undefined;
  if (legacy) return legacy;
  const call = dslCall(context, node);
  if (call?.symbol !== "eventRef" || call.expression.arguments.length !== 2) {
    return undefined;
  }
  const [owner, eventName] = call.expression.arguments;
  return owner &&
    ts.isIdentifier(owner) &&
    hasRuntimeClassBinding(context, owner.text, ["entity", "acl"]) &&
    eventName &&
    ts.isStringLiteral(eventName)
    ? {
        owner: semanticName(context, owner.text, ["entity", "acl"]),
        event: eventName.text,
      }
    : undefined;
}

function parseStaticStringArray(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
  subject: string,
): readonly string[] | undefined {
  if (
    !ts.isArrayLiteralExpression(node) ||
    node.elements.some((element) => !ts.isStringLiteral(element))
  ) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        path,
        subject,
        node,
        "Use an array of static string literals.",
      ),
    );
    return undefined;
  }
  return node.elements.map((element) => (element as ts.StringLiteral).text);
}

function parseStaticIdentifierArray(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
  subject: string,
): readonly string[] | undefined {
  if (
    !ts.isArrayLiteralExpression(node) ||
    node.elements.some((element) => !ts.isIdentifier(element))
  ) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        path,
        subject,
        node,
        "Use an array of static class identifiers.",
      ),
    );
    return undefined;
  }
  const names: string[] = [];
  let hasUnboundIdentifier = false;
  for (const element of node.elements) {
    const identifier = element as ts.Identifier;
    if (!hasRuntimeClassBinding(context, identifier.text, ["module"])) {
      hasUnboundIdentifier = true;
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_MODULE_IMPORT_BINDING",
          [...path, identifier.text],
          `Module import identifier ${identifier.text} is not bound to a runtime class value in this source file.`,
          "Declare the class locally or import it with a non-type import.",
          identifier,
        ),
      );
      continue;
    }
    names.push(semanticName(context, identifier.text, ["module"]));
  }
  return hasUnboundIdentifier ? undefined : names;
}

function parseColumn(
  context: ParserContext,
  entityName: string,
  node: ts.PropertyDeclaration,
): ColumnDeclaration | undefined {
  const name = memberName(context, node.name, [
    "entity",
    entityName,
    "columns",
  ]);
  const path = ["entity", entityName, "columns", name ?? "unknown"];
  const initializer = node.initializer
    ? dslCall(context, node.initializer)
    : undefined;
  const call =
    initializer?.symbol === "Column" ? initializer.expression : undefined;
  if (!name || !call || !requireArgumentCount(context, call, 1, path, "Column"))
    return undefined;
  const semanticPath = ["module", "entities", entityName, "columns", name];
  recordLocation(context, semanticPath, node);
  recordLocation(context, [...semanticPath, "type"], node);
  const options = decoratorObject(context, call, path, "Column");
  if (!options) return undefined;
  rejectUnknownOptions(
    context,
    options,
    new Set([
      "type",
      "identity",
      "nullable",
      "unique",
      "generated",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "default",
      "references",
    ]),
    path,
  );

  const type = parseColumnType(context, options.get("type"), [...path, "type"]);
  if (!type) return undefined;
  const identity = optionalBoolean(context, options, "identity", path);
  const nullable = optionalBoolean(context, options, "nullable", path);
  const unique = optionalBoolean(context, options, "unique", path);
  const generated = optionalStringChoice(
    context,
    options,
    "generated",
    new Set(["uuid", "increment"]),
    path,
  ) as "uuid" | "increment" | undefined;
  const minLength = optionalNumber(context, options, "minLength", path);
  const maxLength = optionalNumber(context, options, "maxLength", path);
  const minimum = optionalNumber(context, options, "minimum", path);
  const maximum = optionalNumber(context, options, "maximum", path);
  const defaultExpression = options.get("default");
  const parsedDefault = defaultExpression
    ? parseJsonValue(context, defaultExpression, [...path, "default"])
    : { matched: false as const };
  if (defaultExpression && !parsedDefault.matched) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        [...path, "default"],
        "Column default",
        defaultExpression,
        "Use a static JSON value: null, boolean, finite number, string, array, or object.",
      ),
    );
  }
  const referencesExpression = options.get("references");
  const references = referencesExpression
    ? parseReference(context, referencesExpression, [...path, "references"])
    : undefined;

  return {
    name,
    type,
    ...(identity === undefined ? {} : { identity }),
    ...(nullable === undefined ? {} : { nullable }),
    ...(unique === undefined ? {} : { unique }),
    ...(generated === undefined ? {} : { generated }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
    ...(parsedDefault.matched ? { default: parsedDefault.value } : {}),
    ...(references === undefined ? {} : { references }),
  };
}

function parseJsonValue(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
):
  | { readonly matched: true; readonly value: JsonValue }
  | { readonly matched: false } {
  const scalar = parseLiteral(node);
  if (scalar.matched) return scalar;
  if (ts.isArrayLiteralExpression(node)) {
    const values: JsonValue[] = [];
    for (const [index, element] of node.elements.entries()) {
      const value = parseJsonValue(context, element, [...path, String(index)]);
      if (!value.matched) return value;
      values.push(value.value);
    }
    return { matched: true, value: values };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const object = staticObject(context, node, path, "JSON default", true);
    if (!object) return { matched: false };
    const value = Object.create(null) as Record<string, JsonValue>;
    for (const [name, expression] of object) {
      const nested = parseJsonValue(context, expression, [...path, name]);
      if (!nested.matched) return nested;
      value[name] = nested.value;
    }
    return { matched: true, value };
  }
  return { matched: false };
}

function parseReference(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): ColumnReferenceDeclaration | undefined {
  const typed = parseTypedColumnReference(context, node);
  if (typed) return typed;
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ts.isIdentifier(node.name) &&
    hasRuntimeClassBinding(context, node.expression.text, ["entity"])
  ) {
    return {
      entity: semanticName(context, node.expression.text, ["entity"]),
      column: node.name.text,
    };
  }

  const object = staticObject(context, node, path, "Column references");
  if (!object) return undefined;
  rejectUnknownOptions(context, object, new Set(["entity", "column"]), path);
  const entityNode = object.get("entity");
  const columnNode = object.get("column");
  const entity =
    entityNode && ts.isIdentifier(entityNode)
      ? hasRuntimeClassBinding(context, entityNode.text, ["entity"])
        ? semanticName(context, entityNode.text, ["entity"])
        : undefined
      : undefined;
  const column =
    columnNode && ts.isStringLiteral(columnNode) ? columnNode.text : undefined;
  if (!entity || !column) {
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_REFERENCE",
        path,
        "Column references must identify a static Entity and Column.",
        'Use references: Customer.id or references: { entity: Customer, column: "id" }.',
        node,
      ),
    );
    return undefined;
  }
  return { entity, column };
}

function parseRule(
  context: ParserContext,
  entityName: string,
  node: ts.MethodDeclaration,
): RuleDeclaration | undefined {
  const name = memberName(context, node.name, ["entity", entityName, "rules"]);
  const path = ["entity", entityName, "rules", name ?? "unknown"];
  const decorator = oneDecorator(context, node, "Rule", path);
  if (!name || !decorator) return undefined;
  const semanticPath = ["module", "entities", entityName, "rules", name];
  recordLocation(context, semanticPath, node);
  recordLocation(context, [...semanticPath, "name"], node.name);
  const options = decoratorObject(context, decorator, path, "Rule");
  if (options) {
    rejectUnknownOptions(context, options, new Set(["expression"]), path);
  }
  const expressionNode = options?.get("expression");
  if (!expressionNode) {
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_RULE_EXPRESSION",
        [...path, "expression"],
        "@Rule requires a static expression.",
        'Use @Rule({ expression: gt(column("endDate"), column("startDate")) }).',
        decorator,
      ),
    );
    return undefined;
  }
  recordLocation(context, [...semanticPath, "expression"], expressionNode);
  const expression = parseRuleExpression(context, expressionNode, [
    ...path,
    "expression",
  ]);
  return expression ? { name, expression } : undefined;
}

function parseRuleExpression(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): RuleExpressionDeclaration | undefined {
  const call = dslCall(context, node);
  if (!call) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        path,
        "Rule expressions",
        node,
        "Use Vane Rule helper calls only.",
      ),
    );
    return undefined;
  }
  const { symbol, expression } = call;

  if (COMPARISON_OPERATORS.has(symbol)) {
    if (!requireArgumentCount(context, expression, 2, path, symbol))
      return undefined;
    const left = parseRuleValue(context, expression.arguments[0], [
      ...path,
      "left",
    ]);
    const right = parseRuleValue(context, expression.arguments[1], [
      ...path,
      "right",
    ]);
    if (!left || !right) return undefined;
    return {
      kind: "comparison",
      operator: symbol as "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
      left,
      right,
    };
  }

  if (symbol === "and" || symbol === "or") {
    if (expression.arguments.length < 2) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_ARGUMENTS",
          path,
          `${symbol} requires at least two operands.`,
          `Pass two or more Rule expressions to ${symbol}(...).`,
          expression,
        ),
      );
      return undefined;
    }
    const operands = expression.arguments.flatMap((argument, index) => {
      const operand = parseRuleExpression(context, argument, [
        ...path,
        String(index),
      ]);
      return operand ? [operand] : [];
    });
    return operands.length === expression.arguments.length
      ? { kind: "logical", operator: symbol, operands }
      : undefined;
  }

  if (symbol === "not") {
    if (!requireArgumentCount(context, expression, 1, path, symbol))
      return undefined;
    const argument = expression.arguments[0];
    if (!argument) return undefined;
    const operand = parseRuleExpression(context, argument, [
      ...path,
      "operand",
    ]);
    return operand ? { kind: "not", operand } : undefined;
  }

  context.diagnostics.push(
    createDiagnostic(
      context,
      "VANE_PARSE_RULE_EXPRESSION",
      path,
      `${symbol} is not a Rule expression operator.`,
      "Use eq, neq, gt, gte, lt, lte, and, or, or not.",
      node,
    ),
  );
  return undefined;
}

function parseRuleValue(
  context: ParserContext,
  node: ts.Expression | undefined,
  path: readonly string[],
): RuleValueDeclaration | undefined {
  if (!node) return undefined;
  const call = dslCall(context, node);
  if (!call || (call.symbol !== "column" && call.symbol !== "literal")) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        path,
        "Rule values",
        node,
        'Use column("name") or literal(value).',
      ),
    );
    return undefined;
  }
  if (!requireArgumentCount(context, call.expression, 1, path, call.symbol))
    return undefined;
  const argument = call.expression.arguments[0];

  if (call.symbol === "column") {
    if (argument && ts.isStringLiteral(argument)) {
      return { kind: "column", column: argument.text };
    }
  } else if (argument) {
    const literal = parseLiteral(argument);
    if (literal.matched) return { kind: "literal", value: literal.value };
  }

  context.diagnostics.push(
    staticDiagnostic(
      context,
      path,
      call.symbol === "column" ? "Column names" : "Rule literals",
      argument ?? node,
      call.symbol === "column"
        ? "Pass a string literal to column(...)."
        : "Pass null, a boolean, a finite number, or a string to literal(...).",
    ),
  );
  return undefined;
}

function parseEvent(
  context: ParserContext,
  entityName: string,
  node: ts.PropertyDeclaration,
): EntityEventDeclaration | undefined {
  const name = memberName(context, node.name, ["entity", entityName, "events"]);
  const path = ["entity", entityName, "events", name ?? "unknown"];
  const initializer = node.initializer
    ? dslCall(context, node.initializer)
    : undefined;
  const call =
    initializer?.symbol === "Event" ? initializer.expression : undefined;
  if (!name || !call) return undefined;
  if (!requireArgumentCount(context, call, 1, path, "Event")) return undefined;
  const semanticPath = ["module", "entities", entityName, "events", name];
  recordLocation(context, semanticPath, node);
  recordLocation(context, [...semanticPath, "name"], node.name);
  const options = decoratorObject(context, call, path, "Event");
  if (!options) return undefined;
  rejectUnknownOptions(context, options, new Set(["input", "operation"]), path);
  const inputExpression = options.get("input");
  const operationExpression = options.get("operation");
  if (!operationExpression) {
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_EVENT_OPERATION",
        [...path, "operation"],
        `Entity Event ${entityName}.${name} must declare one persistent operation.`,
        "Declare operation: create(...), update(...), remove(...), or upsert(...).",
        call,
      ),
    );
    return undefined;
  }
  const inputs = inputExpression
    ? parseTypedInputs(
        context,
        inputExpression,
        [...path, "input"],
        "Event input",
      )
    : [];
  if (inputExpression) {
    recordLocation(context, [...semanticPath, "input"], inputExpression);
  }
  recordLocation(context, [...semanticPath, "operation"], operationExpression);
  const operation = parseEventOperation(context, operationExpression, [
    ...path,
    "operation",
  ]);
  return inputs && operation ? { name, input: inputs, operation } : undefined;
}

function parseEventOperation(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): EntityEventOperationDeclaration | undefined {
  const call = dslCall(context, node);
  if (
    !call ||
    !["create", "update", "remove", "upsert"].includes(call.symbol)
  ) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        path,
        "Entity Event operation",
        node,
        "Use create(values), update(identity, values), remove(identity), or upsert(identity, values).",
      ),
    );
    return undefined;
  }

  if (call.symbol === "create") {
    if (!requireArgumentCount(context, call.expression, 1, path, "create"))
      return undefined;
    const values = parseEventOperationAssignments(
      context,
      call.expression.arguments[0],
      [...path, "values"],
    );
    return values ? { kind: "create", values } : undefined;
  }

  if (call.symbol === "remove") {
    if (!requireArgumentCount(context, call.expression, 1, path, "remove"))
      return undefined;
    const identity = parseEventOperationValue(
      context,
      call.expression.arguments[0],
      [...path, "identity"],
    );
    return identity ? { kind: "delete", identity } : undefined;
  }

  if (!requireArgumentCount(context, call.expression, 2, path, call.symbol))
    return undefined;
  const identity = parseEventOperationValue(
    context,
    call.expression.arguments[0],
    [...path, "identity"],
  );
  const values = parseEventOperationAssignments(
    context,
    call.expression.arguments[1],
    [...path, "values"],
  );
  if (!identity || !values) return undefined;
  return {
    kind: call.symbol as "update" | "upsert",
    identity,
    values,
  };
}

function parseEventOperationAssignments(
  context: ParserContext,
  node: ts.Expression | undefined,
  path: readonly string[],
): readonly EventOperationAssignmentDeclaration[] | undefined {
  if (!node) return undefined;
  const object = staticObject(
    context,
    node,
    path,
    "Entity Event operation values",
  );
  if (!object) return undefined;
  const assignments: EventOperationAssignmentDeclaration[] = [];
  for (const [column, valueNode] of object) {
    const value = parseEventOperationValue(context, valueNode, [
      ...path,
      column,
    ]);
    if (value) assignments.push({ column, value });
  }
  return assignments.length === object.size ? assignments : undefined;
}

function parseEventOperationValue(
  context: ParserContext,
  node: ts.Expression | undefined,
  path: readonly string[],
): EventOperationValueDeclaration | undefined {
  if (!node) return undefined;
  const call = dslCall(context, node);
  if (
    !call ||
    !["input", "literal", "column", "add", "subtract"].includes(call.symbol)
  ) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        path,
        "Entity Event operation value",
        node,
        "Use input, literal, column, add, or subtract.",
      ),
    );
    return undefined;
  }

  if (call.symbol === "add" || call.symbol === "subtract") {
    if (!requireArgumentCount(context, call.expression, 2, path, call.symbol))
      return undefined;
    const left = parseEventOperationValue(
      context,
      call.expression.arguments[0],
      [...path, "left"],
    );
    const right = parseEventOperationValue(
      context,
      call.expression.arguments[1],
      [...path, "right"],
    );
    return left && right
      ? {
          kind: "arithmetic",
          operator: call.symbol,
          left,
          right,
        }
      : undefined;
  }

  if (!requireArgumentCount(context, call.expression, 1, path, call.symbol))
    return undefined;
  const argument = call.expression.arguments[0];
  if (call.symbol === "literal" && argument) {
    const literal = parseLiteral(argument);
    if (literal.matched) return { kind: "literal", value: literal.value };
  } else if (argument && ts.isStringLiteral(argument)) {
    return call.symbol === "input"
      ? { kind: "input", input: argument.text }
      : { kind: "column", column: argument.text };
  }

  context.diagnostics.push(
    staticDiagnostic(
      context,
      path,
      `${call.symbol} argument`,
      argument ?? node,
      call.symbol === "literal"
        ? "Pass null, a boolean, a finite number, or a string."
        : `Pass a string literal to ${call.symbol}(...).`,
    ),
  );
  return undefined;
}

function parseAntiCorruptionLayerEvent(
  context: ParserContext,
  layerName: string,
  node: ts.PropertyDeclaration,
): AntiCorruptionLayerEventDeclaration | undefined {
  const name = memberName(context, node.name, [
    "antiCorruptionLayer",
    layerName,
    "events",
  ]);
  const path = ["antiCorruptionLayer", layerName, "events", name ?? "unknown"];
  const initializer = node.initializer
    ? dslCall(context, node.initializer)
    : undefined;
  const call =
    initializer?.symbol === "ACLEvent" ? initializer.expression : undefined;
  if (
    !name ||
    !call ||
    !requireArgumentCount(context, call, 1, path, "ACLEvent")
  )
    return undefined;

  const semanticPath = [
    "module",
    "antiCorruptionLayers",
    layerName,
    "events",
    name,
  ];
  recordLocation(context, semanticPath, node);
  recordLocation(context, [...semanticPath, "name"], node.name);
  const options = decoratorObject(context, call, path, "ACL Event");
  if (!options) return undefined;
  rejectUnknownOptions(context, options, new Set(["input", "results"]), path);

  const inputExpression = options.get("input");
  const resultsExpression = options.get("results");
  if (!resultsExpression) {
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_ACL_EVENT_RESULTS",
        [...path, "results"],
        `ACL Event ${layerName}.${name} must declare static result interpretations.`,
        "Declare results such as { approved: success({...}), declined: fail({...}) }.",
        call,
      ),
    );
    return undefined;
  }

  const input = inputExpression
    ? parseTypedInputs(
        context,
        inputExpression,
        [...path, "input"],
        "ACL Event input",
      )
    : [];
  const results = parseAntiCorruptionLayerEventResults(
    context,
    resultsExpression,
    [...path, "results"],
  );
  recordLocation(context, [...semanticPath, "results"], resultsExpression);
  if (inputExpression)
    recordLocation(context, [...semanticPath, "input"], inputExpression);
  return input && results ? { name, input, results } : undefined;
}

function parseAntiCorruptionLayerEventResults(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): readonly AntiCorruptionLayerEventResultDeclaration[] | undefined {
  const object = staticObject(context, node, path, "ACL Event results");
  if (!object) return undefined;
  const results: AntiCorruptionLayerEventResultDeclaration[] = [];

  for (const [name, expression] of object) {
    const resultPath = [...path, name];
    const call = dslCall(context, expression);
    if (!call || (call.symbol !== "success" && call.symbol !== "fail")) {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          resultPath,
          "ACL Event result interpretations",
          expression,
          "Use success({...}) or fail({...}) with a static typed result object.",
        ),
      );
      continue;
    }
    if (
      !requireArgumentCount(
        context,
        call.expression,
        1,
        resultPath,
        call.symbol,
      )
    ) {
      continue;
    }
    const argument = call.expression.arguments[0];
    if (!argument) continue;
    const data = parseTypedInputs(
      context,
      argument,
      [...resultPath, "data"],
      "ACL Event result data",
    );
    if (data) {
      results.push({
        name,
        outcome: call.symbol,
        data,
      });
    }
  }

  return results;
}

function parseTypedInputs(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
  subject: string,
): readonly EventInputDeclaration[] | undefined {
  const object = staticObject(context, node, path, subject);
  if (!object) return undefined;
  const inputs: EventInputDeclaration[] = [];
  for (const [name, expression] of object) {
    let typeExpression = expression;
    let optional = false;
    const call = dslCall(context, expression);
    if (call?.symbol === "optional") {
      optional = true;
      if (
        !requireArgumentCount(
          context,
          call.expression,
          1,
          [...path, name],
          "optional",
        )
      ) {
        continue;
      }
      const argument = call.expression.arguments[0];
      if (!argument) continue;
      typeExpression = argument;
    }
    const type = parseColumnType(context, typeExpression, [...path, name]);
    if (type)
      inputs.push({ name, type, ...(optional ? { optional: true } : {}) });
  }
  return inputs;
}

function decoratorObject(
  context: ParserContext,
  decorator: ts.CallExpression,
  path: readonly string[],
  subject: string,
): ReadonlyMap<string, ts.Expression> | undefined {
  if (!requireArgumentCount(context, decorator, 1, path, subject))
    return undefined;
  const argument = decorator.arguments[0];
  return argument
    ? staticObject(context, argument, path, `${subject} options`)
    : undefined;
}

function staticObject(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
  subject: string,
  allowNumericPropertyNames = false,
): ReadonlyMap<string, ts.Expression> | undefined {
  if (!ts.isObjectLiteralExpression(node)) {
    context.diagnostics.push(
      staticDiagnostic(
        context,
        path,
        subject,
        node,
        "Use an inline object literal.",
      ),
    );
    return undefined;
  }
  const values = new Map<string, ts.Expression>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          path,
          subject,
          property,
          "Use explicit key: value properties; spreads and shorthand are not supported.",
        ),
      );
      continue;
    }
    const name = staticPropertyName(property.name, allowNumericPropertyNames);
    if (!name) {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          path,
          subject,
          property.name,
          allowNumericPropertyNames
            ? "Use an identifier, string, or numeric property name."
            : "Use an identifier or string property name.",
        ),
      );
      continue;
    }
    if (values.has(name)) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_DUPLICATE_PROPERTY",
          [...path, name],
          `${subject} declares ${name} more than once.`,
          "Keep one value for each option.",
          property.name,
        ),
      );
    }
    values.set(name, property.initializer);
  }
  return values;
}

function parseColumnType(
  context: ParserContext,
  node: ts.Expression | undefined,
  path: readonly string[],
): ColumnType | undefined {
  if (node && ts.isStringLiteral(node) && COLUMN_TYPE_SET.has(node.text)) {
    return node.text as ColumnType;
  }
  context.diagnostics.push(
    createDiagnostic(
      context,
      "VANE_PARSE_COLUMN_TYPE",
      path,
      "A Column type must be one of the supported static string literals.",
      `Use one of: ${COLUMN_TYPES.join(", ")}.`,
      node ?? context.sourceFile,
    ),
  );
  return undefined;
}

function rejectUnknownOptions(
  context: ParserContext,
  options: ReadonlyMap<string, ts.Expression>,
  allowed: ReadonlySet<string>,
  path: readonly string[],
): void {
  for (const [name, node] of options) {
    if (allowed.has(name)) continue;
    context.diagnostics.push(
      createDiagnostic(
        context,
        "VANE_PARSE_OPTION",
        [...path, name],
        `${name} is not a recognized option here.`,
        `Use only: ${[...allowed].join(", ")}.`,
        node,
      ),
    );
  }
}

function optionalBoolean(
  context: ParserContext,
  options: ReadonlyMap<string, ts.Expression>,
  property: string,
  path: readonly string[],
): boolean | undefined {
  const node = options.get(property);
  if (!node) return undefined;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  context.diagnostics.push(
    staticDiagnostic(
      context,
      [...path, property],
      property,
      node,
      "Use true or false.",
    ),
  );
  return undefined;
}

function optionalNumber(
  context: ParserContext,
  options: ReadonlyMap<string, ts.Expression>,
  property: string,
  path: readonly string[],
): number | undefined {
  const node = options.get(property);
  if (!node) return undefined;
  const literal = parseLiteral(node);
  if (literal.matched && typeof literal.value === "number")
    return literal.value;
  context.diagnostics.push(
    staticDiagnostic(
      context,
      [...path, property],
      property,
      node,
      "Use a finite numeric literal.",
    ),
  );
  return undefined;
}

function optionalStringChoice(
  context: ParserContext,
  options: ReadonlyMap<string, ts.Expression>,
  property: string,
  choices: ReadonlySet<string>,
  path: readonly string[],
): string | undefined {
  const node = options.get(property);
  if (!node) return undefined;
  if (ts.isStringLiteral(node) && choices.has(node.text)) return node.text;
  context.diagnostics.push(
    staticDiagnostic(
      context,
      [...path, property],
      property,
      node,
      `Use one of: ${[...choices].join(", ")}.`,
    ),
  );
  return undefined;
}

function className(
  context: ParserContext,
  node: ts.ClassDeclaration,
  path: readonly string[],
  subject: string,
): string | undefined {
  if (node.name) return node.name.text;
  context.diagnostics.push(
    createDiagnostic(
      context,
      "VANE_PARSE_NAME",
      path,
      `@${subject} must decorate a named class.`,
      `Give the @${subject} class a name.`,
      node,
    ),
  );
  return undefined;
}

function memberName(
  context: ParserContext,
  node: ts.PropertyName,
  path: readonly string[],
): string | undefined {
  const name = staticPropertyName(node);
  if (name) return name;
  context.diagnostics.push(
    staticDiagnostic(
      context,
      path,
      "DSL member names",
      node,
      "Use an identifier or string literal name.",
    ),
  );
  return undefined;
}

function staticPropertyName(
  node: ts.PropertyName,
  allowNumeric = false,
): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return allowNumeric && ts.isNumericLiteral(node)
    ? String(Number(node.text))
    : undefined;
}

function hasDecorator(
  context: ParserContext,
  node: ts.Node,
  symbol: string,
): boolean {
  return decoratorsOf(node).some((decorator) => {
    const expression = decorator.expression;
    return (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      context.bindings.get(expression.expression.text) === symbol
    );
  });
}

function hasDslInitializer(
  context: ParserContext,
  node: ts.Node,
  symbol: string,
): node is ts.PropertyDeclaration {
  return (
    ts.isPropertyDeclaration(node) &&
    node.initializer !== undefined &&
    dslCall(context, node.initializer)?.symbol === symbol
  );
}

function hasSemanticMemberMarker(
  context: ParserContext,
  node: ts.Node,
  symbol: string,
): boolean {
  return (
    hasDecorator(context, node, symbol) ||
    (symbol !== "Rule" && hasDslInitializer(context, node, symbol))
  );
}

function oneDecorator(
  context: ParserContext,
  node: ts.Node,
  symbol: string,
  path: readonly string[],
): ts.CallExpression | undefined {
  const matches = decoratorsOf(node).flatMap((decorator) => {
    const expression = decorator.expression;
    return ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      context.bindings.get(expression.expression.text) === symbol
      ? [expression]
      : [];
  });
  if (matches.length === 1) return matches[0];
  context.diagnostics.push(
    createDiagnostic(
      context,
      "VANE_PARSE_DECORATOR_COUNT",
      path,
      `Expected exactly one @${symbol} decorator; found ${matches.length}.`,
      `Apply @${symbol}(...) exactly once.`,
      node,
    ),
  );
  return undefined;
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function dslCall(
  context: ParserContext,
  node: ts.Expression,
):
  | { readonly symbol: string; readonly expression: ts.CallExpression }
  | undefined {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression))
    return undefined;
  const symbol = context.bindings.get(node.expression.text);
  return symbol ? { symbol, expression: node } : undefined;
}

function requireArgumentCount(
  context: ParserContext,
  node: ts.CallExpression,
  count: number,
  path: readonly string[],
  subject: string,
): boolean {
  if (node.arguments.length === count) return true;
  context.diagnostics.push(
    createDiagnostic(
      context,
      "VANE_PARSE_ARGUMENTS",
      path,
      `${subject} expects ${count} argument(s); found ${node.arguments.length}.`,
      `Pass exactly ${count} argument(s) to ${subject}(...).`,
      node,
    ),
  );
  return false;
}

function parseLiteral(
  node: ts.Expression,
):
  | { readonly matched: true; readonly value: boolean | number | string | null }
  | { readonly matched: false } {
  if (ts.isStringLiteral(node)) return { matched: true, value: node.text };
  if (ts.isNumericLiteral(node))
    return { matched: true, value: Number(node.text) };
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return { matched: true, value: -Number(node.operand.text) };
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword)
    return { matched: true, value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword)
    return { matched: true, value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword)
    return { matched: true, value: null };
  return { matched: false };
}

function appendSyntaxDiagnostics(
  sourceFile: ts.SourceFile,
  diagnostics: Diagnostic[],
): void {
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {
      readonly parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  for (const diagnostic of parseDiagnostics ?? []) {
    const start = diagnostic.start ?? 0;
    const length = diagnostic.length ?? 0;
    diagnostics.push({
      code: "VANE_PARSE_SYNTAX",
      path: ["source", "syntax"],
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      correction: "Fix the TypeScript syntax before compiling the Vane module.",
      location: locationFromOffsets(sourceFile, start, start + length),
    });
  }
}

function staticDiagnostic(
  context: ParserContext,
  path: readonly string[],
  subject: string,
  node: ts.Node,
  correction: string,
): Diagnostic {
  return createDiagnostic(
    context,
    "VANE_PARSE_STATIC_VALUE",
    path,
    `${subject} must be statically representable and cannot depend on executing user code.`,
    correction,
    node,
  );
}

function createDiagnostic(
  context: ParserContext,
  code: string,
  path: readonly string[],
  message: string,
  correction: string,
  node: ts.Node,
): Diagnostic {
  return {
    code,
    path,
    message,
    correction,
    location: locationOf(context.sourceFile, node),
  };
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): SourceLocation {
  return locationFromOffsets(
    sourceFile,
    node.getStart(sourceFile),
    node.getEnd(),
  );
}

function locationFromOffsets(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): SourceLocation {
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    fileName: sourceFile.fileName,
    start: {
      line: startPosition.line + 1,
      column: startPosition.character + 1,
    },
    end: { line: endPosition.line + 1, column: endPosition.character + 1 },
  };
}

function recordLocation(
  context: ParserContext,
  path: readonly string[],
  node: ts.Node,
): void {
  context.sourceLocations.set(
    path.join("."),
    locationOf(context.sourceFile, node),
  );
}

function locationForPath(
  sourceLocations: ReadonlyMap<string, SourceLocation>,
  path: readonly string[],
): { readonly location: SourceLocation } | Record<string, never> {
  for (let length = path.length; length > 0; length -= 1) {
    const location = sourceLocations.get(path.slice(0, length).join("."));
    if (location) return { location };
  }
  return {};
}

function sortDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const leftLocation = left.location?.start;
    const rightLocation = right.location?.start;
    const byLine = (leftLocation?.line ?? 0) - (rightLocation?.line ?? 0);
    if (byLine !== 0) return byLine;
    const byColumn = (leftLocation?.column ?? 0) - (rightLocation?.column ?? 0);
    return byColumn !== 0 ? byColumn : left.code.localeCompare(right.code);
  });
}
