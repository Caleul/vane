# Phase 5: ServiceConfiguration

## Authority and decisions

- Decided: PRD §8.7, §8.8 and §15 phase 5, and normative vocabulary,
  retrieved from Notion on 2026-09-04. Baseline main: 014d08b (phases 1–4).
- Decided: one typed root binds a Semantic Project and explicitly registered
  providers. Profiles inherit one parent; maps merge by key, arrays and complete
  provider selections replace, and policy objects merge by field.
- Decided: precedence is framework baseline < application defaults < service
  override < qualified Event override. Plans expose each field's source.
- Decided: Node 24, PostgreSQL 16+, one explicitly named monolithic service.
  Technical IR retains explicit module/service/entity ownership for future
  distribution. No public distributed builder or remote apply.
- Decided: static compilation produces all four technical IRs atomically, plus
  redacted effective configuration, provider capability reports and artifact
  hashes. Existing storage, contract and Saga materializers remain authoritative.
- Decided: configuration owns HTTP ACL mappings and symbolic secret slots.
  Local literal secrets warn, staging/production reject them. Secrets never
  enter plans, hashes, diagnostics or generated files.
- Decided: phase 5 resolves execution policies; advanced durable retries,
  recovery/backoff scheduling, failure-queue operations, telemetry exporters,
  retention, production vault integration and the reference application belong
  to phase 6. Plans identify this boundary explicitly.
- Completed: compiler, bootstrap, generation, public types, negative cases,
  profile switching, PostgreSQL integration and generated Docker image smoke.
- Decided: explicit Node worker start, service-wide fixed-window HTTP quota,
  bearer/allow-deny security and separate secret resolver boundary.
- Decided: bootstrap rejects policies requiring deferred execution rather than
  accepting them silently; the static plan remains fully inspectable.
