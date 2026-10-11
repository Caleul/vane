# Changelog

## 0.1.0-rc.1 — release candidate

First public release candidate for the Entity Event model and PostgreSQL runtime.
Public exports, CLI and type signatures are recorded in `api-manifest.json`.
Node 24.19.x–24.x and PostgreSQL 16.15 are the validated baseline.

Compared with the private 0.0.0 validation candidate:

- Global CLI `--help` and `-h` succeed without loading application configuration.
- PostgreSQL CHECK comparison accepts associative AND/OR parentheses while
  retaining mixed precedence, negation, literal and actual drift checks.
- Retry persistence uses a generic error instead of storing provider messages;
  telemetry filters credential and error metadata aliases.
- Packaging is public-ready, includes API and operating guides, and reproduces
  identical bytes across clean checkouts with different file creation masks.
- Independent consumers exercise install, upgrade, restart, crash recovery,
  concurrency and S3-compatible side effects. Their Commerce SDK is updated
  to remove the dependency advisories found during release review.

Delivery is at least once. External operations need durable idempotency keys.
See `docs/compatibility.md`, `docs/public-api.md`, `docs/phase-9-security.md`
and `docs/phase-9-release.md` for boundaries and release gates.

Publication and GA are separate gates; a source version is not evidence that
that version is available from npm.
