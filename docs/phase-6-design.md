# Phase 6: robustness

## Decided

Authority: PRD v0.1 sections 8.9–9, 12–15 and 19, retrieved from Notion
2026-09-04 (page 3ca51cfc265c81b78834d4649a9048fb). Base: f553e08.

- Execute resolved retry/backoff with durable attempts and eligibility times;
  preserve Event identity across recovery and retries. Domain failures are final;
  transient infrastructure failures retry. Compensation has its own budget.
- PostgreSQL enforces Entity statement deadlines inside the transaction. Never
  race a write against a JavaScript timer and leave it running after failure.
- Save exhausted failures atomically with Saga transitions. Operators inspect and
  resolve failures; never rewrite an already published terminal or silently replay
  compensated business effects.
- Explicit telemetry configuration, structured safe metadata, spans and metrics;
  sensitive payloads are excluded by default. Internal causal inspection does not
  alter terminal-only public SSE.
- Explicit secret resolver and Vault KV v2 implementation; symbolic references only
  in production. No tokens in logs/artifacts.
- CLI migration diff/apply, development server and Event/Saga/failure inspection.
  Destructive migration approval remains bound to the exact migration hash.
- Reference Sales/Billing application, quickstart, recovery and operational tests.
- Retention is explicit and conservative: no automatic deletion of deduplication
  receipts or pending work; deleting receipts can invalidate at-least-once safety.

## Outside v0.1

Distributed service builder, distributed transactions, remote infrastructure apply,
other production databases/runtimes, public progress streams, visual UI and schema
hot reload in production.

## Completed implementation gates

Retry/restart/compensation; failure operations; telemetry and secret redaction;
CLI and reference app; full PostgreSQL gate; generated deployment smoke.
See phase-6-completion.md for evidence.

## Open

PR Codex review and correction loop.
