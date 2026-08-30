import ts from "typescript";
import { compileSemanticIr } from "./compiler.js";
import {
  COLUMN_TYPES,
  type ColumnDeclaration,
  type ColumnReferenceDeclaration,
  type ColumnType,
  type EntityColumnReferenceDeclaration,
  type EntityDeclaration,
  type EntityEventDeclaration,
  type EventInputDeclaration,
  type ModuleDeclaration,
  type RuleDeclaration,
  type RuleExpressionDeclaration,
  type RuleValueDeclaration,
  type ViewDeclaration,
  type ViewExpressionDeclaration,
  type ViewOrderDeclaration,
  type ViewOutputDeclaration,
  type ViewOutputExpressionDeclaration,
  type ViewPaginationDeclaration,
  type ViewPaginationValueDeclaration,
  type ViewQueryDeclaration,
  type ViewValueDeclaration,
} from "./declaration.js";
import type { Diagnostic, SourceLocation } from "./diagnostic.js";
import type { SemanticIr } from "./semantic-ir.js";

const VANE_MODULE = "@lilka/vane";
const DSL_SYMBOLS = new Set([
  "Module",
  "Entity",
  "Column",
  "Rule",
  "Event",
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

interface ParserContext {
  readonly sourceFile: ts.SourceFile;
  readonly bindings: ReadonlyMap<string, string>;
  readonly diagnostics: Diagnostic[];
  readonly sourceLocations: Map<string, SourceLocation>;
}

export function parseModuleSource(
  input: ModuleSourceParserInput,
): ModuleSourceParseResult {
  const parsed = parseModuleSourceInternal(input);
  if (!parsed.success) return parsed;
  return {
    success: true,
    declaration: parsed.declaration,
    diagnostics: [],
  };
}

function parseModuleSourceInternal(input: ModuleSourceParserInput):
  | {
      readonly success: true;
      readonly declaration: ModuleDeclaration;
      readonly diagnostics: readonly [];
      readonly sourceLocations: ReadonlyMap<string, SourceLocation>;
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

  const bindings = collectDslBindings(sourceFile, diagnostics);
  const context: ParserContext = {
    sourceFile,
    bindings,
    diagnostics,
    sourceLocations: new Map(),
  };
  const classes = sourceFile.statements.filter(ts.isClassDeclaration);
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

  if (diagnostics.length > 0 || !declaration) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  return {
    success: true,
    declaration,
    diagnostics: [],
    sourceLocations: context.sourceLocations,
  };
}

export function compileModuleSource(
  input: ModuleSourceParserInput,
): ModuleSourceCompilationResult {
  const parsed = parseModuleSourceInternal(input);
  if (!parsed.success) return parsed;
  const compiled = compileSemanticIr(parsed.declaration);
  if (compiled.success) return compiled;
  return {
    success: false,
    diagnostics: compiled.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...locationForPath(parsed.sourceLocations, diagnostic.path),
    })),
  };
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
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
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
    rejectUnknownOptions(context, options, new Set(["entities", "views"]), [
      "module",
    ]);
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

  return { name, entities, views };
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
    const memberDecorators = ["Column", "Rule", "Event"].filter((symbol) =>
      hasDecorator(context, member, symbol),
    );
    if (memberDecorators.length === 0) continue;
    if (memberDecorators.length > 1) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_DECORATOR_TARGET",
          ["entity", name, "members"],
          `Entity member combines incompatible DSL decorators: ${memberDecorators.map((symbol) => `@${symbol}`).join(", ")}.`,
          "Apply exactly one of @Column, @Rule, or @Event to each Entity member.",
          member,
        ),
      );
      continue;
    }

    const memberDecorator = memberDecorators[0];
    if (memberDecorator === "Column" && ts.isPropertyDeclaration(member)) {
      const column = parseColumn(context, name, member);
      if (column) columns.push(column);
    } else if (memberDecorator === "Rule" && ts.isMethodDeclaration(member)) {
      const rule = parseRule(context, name, member);
      if (rule) rules.push(rule);
    } else if (memberDecorator === "Event" && ts.isMethodDeclaration(member)) {
      const event = parseEvent(context, name, member);
      if (event) events.push(event);
    } else if (memberDecorator) {
      context.diagnostics.push(
        createDiagnostic(
          context,
          "VANE_PARSE_DECORATOR_TARGET",
          ["entity", name, "members"],
          `@${memberDecorator} cannot decorate this kind of Entity member.`,
          memberDecorator === "Column"
            ? "Apply @Column to a property declaration."
            : `Apply @${memberDecorator} to a method declaration.`,
          member,
        ),
      );
    }
  }

  return { name, columns, rules, events };
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
    const forbidden = ["Column", "Rule", "Event"].filter((symbol) =>
      hasDecorator(context, member, symbol),
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
  const column = parseEntityColumnReference(node);
  if (column) return { kind: "column", ...column };

  const call = dslCall(context, node);
  if (call && VIEW_AGGREGATES.has(call.symbol)) {
    if (!requireArgumentCount(context, call.expression, 1, path, call.symbol)) {
      return undefined;
    }
    const argument = call.expression.arguments[0];
    const value = argument ? parseEntityColumnReference(argument) : undefined;
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
    new Set(["root", "where", "orderBy", "pagination"]),
    path,
  );

  const rootExpression = object.get("root");
  if (!rootExpression || !ts.isIdentifier(rootExpression)) {
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
    (orderByExpression && !parsedOrderBy) ||
    (paginationExpression && !pagination)
  ) {
    return undefined;
  }
  const orderBy = parsedOrderBy ?? [];
  return {
    root: rootExpression.text,
    ...(where ? { where } : {}),
    ...(orderBy.length > 0 ? { orderBy } : {}),
    ...(pagination ? { pagination } : {}),
  };
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
  const column = parseEntityColumnReference(node);
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
    const value = argument ? parseEntityColumnReference(argument) : undefined;
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
  node: ts.Expression,
): EntityColumnReferenceDeclaration | undefined {
  return ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ts.isIdentifier(node.name)
    ? { entity: node.expression.text, column: node.name.text }
    : undefined;
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
  const decorator = oneDecorator(context, node, "Column", path);
  if (!name || !decorator) return undefined;
  const semanticPath = ["module", "entities", entityName, "columns", name];
  recordLocation(context, semanticPath, node);
  recordLocation(context, [...semanticPath, "type"], node);
  const options = decoratorObject(context, decorator, path, "Column");
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
    ...(references === undefined ? {} : { references }),
  };
}

function parseReference(
  context: ParserContext,
  node: ts.Expression,
  path: readonly string[],
): ColumnReferenceDeclaration | undefined {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ts.isIdentifier(node.name)
  ) {
    return { entity: node.expression.text, column: node.name.text };
  }

  const object = staticObject(context, node, path, "Column references");
  if (!object) return undefined;
  rejectUnknownOptions(context, object, new Set(["entity", "column"]), path);
  const entityNode = object.get("entity");
  const columnNode = object.get("column");
  const entity =
    entityNode &&
    (ts.isIdentifier(entityNode) || ts.isStringLiteral(entityNode))
      ? entityNode.text
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
  node: ts.MethodDeclaration,
): EntityEventDeclaration | undefined {
  const name = memberName(context, node.name, ["entity", entityName, "events"]);
  const path = ["entity", entityName, "events", name ?? "unknown"];
  const decorator = oneDecorator(context, node, "Event", path);
  if (!name || !decorator) return undefined;
  const semanticPath = ["module", "entities", entityName, "events", name];
  recordLocation(context, semanticPath, node);
  recordLocation(context, [...semanticPath, "name"], node.name);
  if (decorator.arguments.length === 0) return { name, input: [] };
  const options = decoratorObject(context, decorator, path, "Event");
  if (!options) return undefined;
  rejectUnknownOptions(context, options, new Set(["input"]), path);
  const inputExpression = options.get("input");
  if (!inputExpression) return { name, input: [] };
  recordLocation(context, [...semanticPath, "input"], inputExpression);
  const inputs = parseTypedInputs(
    context,
    inputExpression,
    [...path, "input"],
    "Event input",
  );
  return inputs ? { name, input: inputs } : undefined;
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
    const name = staticPropertyName(property.name);
    if (!name) {
      context.diagnostics.push(
        staticDiagnostic(
          context,
          path,
          subject,
          property.name,
          "Use an identifier or string property name.",
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

function staticPropertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node)
    ? node.text
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
