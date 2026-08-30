import type {
  AntiCorruptionLayerEventResultDeclaration,
  ColumnReferenceDeclaration,
  ColumnType,
  RuleExpressionDeclaration,
  ViewExpressionDeclaration,
  ViewOrderDeclaration,
  ViewOutputExpressionDeclaration,
  ViewPaginationDeclaration,
} from "./declaration.js";

export const SEMANTIC_IR_VERSION = 3 as const;

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

export interface SemanticAntiCorruptionLayerEventResult {
  readonly name: string;
  readonly outcome: AntiCorruptionLayerEventResultDeclaration["outcome"];
  readonly data: readonly SemanticEventInput[];
}

export interface SemanticAntiCorruptionLayerEvent {
  readonly identity: string;
  readonly name: string;
  readonly owner: {
    readonly kind: "antiCorruptionLayer";
    readonly antiCorruptionLayer: string;
  };
  readonly input: readonly SemanticEventInput[];
  readonly results: readonly SemanticAntiCorruptionLayerEventResult[];
}

export interface SemanticAntiCorruptionLayer {
  readonly name: string;
  readonly events: readonly SemanticAntiCorruptionLayerEvent[];
}

export interface SemanticViewInput {
  readonly name: string;
  readonly type: ColumnType;
  readonly optional: boolean;
}

export interface SemanticViewOutput {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
  readonly expression: ViewOutputExpressionDeclaration;
}

export interface SemanticView {
  readonly name: string;
  readonly input: readonly SemanticViewInput[];
  readonly output: readonly SemanticViewOutput[];
  readonly query: {
    readonly root: string;
    readonly where: ViewExpressionDeclaration | null;
    readonly orderBy: readonly ViewOrderDeclaration[];
    readonly pagination: ViewPaginationDeclaration | null;
  };
  readonly persistence: { readonly allowed: false };
  readonly publicResult: { readonly kind: "view" };
}

export interface SemanticIr {
  readonly schema: "vane.semantic-ir";
  readonly version: typeof SEMANTIC_IR_VERSION;
  readonly module: {
    readonly name: string;
    readonly entities: readonly SemanticEntity[];
    readonly views: readonly SemanticView[];
    readonly antiCorruptionLayers: readonly SemanticAntiCorruptionLayer[];
  };
}

export function serializeSemanticIr(ir: SemanticIr): string {
  return `${JSON.stringify(ir, null, 2)}\n`;
}
