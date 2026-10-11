# Phase 8 — external consumers and acceptance

Authority: [Phase 8 — DevXP & Dogfood](https://www.notion.so/3d251cfc265c81ec965fc7a54f78b8d8).
The [implementation plan](phase-8-plan.md) is complete. This integration preserves
the independent consumers and their executed evidence in the main repository.

## Executed candidate

- Framework commit: `12ee6a1182f7c6750e02cf3cf6dd4a3b5663ac2e`.
- Framework tree: `e4c8fa170d3d6a36bca533f9f3df0526e3678b59`.
- External consumer commit: `01e960c` in the independent `vane-dogfood` repository.
- Package: `@lilka/vane@0.0.0` (unpublished).
- Tarball SHA-256: `786c90654e9430cb32233d2b7647656c09a8cf8a2bbae54de2b1d2a6cf5ce043`.
- Final run: `6282d09a-bb44-4181-9b45-6dca4f3c5378`.
- Environment: Node 24.19.0, PostgreSQL 16.15, Moto Server 5.1.18, pinned image digests.

The [candidate identity](evidence/phase-8/candidate.json),
[aggregate manifest](evidence/phase-8/manifest.json),
[independent review](evidence/phase-8/REVIEW.md), and
[friction register](evidence/phase-8/FRICTIONS.md) summarize the preserved run.
Paths in the review/register refer to the extracted consumer project.

## Acceptance

| Gate | Executed result |
| --- | --- |
| Framework checks/build/unit tests | PASS; 248 tests |
| Conformance harness self-tests | PASS; 14 tests |
| PostgreSQL integration | PASS; 48 tests |
| Independent conformance | PASS; 107 cases, 161 required PASS, zero FAIL/GAP |
| Todo/Project | PASS; TD-01–06 |
| Commerce, durable payment ACL, Saga and S3/Moto | PASS; CM-01–07 |
| Reservation/Booking, scheduler and external ledger | PASS; RB-01–08 |
| Capacity-one races | PASS; 50 rounds |
| Confirmation/expiration races | PASS; 50 on/after deadline and 10 before deadline |
| Independent clean adoption | PASS; all three apps, zero core-source consultations |
| Installed package identity | PASS; locks and 155 packed files verified per app |
| Portable evidence | PASS; 49 exported artifacts verified byte-for-byte |

P1 corrections include generated image trust/ownership, report identity enforcement,
overlapping external retry deduplication, and Booking allocation/state guards.
Documented P2 limits include CLI help exit 1, Moto restart volatility and the public
right-nested OR workaround for PostgreSQL CHECK comparison. No P0/P1 or conceptual
pivot remained open in the accepted run. Todo and Reservation AWS integrations are
explicit N/A; Commerce supplies applicable Moto evidence. No real AWS smoke was run.

## External project and reproduction

[consumers.tar.gz](evidence/phase-8/consumers.tar.gz) contains the complete independent
consumer source, public docs, normal npm lockfiles, original tarball, full `REPORT.md`,
raw manifests, HTTP/SSE/crash/snapshot/ledger evidence and portable reproduction logs.
It excludes dependencies, generated build output, Git internals and `.env.local`.
Its SHA-256 is recorded in [consumers.sha256](evidence/phase-8/consumers.sha256).

Extract into a sibling directory outside this checkout:

```sh
tar -xzf docs/evidence/phase-8/consumers.tar.gz -C ..
cd ../vane-dogfood
npm run setup
npm run typecheck
npm test
npm run cleanup
```

Setup replaces the named disposable dogfood containers and their data. The source
README explains individual migrate/start/test/cleanup commands. The original
candidate can also be reconstructed from the public PR #14 baseline plus the
versioned patch included in the archive.

The `Phase 8 external consumers` GitHub workflow extracts into the runner temporary
directory, builds and packs the current clean framework checkout, records fresh
package/docs provenance, and executes all consumers and independent adoption.
It uploads evidence and cleans services even on failures. Archive reports describe
the historical accepted run; each CI run produces its own identity and gate result.
The workflow refreshes the external file-dependency locks against its freshly
packed tarball before installation and records those locks in the new source
identity. This includes README-only changes because npm always packs README.
Evidence from an old package cannot establish a new RC.

Release preparation follows the [Phase 9 plan](phase-9-plan.md).
