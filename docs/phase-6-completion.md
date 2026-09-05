# Phase 6 completion gate

Scope: PRD v0.1 §15 phase 6 and remaining robustness requirements. Baseline
f553e08 includes phases 1–5. See [design decisions](phase-6-design.md),
[operations](operations.md) and [reference quickstart](../examples/sales-billing/README.md).

| Requirement | Delivery | Evidence |
| --- | --- | --- |
| FR-SVC-018–022 | Resolved policies execute with persistent attempts/backoff; independent compensation budget; Entity database statement deadline | Restart, locked-row rollback, exhaustion and compensation integration tests |
| FR-PG-005–006, FR-RUN-004–005 | Atomic failure recording; fenced outbox exhaustion; explicit retry-outbox with original identity; durable standalone public admission | Concurrent workers, process restart, preserved terminal and redrive assertions |
| FR-OBS-001–006, FR-RUN-006 | Structured JSON internal exporter; Event/persistence/publication/consumption/ACL/View spans; counters, queue inspection and redaction | Sink failure isolation, redaction, correlated retry records, safe causal inspection and terminal-only SSE |
| FR-SVC-028–030 | Environment/caller resolvers and configured Vault KV v2; HTTPS/no redirects; symbolic production bindings | Vault protocol test, invalid bootstrap and literal production rejection; generated artifact redaction |
| FR-CLI-001–004 | migrate diff/apply; dev; inspect event/saga/queues; failures list/resolve/retry-outbox/prune | Static CLI subprocess tests and real migrate/dev/HTTP/SSE/inspect/SIGTERM/restart integration |
| PRD §13–14 | Sales/Billing Modules, Order/Payment, PaymentGateway, PlaceOrder, OrderDetails/PaymentReceipt, real two-Column Rule, three profiles | Reference project compile, cross-Module ownership, PostgreSQL Rule and generated Docker execution |
| Retention boundary | Explicit bounded pruning of resolved failure metadata; durable receipts retained | Pruning/resolution tests and operational documentation; no hidden cleanup |

## Validation

Node 24.13.0: lint, strict types, positive/negative public type fixtures, build and
233 unit tests passed. PostgreSQL 16.15: 46 integration tests passed, including
all prior phases. The CLI test runs separate operating-system processes and
verifies successful signal shutdown and terminal replay after restart.

The generated Docker image was packed from the actual library, built and started.
Order.Place returned 202, Payment persisted through its owning Billing Module,
the HTTP gateway failed once and succeeded on the second attempt, and SSE
returned only OrderDetails with status complete. SIGTERM exited with code 0.
Local smoke resources were removed; no remote infrastructure was applied.

## Operational limits and future scope

- Entity deadlines are database statement deadlines; pool acquisition/network
  liveness use pool configuration. External idempotency depends on the gateway.
- Only known transient failures retry. Unexpected worker errors are observable
  through the worker lifetime promise, leaving durable work available to resume.
- Failure resolution never rewrites terminal results or replays compensation.
  Only failed outbox publications support explicit redrive of the same identity.
- Retained Saga/mailbox records are not automatically deleted. Other retention
  windows require an explicit policy that preserves the redelivery horizon.
- JSON telemetry export is the reference implementation. Vendor-specific
  collectors can consume the sink; native vendor exporters are not bundled.
- The production Vault service itself was not contacted; its HTTPS request,
  response, path and secrecy contracts are tested through a controlled transport.
- Microservice builders, remote infrastructure apply, distributed transactions,
  other production databases/runtimes and public progress remain outside v0.1.

PR review and any resulting corrections are recorded in the PR history.

## PR review corrections

Codex identified a mismatch between static Vault reference validation and the
installed resolver. A failing regression reproduced acceptance of a missing
field selector. Both boundaries now share path#field validation, including
rejection of empty/traversal/dotted path segments; custom resolvers retain their
existing symbolic-name contract. The upgrade integration also proves the
reviewed outbox constraint migration preserves preexisting Saga records.

The complementary review also hardened raw Semantic IR import scopes against
ambiguous Event owners, preventing policy and executor collisions before runtime.
Operational CLI failures emit safe codes; outbox construction requires its real
failure table, and failed rollback cannot hide the original operation error.
Regression tests cover ambiguous scopes, missing failure storage and rollback
failure; the negative Vault provider type fixture now supplies all other fields.

Further Codex feedback reproduced literal Vault bootstrap leakage into generated
artifacts and rejection of custom-resolver symbolic names. Bootstrap address and
token now follow the shared redaction path. Embedded compilation can explicitly
select caller resolver validation, matching runtime precedence, while standalone
configuration still requires valid Vault selectors. Artifact and runtime tests
prove both fixes and preserve the deployment hash check.

The final runtime review also reproduced installation of stale imported-module
semantics. Saga construction now verifies the complete imported hash inventory
against both installed Event and View runtimes; missing or changed inventories
fail before database access. Standalone public plans carry the same import
fingerprints. The regression covers missing/stale fingerprints on both runtime
boundaries and acceptance of matching fingerprints.

Aliased standalone Event routes now reuse one durable technical plan. Conflicting
terminal bindings fail during compilation. A PostgreSQL regression reproduces
the previous duplicate-plan startup failure and now admits through both routes,
restarts the runtime and verifies both terminal results.
