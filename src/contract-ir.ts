import { createHash } from "node:crypto";
import type { ColumnType, JsonValue } from "./declaration.js";
import type {
  SemanticEntityEvent,
  SemanticModule,
  SemanticView,
} from "./semantic-ir.js";

export const CONTRACT_IR_VERSION = 1 as const;

export interface PublicViewExposure {
  readonly view: string;
  readonly path?: string;
}

export interface TerminalViewInputMapping {
  readonly [viewInput: string]:
    | { readonly kind: "eventInput"; readonly input: string }
    | { readonly kind: "literal"; readonly value: JsonValue };
}

export interface PublicEventExposure {
  readonly event: string;
  readonly path?: string;
  readonly terminal: {
    readonly view: string;
    readonly input?: TerminalViewInputMapping;
  };
}

export interface ContractMaterializerConfiguration {
  readonly basePath?: string;
  readonly events?: readonly PublicEventExposure[];
  readonly views?: readonly PublicViewExposure[];
}

export interface ContractField {
  readonly name: string;
  readonly type: ColumnType;
  readonly optional: boolean;
  readonly nullable: boolean;
}

export interface ContractViewOperation {
  readonly kind: "view";
  readonly identity: string;
  readonly method: "POST";
  readonly path: string;
  readonly input: readonly ContractField[];
  readonly output: readonly ContractField[];
}

export interface ContractEventOperation {
  readonly kind: "event";
  readonly identity: string;
  readonly method: "POST";
  readonly path: string;
  readonly input: readonly ContractField[];
  readonly accepted: { readonly status: 202; readonly sagaId: true };
  readonly terminal: {
    readonly view: string;
    readonly input: TerminalViewInputMapping;
    readonly streamPath: string;
  };
}

export interface ContractIr {
  readonly schema: "vane.contract-ir";
  readonly version: typeof CONTRACT_IR_VERSION;
  readonly module: string;
  readonly inputHash: string;
  readonly operations: readonly (
    | ContractEventOperation
    | ContractViewOperation
  )[];
}

export interface ContractDiagnostic {
  readonly code: string;
  readonly path: readonly string[];
  readonly message: string;
  readonly correction: string;
}

export type ContractMaterializationResult =
  | { readonly success: true; readonly ir: ContractIr }
  | {
      readonly success: false;
      readonly diagnostics: readonly ContractDiagnostic[];
    };

export function materializeContract(
  module: SemanticModule,
  configuration: ContractMaterializerConfiguration,
): ContractMaterializationResult {
  const diagnostics: ContractDiagnostic[] = [];
  let basePath: string;
  try {
    basePath = normalizeBasePath(configuration.basePath ?? "");
  } catch (error) {
    return {
      success: false,
      diagnostics: [
        {
          code: "VANE_CONTRACT_BASE_PATH_INVALID",
          path: ["basePath"],
          message:
            error instanceof Error
              ? error.message
              : "The contract basePath is invalid.",
          correction: "Use an absolute base path without query or fragment.",
        },
      ],
    };
  }
  const eventsByIdentity = new Map<string, SemanticEntityEvent>();
  for (const entity of module.entities) {
    for (const event of entity.events)
      eventsByIdentity.set(event.identity, event);
  }
  const viewsByName = new Map(module.views.map((view) => [view.name, view]));
  const operations: (ContractEventOperation | ContractViewOperation)[] = [];
  const paths = new Map<string, string>();

  for (const exposure of configuration.views ?? []) {
    const view = viewsByName.get(exposure.view);
    const path = resolvePath(
      basePath,
      exposure.path ?? `/views/${exposure.view}`,
      ["views", exposure.view, "path"],
      diagnostics,
    );
    if (!view) {
      diagnostics.push(unknown("view", exposure.view));
      continue;
    }
    if (!path) continue;
    registerPath(path, `View ${view.name}`, paths, diagnostics);
    operations.push(toViewOperation(view, path));
  }

  for (const exposure of configuration.events ?? []) {
    const event = eventsByIdentity.get(exposure.event);
    const view = viewsByName.get(exposure.terminal.view);
    const path = resolvePath(
      basePath,
      exposure.path ?? `/events/${exposure.event}`,
      ["events", exposure.event, "path"],
      diagnostics,
    );
    if (!event) diagnostics.push(unknown("event", exposure.event));
    if (!view)
      diagnostics.push(unknown("terminal View", exposure.terminal.view));
    if (!event || !view || !path) continue;
    const mapping = exposure.terminal.input ?? {};
    validateTerminalMapping(event, view, mapping, diagnostics);
    registerPath(path, `Event ${event.identity}`, paths, diagnostics);
    operations.push({
      kind: "event",
      identity: event.identity,
      method: "POST",
      path,
      input: event.input.map((field) => ({ ...field, nullable: false })),
      accepted: { status: 202, sagaId: true },
      terminal: {
        view: view.name,
        input: canonicalObject(mapping),
        streamPath: joinPath(basePath, "/sagas/{sagaId}"),
      },
    });
  }

  if (diagnostics.length > 0) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }
  operations.sort((left, right) =>
    `${left.method} ${left.path}`.localeCompare(
      `${right.method} ${right.path}`,
    ),
  );
  const inputHash = sha256({
    module,
    configuration: canonicalConfiguration(configuration),
  });
  return {
    success: true,
    ir: {
      schema: "vane.contract-ir",
      version: CONTRACT_IR_VERSION,
      module: module.name,
      inputHash,
      operations,
    },
  };
}

export function serializeContractIr(ir: ContractIr): string {
  return `${JSON.stringify(ir, null, 2)}\n`;
}

function toViewOperation(
  view: SemanticView,
  path: string,
): ContractViewOperation {
  return {
    kind: "view",
    identity: view.name,
    method: "POST",
    path,
    input: view.input.map((field) => ({ ...field, nullable: false })),
    output: view.output.map((field) => ({
      name: field.name,
      type: field.type,
      optional: false,
      nullable: field.nullable,
    })),
  };
}

function validateTerminalMapping(
  event: SemanticEntityEvent,
  view: SemanticView,
  mapping: TerminalViewInputMapping,
  diagnostics: ContractDiagnostic[],
): void {
  const eventInputs = new Map(event.input.map((field) => [field.name, field]));
  const viewInputs = new Map(view.input.map((field) => [field.name, field]));
  for (const field of view.input) {
    if (!field.optional && !Object.hasOwn(mapping, field.name)) {
      diagnostics.push({
        code: "VANE_CONTRACT_TERMINAL_INPUT_REQUIRED",
        path: ["events", event.identity, "terminal", "input", field.name],
        message: `Terminal View ${view.name} requires input ${field.name}.`,
        correction:
          "Map the required View input from Event input or a literal.",
      });
    }
  }
  for (const [name, source] of Object.entries(mapping)) {
    const target = viewInputs.get(name);
    if (!target) {
      diagnostics.push({
        code: "VANE_CONTRACT_TERMINAL_INPUT_UNKNOWN",
        path: ["events", event.identity, "terminal", "input", name],
        message: `Terminal mapping targets undeclared View input ${name}.`,
        correction: `Use an input declared by View ${view.name}.`,
      });
      continue;
    }
    if (source.kind === "eventInput") {
      const origin = eventInputs.get(source.input);
      if (
        !origin ||
        origin.type !== target.type ||
        (origin.optional && !target.optional)
      ) {
        diagnostics.push({
          code: "VANE_CONTRACT_TERMINAL_INPUT_TYPE",
          path: ["events", event.identity, "terminal", "input", name],
          message: `Event input ${source.input} cannot supply ${target.type} View input ${name}.`,
          correction: "Map an Event input with the same semantic type.",
        });
      }
    } else if (!matchesType(source.value, target.type)) {
      diagnostics.push({
        code: "VANE_CONTRACT_TERMINAL_LITERAL_TYPE",
        path: ["events", event.identity, "terminal", "input", name],
        message: `Terminal literal cannot supply ${target.type} View input ${name}.`,
        correction: "Use a literal matching the View input semantic type.",
      });
    }
  }
}

function unknown(kind: string, identity: string): ContractDiagnostic {
  return {
    code: "VANE_CONTRACT_UNKNOWN_IDENTITY",
    path: [`${kind}s`, identity],
    message: `Public contract references unknown ${kind} ${identity}.`,
    correction: "Expose an identity present in the compiled Module.",
  };
}

function registerPath(
  path: string,
  owner: string,
  paths: Map<string, string>,
  diagnostics: ContractDiagnostic[],
): void {
  const previous = paths.get(path);
  if (previous) {
    diagnostics.push({
      code: "VANE_CONTRACT_PATH_COLLISION",
      path: ["paths", path],
      message: `${owner} and ${previous} resolve to the same public path ${path}.`,
      correction:
        "Assign distinct public paths without changing internal identities.",
    });
  } else paths.set(path, owner);
}

function normalizeBasePath(path: string): string {
  if (path === "" || path === "/") return "";
  const normalized = `/${path}`.replace(/\/{2,}/g, "/").replace(/\/$/u, "");
  if (normalized.includes("?") || normalized.includes("#")) {
    throw new Error("Contract basePath cannot contain a query or fragment.");
  }
  return normalized;
}

function joinPath(base: string, path: string): string {
  if (!path.startsWith("/"))
    throw new Error(`Public path ${path} must start with '/'.`);
  return `${base}${path}`.replace(/\/{2,}/g, "/");
}

function resolvePath(
  base: string,
  path: string,
  diagnosticPath: readonly string[],
  diagnostics: ContractDiagnostic[],
): string | null {
  try {
    const resolved = joinPath(base, path);
    if (
      resolved.includes("?") ||
      resolved.includes("#") ||
      resolved.includes("{")
    ) {
      throw new Error(
        "Public paths cannot contain query, fragment or template syntax.",
      );
    }
    if (new URL(resolved, "http://vane.local").pathname !== resolved) {
      throw new Error("Public paths cannot contain dot segments.");
    }
    return resolved;
  } catch (error) {
    diagnostics.push({
      code: "VANE_CONTRACT_PATH_INVALID",
      path: diagnosticPath,
      message:
        error instanceof Error ? error.message : "The public path is invalid.",
      correction:
        "Use an absolute HTTP path without query, fragment or templates.",
    });
    return null;
  }
}

function canonicalConfiguration(
  value: ContractMaterializerConfiguration,
): ContractMaterializerConfiguration {
  return {
    basePath: value.basePath ?? "",
    events: [...(value.events ?? [])].sort((a, b) =>
      `${a.event}:${a.path ?? ""}`.localeCompare(`${b.event}:${b.path ?? ""}`),
    ),
    views: [...(value.views ?? [])].sort((a, b) =>
      `${a.view}:${a.path ?? ""}`.localeCompare(`${b.view}:${b.path ?? ""}`),
    ),
  };
}

function canonicalObject<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonicalObject) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalObject(item)]),
    ) as T;
  }
  return value;
}

function matchesType(value: JsonValue, type: ColumnType): boolean {
  if (value === null) return false;
  if (type === "string") return typeof value === "string";
  if (type === "integer")
    return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "decimal")
    return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "uuid")
    return (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        value,
      )
    );
  if (type === "date") return typeof value === "string" && isIsoDate(value);
  if (type === "datetime")
    return (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      ) &&
      isIsoDate(value.slice(0, 10)) &&
      Number.isFinite(Date.parse(value))
    );
  return type === "json";
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] as number);
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalObject(value)))
    .digest("hex");
}

function sortDiagnostics(
  diagnostics: ContractDiagnostic[],
): readonly ContractDiagnostic[] {
  return diagnostics.sort((a, b) =>
    `${a.path.join(".")}:${a.code}`.localeCompare(
      `${b.path.join(".")}:${b.code}`,
    ),
  );
}
