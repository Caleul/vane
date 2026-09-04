# Phase 4 completion gate

Phase 4 executes the existing ACL and Saga semantics. Its scope and decisions
are in [the design](phase-4-design.md); API usage is in [the runtime guide](sagas.md).

| Requirement | Delivery | Verification |
| --- | --- | --- |
| FR-ACL-001–003 | Declared ACL Event inputs and result interpretations execute as success/fail; external fields are explicitly mapped | Unit tests and real HTTP provider integration |
| FR-ACL-004–006 | Explicit versioned, idempotent runtime adapters; transport and credentials remain outside semantic/contract/Saga IR; incompatible result bindings rejected | Type fixtures, invalid binding tests, safe error and redaction tests |
| FR-SAGA-001–002 | Deterministic topological plan from compiled Saga, typed input and compensation bindings, required parent convergence | Unit plan tests and branching DAG integration |
| FR-SAGA-003 | Stable Event envelopes plus all parent Event IDs, Saga/correlation IDs and compensation causation | Durable state assertions, crash/replay tests |
| FR-SAGA-004, FR-PG-006 | Versioned state in the existing migration-managed PostgreSQL Saga table; admission before HTTP 202 | Admission readback and database outage test |
| FR-SAGA-005 | Compensation is another Event, in reverse causal order; failures remain recorded and never become success | Entity compensation, DAG reverse order, compensation failure tests |
| FR-SAGA-006 | The worker advances one-way Events; no Event calls or receives a return from another Event | Stored step/envelope execution and dependency gates |
| FR-SAGA-007, FR-HTTP-005–006 | Durable first terminal result, reconnectable and abortable terminal-only SSE | Real Node HTTP, PostgreSQL and external HTTP provider test |
| FR-SAGA-008 | Step outcomes, ACL interpreted data and compensation results remain in the internal state; public stream contains only View/fail | Terminal payload assertions; exporters remain phase 6 |
| Recovery guarantee used by phase 4 | Stored envelope replay; Entity mailbox deduplication; external Event idempotency contract; concurrent workers serialized | Crash after Entity commit, crash after ACL response, worker races and stop/resume tests |

## Verification

Local gate: **178 unit tests + 28 PostgreSQL integration tests**, all passing.
Includes a fresh Node process resuming persisted admission, HTTP ACL-owned
admission, and rejection of semantic/adapter drift before execution.

- `npm run verify`: formatting/lint, strict TypeScript, positive/negative public
  types, build and unit tests.
- `VANE_TEST_DATABASE_URL=... npm run test:integration`: existing phases plus
  PostgreSQL Saga admission, causal execution, compensation, recovery and real
  HTTP/SSE. Tests use isolated schemas on PostgreSQL 16.15.

## Deferred scope

Phase 5 supplies ServiceConfiguration profiles, provider capability negotiation,
policy precedence and complete technical IRs. Phase 4 accepts explicit adapter
and binding inputs without adding technical policy to the Module.

Phase 6 supplies telemetry exporters, failure queue tooling, retention operations,
production secret integration and the complete reference application. Pending
work and terminal results currently remain retained; no implicit cleanup occurs.

No external exactly-once guarantee is claimed: replay is safe only when the
selected external provider honors Event identity idempotency for the recovery
horizon. Workers keep transient database errors observable and preserve pending
work; automatic backoff/retry policy is not invented in this phase.
