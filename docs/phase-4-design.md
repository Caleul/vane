# Phase 4: ACL and durable Saga execution

## Authority and boundary (decided)

PRD §15 phase 4 covers ACL Events, causality, compensation, Saga registration
and terminal streams (FR-ACL-001–006, FR-SAGA-001–008). Phases 1–3 are merged
in main through #7, #8 and #9; baseline d0b32b4 passes 168 unit tests.
Authority: Notion PRD 3ca51cfc265c81b78834d4649a9048fb and vocabulary
3ca51cfc265c81608ca5c34039ad121f, checked 2026-09-04.

- Decided: reuse PostgreSQL's existing technical Saga table and migration flow.
- Decided: persist admission before HTTP 202; retain immutable Event envelopes,
  plan identity, step outcomes, compensation and final public result.
- Decided: advance a causal DAG through a worker. Events never invoke or await
  one another. Ready steps execute deterministically; parallel execution is not
  required for DAG semantics. All parents must succeed before a child runs.
- Decided: compensate completed steps in reverse topological order. Compensation
  is another Entity/ACL Event with its own durable identity. A failed compensation
  cannot turn into public success; preserve its internal failure record.
- Decided: Entity replay uses the existing mailbox. Recoverable external Events
  require explicit adapter idempotency support and reuse eventId across attempts.
  No exactly-once claim is made for external systems.
- Decided: technical ACL adapters and Saga input bindings are explicit materializer
  inputs, following phase 3's contract input boundary. Phase 5 will resolve these
  from ServiceConfiguration. Credentials stay in runtime closures, outside IRs.
- Decided: persist terminal View after required Events, then serve it through the
  existing terminal-only SSE interface, including reconnect after restart.
- Deferred to phase 5: root configuration, profile inheritance, provider registry,
  policy precedence, complete Runtime/Infrastructure IR and deploy plans.
- Deferred to phase 6: telemetry exporters, failure-queue operations, retention
  administration, production secret integration and the full reference project.

## Execution checklist (decided and implemented)

- [x] Typed ACL adapter and HTTP mapping with safe success/fail normalization.
- [x] Deterministic validated Saga plan and input bindings.
- [x] Durable admission, causal worker, deduplication and compensation.
- [x] PostgreSQL terminal store and HTTP admission integration.
- [x] Type/unit/integration gates, including restart, races and safe SSE.
- [x] Completion matrix and usage documentation.
