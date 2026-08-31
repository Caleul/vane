export const COLUMN_TYPES = [
  "string",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "uuid",
  "json",
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ColumnReferenceDeclaration {
  readonly entity: string;
  readonly column: string;
}

export interface ColumnDeclaration {
  readonly name: string;
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
  readonly references?: ColumnReferenceDeclaration;
}

export type RuleValueDeclaration =
  | { readonly kind: "column"; readonly column: string }
  | {
      readonly kind: "literal";
      readonly value: boolean | number | string | null;
    };

export type RuleExpressionDeclaration =
  | {
      readonly kind: "comparison";
      readonly operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
      readonly left: RuleValueDeclaration;
      readonly right: RuleValueDeclaration;
    }
  | {
      readonly kind: "logical";
      readonly operator: "and" | "or";
      readonly operands: readonly RuleExpressionDeclaration[];
    }
  | {
      readonly kind: "not";
      readonly operand: RuleExpressionDeclaration;
    };

export interface RuleDeclaration {
  readonly name: string;
  readonly expression: RuleExpressionDeclaration;
}

export interface EventInputDeclaration {
  readonly name: string;
  readonly type: ColumnType;
  readonly optional?: boolean;
}

export interface EntityEventDeclaration {
  readonly name: string;
  readonly input?: readonly EventInputDeclaration[];
}

export interface AntiCorruptionLayerEventResultDeclaration {
  readonly name: string;
  readonly outcome: "success" | "fail";
  readonly data: readonly EventInputDeclaration[];
}

export interface AntiCorruptionLayerEventDeclaration {
  readonly name: string;
  readonly input?: readonly EventInputDeclaration[];
  readonly results: readonly AntiCorruptionLayerEventResultDeclaration[];
}

export interface AntiCorruptionLayerDeclaration {
  readonly name: string;
  readonly events: readonly AntiCorruptionLayerEventDeclaration[];
}

export interface EventReferenceDeclaration {
  readonly owner: string;
  readonly event: string;
}

export interface SagaStepDeclaration {
  readonly name: string;
  readonly event: EventReferenceDeclaration;
  readonly causedBy: readonly string[];
  readonly compensateWith?: EventReferenceDeclaration;
}

export interface SagaTerminalDeclaration {
  readonly step: string;
  readonly view: string;
}

export interface SagaDeclaration {
  readonly name: string;
  readonly input: readonly EventInputDeclaration[];
  readonly steps: readonly SagaStepDeclaration[];
  readonly terminal: SagaTerminalDeclaration;
}

export interface EntityDeclaration {
  readonly name: string;
  readonly columns: readonly ColumnDeclaration[];
  readonly rules?: readonly RuleDeclaration[];
  readonly events?: readonly EntityEventDeclaration[];
}

export interface EntityColumnReferenceDeclaration {
  readonly entity: string;
  readonly column: string;
}

export type ViewValueDeclaration =
  | ({ readonly kind: "column" } & EntityColumnReferenceDeclaration)
  | { readonly kind: "input"; readonly input: string }
  | {
      readonly kind: "literal";
      readonly value: boolean | number | string | null;
    };

export type ViewExpressionDeclaration =
  | {
      readonly kind: "comparison";
      readonly operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
      readonly left: ViewValueDeclaration;
      readonly right: ViewValueDeclaration;
    }
  | {
      readonly kind: "logical";
      readonly operator: "and" | "or";
      readonly operands: readonly ViewExpressionDeclaration[];
    }
  | {
      readonly kind: "not";
      readonly operand: ViewExpressionDeclaration;
    };

export type ViewOutputExpressionDeclaration =
  | ({ readonly kind: "column" } & EntityColumnReferenceDeclaration)
  | {
      readonly kind: "aggregate";
      readonly function: "count" | "sum" | "avg" | "min" | "max";
      readonly value: EntityColumnReferenceDeclaration;
    };

export interface ViewOutputDeclaration {
  readonly name: string;
  readonly expression: ViewOutputExpressionDeclaration;
}

export interface ViewOrderDeclaration {
  readonly value: EntityColumnReferenceDeclaration;
  readonly direction: "asc" | "desc";
}

export type ViewPaginationValueDeclaration =
  | { readonly kind: "literal"; readonly value: number }
  | { readonly kind: "input"; readonly input: string };

export interface ViewPaginationDeclaration {
  readonly limit?: ViewPaginationValueDeclaration;
  readonly offset?: ViewPaginationValueDeclaration;
}

export interface ViewRelationDeclaration {
  readonly name: string;
  readonly from: EntityColumnReferenceDeclaration;
  readonly to: EntityColumnReferenceDeclaration;
}

export interface ViewQueryDeclaration {
  readonly root: string;
  readonly relations?: readonly ViewRelationDeclaration[];
  readonly where?: ViewExpressionDeclaration;
  readonly orderBy?: readonly ViewOrderDeclaration[];
  readonly pagination?: ViewPaginationDeclaration;
}

export interface ViewDeclaration {
  readonly name: string;
  readonly input: readonly EventInputDeclaration[];
  readonly output: readonly ViewOutputDeclaration[];
  readonly query: ViewQueryDeclaration;
}

/**
 * Parser-to-compiler boundary for the first executable slice.
 *
 * This is deliberately not presented as the final user-facing TypeScript DSL.
 */
export interface ModuleDeclaration {
  readonly name: string;
  readonly imports?: readonly string[];
  readonly entities: readonly EntityDeclaration[];
  readonly views?: readonly ViewDeclaration[];
  readonly antiCorruptionLayers?: readonly AntiCorruptionLayerDeclaration[];
  readonly sagas?: readonly SagaDeclaration[];
}
