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

/**
 * Parser-to-compiler boundary for the first executable slice.
 *
 * This is deliberately not presented as the final user-facing TypeScript DSL.
 */
export interface ModuleDeclaration {
  readonly name: string;
  readonly entities: readonly EntityDeclaration[];
}
