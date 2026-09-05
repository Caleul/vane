# Robustness and operations

## Durable execution

Configured public Events are admitted durably before HTTP 202. A public Entity
Event without a declared Saga receives an explicit `vane.event.Owner.Event`
one-step technical plan in Runtime IR. Semantic IR is unchanged.

Each Saga snapshots resolved retry policies, tracks attempts and next eligibility
for normal and compensation Events, and reuses its stored Event envelope.
Domain rejection, invalid input and integrity/Rule violations are final. ACL
unavailability/timeouts and transient PostgreSQL failures retry with fixed or
capped exponential backoff. An interrupted attempt is reconciled with the same
identity, without consuming another completed-attempt budget. At-least-once
external delivery requires the gateway's durable idempotency contract.

Entity timeout uses PostgreSQL `statement_timeout` in the Event transaction;
waiting for a row lock is included. Pool acquisition and network liveness must be
bounded by pool/connection settings. It is a per-statement database deadline,
not a JavaScript race against a still-running write. Unrecognized programming or
configuration errors reject the worker visibly; they are not silently retried.

Saga failures and the completed attempt commit atomically. Success of earlier
steps is compensated in reverse causal order. Public terminal results are
immutable, including when an operator resolves a failure record. Old phase-four
and phase-five Saga states resume with the original one-attempt baseline.
Changed semantic/adapter plan hashes leave old work untouched for explicit
operator investigation and compatible-runtime recovery.

Outbox `dispatch` accepts an optional ExecutionPolicy; exhausted publication
moves the message to `failed` and atomically creates a failure record. Existing
lease tokens fence stale publishers. The application supplies the explicit
publisher; the framework does not invent routing or send outbox messages to an
arbitrary destination. Without a supplied policy the earlier explicit retryAt
contract remains available. Never delete deduplication receipts while a message
can be redelivered.

## Internal observability

Configure `telemetry: { exporter: "json", redact: ["email"] }` in a profile.
JSON records go to stderr or an explicit `telemetrySink` binding. Event,
persistence, publication, consumption, ACL and View spans include durations;
Saga, retry, deduplication and queued failures are counted. `runtime.telemetry.metrics()`
returns bounded operation/outcome counters and duration totals, and
`runtime.operations.queues()` returns durable queue/Saga counts. Exporter errors
increment `exporterFailures` without changing business execution.

Payload, input, result data, credentials and arbitrary exception messages are
excluded from runtime records. Additional metadata keys are recursively redacted.
Event IDs, Saga ID, correlation and causation reconstruct the internal causal
line; `inspect saga` also lists causal parents and compensation identities.
These APIs are privileged and are never installed as public HTTP routes. SSE
continues to emit only the terminal View/fail.

## Secrets

Environment bindings and explicit caller resolvers remain supported. A profile
can select:

```ts
secrets: {
  provider: "vault-kv-v2",
  address: env("VAULT_ADDR"),
  token: env("VAULT_TOKEN"),
  mount: "secret",
  timeoutMs: 5000,
}
```

Use `secret("application/database#password")` to select a KV v2 field. Bootstrap
address/token use environment references, not recursive Vault references. Vault
requires HTTPS, refuses redirects and has a request deadline. Resolution errors
are generic; tokens and returned values never enter diagnostics or artifacts.
A new runtime resolves fresh values after rotation. Generated deployments also
support provisioned `VANE_BINDING_n` values through the existing explicit binding
inventory; supplying a caller resolver takes precedence over Vault, including
symbolic names without a Vault field selector. For an embedded deployment using
that override, `compileServiceConfiguration(config, profile, { secretResolver:
"caller" })` validates the same names as `createServiceRuntime` with
`resolveSecret`. Standalone CLI/generated deployments validate the configured
provider and require Vault path#field references. Resolver choice does not change
the configuration hash; resolved values remain external runtime bindings.

## CLI

All commands take `--config <trusted configuration.mjs>` and `--profile <name>`;
`--json` gives machine-readable output. Configuration modules are trusted local
code, not a sandbox. Static validation, planning, Event inspection and migration
diff do not access a database.

```sh
entity-event inspect event Sales.Order.Place --config configuration.mjs --profile test --json
entity-event inspect saga <uuid> --config configuration.mjs --profile test --json
entity-event inspect queues --config configuration.mjs --profile test --json
entity-event failures list --config configuration.mjs --profile test --json
entity-event failures list --limit 100 --offset 100 --config configuration.mjs --profile test --json
entity-event failures retry-outbox <failure-uuid> --config configuration.mjs --profile test
entity-event failures resolve <failure-uuid> --config configuration.mjs --profile test
entity-event failures prune --before 2026-01-01T00:00:00Z --config configuration.mjs --profile test
entity-event migrate diff --previous storage-ir.json --config configuration.mjs --profile test --json
entity-event migrate apply --migration migration.json --approval approval.json --config configuration.mjs --profile test
entity-event dev --config configuration.mjs --profile development --port 3000
```

For a new empty schema omit `--previous`. For upgrades provide the actual
previous Storage IR snapshot. Apply verifies the content hash, current storage
history, target configuration and any required approval. Approval JSON contains
`planHash`, `classification` (`unsafe` or `destructive`) and a nonempty `reason`.
Never approve a hash before reviewing its exact migration plan. No remote
infrastructure is applied by these commands.

`retry-outbox` explicitly requeues only exhausted publications, preserving the
original Event identity. It never replays Saga steps. Failure resolution acknowledges investigation; it never replays a compensated
Saga or changes an already-published terminal. Correct the underlying cause,
then submit a new business request when appropriate. Retention is explicit:
only resolved failure metadata older than the cutoff is pruned, at most 100
records per CLI invocation. Saga/terminal/mailbox receipts and unpublished
outbox entries are retained indefinitely. There is no background cleanup.

See the [reference quickstart](../examples/sales-billing/README.md).


Low-level cross-Module Saga wiring must expose `importedHashes` on its Event and
View executors, calculated from the installed semantic Modules. Saga construction
requires an exact match with the materialized plan and rejects missing hashes.
The service runtime and PostgreSQL View runtime provide this inventory directly;
single-Module callers remain compatible without it.


Rows created before policy snapshots use the one-attempt, 10-second baseline,
including their dispatch deadline, when resumed under a changed profile. New
low-level Saga callers that omit a policy entry retain their executor's explicit
timeout; configured service runtimes snapshot every resolved Event policy.
Telemetry sinks may be asynchronous: rejection is counted in `exporterFailures`
without an unhandled rejection or delaying business completion.


Failure inspection lists unresolved records before resolved history, newest first
within each group, with a stable failure-ID tie-breaker. The default page has 100
records; `--limit` accepts 1–1000 and `--offset` selects later pages. The internal
API exposes the same `failures(limit, offset)` arguments. Offset pages are live,
so concurrent insertions or resolutions can move records between pages.


The low-level outbox and Saga APIs reject malformed complete execution policies
before touching durable work. Outbox captures a policy per dispatch, and Saga
captures its policy catalog when installed; later mutation by the caller does
not change those execution decisions.
