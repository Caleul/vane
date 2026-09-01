import type {
  ContractEventOperation,
  ContractField,
  ContractIr,
  ContractViewOperation,
} from "./contract-ir.js";
import type { ColumnType } from "./declaration.js";

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: { readonly schemas: Readonly<Record<string, unknown>> };
  readonly "x-vane-contract": {
    readonly schema: ContractIr["schema"];
    readonly version: ContractIr["version"];
    readonly inputHash: string;
  };
}

export function generateOpenApi(ir: ContractIr): OpenApiDocument {
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {
    VanePublicFail: objectSchema([
      field("code", "string"),
      field("message", "string"),
      field("correlationId", "string"),
    ]),
    VaneEventAccepted: objectSchema([field("sagaId", "uuid")]),
  };
  for (const [index, operation] of ir.operations.entries()) {
    if (operation.kind === "view") addView(operation, index, paths, schemas);
    else addEvent(operation, index, paths, schemas);
  }
  const streamPath = ir.operations.find(
    (operation): operation is ContractEventOperation =>
      operation.kind === "event",
  )?.terminal.streamPath;
  if (streamPath) {
    paths[streamPath] = {
      get: {
        operationId: "streamSagaTerminal",
        parameters: [
          {
            name: "sagaId",
            in: "path",
            required: true,
            schema: scalar("uuid"),
          },
        ],
        responses: {
          "200": {
            description:
              "Terminal-only Saga stream. Each connection emits one view or fail event and closes.",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: `${ir.module} public contract`,
      version: `contract-${ir.version}`,
    },
    paths,
    components: { schemas },
    "x-vane-contract": {
      schema: ir.schema,
      version: ir.version,
      inputHash: ir.inputHash,
    },
  };
}

export function serializeOpenApi(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function addView(
  operation: ContractViewOperation,
  index: number,
  paths: Record<string, unknown>,
  schemas: Record<string, unknown>,
): void {
  const inputName = `View_${operation.identity}_Input`;
  const outputName = `View_${operation.identity}_Output`;
  schemas[inputName] = objectSchema(operation.input);
  schemas[outputName] = {
    type: "array",
    items: objectSchema(operation.output),
  };
  paths[operation.path] = {
    post: {
      operationId: `query${operation.identity}_${index + 1}`,
      requestBody: jsonBody(ref(inputName)),
      responses: {
        "200": {
          description: `${operation.identity} View`,
          content: jsonContent(ref(outputName)),
        },
        "400": failResponse("Invalid View input"),
      },
      "x-vane-identity": operation.identity,
    },
  };
}

function addEvent(
  operation: ContractEventOperation,
  index: number,
  paths: Record<string, unknown>,
  schemas: Record<string, unknown>,
): void {
  const inputName = `Event_${operation.identity.replace(".", "_")}_Input`;
  schemas[inputName] = objectSchema(operation.input);
  paths[operation.path] = {
    post: {
      operationId: `dispatch${operation.identity.replace(".", "_")}_${index + 1}`,
      requestBody: jsonBody(ref(inputName)),
      responses: {
        "202": {
          description: "Event accepted",
          content: jsonContent(ref("VaneEventAccepted")),
        },
        "400": failResponse("Invalid Event input"),
      },
      "x-vane-identity": operation.identity,
      "x-vane-terminal-view": operation.terminal.view,
    },
  };
}

function field(name: string, type: ColumnType): ContractField {
  return { name, type, optional: false, nullable: false };
}

function objectSchema(fields: readonly ContractField[]): unknown {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      fields.map((item) => [item.name, schemaFor(item)]),
    ),
    required: fields.filter((item) => !item.optional).map((item) => item.name),
  };
}

function schemaFor(field: ContractField): unknown {
  const schema = scalar(field.type);
  return field.nullable ? { anyOf: [schema, { type: "null" }] } : schema;
}

function scalar(type: ColumnType): Record<string, unknown> {
  if (type === "integer")
    return {
      type: "integer",
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    };
  if (type === "decimal") return { type: "number" };
  if (type === "boolean") return { type: "boolean" };
  if (type === "json") return {};
  if (type === "uuid") return { type: "string", format: "uuid" };
  if (type === "date") return { type: "string", format: "date" };
  if (type === "datetime") return { type: "string", format: "date-time" };
  return { type: "string" };
}

const ref = (name: string): unknown => ({
  $ref: `#/components/schemas/${name}`,
});
const jsonContent = (schema: unknown): unknown => ({
  "application/json": { schema },
});
const jsonBody = (schema: unknown): unknown => ({
  required: true,
  content: jsonContent(schema),
});
const failResponse = (description: string): unknown => ({
  description,
  content: jsonContent(ref("VanePublicFail")),
});
