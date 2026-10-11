# Phase 9 supply chain audit

The framework has zero reported npm advisories in both runtime and complete dependency graphs. The active Commerce release consumer was upgraded from pinned `@aws-sdk/client-s3@3.922.0` to pinned `3.1149.0`: its original lock contained 19 vulnerable packages, including a critical `fast-xml-parser` advisory. Both graphs now report zero advisories. The original phase-8 archive and `/workspace/vane-dogfood` consumer files remain historical evidence; this correction is in `/workspace/vane-release-consumers/apps/commerce` and must be incorporated into the phase-9 archive.

## Actual verification

Commands executed on Node 24.19.0 (the machine version is also recorded per evidence):

```sh
npm audit --omit=dev --json
npm audit --json
npm pack --dry-run --json
node scripts/release/audit.mjs --output docs/evidence/phase9/supply-chain-current.json --consumer /workspace/vane-release-consumers/apps/commerce
```

In the active Commerce directory:

```sh
npm install --save-exact @aws-sdk/client-s3@3.1149.0 --ignore-scripts
npm run typecheck
npm run build
npm audit --omit=dev --json
npm audit --json
```

The update and both type checks completed successfully. Full runtime/S3 dogfood must run against the final RC tarball after the coordinator refreshes the active consumer dependency; the old phase-8 tarball run is not evidence for the new release artifact.

`supply-chain-baseline.json` records the original runtime/full audit and a real nonzero blocking result for the external critical advisory. `supply-chain-current.json` records the updated inventories and advisory results. Current evidence is tied to the Git HEAD, a dirty-source flag, lock SHA-256, Node/npm versions, timestamps, package integrity and per-packaged-file hashes. Re-run after the final build/version changes to bind the evidence to the release candidate.

## Advisory disposition

| Scope | Initial result | Disposition |
| --- | --- | --- |
| Vane runtime | 0 vulnerabilities, 15 production dependency nodes | No dependency change needed. `pg@8.23.0`, `typescript@5.7.3` remain exact pins. |
| Vane full | 0 vulnerabilities, 27 total dependency nodes | Development graph clean too. |
| Commerce runtime/full | 19 affected packages: 18 moderate, 1 critical | Upgrade direct SDK to exact `3.1149.0`, regenerating lock; both audits now zero. |

The original critical advisory is [GHSA-m7jm-9gc2-mpf2](https://github.com/advisories/GHSA-m7jm-9gc2-mpf2), entity encoding bypass through DOCTYPE entity names in `fast-xml-parser >=5.0.0 <5.3.5`. Its original graph also includes high DoS advisories [GHSA-37qj-frw5-hhjh](https://github.com/advisories/GHSA-37qj-frw5-hhjh), [GHSA-jmr7-xgp7-cmfj](https://github.com/advisories/GHSA-jmr7-xgp7-cmfj) and [GHSA-8gc5-j5rx-235r](https://github.com/advisories/GHSA-8gc5-j5rx-235r). The audit's maximum severity per affected package makes the summary show one critical package and zero high packages; the underlying advisory records retain the high findings. The supported direct SDK upgrade removes that affected transitive chain instead of forcing a parser override across unverified SDK versions. npm reports the direct update as non-major. No waiver or reliance on local-only exposure is used to pass the gate.

The AWS SDK belongs to the external application, not the Vane npm archive. Nonetheless, the external regression runner is part of the release evidence, so its critical dependency is fixed. No real AWS credentials, account endpoints or production data are used.

## Packaged content and licenses

The baseline pre-version-bump dry-run archive contained 155 files: `LICENSE`, `README.md`, `package.json`, and compiled `.js`, `.d.ts` and their `.map` files under `dist`. At that baseline no source tests, examples, infrastructure fixtures, `.env`, credential files, application databases, payment ledger, consumer archive or release evidence are included. The RC intentionally also packages top-level `docs/*.md` public guides, `api-manifest.json`, `CHANGELOG.md`, and the Sales/Billing example’s `.mjs`, `.vane.ts` and `README.md`. These exact path forms are allowed; nested evidence/archives, unrelated examples and arbitrary extensions remain forbidden. Source maps are expected development metadata; package inspection records their hashes too. The gate rejects any unrecognized archive path and scans package bytes for high-confidence private-key, AWS access-key, GitHub-token and literal long bearer-token markers without printing matched values. This is a bounded credential-pattern scan, not a claim that every possible secret representation is detected.

All framework locked dependencies have declared permissive licenses: MIT, ISC, Apache-2.0, and MIT OR Apache-2.0. Updated Commerce dependencies are also accepted by the explicit license allowlist. Every non-root locked dependency has an integrity value. Inventory includes the full lock graph (optional platform entries included), versions, declared licenses, integrity and source URL. Dependencies are installed separately by npm and are not bundled into Vane's tarball; license declarations are audited rather than silently inferred.

## Gate behavior

Run `node scripts/release/audit.mjs --consumer <active-consumer>` for each release consumer to include it in the gate; repeat `--consumer` as needed. `--output <path>` selects retained evidence. The command exits nonzero for high/critical advisories, unavailable/invalid advisory results, missing dependency integrity, unknown/unreviewed licenses, unexpected package files or credential-pattern matches. Lower-severity findings remain visible in raw audit evidence and must receive explicit disposition in release review; they are never deleted from the report. There is no exemption/waiver switch.

The audit is advisory-database evidence at execution time, not a guarantee against unknown vulnerabilities. Build before running it, and execute the final RC gate against the same identified package and regenerated active-consumer locks used by the external suites.

## Canonical archive verification

Use `--tarball /absolute/path/canonical.tgz` for the release gate. This reads and hashes the provided artifact bytes; it never recomputes npm pack and never extracts paths. The bounded in-memory gzip/tar reader validates checksums, complete archive termination, unique `package/` paths and regular-file-only entries; symlinks, hardlinks, extension records and traversal are rejected. Evidence `package.sha256` is the canonical archive identity and must equal the release-pack manifest’s archive SHA-256. Archive package name, version and production dependencies must match the clean source checkout executing the script. A dirty/missing Git identity blocks release-archive mode; dirty work-in-progress is permitted only in explicitly marked `preliminary-dry-run` mode. Write final evidence outside the clean candidate checkout to avoid making the checkout dirty.

```sh
node scripts/release/audit.mjs --tarball /absolute/path/canonical.tgz --consumer /workspace/vane-release-consumers/apps/commerce --output /workspace/vane-release-evidence/supply-chain.json
node --test scripts/release/audit.test.mjs
```

Meaningful gate tests cover high/critical rejection, absent/failed advisory responses, exact intended package paths, credential-marker redaction, regular-file inspection, links and path traversal. All three tests pass. A real negative run against the old phase-8 tarball from the dirty RC workspace exited 1 with both source-provenance and package-identity findings, as required.
