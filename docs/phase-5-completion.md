# Phase 5 completion gate

Phase 5 implements PRD §15's ServiceConfiguration stage, using the existing
semantic, persistence, contract and Saga materializers. See the
[design](phase-5-design.md) and [usage guide](service-configuration.md).

| Requirement | Delivery | Evidence |
| --- | --- | --- |
| FR-SVC-001–005 | Single typed root; named profiles; one-parent inheritance; offline profile validation and effective configuration | Type fixtures; cycle/missing-parent tests; CLI all-profile validation and profile switching |
| FR-SVC-006–012, FR-ENT-004 | Explicit monolithic service, complete Module membership, unique Entity ownership, one persistence selection | Multi-Module and missing/duplicate ownership tests; qualified Event policy resolution |
| FR-SVC-013–017 | Explicit provider selectors, interface/version/capability registry and dependency negotiation | Wrong kind, unknown provider, missing guarantees, version and dependency rejection tests |
| FR-SVC-018–022 | Policy defaults, per-service/per-Event overrides, bounds and visible source precedence; explicit technical-store providers | Precedence and negative-policy tests; four technical IRs and provider report |
| FR-SVC-023–026, FR-ACL-004–006 | Configuration-owned HTTP JSON ACL mappings, secret slots, public exposure and internal identities | Actual configured external HTTP invocation, durable admission and terminal View; mapping incompatibility tests |
| FR-SVC-027 | Configured bearer/anonymous auth, allow/deny authorization, CORS, service-wide rate budget and terminal SSE | Real HTTP tests for 401/403/429, preflight, origins and SSE |
| FR-SVC-028–030 | Local literal warning; staging/production reference-only; redacted plans, hashes and artifacts | Literal value change leaves safe input hash unchanged; output leak and production rejection assertions |
| FR-SVC-031–032 | Deterministic Docker recipe, bootstrap, package/secret manifests and manual deployment plan | Generated image built and started locally; no remote apply implementation |
| FR-COMP-005–010 | Resolved profile, capability negotiation, Runtime/Storage/Contract/Infrastructure IR, actionable diagnostics, atomic output and safe plan | No-partial-output tests; CLI generate/refuse-overwrite; hash/determinism tests |
| FR-HTTP-001, FR-CLI-001–004 (phase-five subset) | Configuration-derived routes; validate/plan/generate with JSON; static operation without database access | CLI subprocess tests; configured PostgreSQL/HTTP/Saga integration |
| FR-RUN-002 (configuration boundary) | Snapshot and recompile before startup; validate migrated schema; explicit workers and shutdown | Schema rejection and configured runtime integration; generated container signal shutdown |

## Validation

- Node **24.13.0**: `npm run verify` passes strict types, public positive/negative
  type fixtures, lint/format, build and **220 unit tests**.
- PostgreSQL **16.15**: `npm run test:integration` passes **37 integration tests**,
  including all previous phases and five configured runtime scenarios.
- Generated deployment was packed with the actual built Vane package, built from
  its generated Dockerfile and started locally. Its HTTP endpoint returned 202;
  the configured HTTP ACL executed, PostgreSQL persisted the Saga, and terminal
  SSE returned only the final Receipt View with status `complete`.
- No production or remote infrastructure was changed.

## Phase 6 and future boundaries

Phase 5 resolves policies and reports their sources. Durable retry/backoff
scheduling, Entity timeout enforcement, expanded recovery, failure-queue
operations, telemetry exporters, retention, production vault integration,
operational CLI expansion and the Sales/Billing reference application remain
phase 6. The bootstrap rejects more-than-one-attempt policies or Entity timeout
overrides; the IR explicitly labels deferred execution. Per-ACL timeout and the
existing transactional mailbox/deduplication behavior execute now.

Authorization currently selects service-wide allow/deny after optional bearer
validation; rate limiting is a per-process service budget. Identity-provider,
per-resource and distributed quota providers are not implemented. Provider
descriptors cannot pretend to install unsupported runtime implementations.

Multiple Modules run in one service. Distributed builders, multi-service physical
database sharing, other production runtimes/databases and remote infrastructure
apply remain outside v0.1. Entity ownership is preserved explicitly for future
service mapping. Generation emits an image recipe; building/publishing/deploying
an image is a separate explicit operation. Initial migration output is not an
upgrade plan for an already-populated database.

## PR #11 review corrections

Both reported issues were reproduced before correction:

- Generated deployments now preserve the selected profile, symbolic secret
  references and original compiled input hash. Environment aliases live only in
  deployment binding metadata. The runtime verifies the expected hash before
  resolving bindings; local secret sentinels retain their redacted identity.
- The semantic project embedded in configuration.mjs uses the same sorted Module
  order as semantic-hash validation, so reordering Modules cannot change output.

Regression coverage includes full original/generated plan equality, byte-identical
artifacts for reordered Modules, local-secret redaction and per-slot resolution,
and rejection of configuration drift before secret/database access. Validation:
220 unit tests and 37 PostgreSQL integration tests, plus the generated Docker
bootstrap executing HTTP admission through the configured ACL to terminal SSE.
