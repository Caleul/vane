import type { HttpAclAdapterOptions } from "./acl-runtime.js";
import type { ContractMaterializerConfiguration } from "./contract-ir.js";
import type { SagaPlanConfiguration } from "./saga-plan.js";
import type { SemanticProjectIr } from "./semantic-ir.js";

export type ProviderKind =
  | "runtime"
  | "storage"
  | "mailbox"
  | "outbox"
  | "deduplication"
  | "saga"
  | "failureQueue"
  | "http"
  | "sagaStream"
  | "acl";
export interface ProviderDefinition<K extends ProviderKind = ProviderKind> {
  readonly id: string;
  readonly kind: K;
  readonly interfaceVersion: 1;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly requires?: readonly {
    readonly kind: ProviderKind;
    readonly capability: string;
  }[];
}
export interface ProviderSelection<K extends ProviderKind> {
  readonly kind: K;
  readonly provider: string;
}
export function selectProvider<K extends ProviderKind>(
  kind: K,
  provider: string,
): ProviderSelection<K> {
  return { kind, provider };
}
export const node = (): ProviderSelection<"runtime"> =>
  selectProvider("runtime", "vane.node");
export const postgres = (): ProviderSelection<"storage"> =>
  selectProvider("storage", "vane.postgresql");
export const postgresMailbox = (): ProviderSelection<"mailbox"> =>
  selectProvider("mailbox", "vane.postgresql.mailbox");
export const postgresOutbox = (): ProviderSelection<"outbox"> =>
  selectProvider("outbox", "vane.postgresql.outbox");
export const postgresDeduplication = (): ProviderSelection<"deduplication"> =>
  selectProvider("deduplication", "vane.postgresql.deduplication");
export const postgresSaga = (): ProviderSelection<"saga"> =>
  selectProvider("saga", "vane.postgresql.saga");
export const postgresFailureQueue = (): ProviderSelection<"failureQueue"> =>
  selectProvider("failureQueue", "vane.postgresql.failureQueue");
export const http = (): ProviderSelection<"http"> =>
  selectProvider("http", "vane.http");
export const sse = (): ProviderSelection<"sagaStream"> =>
  selectProvider("sagaStream", "vane.sse");
export const httpAcl = (): ProviderSelection<"acl"> =>
  selectProvider("acl", "vane.http.acl");
export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "vane.node",
    kind: "runtime",
    interfaceVersion: 1,
    version: "1",
    capabilities: ["node24", "monolith"],
  },
  {
    id: "vane.postgresql",
    kind: "storage",
    interfaceVersion: 1,
    version: "1",
    capabilities: [
      "postgresql16",
      "transactions",
      "columns",
      "rules",
      "references",
      "views",
    ],
  },
  ...(
    ["mailbox", "outbox", "deduplication", "saga", "failureQueue"] as const
  ).map((kind) => ({
    id: `vane.postgresql.${kind}`,
    kind,
    interfaceVersion: 1 as const,
    version: "1",
    capabilities: ["durable", "sharedTransaction"],
    requires: [{ kind: "storage" as const, capability: "transactions" }],
  })),
  {
    id: "vane.http",
    kind: "http",
    interfaceVersion: 1,
    version: "1",
    capabilities: ["http", "views", "asyncAdmission"],
  },
  {
    id: "vane.sse",
    kind: "sagaStream",
    interfaceVersion: 1,
    version: "1",
    capabilities: ["terminalOnly", "reconnect"],
    requires: [{ kind: "http", capability: "http" }],
  },
  {
    id: "vane.http.acl",
    kind: "acl",
    interfaceVersion: 1,
    version: "1",
    capabilities: ["json", "eventId", "timeout"],
  },
];

export type SecretValue =
  | { readonly kind: "env" | "secret"; readonly name: string }
  | { readonly kind: "literal"; readonly value: string };
export const env = (name: string): SecretValue => ({ kind: "env", name });
export const secret = (name: string): SecretValue => ({ kind: "secret", name });
export const localSecret = (value: string): SecretValue => ({
  kind: "literal",
  value,
});
export interface ExecutionPolicy {
  readonly timeoutMs: number;
  readonly retry: {
    readonly attempts: number;
    readonly backoff: "fixed" | "exponential";
    readonly delayMs: number;
    readonly maxDelayMs: number;
  };
  readonly idempotency: "required";
  readonly deduplication: "durable";
}
export type PolicyOverride = Partial<ExecutionPolicy>;
export interface PolicyConfiguration {
  readonly defaults?: PolicyOverride;
  readonly services?: Readonly<Record<string, PolicyOverride>>;
  /** Module.Owner.Event, so equally named Events in different Modules remain distinct. */
  readonly events?: Readonly<Record<string, PolicyOverride>>;
}
export interface ServiceDefinition {
  readonly name: string;
  readonly modules: readonly string[];
  readonly runtime: ProviderSelection<"runtime">;
  readonly persistence: {
    readonly provider: ProviderSelection<"storage">;
    readonly namespace: string;
    readonly targetVersion: number;
    readonly connection: SecretValue;
  };
}
export const service = (definition: ServiceDefinition): ServiceDefinition =>
  definition;
export const monolith = (definition: ServiceDefinition) => ({
  kind: "monolith" as const,
  service: definition,
});
export interface AclConfiguration {
  readonly provider: ProviderSelection<"acl">;
  readonly version: string;
  readonly endpoint: SecretValue;
  readonly method?: NonNullable<HttpAclAdapterOptions["method"]>;
  readonly idempotencyHeader: string;
  readonly headers?: Readonly<Record<string, SecretValue>>;
  readonly responses: HttpAclAdapterOptions["responses"];
  readonly maxResponseBytes?: number;
}
export interface HttpSecurityConfiguration {
  readonly authentication: "none" | { readonly bearer: SecretValue };
  readonly authorization: "allow" | "deny";
  readonly cors: readonly string[];
  readonly rateLimit: {
    readonly requests: number;
    readonly windowMs: number;
  } | null;
}
export interface ServiceProfile {
  readonly extends?: string;
  readonly environment?: "development" | "test" | "staging" | "production";
  readonly topology?: ReturnType<typeof monolith>;
  readonly communication?: {
    readonly mailbox: ProviderSelection<"mailbox">;
    readonly outbox: ProviderSelection<"outbox">;
    readonly deduplication: ProviderSelection<"deduplication">;
    readonly saga: ProviderSelection<"saga">;
    readonly failureQueue: ProviderSelection<"failureQueue">;
  };
  readonly http?: {
    readonly provider: ProviderSelection<"http">;
    readonly sagaStream: ProviderSelection<"sagaStream">;
    readonly security: HttpSecurityConfiguration;
  };
  readonly policies?: PolicyConfiguration;
  readonly contracts?: Readonly<
    Record<string, ContractMaterializerConfiguration>
  >;
  readonly acls?: Readonly<Record<string, AclConfiguration>>;
  readonly sagas?: Readonly<Record<string, SagaPlanConfiguration>>;
}
export interface ServiceConfiguration<P extends string = string> {
  readonly schema: "vane.service-configuration";
  readonly version: 1;
  readonly application: string;
  readonly project: SemanticProjectIr;
  readonly providers: readonly ProviderDefinition[];
  readonly profiles: Readonly<Record<P, ServiceProfile>>;
}
export function serviceConfiguration<const P extends string>(
  configuration: Omit<ServiceConfiguration<P>, "schema" | "version">,
): ServiceConfiguration<P> {
  return { schema: "vane.service-configuration", version: 1, ...configuration };
}
