import type {
  AntiCorruptionLayerEventResultDeclaration,
  ColumnReferenceDeclaration,
  ColumnType,
  EventReferenceDeclaration,
  JsonValue,
  RuleExpressionDeclaration,
  ViewExpressionDeclaration,
  ViewOrderDeclaration,
  ViewOutputExpressionDeclaration,
  ViewPaginationDeclaration,
  ViewRelationDeclaration,
} from "./declaration.js";

export const SEMANTIC_IR_VERSION = 5 as const;
export const SEMANTIC_PROJECT_IR_VERSION = 1 as const;

export interface SemanticColumn {
  readonly name: string;
  readonly type: ColumnType;
  readonly identity: boolean;
  readonly nullable: boolean;
  readonly unique: boolean;
  readonly generated: "uuid" | "increment" | null;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly default: JsonValue;
  readonly hasDefault: boolean;
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
  readonly publicResult: {
    readonly success: "viewOnly";
    readonly fail: {
      readonly code: "stable";
      readonly message: "safe";
      readonly correlationId: true;
    };
  };
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
  readonly publicResult: SemanticEntityEvent["publicResult"];
}

export interface SemanticAntiCorruptionLayer {
  readonly name: string;
  readonly events: readonly SemanticAntiCorruptionLayerEvent[];
}

export interface SemanticSagaStep {
  readonly name: string;
  readonly event: EventReferenceDeclaration;
  readonly causedBy: readonly string[];
  readonly compensateWith: EventReferenceDeclaration | null;
}

export interface SemanticSaga {
  readonly name: string;
  readonly input: readonly SemanticEventInput[];
  readonly steps: readonly SemanticSagaStep[];
  readonly terminal: {
    readonly step: string;
    readonly success: { readonly kind: "view"; readonly view: string };
    readonly fail: { readonly kind: "fail" };
  };
  readonly guarantees: {
    readonly causalMetadata: readonly [
      "eventId",
      "sagaId",
      "causationId",
      "correlationId",
    ];
    readonly durableState: true;
    readonly intermediateResults: "internal";
    readonly streamVisibility: "terminalOnly";
  };
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
    readonly relations: readonly ViewRelationDeclaration[];
    readonly where: ViewExpressionDeclaration | null;
    readonly orderBy: readonly ViewOrderDeclaration[];
    readonly pagination: ViewPaginationDeclaration | null;
  };
  readonly persistence: { readonly allowed: false };
  readonly publicResult: { readonly kind: "view" };
}

export interface SemanticModule {
  readonly name: string;
  readonly imports: readonly string[];
  readonly entities: readonly SemanticEntity[];
  readonly views: readonly SemanticView[];
  readonly antiCorruptionLayers: readonly SemanticAntiCorruptionLayer[];
  readonly sagas: readonly SemanticSaga[];
}

export interface SemanticIr {
  readonly schema: "vane.semantic-ir";
  readonly version: typeof SEMANTIC_IR_VERSION;
  readonly module: SemanticModule;
}

export interface SemanticProjectIr {
  readonly schema: "vane.semantic-project-ir";
  readonly version: typeof SEMANTIC_PROJECT_IR_VERSION;
  readonly modules: readonly SemanticModule[];
}

export function serializeSemanticIr(ir: SemanticIr): string {
  return `${JSON.stringify(ir, null, 2)}\n`;
}

export function serializeSemanticProjectIr(ir: SemanticProjectIr): string {
  return `${JSON.stringify(ir, null, 2)}\n`;
}
