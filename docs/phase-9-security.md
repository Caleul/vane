# Phase 9 security and operations review

This review covers the core service HTTP/SSE boundary, ACL transports, secret resolution, telemetry, durable delivery failures, privileged operations and CLI diagnostics. It is a source and regression review, not a penetration test or release certification. Dependency and packaged-release checks are recorded separately by the release gate.

## Corrections

| Finding | Disposition | Regression |
| --- | --- | --- |
| Provider exception strings could persist credentials or response bodies in outbox `last_error`. | Resolved: persist the stable message `Outbox publication failed.` while preserving retry timing, lease fencing and the original Event identity. | `postgresql-delivery.test.ts`: credentials, URL and response sentinels never enter SQL parameters. |
| Default telemetry redaction missed common credential aliases and exception fields. | Resolved: normalize key separators/case and redact token/API key/cloud credential, cookie/header, connection URL and error/message/stack/cause keys recursively before export. Custom redaction keys use the same normalization. | `phase-nine-security.test.ts`: nested aliases and configured keys disappear while IDs/counters remain. |
| A known Saga UUID could expose another Module's terminal or an internal View through a configured Module's public SSE route. | Resolved: the streaming adapter admits only current Module plan hashes whose terminal View is exposed by that Module's contract. The terminal View is checked again before delivery. | Unit and real PostgreSQL regressions clone equivalent Modules, persist foreign/private terminals, require 404, and retain application-admitted exposed Views and replay. |
| CLI help exited as a failed command and could load configuration unnecessarily. | Resolved: `--help` and `-h` return usage with exit 0 before configuration loading. Invalid commands retain exit 1; configuration exceptions retain generic diagnostics. | Actual emitted CLI subprocess verifies exit codes and a configuration side-effect marker. Installed-package verification belongs to the release harness. |

Plan hashes include Module identity; scoped plans are selected by Module before the streaming whitelist is built. Application-specific admission remains supported when its terminal View is explicitly exposed, such as a Booking confirmation. Privileged store inspection is preserved. No exports or configuration shapes were added or removed.

## Reviewed operating boundaries

Mount `ServiceRuntime.handler` at the public server boundary. It applies the configured service-wide bearer authorization, allow/deny policy, exact-origin CORS and rate limits before public dispatch. Lower-level Module handlers, stores and operations APIs are privileged embedding interfaces; they do not independently supply the outer service authentication policy. Failure inspection, acknowledgment, retry and retention operations are not exposed as HTTP routes by the configured service. A bearer credential authorizes the service; it does not implement per-user or per-row authorization. Use TLS at the ingress and add application authorization where the domain requires it.

HTTP admission limits body size, rejects malformed UTF-8 and undeclared inputs, and emits safe runtime diagnostics. SSE emits declared terminal business data or safe failures, not execution steps. Public Views intentionally return modeled business fields; telemetry redaction does not redact domain data selected by those Views.

ACL HTTP requests reject credential-bearing endpoint URLs, do not follow redirects, bound response size and execution time, whitelist declared result fields and send stable idempotency keys. Secret resolution remains outside semantic artifacts. Vault requires HTTPS and reports safe errors. External providers must honor their idempotency contract; the framework does not promise exactly-once external effects.

Failure queues expose safe codes and operational metadata rather than request/response bodies. Outbox retry preserves the original Event identity. Failure acknowledgment does not repeat a Saga; pruning resolved failure metadata preserves durable receipts. Domain input and declared ACL results may remain in privileged durable Saga state. Operators must protect database access and backups accordingly.

Telemetry redaction is key-based, including nested values. Callers must avoid embedding secrets in arbitrary unlabeled strings or business keys and configure additional redaction keys when necessary. Generic persisted delivery diagnostics intentionally trade provider text for confidentiality; investigate through protected provider systems and correlation IDs. Fixed-window process-local rate counters reset on process restart and are not a distributed ingress quota.

## Verification and limits

Affected TypeScript compilation and scoped Biome checks pass. The combined HTTP, ACL, secret, telemetry, delivery and deployment regression run passes 75 tests with no skips. The additional persisted SSE isolation regression passes against real PostgreSQL with an isolated schema and cleanup. It tests the actual configured Module HTTP boundary and public durable store, without replacing store reads/waits. The emitted CLI subprocess regression is distinct from installed-tarball checks.

Within this reviewed scope, the concrete credential-persistence and public-terminal exposure findings are resolved; no unresolved P0/P1 finding was identified. Whole-package compatibility, consumer dogfood, supply-chain evidence and release approval remain separate gates. These results do not establish arbitrary application authorization or confidentiality for deliberately exposed business Views.
