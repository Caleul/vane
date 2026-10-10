# Phase 8 implementation plan

Authority: [Phase 8 — DevXP & Dogfood](https://www.notion.so/3d251cfc265c81ec965fc7a54f78b8d8), updated 2026-10-08, and the Validation & Release PRD. No scenario is PASS before execution.

## Phase A — candidate and provenance

- A1: Use PR #14 head `3465e6c60353796d880022d09f6771d2f46509fe`, tree `7dd8c72e53f4f5452507a6ac74d1730fba2100c8`, as implementation baseline; no merge/publication required.
- A2: Build from a clean identified checkout, pack `@lilka/vane@0.0.0`, and record package SHA-256, source tree, docs hashes, Node and dependency versions.
- A3: Retain the baseline conformance evidence; run the candidate gate again when changing the package. Evidence from a different package is never silently transferred.

## Phase B — external harness

- B1: Create `/workspace/vane-dogfood`, outside the framework, with three independent consumers, package/lockfiles, public imports only, no npm link or workspaces.
- B2: Pin PostgreSQL 16 and Moto Server/S3; provision local dummy credentials, isolated schemas/buckets, healthchecks, deterministic reset and cleanup.
- B3: Provide setup, typecheck/build, migrate, start, test and cleanup commands for each app; execute actual Node processes and HTTP/SSE.
- B4: Emit human/JSON scenario evidence: requirement IDs, precondition, action, expected/observed, PASS/FAIL/GAP/N/A, revisions, versions, seed, timestamps, command and exit code.
- B5: Expose observable crash barriers without core fault injection; include abrupt crash and graceful shutdown. Required GAP/FAIL must produce a nonzero exit.

## Phase C — three consumer applications

- C1 / Todo: Project/Todo, explicit reference, owner-only Events, `completedUnits <= totalUnits`, paginated/filterable Views. Implement TD-01 positive, TD-02 negative, TD-03 actionable diagnostics, TD-04 persistence, TD-05 admission/commit crash recovery, TD-06 package/types/docs.
- C2 / Commerce: User/Coupon/Inventory/Order/Payment, ACL/Saga, persistent payment ledger, S3 receipt adapter via Moto. Implement CM-01 positive, CM-02 negatives, CM-03 retry/exhaustion, CM-04 compensation/refund and compensation failure, CM-05 runtime/gateway crash/replay, CM-06 terminal-only SSE reconnect, CM-07 Moto/persistence/reset.
- C3 / Reservation: Resource/Booking, capacity Rule, persisted deadlines, application scheduler, persistent external ledger. Implement RB-01 positive, RB-02 capacity concurrency (50 rounds), RB-03 expiration/scheduler restart, RB-04 confirm/expire race (50 rounds), RB-05 retry/deadline, RB-06 crash recovery, RB-07 duplicate/lease/outbox operations, RB-08 invalid configurations and public boundary.

## Phase D — friction and independent reproduction

- D1: Record each friction as BUG, DX, MISSING CAPABILITY or CONCEPTUAL FAILURE with severity, reproduction and rerun. P0/P1 cannot be waived by acceptance.
- D2: Make focused public-contract fixes; conceptual changes require explicit decision and stop only the affected case.
- D3: A package fix requires fresh clean artifact identity and affected reruns plus regression of all three consumers.
- D4: An independent adopter follows the versioned docs literally from empty directories without private-source help; record time, commands and source consultations.

## Phase E — final gate

- E1: Run framework checks, PostgreSQL integration/conformance and external consumer suites with the same final tarball.
- E2: Assemble manifests, scenario matrix, HTTP/SSE transcripts, database snapshots, payment/confirmation ledgers, S3 object hashes, crash timelines and friction disposition.
- E3: Declare PASS only for three independent green apps, 50/50 for both reservation races, real PostgreSQL, applicable Moto, independent docs reproduction, zero P0/P1 and no pending conceptual pivot. Otherwise report BLOCKED with exact FAIL/GAP.

## Ownership and boundaries

The coordinator owns the framework branch, package identity, integration and core fixes. Subagents own external harness, Todo, Commerce and Reservation respectively. Independent reproduction follows implementation. Consumers may share test utilities but each installs its own normal tarball dependency. Source inspection by implementers is recorded; it does not count as independent adoption.

Release publication, productive distribution and a generic public `@harness` primitive are outside this phase.
