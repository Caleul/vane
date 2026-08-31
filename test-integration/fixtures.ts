import type {
  EntityEventOperationDeclaration,
  JsonValue,
} from "../src/declaration.js";
import type {
  SemanticColumn,
  SemanticEntityEvent,
  SemanticEventInput,
  SemanticProjectIr,
} from "../src/semantic-ir.js";
import { SEMANTIC_PROJECT_IR_VERSION } from "../src/semantic-ir.js";

interface ColumnOptions {
  readonly default?: JsonValue;
  readonly generated?: SemanticColumn["generated"];
  readonly identity?: boolean;
  readonly maximum?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly minLength?: number;
  readonly nullable?: boolean;
  readonly unique?: boolean;
}

function column(
  name: string,
  type: SemanticColumn["type"],
  options: ColumnOptions = {},
): SemanticColumn {
  return {
    name,
    type,
    identity: options.identity ?? false,
    nullable: options.nullable ?? false,
    unique: options.unique ?? false,
    generated: options.generated ?? null,
    minLength: options.minLength ?? null,
    maxLength: options.maxLength ?? null,
    minimum: options.minimum ?? null,
    maximum: options.maximum ?? null,
    default: options.default ?? null,
    hasDefault: Object.hasOwn(options, "default"),
    references: null,
  };
}

function event(
  name: string,
  input: readonly SemanticEventInput[],
  operation: EntityEventOperationDeclaration,
): SemanticEntityEvent {
  return {
    identity: `StockItem.${name}`,
    name,
    owner: { kind: "entity", entity: "StockItem" },
    persistence: { target: "owner", required: true },
    input,
    operation,
    publicResult: {
      success: "viewOnly",
      fail: { code: "stable", message: "safe", correlationId: true },
    },
  };
}

function requiredInput(
  name: string,
  type: SemanticEventInput["type"],
): SemanticEventInput {
  return { name, type, optional: false };
}

export function phaseTwoProject(): SemanticProjectIr {
  return {
    schema: "vane.semantic-project-ir",
    version: SEMANTIC_PROJECT_IR_VERSION,
    modules: [
      {
        name: "Inventory",
        imports: [],
        entities: [
          {
            name: "StockItem",
            identityColumn: "id",
            columns: [
              column("active", "boolean", { default: true }),
              column("attributes", "json", {
                default: { fragile: false, labels: ["new"] },
              }),
              column("available", "integer", { minimum: 0 }),
              column("createdAt", "datetime"),
              column("expiresOn", "date", { nullable: true }),
              column("id", "uuid", {
                generated: "uuid",
                identity: true,
              }),
              column("name", "string", {
                maxLength: 80,
                minLength: 1,
                unique: true,
              }),
              column("price", "decimal", { minimum: 0 }),
              column("reserved", "integer", { minimum: 0 }),
            ],
            rules: [
              {
                name: "AvailableCoversReserved",
                columns: ["available", "reserved"],
                expression: {
                  kind: "comparison",
                  operator: "gte",
                  left: { kind: "column", column: "available" },
                  right: { kind: "column", column: "reserved" },
                },
              },
              {
                name: "NameIsNotBlocked",
                columns: ["name"],
                expression: {
                  kind: "comparison",
                  operator: "neq",
                  left: { kind: "column", column: "name" },
                  right: { kind: "literal", value: "blocked" },
                },
              },
            ],
            events: [
              event(
                "Create",
                [
                  requiredInput("available", "integer"),
                  requiredInput("createdAt", "datetime"),
                  requiredInput("name", "string"),
                  requiredInput("price", "decimal"),
                  requiredInput("reserved", "integer"),
                ],
                {
                  kind: "create",
                  values: [
                    {
                      column: "available",
                      value: { kind: "input", input: "available" },
                    },
                    {
                      column: "createdAt",
                      value: { kind: "input", input: "createdAt" },
                    },
                    {
                      column: "name",
                      value: { kind: "input", input: "name" },
                    },
                    {
                      column: "price",
                      value: { kind: "input", input: "price" },
                    },
                    {
                      column: "reserved",
                      value: { kind: "input", input: "reserved" },
                    },
                  ],
                },
              ),
              event(
                "Rename",
                [requiredInput("id", "uuid"), requiredInput("name", "string")],
                {
                  kind: "update",
                  identity: { kind: "input", input: "id" },
                  values: [
                    {
                      column: "name",
                      value: { kind: "input", input: "name" },
                    },
                  ],
                },
              ),
              event(
                "Reserve",
                [
                  requiredInput("amount", "integer"),
                  requiredInput("id", "uuid"),
                ],
                {
                  kind: "update",
                  identity: { kind: "input", input: "id" },
                  values: [
                    {
                      column: "reserved",
                      value: {
                        kind: "arithmetic",
                        operator: "add",
                        left: { kind: "column", column: "reserved" },
                        right: { kind: "input", input: "amount" },
                      },
                    },
                  ],
                },
              ),
            ],
          },
        ],
        views: [],
        antiCorruptionLayers: [],
        sagas: [],
      },
    ],
  };
}
