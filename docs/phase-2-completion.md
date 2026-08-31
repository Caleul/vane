# Phase 2 completion gate

Phase 2 turns the persistent intent preserved by Semantic IR into a
deterministic, transactional, recoverable PostgreSQL implementation. Its frozen
design is documented in [`phase-2-design.md`](phase-2-design.md), and usage is
documented in [`postgresql.md`](postgresql.md).

## Acceptance matrix

| Gate | PRD traceability | Status | Executable evidence |
| --- | --- | --- | --- |
| Entity Event operation grammar | FR-EVT-002, FR-EVT-004–008, FR-EVT-013–016 | Complete | `create`, `update`, `remove`/`delete`, `upsert`, input/literal/current Column and atomic add/subtract in DSL, parser, compiler and Semantic IR v6; `test/event-operation.test.ts`; type tests |
| Owner-only persistence | FR-EVT-004–007 | Complete | compiler rejects missing operation, cross-owner mutation, identity assignment, invalid current-row reads and incompatible values; runtime resolves the owner from compiled metadata |
| PostgreSQL Storage IR | FR-ENT-003, FR-COL-001–006, FR-PG-001 | Complete | `src/postgresql/storage-ir.ts`, `materializer.ts`, `renderer.ts`; versioned canonical IR; eight PostgreSQL types; all-or-nothing diagnostics |
| Physical constraints and Rules | FR-COL-002–004, FR-RUL-001–005 | Complete | PK, nullable, unique, generated/default, length/bounds, FK and named CHECK constraints; provider compatibility and non-unique FK targets rejected before SQL |
| Physical naming | FR-PG-001–003, determinism NFR | Complete | quoted Module-qualified names, Unicode/63-byte fitting, stable hashes and collision diagnostics in `identifiers.ts` |
| Durable technical schema | FR-EVT-008, FR-PG-005–006 | Complete | revision/timestamps plus migration history, mailbox, outbox, Saga registration and failure queue tables with causal, receipt, retry and lease fields |
| Deterministic DDL | FR-PG-001–002 | Complete | stable dependency ordering and byte-identical renderer output; unit permutations plus real schema application in integration gate |
| Snapshot, diff and renames | FR-PG-002–004 | Complete | content-addressed plans over previous/next Storage IR; exact rename map; no heuristic rename; physical swap/cycle rejection; table/Column/constraint/index diffs |
| Migration safety | FR-PG-004 | Complete | safe/unsafe/destructive classification; approval bound to plan hash and classification; stale or mismatched approval rejected |
| Migration application | FR-PG-002–004 | Complete | one reserved PostgreSQL connection for DDL/history/commit; namespace advisory lock; monotonic history order; concurrent replay, divergence and rollback tests |
| Canonical Event envelope | FR-SAGA-003, FR-PG-005–006 | Complete | immutable causal envelope, canonical JSON and SHA-256 fingerprint; forged/non-JSON/invalid identifiers rejected |
| Entity Event executor | FR-EVT-003–008, FR-RUN-001–003 | Complete | create/update/delete/upsert SQL derived from Operation IR; mailbox claim, owner mutation, revision, outbox and receipt transaction |
| Equal-value writes | FR-EVT-007–008 | Complete | every accepted update executes SQL and increments `__vane_revision`, including equal values |
| Safe terminal failure | FR-EVT-003–004, FR-RUL-003–004 | Complete | typed payload, Rule and constraint failures are safe, persisted and deduplicated; the mailbox preserves the serialized envelope even when its payload is not valid PostgreSQL JSONB; savepoint removes invalid mutation; SQL details are not public |
| Infrastructure rollback | FR-PG-005, FR-RUN-004–005 | Complete | infrastructure errors roll back owner, mailbox and outbox and remain retryable with the same event occurrence |
| Mailbox and deduplication | FR-PG-005–006 | Complete | global `eventId`, fingerprint collision detection and terminal receipt; concurrent duplicates produce one protected effect |
| Transactional outbox | FR-PG-005–006 | Complete | outbox append shares the owner commit and stores the complete immutable envelope |
| At-least-once delivery | FR-PG-005–006, FR-RUN-004–005 | Complete | PostgreSQL transaction clock, `FOR UPDATE SKIP LOCKED`, bounded lease, worker/token fencing, acknowledge/reschedule and expired-lease recovery |
| Module runtime lifecycle | FR-RUN-001–006 | Complete | start validates IR/version, PostgreSQL version, types/defaults/nullability, complete constraint/index definitions and installed Storage IR hash; PostgreSQL casts and `IN`/`ANY` deparse are canonicalized without accepting definition drift; identity-only dispatch; stop/drain/restart proven against PostgreSQL |
| Public typed API | typing/evolution NFR | Complete | root exports cover semantic operations and safe Module dispatch plus PostgreSQL materialization/migrations/delivery; low-level executor remains internal; consumer type fixtures and declaration build |

## Migration safety

Migration plans never infer a rename from similarity. A table or Column rename
must be supplied as an exact mapping. Without it, the planner sees a drop and an
add and classifies the data risk accordingly.

| Change | Minimum behavior |
| --- | --- |
| Add nullable Column or compatible object | safe deterministic plan |
| Add required Column without usable default/backfill | unsafe or destructive; exact approval required |
| Drop table, Column, PK, unique, FK or Rule | destructive; exact approval required |
| Incompatible/narrowing type or constraint | destructive; exact approval required |
| Compatible widening/default change | classified deterministically from old/new objects |
| Explicit rename | preserved as rename step; never guessed |

Approval is an artifact containing the canonical plan hash, its classification
and a non-empty reason. Any plan change invalidates the approval.

## Automated verification

The local gate is:

```bash
npm run verify
```

It runs Biome, TypeScript, public type fixtures, package build and the complete
139-test unit suite. Phase 2 adds semantic-operation, materializer, migrations, envelope,
runtime, module-lifecycle and outbox suites while retaining every phase-1
regression.

The real PostgreSQL gate is:

```bash
VANE_TEST_DATABASE_URL=postgresql://user:password@localhost:5432/vane \
  npm run test:integration
```

CI provisions PostgreSQL 16.15 and proves:

1. server/version and transactional-DDL capability;
2. generated schema, all eight types, defaults and physical constraints;
3. multi-Column Rule and uniqueness enforcement;
4. initial/replayed/incremental migrations with preserved data;
5. single-connection concurrent migration locking, rollback and immutable history;
6. twelve concurrent duplicate deliveries with one protected effect;
7. `eventId` collision rejection;
8. typed-input/Rule rollback and deduplicated terminal fail;
9. equal-value physical revision;
10. owner/outbox/mailbox atomic rollback on infrastructure failure;
11. fenced outbox claims and stale-worker rejection;
12. expired lease recovery through a new PostgreSQL pool;
13. Module runtime preflight, dispatch, stop/restart, low-year Gregorian values,
    PostgreSQL CHECK deparse and same-name catalog-drift rejection.

The integration command intentionally fails when the database URL is absent; no
PostgreSQL scenario is silently skipped.

## What remains outside phase 2

Phase 2 persists Saga and failure-queue primitives required by FR-PG-006, but it
does not claim phase-4 Saga/ACL orchestration or phase-6 observability and
production hardening. View execution, HTTP/OpenAPI and terminal public contracts
belong to phase 3. Provider profiles, topology and policy inheritance belong to
phase 5 ServiceConfiguration.
