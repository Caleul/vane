import { createHash } from "node:crypto";
import type { AclEventAdapter } from "./acl-runtime.js";
import { validateAclAdapter } from "./acl-runtime.js";
import type { JsonValue } from "./declaration.js";
import { validatePublicInput } from "./http-runtime.js";
import { hashSemanticModule } from "./module-fingerprint.js";
import { importedModuleHashes, moduleScope } from "./module-scope.js";
import { canonicalJson } from "./postgresql/envelope.js";
import type {
  SemanticEventInput,
  SemanticModule,
  SemanticSaga,
} from "./semantic-ir.js";

export type SagaInputBinding = Readonly<
  Record<
    string,
    | { readonly kind: "input"; readonly name: string }
    | { readonly kind: "literal"; readonly value: JsonValue }
  >
>;
export interface SagaPlanConfiguration {
  readonly steps?: Readonly<Record<string, SagaInputBinding>>;
  readonly compensations?: Readonly<Record<string, SagaInputBinding>>;
  readonly terminal?: SagaInputBinding;
}
export interface SagaPlanStep {
  readonly name: string;
  readonly event: string;
  readonly ownerKind: "entity" | "antiCorruptionLayer";
  readonly causedBy: readonly string[];
  readonly input: SagaInputBinding;
  readonly compensation: {
    readonly event: string;
    readonly ownerKind: "entity" | "antiCorruptionLayer";
    readonly input: SagaInputBinding;
  } | null;
}
export interface SagaPlan {
  readonly schema: "vane.saga-plan";
  readonly version: 1;
  readonly module: string;
  readonly semanticHash: string;
  readonly importedHashes?: Readonly<Record<string, string>>;
  readonly saga: string;
  readonly input: readonly SemanticEventInput[];
  readonly steps: readonly SagaPlanStep[];
  readonly terminal: {
    readonly view: string;
    readonly input: SagaInputBinding;
  };
  readonly adapters: readonly {
    readonly event: string;
    readonly version: string;
  }[];
  readonly hash: string;
}
export class SagaPlanError extends Error {
  readonly code = "VANE_SAGA_PLAN_INVALID";
}

export function materializeSagaPlan(
  module: SemanticModule,
  sagaName: string,
  configuration: SagaPlanConfiguration = {},
  adapters: readonly AclEventAdapter[] = [],
  modules: readonly SemanticModule[] = [module],
): SagaPlan {
  const saga = module.sagas.find((candidate) => candidate.name === sagaName);
  if (!saga) throw new SagaPlanError("Saga is not declared in the Module.");
  const scope = moduleScope(module, modules);
  const events = new Map(
    [
      ...scope.flatMap((m) => m.entities.flatMap((entity) => entity.events)),
      ...scope.flatMap((m) =>
        m.antiCorruptionLayers.flatMap((acl) => acl.events),
      ),
    ].map((event) => [event.identity, event]),
  );
  const adapterMap = new Map(
    adapters.map((adapter) => [adapter.eventIdentity, adapter]),
  );
  if (adapterMap.size !== adapters.length)
    throw new SagaPlanError("Duplicate ACL adapter.");
  const usedAdapters = new Map<string, string>();
  const bind = (identity: string, binding: SagaInputBinding | undefined) => {
    const event = events.get(identity);
    if (!event)
      throw new SagaPlanError(
        "Saga Event cannot be resolved in the materialized Module.",
      );
    if (event.owner.kind === "antiCorruptionLayer") {
      const adapter = adapterMap.get(identity);
      if (!adapter || !("results" in event))
        throw new SagaPlanError(
          "Saga ACL Event requires an idempotent adapter.",
        );
      validateAclAdapter(event, adapter);
      usedAdapters.set(identity, adapter.version);
    }
    return {
      event: identity,
      ownerKind: event.owner.kind,
      input: validateBinding(saga, event.input, binding),
    };
  };
  for (const name of Object.keys(configuration.steps ?? {}))
    if (!saga.steps.some((step) => step.name === name))
      throw new SagaPlanError("Unknown step input mapping.");
  for (const name of Object.keys(configuration.compensations ?? {}))
    if (!saga.steps.some((step) => step.name === name && step.compensateWith))
      throw new SagaPlanError("Unknown compensation input mapping.");
  const ordered: SagaPlanStep[] = [];
  const remaining = new Map(saga.steps.map((step) => [step.name, step]));
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((step) =>
        step.causedBy.every((parent) =>
          ordered.some((done) => done.name === parent),
        ),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!ready.length)
      throw new SagaPlanError(
        "Saga graph is cyclic or has unresolved dependencies.",
      );
    for (const step of ready) {
      ordered.push({
        name: step.name,
        ...bind(
          `${step.event.owner}.${step.event.event}`,
          configuration.steps?.[step.name],
        ),
        causedBy: [...step.causedBy].sort(),
        compensation: step.compensateWith
          ? bind(
              `${step.compensateWith.owner}.${step.compensateWith.event}`,
              configuration.compensations?.[step.name],
            )
          : null,
      });
      remaining.delete(step.name);
    }
  }
  const view = module.views.find(
    (view) => view.name === saga.terminal.success.view,
  );
  if (!view) throw new SagaPlanError("Saga terminal View is unavailable.");
  const content = {
    schema: "vane.saga-plan" as const,
    version: 1 as const,
    module: module.name,
    semanticHash: hashSemanticModule(module),
    ...(scope.length > 1
      ? {
          importedHashes: importedModuleHashes(module, modules),
        }
      : {}),
    saga: saga.name,
    input: saga.input,
    steps: ordered,
    terminal: {
      view: view.name,
      input: validateBinding(saga, view.input, configuration.terminal),
    },
    adapters: [...usedAdapters]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([event, version]) => ({ event, version })),
  };
  // Hash semantic operations and View definitions as well as the technical binding.
  const hash = hashValue(content);
  return JSON.parse(
    canonicalJson(
      JSON.parse(JSON.stringify({ ...content, hash })) as JsonValue,
    ),
  ) as SagaPlan;
}

function validateBinding(
  saga: SemanticSaga,
  fields: readonly SemanticEventInput[],
  explicit?: SagaInputBinding,
): SagaInputBinding {
  const binding: SagaInputBinding =
    explicit ??
    Object.fromEntries(
      fields
        .filter((field) =>
          saga.input.some((input) => input.name === field.name),
        )
        .map((field) => [field.name, { kind: "input", name: field.name }]),
    );
  for (const name of Object.keys(binding))
    if (!fields.some((field) => field.name === name))
      throw new SagaPlanError("Mapping targets an undeclared input.");
  for (const field of fields) {
    const source = binding[field.name];
    if (!source) {
      if (!field.optional)
        throw new SagaPlanError("A required input has no Saga binding.");
      continue;
    }
    if (source.kind === "input") {
      const input = saga.input.find((input) => input.name === source.name);
      if (
        !input ||
        input.type !== field.type ||
        (input.optional && !field.optional)
      )
        throw new SagaPlanError("Saga input mapping has an incompatible type.");
    } else if (
      source.kind !== "literal" ||
      !validatePublicInput({ value: source.value }, [
        { name: "value", type: field.type, optional: false, nullable: false },
      ]).success
    )
      throw new SagaPlanError("Saga literal mapping has an incompatible type.");
  }
  return binding;
}
export function bindSagaInput(
  binding: SagaInputBinding,
  input: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(
    Object.entries(binding).flatMap(([name, source]) => {
      const value = source.kind === "input" ? input[source.name] : source.value;
      return value === undefined ? [] : [[name, value]];
    }),
  );
}
export function serializeSagaPlan(plan: SagaPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function hashValue(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value as JsonValue))
    .digest("hex");
}
export function assertSagaPlan(plan: SagaPlan): void {
  const { hash, ...content } = plan;
  if (
    plan.schema !== "vane.saga-plan" ||
    plan.version !== 1 ||
    hashValue(content) !== hash ||
    plan.steps.length === 0
  )
    throw new SagaPlanError(
      "Saga plan version or content hash is invalid; rematerialize before execution.",
    );
}

/** A visible technical one-step plan makes standalone public admission durable. */
export function materializePublicEventPlan(
  module: SemanticModule,
  operation: import("./contract-ir.js").ContractEventOperation,
  modules: readonly SemanticModule[] = [module],
): SagaPlan {
  const importedHashes = importedModuleHashes(module, modules);
  const content: Omit<SagaPlan, "hash"> = {
    schema: "vane.saga-plan",
    version: 1,
    module: module.name,
    semanticHash: hashSemanticModule(module),
    ...(Object.keys(importedHashes).length ? { importedHashes } : {}),
    saga: `vane.event.${operation.identity}`,
    input: operation.input.map(({ name, type, optional }) => ({
      name,
      type,
      optional,
    })),
    steps: [
      {
        name: "execute",
        event: operation.identity,
        ownerKind: operation.ownerKind,
        causedBy: [],
        input: Object.fromEntries(
          operation.input.map((f) => [
            f.name,
            { kind: "input" as const, name: f.name },
          ]),
        ),
        compensation: null,
      },
    ],
    terminal: {
      view: operation.terminal.view,
      input: Object.fromEntries(
        Object.entries(operation.terminal.input).map(([name, value]) => [
          name,
          value.kind === "eventInput"
            ? { kind: "input" as const, name: value.input }
            : value,
        ]),
      ),
    },
    adapters: [],
  };
  return { ...content, hash: hashValue(content) };
}
