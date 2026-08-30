import type {
  ColumnReferenceDeclaration,
  ColumnType,
  RuleExpressionDeclaration,
} from "./declaration.js";

export const SEMANTIC_IR_VERSION = 1 as const;

export interface SemanticColumn {
  readonly name: string;
  readonly type: ColumnType;
  readonly identity: boolean;
  readonly nullable: boolean;
  readonly unique: boolean;
  readonly generated: "uuid" | "increment" | null;
  readonly references: ColumnReferenceDeclaration | null;
}

export interface SemanticRule {
  readonly name: string;
  readonly columns: readonly string[];
  readonly expression: RuleExpressionDeclaration;
}

export interface SemanticEventInput {
  readonly name: string;
  readonly type: ColumnType;
  readonly optional: boolean;
}

export interface SemanticEntityEvent {
  readonly identity: string;
  readonly name: string;
  readonly owner: {
    readonly kind: "entity";
    readonly entity: string;
  };
  readonly persistence: {
    readonly target: "owner";
    readonly required: true;
  };
  readonly input: readonly SemanticEventInput[];
}

export interface SemanticEntity {
  readonly name: string;
  readonly identityColumn: string;
  readonly columns: readonly SemanticColumn[];
  readonly rules: readonly SemanticRule[];
  readonly events: readonly SemanticEntityEvent[];
}

export interface SemanticIr {
  readonly schema: "vane.semantic-ir";
  readonly version: typeof SEMANTIC_IR_VERSION;
  readonly module: {
    readonly name: string;
    readonly entities: readonly SemanticEntity[];
  };
}

export function serializeSemanticIr(ir: SemanticIr): string {
  return `${JSON.stringify(ir, null, 2)}\n`;
}
