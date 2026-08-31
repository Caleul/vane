import type {
  ColumnType,
  JsonValue,
  RuleExpressionDeclaration,
  RuleValueDeclaration,
  ViewExpressionDeclaration,
  ViewOrderDeclaration,
  ViewPaginationValueDeclaration,
  ViewValueDeclaration,
} from "./declaration.js";

export type VaneClass<T = object> = abstract new (...args: never[]) => T;
type MemberName<T> = Extract<keyof T, string>;
type TypedField = ColumnType | OptionalField;

export interface OptionalField {
  readonly kind: "optional";
  readonly type: ColumnType;
}

export type ColumnToken = Extract<ViewValueDeclaration, { kind: "column" }>;

export interface EventToken {
  readonly owner: string;
  readonly event: string;
}

export interface RelationToken {
  readonly from: ColumnToken;
  readonly to: ColumnToken;
}

export interface AggregateToken {
  readonly kind: "aggregate";
  readonly function: "count" | "sum" | "avg" | "min" | "max";
  readonly value: ColumnToken;
}

export interface ModuleOptions {
  readonly imports?: readonly VaneClass[];
  readonly entities: readonly VaneClass[];
  readonly views?: readonly VaneClass[];
  readonly antiCorruptionLayers?: readonly VaneClass[];
  readonly sagas?: readonly VaneClass[];
}

export interface ColumnOptions {
  readonly type: ColumnType;
  readonly identity?: boolean;
  readonly nullable?: boolean;
  readonly unique?: boolean;
  readonly generated?: "uuid" | "increment";
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: JsonValue;
  readonly references?: ColumnToken;
}

export interface RuleOptions {
  readonly expression: RuleExpressionDeclaration;
}

export interface EventOptions {
  readonly input?: Readonly<Record<string, TypedField>>;
  readonly results?: Readonly<Record<string, EventResultToken>>;
}

export interface EventResultToken {
  readonly outcome: "success" | "fail";
  readonly data: Readonly<Record<string, TypedField>>;
}

export interface ViewOptions {
  readonly input: Readonly<Record<string, TypedField>>;
  readonly output: Readonly<Record<string, ColumnToken | AggregateToken>>;
  readonly query: {
    readonly root: VaneClass;
    readonly relations?: Readonly<Record<string, RelationToken>>;
    readonly where?: ViewExpressionDeclaration;
    readonly orderBy?: readonly ViewOrderDeclaration[];
    readonly pagination?: {
      readonly limit?: ViewPaginationValueDeclaration | number;
      readonly offset?: ViewPaginationValueDeclaration | number;
    };
  };
}

export interface SagaStepOptions {
  readonly causedBy?: readonly string[];
  readonly compensateWith?: EventToken;
}

export interface SagaStepToken extends EventToken {
  readonly causedBy: readonly string[];
  readonly compensateWith?: EventToken;
}

export interface SagaOptions {
  readonly input?: Readonly<Record<string, TypedField>>;
  readonly steps: Readonly<Record<string, SagaStepToken>>;
  readonly terminal: { readonly step: string; readonly view: VaneClass };
}

const classDecorator: ClassDecorator = () => undefined;
const propertyDecorator: PropertyDecorator = () => undefined;
const methodDecorator: MethodDecorator = () => undefined;

export function Module(_options: ModuleOptions): ClassDecorator {
  return classDecorator;
}
export function Entity(): ClassDecorator {
  return classDecorator;
}
export function ACL(): ClassDecorator {
  return classDecorator;
}
export function Column(_options: ColumnOptions): PropertyDecorator {
  return propertyDecorator;
}
export function Rule(_options: RuleOptions): MethodDecorator {
  return methodDecorator;
}
export function Event(_options: EventOptions = {}): MethodDecorator {
  return methodDecorator;
}
export function View(_options: ViewOptions): ClassDecorator {
  return classDecorator;
}
export function Saga(_options: SagaOptions): ClassDecorator {
  return classDecorator;
}

function className<T>(value: VaneClass<T>): string {
  return value.name;
}

export function field<T>(
  entity: VaneClass<T>,
  name: MemberName<T>,
): ColumnToken {
  return { kind: "column", entity: className(entity), column: name };
}

export const reference = field;

export function relation(from: ColumnToken, to: ColumnToken): RelationToken {
  return { from, to };
}

export function eventRef<T>(
  owner: VaneClass<T>,
  name: MemberName<T>,
): EventToken {
  return { owner: className(owner), event: name };
}

export function event<T>(
  owner: VaneClass<T>,
  name: MemberName<T>,
  options: SagaStepOptions = {},
): SagaStepToken {
  return {
    ...eventRef(owner, name),
    causedBy: options.causedBy ?? [],
    ...(options.compensateWith
      ? { compensateWith: options.compensateWith }
      : {}),
  };
}

export function optional(type: ColumnType): OptionalField {
  return { kind: "optional", type };
}
export function column(name: string): RuleValueDeclaration {
  return { kind: "column", column: name };
}
export function input(
  name: string,
): ViewValueDeclaration & ViewPaginationValueDeclaration {
  return { kind: "input", input: name };
}
type LiteralDeclaration = {
  readonly kind: "literal";
  readonly value: boolean | number | string | null;
};
export function literal(
  value: boolean | number | string | null,
): LiteralDeclaration {
  return { kind: "literal", value };
}

type Comparable = RuleValueDeclaration | ViewValueDeclaration;
type SharedComparison = {
  readonly kind: "comparison";
  readonly operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  readonly left: LiteralDeclaration;
  readonly right: LiteralDeclaration;
};
type SharedExpression =
  | SharedComparison
  | {
      readonly kind: "logical";
      readonly operator: "and" | "or";
      readonly operands: readonly SharedExpression[];
    }
  | { readonly kind: "not"; readonly operand: SharedExpression };
function comparison(
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
  left: Comparable,
  right: Comparable,
): RuleExpressionDeclaration | ViewExpressionDeclaration {
  return {
    kind: "comparison",
    operator,
    left,
    right,
  } as RuleExpressionDeclaration | ViewExpressionDeclaration;
}
interface ComparisonOverloads {
  (left: LiteralDeclaration, right: LiteralDeclaration): SharedComparison;
  (
    left: ViewValueDeclaration,
    right: ViewValueDeclaration,
  ): ViewExpressionDeclaration;
  (
    left: RuleValueDeclaration,
    right: RuleValueDeclaration,
  ): RuleExpressionDeclaration;
}
function makeComparison(
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
): ComparisonOverloads {
  return ((left: Comparable, right: Comparable) =>
    comparison(operator, left, right)) as ComparisonOverloads;
}
export const eq = makeComparison("eq");
export const neq = makeComparison("neq");
export const gt = makeComparison("gt");
export const gte = makeComparison("gte");
export const lt = makeComparison("lt");
export const lte = makeComparison("lte");

export function and(
  ...operands: readonly [
    SharedExpression,
    SharedExpression,
    ...SharedExpression[],
  ]
): SharedExpression;
export function and(
  ...operands: readonly [
    RuleExpressionDeclaration,
    RuleExpressionDeclaration,
    ...RuleExpressionDeclaration[],
  ]
): RuleExpressionDeclaration;
export function and(
  ...operands: readonly [
    ViewExpressionDeclaration,
    ViewExpressionDeclaration,
    ...ViewExpressionDeclaration[],
  ]
): ViewExpressionDeclaration;
export function and(
  ...operands: readonly (
    | RuleExpressionDeclaration
    | ViewExpressionDeclaration
  )[]
): RuleExpressionDeclaration | ViewExpressionDeclaration {
  return {
    kind: "logical",
    operator: "and",
    operands,
  } as RuleExpressionDeclaration | ViewExpressionDeclaration;
}
export function or(
  ...operands: readonly [
    SharedExpression,
    SharedExpression,
    ...SharedExpression[],
  ]
): SharedExpression;
export function or(
  ...operands: readonly [
    RuleExpressionDeclaration,
    RuleExpressionDeclaration,
    ...RuleExpressionDeclaration[],
  ]
): RuleExpressionDeclaration;
export function or(
  ...operands: readonly [
    ViewExpressionDeclaration,
    ViewExpressionDeclaration,
    ...ViewExpressionDeclaration[],
  ]
): ViewExpressionDeclaration;
export function or(
  ...operands: readonly (
    | RuleExpressionDeclaration
    | ViewExpressionDeclaration
  )[]
): RuleExpressionDeclaration | ViewExpressionDeclaration {
  return {
    kind: "logical",
    operator: "or",
    operands,
  } as RuleExpressionDeclaration | ViewExpressionDeclaration;
}
export function not(operand: SharedExpression): SharedExpression;
export function not(
  operand: RuleExpressionDeclaration,
): RuleExpressionDeclaration;
export function not(
  operand: ViewExpressionDeclaration,
): ViewExpressionDeclaration;
export function not(
  operand: RuleExpressionDeclaration | ViewExpressionDeclaration,
): RuleExpressionDeclaration | ViewExpressionDeclaration {
  return { kind: "not", operand } as
    | RuleExpressionDeclaration
    | ViewExpressionDeclaration;
}

function aggregate(
  functionName: AggregateToken["function"],
  value: ColumnToken,
): AggregateToken {
  return { kind: "aggregate", function: functionName, value };
}
export const count = (value: ColumnToken) => aggregate("count", value);
export const sum = (value: ColumnToken) => aggregate("sum", value);
export const avg = (value: ColumnToken) => aggregate("avg", value);
export const min = (value: ColumnToken) => aggregate("min", value);
export const max = (value: ColumnToken) => aggregate("max", value);
export const asc = (value: ColumnToken): ViewOrderDeclaration => ({
  value,
  direction: "asc",
});
export const desc = (value: ColumnToken): ViewOrderDeclaration => ({
  value,
  direction: "desc",
});
export const success = (
  data: Readonly<Record<string, TypedField>>,
): EventResultToken => ({ outcome: "success", data });
export const fail = (
  data: Readonly<Record<string, TypedField>>,
): EventResultToken => ({ outcome: "fail", data });
