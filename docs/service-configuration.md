# ServiceConfiguration

Phase 5 is the second compilation stage. A single `serviceConfiguration()` root
binds an already compiled Semantic Project, an explicit provider registry and
named profiles. It does not execute configuration hidden in Modules.

```ts
import {
  serviceConfiguration, monolith, node, postgres, env, BUILTIN_PROVIDERS,
  postgresMailbox, postgresOutbox, postgresDeduplication, postgresSaga,
  postgresFailureQueue, http, sse, compileServiceConfiguration,
} from "@lilka/vane";

const configuration = serviceConfiguration({
  application: "orders",
  project, // successful compileProjectSources(...).ir, or SemanticProjectIr
  providers: BUILTIN_PROVIDERS, // registration is explicit, never implicit
  profiles: {
    development: {
      environment: "development",
      topology: monolith({
        name: "api",
        modules: ["Sales", "Billing"],
        runtime: node(),
        persistence: {
          provider: postgres(), namespace: "orders", targetVersion: 16,
          connection: env("DATABASE_URL"),
        },
      }),
      communication: {
        mailbox: postgresMailbox(), outbox: postgresOutbox(),
        deduplication: postgresDeduplication(), saga: postgresSaga(),
        failureQueue: postgresFailureQueue(),
      },
      http: {
        provider: http(), sagaStream: sse(),
        security: {
          authentication: "none", authorization: "allow",
          cors: ["http://localhost:3000"], rateLimit: null,
        },
      },
      contracts: { Sales: { views: [{ view: "OrderDetails" }] } },
      // Every declared ACL Event also needs the mapping described below.
    },
    test: { extends: "development", environment: "test" },
    production: { extends: "development", environment: "production" },
  },
});
const result = compileServiceConfiguration(configuration, "test");
if (!result.success) throw new Error(result.diagnostics.map(d => d.code).join(","));
console.log(result.plan); // safe: values from secret slots are omitted
```

The example illustrates structure; Module names and exposures must match your
actual Semantic Project. The complete executable fixture is
`test/phase-five-fixture.ts`.

## Profile inheritance and ownership

Each profile inherits at most one parent. Missing parents and cycles fail.
`environment` is explicit and inherited; a profile name alone never implies a
security environment. Production and staging reject literal secret slots even
when inherited from development.

Top-level topology, HTTP and communication objects replace as whole units.
Contracts, ACLs and Saga maps merge by qualified key; a child replaces the whole
entry. Policy maps merge by key and policy fields merge individually; `retry`
is an atomic policy field. Arrays replace. These rules avoid silently combining
credentials or half of a provider selection. Effective configuration is included
in the plan. To remove inherited public exposures, replace the Module's contract
with `{}`. Every ACL Event still requires a mapping.

Every compiled Module must appear exactly once in the named monolithic service.
Each Entity inherits that owner and the single service persistence selection.
Multiple Modules are supported; unknown, missing and duplicate membership fail.
Qualified technical keys use `Module.Owner.Event` and `Module.Saga`. Runtime and
public contracts preserve each Module's internal `Owner.Event` identity.

Distributed execution and multiple public services are not supported in v0.1.
The IR records service/module/Entity mapping explicitly for future distribution;
the framework neither discovers boundaries nor creates services.

## Providers and capabilities

Providers declare an ID, kind, version, interface version, capabilities and
optional dependencies on other provider capabilities. Required guarantees are
checked before materialization. Missing registrations, wrong kinds, insufficient
capabilities, unmet dependencies and unsupported versions are actionable errors.

v0.1 supplies Node 24, PostgreSQL 16+, PostgreSQL technical stores, HTTP, SSE and
HTTP JSON ACLs. The compiler does not accept a made-up implementation merely
because its descriptor claims capabilities. `selectProvider(kind, id)` exposes
typed selection; implementation extension requires an actual materializer in a
future provider interface revision. PostgreSQL remains responsible for Columns,
Rules, relations and transactional persistence.

## Policies

Precedence is **framework baseline < defaults < service override < qualified
Event override**. The plan lists each Event's effective policy and the source of
every field. Framework baseline is 10,000 ms timeout, one attempt, fixed zero
delay, required Event identity idempotency and durable deduplication.

```ts
policies: {
  defaults: { timeoutMs: 10_000 },
  services: { api: { timeoutMs: 10_000 } },
  events: {
    "Sales.PaymentGateway.Authorize": { timeoutMs: 30_000 },
  },
}
```

Retry accepts `{ attempts, backoff: "fixed" | "exponential", delayMs,
maxDelayMs }`. Numeric bounds, unknown overrides and weakened idempotency or
deduplication fail statically. Configuration and inspection of these policies
belong to phase 5. Durable retry/backoff scheduling, Entity execution timeout,
failure-queue operation and expanded recovery belong to phase 6. The Runtime IR
states this boundary. The bootstrap **rejects** more than one attempt or an
Entity timeout override instead of silently ignoring them. Per-ACL timeout is
executed now, alongside existing mailbox/deduplication guarantees. The baseline
Entity timeout is a resolved future policy, not a claimed query deadline.

## ACL, Saga and public HTTP

All ACL mappings live under the qualified Event identity in `acls`:

```ts
"Sales.PaymentGateway.Authorize": {
  provider: httpAcl(), version: "1", endpoint: env("GATEWAY_URL"),
  method: "POST", idempotencyHeader: "Idempotency-Key",
  headers: { Authorization: secret("gateway-token") },
  responses: [
    { status: 200, result: "approved", fields: { reference: "reference" } },
    { status: 402, result: "declined", fields: {} },
  ],
}
```

HTTP serializes the Event payload as JSON and explicitly maps response fields.
The external provider must honor Event identity idempotency for the recovery
horizon. No exactly-once guarantee is implied. Endpoint and header values use
secret slots, so URL tokens cannot leak into plans. Extra transport headers and
invalid result bindings fail compilation. Custom serialization transports are
not claimed by the built-in HTTP JSON provider.

`contracts` reuses phase 3's public exposure API. `sagas` reuses phase 4's typed
input/compensation/terminal mappings. The compiler validates them together,
including public root/terminal bindings, and rejects collisions across Modules.
Multiple Events within one Module share its terminal-only SSE route. Public ACL
Events require an explicit declared Saga for durable admission.

HTTP security is explicit: anonymous or bearer authentication, allow/deny
service authorization, exact-origin/wildcard CORS and an optional fixed-window
service-wide rate budget `{ requests, windowMs }`. It is not an IP-based or
per-principal quota and is reset on process restart. Per-resource authorization,
identity providers and distributed quotas require future provider support.
Default production posture is chosen explicitly, never inferred from a route.

## Secrets and artifacts

`env(name)` references a process environment value. `secret(name)` references a
caller-supplied resolver (vault integration is phase 6). `localSecret(value)` is
allowed only in development/test with a warning. Literal values are removed
before plan hashing, serialization and generation. Symbolic names remain
inspectable. Do not place credentials in semantic input or names; secret slots
are the only supported credential fields.

`generateServiceDeployment(plan, project)` returns deterministic files:
all technical IRs, per-Module OpenAPI, schema SQL, initial migration plan,
Dockerfile, bootstrap, executable configuration, package manifest, deployment
plan and a content hash inventory. It validates the semantic input hash.
The original profile and secret references remain in the generated configuration.
The deploy plan maps each secret slot to a `VANE_BINDING_n` environment alias
outside the hashed input. Local values are represented only by safe sentinels.
The bootstrap resolves each slot externally and verifies `expectedInputHash`
before secret resolution or database access, preserving the original plan identity.
Reordering the input Modules produces byte-identical deployment artifacts.

Generation creates an image build recipe. Build Vane, use `npm pack`, copy the
tarball into the generated directory as `vane.tgz`, and build the Dockerfile.
No remote infrastructure is applied. Initial migrations are for empty databases;
for existing databases, use the actual previous storage snapshot and phase 2's
review/approval workflow. No schema changes occur at bootstrap.

## CLI and runtime

The package exposes:

```sh
entity-event validate --config ./configuration.mjs --json
entity-event plan --config ./configuration.mjs --profile test --json
entity-event generate --config ./configuration.mjs --profile test --out ./generated
```

The trusted `.mjs` file default-exports a ServiceConfiguration. Static validation
needs no database or network. Without `--profile`, validate checks every profile.
Generation publishes a complete new directory and refuses overwrites.
Configuration import is normal JavaScript execution; do not load untrusted code.
Phase 6 will extend CLI inspection, development and operational commands.

`createServiceRuntime(configuration, profile, { pool, resolveSecret?, expectedInputHash? })` compiles
and snapshots the configuration before wiring the existing runtimes. The caller
owns and closes the pool. The optional resolver receives `(reference, slot)`,
so distinct redacted local values can be bound independently. `start()` checks the migrated database before accepting
requests. `handler` provides the configured Node HTTP API; `modules` exposes
identity dispatch, Views and Saga controls. `runWorkers()` explicitly starts
workers and returns their lifetime promise, whose rejection must be observed.
`stop()` stops workers and drains active Entity executions. Creating a runtime
does not start workers or perform migrations. The generated bootstrap installs
these lifecycle operations and signal handlers.
