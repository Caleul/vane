import { createHash } from "node:crypto";
import {
  type AclEventAdapter,
  httpAclAdapter,
  validateAclAdapter,
} from "./acl-runtime.js";
import { type ContractIr, materializeContract } from "./contract-ir.js";
import type { JsonValue } from "./declaration.js";
import type { Diagnostic } from "./diagnostic.js";
import { canonicalJson } from "./postgresql/envelope.js";
import { materializePostgreSql } from "./postgresql/materializer.js";
import { PostgreSqlPublicSagaAdmission } from "./postgresql/public-saga-admission.js";
import type { PostgreSqlSagaRuntime } from "./postgresql/saga-runtime.js";
import type { PostgreSqlStorageIr } from "./postgresql/storage-ir.js";
import { type SagaPlan, materializeSagaPlan } from "./saga-plan.js";
import {
  BUILTIN_PROVIDERS,
  type ExecutionPolicy,
  type PolicyOverride,
  type ProviderDefinition,
  type ProviderKind,
  type ProviderSelection,
  type SecretValue,
  type ServiceConfiguration,
  type ServiceProfile,
} from "./service-configuration.js";

export interface SecretBinding {
  readonly slot: string;
  readonly source: "env" | "secret" | "literal";
  readonly name?: string;
}
export interface ResolvedEventPolicy {
  readonly event: string;
  readonly service: string;
  readonly effective: ExecutionPolicy;
  readonly sources: Readonly<Record<keyof ExecutionPolicy, string>>;
}
export interface RuntimeIr {
  readonly schema: "vane.runtime-ir";
  readonly version: 1;
  readonly inputHash: string;
  readonly service: {
    readonly name: string;
    readonly modules: readonly string[];
    readonly runtime: string;
    readonly connectionSlot: string;
  };
  /** Resolved technical wiring with redacted secret slots; portable without the root profiles. */
  readonly configuration: JsonValue;
  readonly semanticProjectHash: string;
  readonly ownership: readonly {
    readonly entity: string;
    readonly service: string;
  }[];
  readonly providers: readonly ProviderDefinition[];
  readonly policies: readonly ResolvedEventPolicy[];
  readonly sagas: readonly SagaPlan[];
  readonly bindings: readonly SecretBinding[];
  readonly policyExecution: {
    readonly idempotency: "durable";
    readonly aclTimeout: "enforced";
    readonly durableRetryAndBackoff: "phase6";
    readonly entityTimeout: "phase6";
  };
}
export interface InfrastructureIr {
  readonly schema: "vane.infrastructure-ir";
  readonly version: 1;
  readonly inputHash: string;
  readonly topology: "monolith";
  readonly services: readonly {
    readonly name: string;
    readonly modules: readonly string[];
    readonly image: string;
    readonly runtime: "node24";
    readonly secretSlots: readonly string[];
  }[];
  readonly apply: "manual";
  readonly steps: readonly string[];
}
export interface ServicePlan {
  readonly schema: "vane.service-plan";
  readonly version: 1;
  readonly application: string;
  readonly profile: string;
  readonly inputHash: string;
  readonly effective: JsonValue;
  readonly runtime: RuntimeIr;
  readonly storage: PostgreSqlStorageIr;
  readonly contracts: readonly ContractIr[];
  readonly infrastructure: InfrastructureIr;
  readonly artifactHashes: Readonly<Record<string, string>>;
}
export type ServiceCompilationResult =
  | {
      readonly success: true;
      readonly plan: ServicePlan;
      readonly warnings: readonly Diagnostic[];
    }
  | { readonly success: false; readonly diagnostics: readonly Diagnostic[] };
export const BASE_EXECUTION_POLICY: ExecutionPolicy = {
  timeoutMs: 10000,
  retry: { attempts: 1, backoff: "fixed", delayMs: 0, maxDelayMs: 0 },
  idempotency: "required",
  deduplication: "durable",
};
const MAX_TIMER = 2147483647;
const REQUIRED: Record<ProviderKind, readonly string[]> = {
  runtime: ["node24", "monolith"],
  storage: [
    "postgresql16",
    "transactions",
    "columns",
    "rules",
    "references",
    "views",
  ],
  mailbox: ["durable", "sharedTransaction"],
  outbox: ["durable", "sharedTransaction"],
  deduplication: ["durable", "sharedTransaction"],
  saga: ["durable", "sharedTransaction"],
  failureQueue: ["durable", "sharedTransaction"],
  http: ["http", "views", "asyncAdmission"],
  sagaStream: ["terminalOnly", "reconnect"],
  acl: ["json", "eventId", "timeout"],
};
class ConfigurationIssue extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}
function issue(
  code: string,
  path: readonly string[],
  message: string,
  correction: string,
): never {
  throw new ConfigurationIssue({
    code: `VANE_SVC_${code}`,
    path,
    message,
    correction,
  });
}
export function technicalJson(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value)) as JsonValue);
}
export function technicalHash(value: unknown): string {
  return createHash("sha256").update(technicalJson(value)).digest("hex");
}
export function serializeServicePlan(plan: ServicePlan): string {
  return technicalJson(plan);
}

/** Resolves only technical configuration; never contacts providers or starts runtime. */
export function resolveServiceProfile(
  configuration: ServiceConfiguration,
  name: string,
): ServiceProfile {
  const visiting = new Set<string>();
  const resolve = (key: string): ServiceProfile => {
    if (!Object.hasOwn(configuration.profiles, key))
      issue(
        "PROFILE_MISSING",
        ["profiles"],
        "Selected or inherited profile does not exist.",
        "Declare the referenced profile.",
      );
    if (visiting.has(key))
      issue(
        "PROFILE_CYCLE",
        ["profiles"],
        "Profile inheritance is cyclic.",
        "Remove an inheritance edge.",
      );
    visiting.add(key);
    const child = configuration.profiles[key] as ServiceProfile;
    const parent = child.extends === undefined ? {} : resolve(child.extends);
    visiting.delete(key);
    const { extends: _extends, ...own } = child;
    const mergePolicies = (
      a: Readonly<Record<string, PolicyOverride>> = {},
      b: Readonly<Record<string, PolicyOverride>> = {},
    ) =>
      Object.fromEntries(
        [...new Set([...Object.keys(a), ...Object.keys(b)])]
          .sort()
          .map((k) => [k, { ...a[k], ...b[k] }]),
      );
    return {
      ...parent,
      ...own,
      policies: {
        defaults: { ...parent.policies?.defaults, ...own.policies?.defaults },
        services: mergePolicies(
          parent.policies?.services,
          own.policies?.services,
        ),
        events: mergePolicies(parent.policies?.events, own.policies?.events),
      },
      contracts: { ...parent.contracts, ...own.contracts },
      acls: { ...parent.acls, ...own.acls },
      sagas: { ...parent.sagas, ...own.sagas },
    };
  };
  return resolve(name);
}
export function compileServiceConfiguration<P extends string>(
  configuration: ServiceConfiguration<P>,
  profile: NoInfer<P>,
): ServiceCompilationResult {
  try {
    return compile(configuration, profile);
  } catch (error) {
    return {
      success: false,
      diagnostics: [
        error instanceof ConfigurationIssue
          ? error.diagnostic
          : {
              code: "VANE_SVC_INVALID",
              path: ["configuration"],
              message:
                "Configuration is malformed or incompatible with the selected materializer.",
              correction:
                "Use the typed ServiceConfiguration API and valid semantic input; do not include executable values.",
            },
      ],
    };
  }
}
export function validateServiceConfiguration(
  configuration: ServiceConfiguration,
): Readonly<Record<string, ServiceCompilationResult>> {
  return Object.fromEntries(
    Object.keys(configuration.profiles)
      .sort()
      .map((profile) => [
        profile,
        compileServiceConfiguration(configuration, profile),
      ]),
  );
}
function compile(
  configuration: ServiceConfiguration,
  profileName: string,
): ServiceCompilationResult {
  if (
    configuration.schema !== "vane.service-configuration" ||
    configuration.version !== 1 ||
    !/^[a-z][a-z0-9-]*$/.test(configuration.application)
  )
    issue(
      "ROOT",
      ["configuration"],
      "A versioned, named ServiceConfiguration root is required.",
      "Use one serviceConfiguration root with a lowercase application name.",
    );
  validateShapes(configuration);
  const profile = resolveServiceProfile(configuration, profileName);
  if (
    !profile.environment ||
    !["development", "test", "staging", "production"].includes(
      profile.environment,
    )
  )
    issue(
      "ENVIRONMENT",
      ["environment"],
      "Profile environment is required.",
      "Set development, test, staging or production explicitly.",
    );
  if (profile.topology?.kind !== "monolith")
    issue(
      "TOPOLOGY",
      ["topology"],
      "v0.1 requires an explicit monolithic service.",
      "Select monolith(service(...)); distributed execution is deferred.",
    );
  const service = profile.topology.service;
  if (!/^[a-z][a-z0-9-]*$/.test(service.name))
    issue(
      "SERVICE",
      ["topology", "service", "name"],
      "Service name is invalid.",
      "Use a lowercase identifier with optional hyphens.",
    );
  const modules = [...configuration.project.modules].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (
    !modules.length ||
    new Set(modules.map((m) => m.name)).size !== modules.length ||
    new Set(service.modules).size !== service.modules.length ||
    modules.length !== service.modules.length ||
    modules.some((m) => !service.modules.includes(m.name))
  )
    issue(
      "OWNERSHIP",
      ["topology", "service", "modules"],
      "Every Module and Entity must have exactly one explicit owner.",
      "Map every compiled Module exactly once to the monolithic service.",
    );
  if (!profile.communication || !profile.http)
    issue(
      "PROVIDERS_MISSING",
      ["profiles"],
      "Communication and HTTP providers must be explicit.",
      "Select mailbox, outbox, deduplication, Saga, failure queue, HTTP and Saga Stream providers.",
    );
  const registry = new Map<string, ProviderDefinition>();
  for (const provider of configuration.providers) {
    if (
      registry.has(provider.id) ||
      provider.interfaceVersion !== 1 ||
      !provider.version.trim() ||
      !Object.hasOwn(REQUIRED, provider.kind) ||
      !/^[a-zA-Z0-9._-]+$/.test(provider.id)
    )
      issue(
        "PROVIDER_REGISTRY",
        ["providers"],
        "Provider registry contains duplicate or incompatible definitions.",
        "Register each provider once with interfaceVersion 1 and a stable version.",
      );
    registry.set(provider.id, provider);
  }
  const selected = new Map<string, ProviderDefinition>();
  function negotiate<K extends ProviderKind>(
    selection: ProviderSelection<K>,
    kind: K,
    path: readonly string[],
  ) {
    const definition = registry.get(selection.provider);
    if (!definition || selection.kind !== kind || definition.kind !== kind)
      issue(
        "PROVIDER_SELECTION",
        path,
        "Provider is missing or has the wrong kind.",
        "Register and select a provider for this exact role.",
      );
    if (REQUIRED[kind].some((cap) => !definition.capabilities.includes(cap)))
      issue(
        "CAPABILITY",
        path,
        "Provider cannot guarantee the required capabilities.",
        `Select a provider declaring ${REQUIRED[kind].join(", ")}.`,
      );
    const builtin = BUILTIN_PROVIDERS.find((p) => p.id === definition.id);
    if (
      !builtin ||
      builtin.kind !== kind ||
      builtin.version !== definition.version
    )
      issue(
        "PROVIDER_IMPLEMENTATION",
        path,
        "No v0.1 materializer exists for this provider version.",
        "Use a supported built-in provider; declarations alone cannot install runtime implementations.",
      );
    selected.set(definition.id, definition);
  }
  negotiate(service.runtime, "runtime", ["runtime"]);
  negotiate(service.persistence.provider, "storage", ["persistence"]);
  for (const kind of [
    "mailbox",
    "outbox",
    "deduplication",
    "saga",
    "failureQueue",
  ] as const)
    negotiate(profile.communication[kind], kind, ["communication", kind]);
  negotiate(profile.http.provider, "http", ["http"]);
  negotiate(profile.http.sagaStream, "sagaStream", ["http", "sagaStream"]);
  const warnings: Diagnostic[] = [];
  const bindings: SecretBinding[] = [];
  function bind(value: SecretValue, slot: string): void {
    if (!value || !["env", "secret", "literal"].includes(value.kind))
      issue(
        "SECRET",
        [slot],
        "Secret slot requires a typed reference.",
        "Use env(), secret(), or localSecret() in local profiles.",
      );
    if (value.kind === "literal") {
      if (typeof value.value !== "string" || !value.value)
        issue(
          "SECRET",
          [slot],
          "A local secret value is empty.",
          "Provide a nonempty value or symbolic reference.",
        );
      if (
        profile.environment === "staging" ||
        profile.environment === "production"
      )
        issue(
          "SECRET_LITERAL",
          [slot],
          "This environment forbids literal secrets.",
          "Use an environment or secret reference.",
        );
      warnings.push({
        code: "VANE_SVC_LOCAL_SECRET",
        path: [slot],
        message: "Local literal secret is omitted from generated artifacts.",
        correction:
          "Use a symbolic reference for portable generated deployments.",
      });
      bindings.push({ slot, source: "literal" });
    } else {
      if (!/^[A-Za-z_][A-Za-z0-9_.\/-]*$/.test(value.name))
        issue(
          "SECRET_REFERENCE",
          [slot],
          "Secret reference name is invalid.",
          "Use a symbolic identifier, never a credential or URL.",
        );
      bindings.push({ slot, source: value.kind, name: value.name });
    }
  }
  bind(service.persistence.connection, "persistence.connection");
  const security = profile.http.security;
  if (
    !security ||
    !["allow", "deny"].includes(security.authorization) ||
    (security.authentication !== "none" &&
      !(
        typeof security.authentication === "object" &&
        security.authentication.bearer
      ))
  )
    issue(
      "HTTP_SECURITY",
      ["http", "security"],
      "HTTP security must be explicit.",
      "Configure authentication, authorization, CORS and rate limiting.",
    );
  if (security.authentication !== "none")
    bind(security.authentication.bearer, "http.authentication.bearer");
  if (
    !Array.isArray(security.cors) ||
    security.cors.some((origin) => {
      if (origin === "*") return false;
      try {
        return new URL(origin).origin !== origin;
      } catch {
        return true;
      }
    })
  )
    issue(
      "CORS",
      ["http", "security", "cors"],
      "CORS contains an invalid origin.",
      "List exact origins or an explicit wildcard.",
    );
  if (
    security.rateLimit !== null &&
    (!positive(security.rateLimit.requests) ||
      !positive(security.rateLimit.windowMs))
  )
    issue(
      "RATE_LIMIT",
      ["http", "security", "rateLimit"],
      "Rate limiting bounds are invalid.",
      "Use positive bounded integer requests and windowMs, or null.",
    );
  const knownEvents = new Set(
    modules.flatMap((m) =>
      [
        ...m.entities.flatMap((e) => e.events),
        ...m.antiCorruptionLayers.flatMap((a) => a.events),
      ].map((e) => `${m.name}.${e.identity}`),
    ),
  );
  for (const key of Object.keys(profile.policies?.events ?? {}))
    if (!knownEvents.has(key))
      issue(
        "POLICY_EVENT",
        ["policies", "events"],
        "Policy override refers to an unknown Event.",
        "Use Module.Owner.Event from the Semantic IR.",
      );
  for (const key of Object.keys(profile.policies?.services ?? {}))
    if (key !== service.name)
      issue(
        "POLICY_SERVICE",
        ["policies", "services"],
        "Policy override refers to an unknown service.",
        "Use the explicitly named service.",
      );
  const policies: ResolvedEventPolicy[] = [...knownEvents]
    .sort()
    .map((event) => {
      let effective = BASE_EXECUTION_POLICY;
      const sources: Record<keyof ExecutionPolicy, string> = {
        timeoutMs: "framework",
        retry: "framework",
        idempotency: "framework",
        deduplication: "framework",
      };
      for (const [source, override] of [
        ["defaults", profile.policies?.defaults],
        [
          `services.${service.name}`,
          profile.policies?.services?.[service.name],
        ],
        [`events.${event}`, profile.policies?.events?.[event]],
      ] as const) {
        if (!override) continue;
        validatePolicyOverride(override);
        effective = { ...effective, ...override };
        for (const key of Object.keys(override) as (keyof ExecutionPolicy)[])
          sources[key] = source;
      }
      return { event, service: service.name, effective, sources };
    });
  // Validate unused defaults as well (including applications without Events).
  validatePolicyOverride(profile.policies?.defaults ?? {});
  for (const p of Object.values(profile.policies?.services ?? {}))
    validatePolicyOverride(p);
  const knownAcls = new Set<string>();
  const knownSagas = new Set<string>();
  const sagaPlans: SagaPlan[] = [];
  const contracts: ContractIr[] = [];
  for (const module of modules) {
    const moduleAdapters: AclEventAdapter[] = [];
    for (const event of module.antiCorruptionLayers.flatMap((a) => a.events)) {
      const identity = `${module.name}.${event.identity}`;
      knownAcls.add(identity);
      const mapping = profile.acls?.[identity];
      if (!mapping)
        issue(
          "ACL_MISSING",
          ["acls", identity],
          "ACL Event has no technical mapping.",
          "Configure its provider, endpoint, authentication and response mapping.",
        );
      negotiate(mapping.provider, "acl", ["acls", identity, "provider"]);
      if (
        mapping.method !== undefined &&
        !["POST", "PUT", "PATCH", "DELETE"].includes(mapping.method)
      )
        issue(
          "ACL_MAPPING",
          ["acls", identity],
          "Unsupported HTTP method.",
          "Select POST, PUT, PATCH or DELETE.",
        );
      bind(mapping.endpoint, `acls.${identity}.endpoint`);
      for (const [header, value] of Object.entries(mapping.headers ?? {})) {
        if (
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) ||
          [
            "host",
            "content-length",
            "content-type",
            mapping.idempotencyHeader.toLowerCase(),
          ].includes(header.toLowerCase())
        )
          issue(
            "ACL_HEADER",
            ["acls", identity, "headers"],
            "ACL header is invalid or reserved.",
            "Use authentication headers without overriding transport or idempotency headers.",
          );
        bind(value, `acls.${identity}.headers.${header}`);
      }
      try {
        const adapter = httpAclAdapter({
          ...mapping,
          url:
            mapping.endpoint.kind === "literal"
              ? mapping.endpoint.value
              : "https://configuration.invalid",
          eventIdentity: event.identity,
          headers: () => ({}),
        });
        validateAclAdapter(event, adapter);
        moduleAdapters.push(adapter);
      } catch {
        issue(
          "ACL_MAPPING",
          ["acls", identity],
          "ACL mapping does not satisfy its semantic Event.",
          "Map every result and required field with valid HTTP statuses and Event identity idempotency.",
        );
      }
    }
    for (const saga of module.sagas) {
      const identity = `${module.name}.${saga.name}`;
      knownSagas.add(identity);
      try {
        sagaPlans.push(
          materializeSagaPlan(
            module,
            saga.name,
            profile.sagas?.[identity] ?? {},
            moduleAdapters,
          ),
        );
      } catch {
        issue(
          "SAGA_BINDING",
          ["sagas", identity],
          "Saga bindings are incompatible.",
          "Map declared inputs, compensations and terminal View fields consistently.",
        );
      }
    }
    const result = materializeContract(
      module,
      profile.contracts?.[module.name] ?? {},
    );
    if (!result.success)
      return { success: false, diagnostics: result.diagnostics };
    contracts.push(result.ir);
    for (const operation of result.ir.operations) {
      if (operation.kind !== "event") continue;
      if (operation.ownerKind === "antiCorruptionLayer" && !operation.saga)
        issue(
          "ACL_PUBLIC_SAGA",
          ["contracts", module.name],
          "Public ACL admission requires an explicit Saga.",
          "Associate the public ACL Event with a declared Saga.",
        );
      if (!operation.saga) continue;
      const plan = sagaPlans.find(
        (p) => p.module === module.name && p.saga === operation.saga,
      );
      if (!plan)
        issue(
          "PUBLIC_SAGA",
          ["contracts", module.name],
          "Public Event refers to an unknown Saga.",
          "Expose an installed Saga whose root and terminal bindings match.",
        );
      try {
        new PostgreSqlPublicSagaAdmission({} as PostgreSqlSagaRuntime, {
          [operation.identity]: plan,
        }).validateOperation(operation);
      } catch {
        issue(
          "PUBLIC_SAGA_BINDING",
          ["contracts", module.name],
          "Public contract and Saga bindings disagree.",
          "Align the root Event, Saga input and terminal View mappings.",
        );
      }
    }
  }
  for (const key of Object.keys(profile.acls ?? {}))
    if (!knownAcls.has(key))
      issue(
        "ACL_UNKNOWN",
        ["acls"],
        "Mapping refers to an unknown ACL Event.",
        "Use a qualified Module.ACL.Event identity.",
      );
  for (const key of Object.keys(profile.sagas ?? {}))
    if (!knownSagas.has(key))
      issue(
        "SAGA_UNKNOWN",
        ["sagas"],
        "Mapping refers to an unknown Saga.",
        "Use a qualified Module.Saga identity.",
      );
  for (const key of Object.keys(profile.contracts ?? {}))
    if (!modules.some((m) => m.name === key))
      issue(
        "CONTRACT_UNKNOWN",
        ["contracts"],
        "Exposure refers to an unknown Module.",
        "Configure only compiled Modules.",
      );
  const routes = new Map<string, string>();
  for (const contract of contracts)
    for (const operation of contract.operations) {
      for (const route of [
        `POST ${operation.path}`,
        ...(operation.kind === "event"
          ? [`GET ${operation.terminal.streamPath}`]
          : []),
      ]) {
        if (
          routes.has(route) &&
          !(route.startsWith("GET ") && routes.get(route) === contract.module)
        )
          issue(
            "ROUTE_COLLISION",
            ["contracts"],
            "Public routes collide across Modules.",
            "Assign distinct base paths to Modules.",
          );
        routes.set(route, contract.module);
      }
    }
  for (const p of selected.values())
    for (const requirement of p.requires ?? [])
      if (
        ![...selected.values()].some(
          (q) =>
            q.kind === requirement.kind &&
            q.capabilities.includes(requirement.capability),
        )
      )
        issue(
          "COMPATIBILITY",
          ["providers"],
          "A selected provider dependency is not satisfied.",
          "Select compatible providers for every required capability.",
        );
  const storage = materializePostgreSql(
    { ...configuration.project, modules },
    {
      namespace: service.persistence.namespace,
      targetVersion: service.persistence.targetVersion,
    },
  );
  if (!storage.success)
    return { success: false, diagnostics: storage.diagnostics };
  const effective = redactProfile(profile);
  // Array order is meaningful for mappings but not for service membership or provider capabilities.
  const normalized = JSON.parse(technicalJson(effective)) as Record<
    string,
    unknown
  >;
  const topology = normalized.topology as { service: { modules: string[] } };
  topology.service.modules.sort();
  const providers = [...selected.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({
      ...p,
      capabilities: [...new Set(p.capabilities)].sort(),
      ...(p.requires
        ? {
            requires: [...p.requires].sort((a, b) =>
              technicalJson(a).localeCompare(technicalJson(b)),
            ),
          }
        : {}),
    }));
  const inputHash = technicalHash({
    application: configuration.application,
    profile: profileName,
    project: { ...configuration.project, modules },
    effective: normalized,
    providers,
  });
  const runtime: RuntimeIr = {
    schema: "vane.runtime-ir",
    version: 1,
    inputHash,
    service: {
      name: service.name,
      modules: [...service.modules].sort(),
      runtime: service.runtime.provider,
      connectionSlot: "persistence.connection",
    },
    configuration: normalized as JsonValue,
    semanticProjectHash: technicalHash({ ...configuration.project, modules }),
    ownership: modules
      .flatMap((m) =>
        m.entities.map((e) => ({
          entity: `${m.name}.${e.name}`,
          service: service.name,
        })),
      )
      .sort((a, b) => a.entity.localeCompare(b.entity)),
    providers,
    policies,
    sagas: sagaPlans,
    bindings: bindings.sort((a, b) => a.slot.localeCompare(b.slot)),
    policyExecution: {
      idempotency: "durable",
      aclTimeout: "enforced",
      durableRetryAndBackoff: "phase6",
      entityTimeout: "phase6",
    },
  };
  const infrastructure: InfrastructureIr = {
    schema: "vane.infrastructure-ir",
    version: 1,
    inputHash,
    topology: "monolith",
    services: [
      {
        name: service.name,
        modules: runtime.service.modules,
        image: `${configuration.application}:${inputHash.slice(0, 12)}`,
        runtime: "node24",
        secretSlots: bindings.map((b) => b.slot),
      },
    ],
    apply: "manual",
    steps: [
      "build-image",
      "review-migration-diff",
      "apply-approved-migrations",
      "supply-secret-bindings",
      "start-monolith",
    ],
  };
  const plan: ServicePlan = {
    schema: "vane.service-plan",
    version: 1,
    application: configuration.application,
    profile: profileName,
    inputHash,
    effective: normalized as JsonValue,
    runtime,
    storage: storage.ir,
    contracts,
    infrastructure,
    artifactHashes: {
      runtime: technicalHash(runtime),
      storage: technicalHash(storage.ir),
      contracts: technicalHash(contracts),
      infrastructure: technicalHash(infrastructure),
    },
  };
  return { success: true, plan, warnings };
}
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER;
}
function validatePolicyOverride(policy: PolicyOverride): void {
  if (
    Object.keys(policy).some(
      (k) =>
        !["timeoutMs", "retry", "idempotency", "deduplication"].includes(k),
    ) ||
    (policy.timeoutMs !== undefined && !positive(policy.timeoutMs)) ||
    (policy.idempotency !== undefined && policy.idempotency !== "required") ||
    (policy.deduplication !== undefined && policy.deduplication !== "durable")
  )
    issue(
      "POLICY",
      ["policies"],
      "Execution policy weakens a required guarantee or has invalid bounds.",
      "Use positive bounded timeoutMs, required idempotency and durable deduplication.",
    );
  const r = policy.retry;
  if (
    r !== undefined &&
    (!positive(r.attempts) ||
      !["fixed", "exponential"].includes(r.backoff) ||
      !Number.isSafeInteger(r.delayMs) ||
      r.delayMs < 0 ||
      !Number.isSafeInteger(r.maxDelayMs) ||
      r.maxDelayMs < r.delayMs ||
      r.maxDelayMs > MAX_TIMER)
  )
    issue(
      "RETRY",
      ["policies", "retry"],
      "Retry and backoff configuration is invalid.",
      "Use positive attempts and bounded nonnegative delays with maxDelayMs >= delayMs.",
    );
}
function redact(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(object)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, redact(v)]),
    );
  }
  issue(
    "SERIALIZATION",
    ["configuration"],
    "Technical configuration must be serializable data.",
    "Use references and declarative mappings instead of executable callbacks.",
  );
}

function redactProfile(profile: ServiceProfile): JsonValue {
  const copy = structuredClone(profile);
  const safe = (value: SecretValue): SecretValue =>
    value.kind === "literal" ? { kind: "literal", value: "[REDACTED]" } : value;
  return redact({
    ...copy,
    topology: copy.topology
      ? {
          ...copy.topology,
          service: {
            ...copy.topology.service,
            persistence: {
              ...copy.topology.service.persistence,
              connection: safe(copy.topology.service.persistence.connection),
            },
          },
        }
      : undefined,
    http: copy.http
      ? {
          ...copy.http,
          security: {
            ...copy.http.security,
            authentication:
              copy.http.security.authentication === "none"
                ? "none"
                : { bearer: safe(copy.http.security.authentication.bearer) },
          },
        }
      : undefined,
    acls: Object.fromEntries(
      Object.entries(copy.acls ?? {}).map(([key, mapping]) => [
        key,
        {
          ...mapping,
          endpoint: safe(mapping.endpoint),
          headers: Object.fromEntries(
            Object.entries(mapping.headers ?? {}).map(([header, value]) => [
              header,
              safe(value),
            ]),
          ),
        },
      ]),
    ),
  });
}

function keys(
  value: unknown,
  allowed: readonly string[],
  path: readonly string[],
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    issue(
      "STRUCTURE",
      path,
      "Configuration contains an unsupported field or object shape.",
      "Use only fields from the typed ServiceConfiguration contract.",
    );
}
function validateShapes(configuration: ServiceConfiguration): void {
  keys(
    configuration,
    ["schema", "version", "application", "project", "providers", "profiles"],
    ["configuration"],
  );
  const selection = (v: unknown) =>
    keys(v, ["kind", "provider"], ["providers"]);
  const secretShape = (v: SecretValue) =>
    keys(v, v.kind === "literal" ? ["kind", "value"] : ["kind", "name"], [
      "secrets",
    ]);
  for (const provider of configuration.providers) {
    keys(
      provider,
      ["id", "kind", "interfaceVersion", "version", "capabilities", "requires"],
      ["providers"],
    );
    for (const r of provider.requires ?? [])
      keys(r, ["kind", "capability"], ["providers", "requires"]);
  }
  for (const p of Object.values(configuration.profiles)) {
    keys(
      p,
      [
        "extends",
        "environment",
        "topology",
        "communication",
        "http",
        "policies",
        "contracts",
        "acls",
        "sagas",
      ],
      ["profiles"],
    );
    if (p.topology) {
      keys(p.topology, ["kind", "service"], ["topology"]);
      const s = p.topology.service;
      keys(s, ["name", "modules", "runtime", "persistence"], ["service"]);
      selection(s.runtime);
      keys(
        s.persistence,
        ["provider", "namespace", "targetVersion", "connection"],
        ["persistence"],
      );
      selection(s.persistence.provider);
      secretShape(s.persistence.connection);
    }
    if (p.communication) {
      keys(
        p.communication,
        ["mailbox", "outbox", "deduplication", "saga", "failureQueue"],
        ["communication"],
      );
      for (const v of Object.values(p.communication)) selection(v);
    }
    if (p.http) {
      keys(p.http, ["provider", "sagaStream", "security"], ["http"]);
      selection(p.http.provider);
      selection(p.http.sagaStream);
      const s = p.http.security;
      keys(
        s,
        ["authentication", "authorization", "cors", "rateLimit"],
        ["http", "security"],
      );
      if (s.authentication !== "none") {
        keys(s.authentication, ["bearer"], ["authentication"]);
        secretShape(s.authentication.bearer);
      }
      if (s.rateLimit !== null)
        keys(s.rateLimit, ["requests", "windowMs"], ["rateLimit"]);
    }
    if (p.policies) {
      keys(p.policies, ["defaults", "services", "events"], ["policies"]);
      for (const policy of [
        p.policies.defaults ?? {},
        ...Object.values(p.policies.services ?? {}),
        ...Object.values(p.policies.events ?? {}),
      ]) {
        keys(
          policy,
          ["timeoutMs", "retry", "idempotency", "deduplication"],
          ["policies"],
        );
        if (policy.retry)
          keys(
            policy.retry,
            ["attempts", "backoff", "delayMs", "maxDelayMs"],
            ["retry"],
          );
      }
    }
    for (const acl of Object.values(p.acls ?? {})) {
      keys(
        acl,
        [
          "provider",
          "version",
          "endpoint",
          "method",
          "idempotencyHeader",
          "headers",
          "responses",
          "maxResponseBytes",
        ],
        ["acls"],
      );
      selection(acl.provider);
      secretShape(acl.endpoint);
      for (const v of Object.values(acl.headers ?? {})) secretShape(v);
      for (const r of acl.responses)
        keys(r, ["status", "result", "fields"], ["acls", "responses"]);
    }
    for (const c of Object.values(p.contracts ?? {})) {
      keys(c, ["basePath", "events", "views"], ["contracts"]);
      for (const v of c.views ?? [])
        keys(v, ["view", "path"], ["contracts", "views"]);
      for (const e of c.events ?? []) {
        keys(e, ["event", "saga", "path", "terminal"], ["contracts", "events"]);
        keys(e.terminal, ["view", "input"], ["contracts", "terminal"]);
        for (const v of Object.values(e.terminal.input ?? {}))
          keys(
            v,
            v.kind === "literal" ? ["kind", "value"] : ["kind", "input"],
            ["contracts", "input"],
          );
      }
    }
    for (const s of Object.values(p.sagas ?? {})) {
      keys(s, ["steps", "compensations", "terminal"], ["sagas"]);
      for (const b of [
        s.terminal ?? {},
        ...Object.values(s.steps ?? {}),
        ...Object.values(s.compensations ?? {}),
      ])
        for (const v of Object.values(b))
          keys(v, v.kind === "literal" ? ["kind", "value"] : ["kind", "name"], [
            "sagas",
            "input",
          ]);
    }
  }
}
