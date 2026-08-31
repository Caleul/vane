# Phase 1 completion gate

Phase 1 is complete when the Entity Event specification is executable before
any provider or runtime is selected. The gate covers the public DSL, static
declarations, Semantic IR, semantic validators, determinism, diagnostics, and
type tests.

## Acceptance matrix

| Gate | Status | Executable evidence |
| --- | --- | --- |
| Public TypeScript DSL | Complete | `src/dsl.ts`; `test-dts/public-dsl.ts`; `npm run test:types` |
| Static AST/declarations | Complete | `parseModuleSource`; `compileProjectSources`; parser tests prove user code is never executed |
| Entity, Column, Rule, Event | Complete | inferred `Column(...)`, `Event(...)`, and `ACLEvent(...)` member initializers correlate options with opaque semantic member types; the AST compiler—not copyable structural types—proves member existence, ownership, and kind; identity, references, full constraints, persistence and terminal guarantees are preserved in Semantic IR v5 |
| View and query | Complete | typed projection, filters, aggregates, ordering, pagination, explicit relation paths, no persistence |
| ACL Event | Complete | `ACLEvent(...)` member factory plus compiler-validated ACL ownership, semantic input/result interpretations, mandatory success/fail, no technical policy |
| Saga and Saga Stream | Complete | causal DAG, compensation, single terminal sink, durable/causal guarantees, terminal-only visibility |
| Module composition | Complete | explicit imports, transitive visibility, unknown/duplicate/self/cycle/ambiguity rejection |
| Deterministic IR | Complete | canonical module/project ordering and byte-identical serialization tests |
| Actionable failure | Complete | stable diagnostic codes, semantic paths, corrections, source locations, no partial IR |
| Positive and negative type tests | Complete | valid public grammar plus `@ts-expect-error` cases in the type-test gate |

## PRD traceability

| PRD group | Phase-one result |
| --- | --- |
| FR-ENT-001–005 | Entity identity, persistent ownership, typed Columns, Rules, and owned Events are represented and validated |
| FR-COL-001–005 | Closed types, nullability, length/bounds, uniqueness, identity, references, generation, defaults, and contradictions are executable |
| FR-COL-006 | Semantic persistence intent is preserved; physical DDL is phase 2 |
| FR-RUL-001–004 | Rule ownership, multi-Column scope, static AST, and invalid reference rejection are executable |
| FR-RUL-005 | Provider enforcement choice is phase 2; the invariant is already preserved in IR |
| FR-EVT-001–003, 009–012 | Stable owner identity, typed input, success/fail, View-only public success, safe/stable fail, and compensation references are executable |
| FR-EVT-004–008 | Required Entity persistence is preserved as a semantic guarantee; transaction/outbox realization is phase 2 |
| FR-VIEW-001–005, 007 | Named Views, typed contracts, owned query, explicit relations, aggregates, no persistence, and View-only public success are executable |
| FR-VIEW-006 | Query execution and contract generation are phase 3 materializers |
| FR-ACL-001–004, 006 | ACL ownership, typed boundary interpretations, success/fail normalization, and absence of credentials are executable |
| FR-ACL-005 | Endpoint/protocol/status mapping is phase 4 plus ServiceConfiguration |
| FR-SAGA-001–007 | Causal Events, durable-state guarantee, compensation, no awaited intermediates, and terminal-only stream are executable |
| FR-SAGA-008 | Trace identities are preserved; exporters and runtime telemetry are phase 6 |
| FR-MOD-001–005 | All concept collections, explicit imports, reference validation, deterministic composition, and explicit Modules are executable |
| FR-COMP-001–004 | Stage-one DSL-to-IR pipeline, mandatory ServiceConfiguration boundary, actionable diagnostics, and provider-free IR are enforced |

## What 100% means

It means no semantic requirement assigned to phase 1 is represented only by a
comment, mock, or future promise. Every one has a public type, parser rule, IR
field or invariant, validator, and test where applicable.

It does not mean the entire framework is complete. Phases 2–6 materialize the
already-preserved meaning into persistence, Views/contracts, ACL/Saga runtime,
ServiceConfiguration, and production robustness. Keeping that boundary explicit
prevents infrastructure choices from leaking backward into the ubiquitous
language.

## Verification

Run the complete gate with:

```bash
npm run verify
```

The command runs formatting/lint checks, project type checking, public DSL type
fixtures, declaration build, and all runtime tests.
