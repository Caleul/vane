# Release v0.1 — candidate operation

The candidate is `@lilka/vane@0.1.0-rc.1`. Its npm prerelease tag is `next`;
`latest` is reserved for the separately validated `0.1.0` GA release.
This document describes the candidate; registry availability must be verified
from release evidence before using a registry install.

## Local candidate gates

Use Node 24.19.0, `npm ci`, then `npm run verify`, `npm run test:release`,
`npm run release:api` and the real PostgreSQL integration suite.
Commit reviewed source before packaging. Run `npm run release:pack -- --out
/absolute/outside/checkout --manifest /absolute/outside/checkout/manifest.json`.
The manifest records version, commit, tree, runtime and exact package integrity.
The same tarball must feed conformance, independent consumers, supply-chain
inspection and `npm run release:upgrade -- --tarball /absolute/candidate.tgz`.
`npm run release:reproducibility -- --out /absolute/reproduction` checks two
clean checkouts under different umasks; it cannot replace runtime validation.

The Release readiness workflow preserves the tarball and evidence. CI and the
external-consumer workflow must pass on the same source revision. Publication
uses the tested tarball rather than repacking source on the publishing runner.
Configure npm publishing through CI credentials or trusted publishing; GitHub
repository access does not establish npm scope ownership.

## Operational boundaries

PostgreSQL 16.15 is the tested backend. The package engine admits Node 24 from
24.19.0 onward within that major; future minor patches still need CI validation.
Only the documented root export and CLI are entry points. Runtime, inspection
and failure-queue capabilities are privileged application operations; keep
configuration and service credentials in trusted deployment code.

Delivery and external gateways use at-least-once semantics. Supply durable
idempotency keys and transactionally persistent receipts. Retry and retention
need explicit operational configuration and monitoring; filtered telemetry is
not a substitute for sanitizing application-owned logs.

Reservation's trusted-clock/CAS pattern remains application-specific. Moto
validates the exercised S3-compatible operations, and its disposable state is
not production durability evidence. AWS smoke remains opt-in when a critical
fidelity gap requires it. No new distributed runtime or storage backend is
introduced by this release.

## Promotion

A successful registry RC install must precede an explicit API, documentation
and security review of that published artifact. Findings require disposition
and renewed gates after changes. Prepare GA with version and lockfile 0.1.0,
then repeat package, install/upgrade, conformance, integration, independent
consumer and security gates. Publish GA and tag its exact commit only after
these obligations and the post-publication RC review are recorded.
