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

export interface ViewQueryDeclaration {
  readonly root: string;
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
  readonly entities: readonly EntityDeclaration[];
  readonly views?: readonly ViewDeclaration[];
}
