# Phase 9 RC implementation gate

The implementation candidate is source commit
`216b1557af89dbb77a0af3e51a727fcf28469561`, version `0.1.0-rc.1`.
Canonical package SHA-256:
`b467027e13687831b0f073b4bd07cf140063ae446cec7d9fc7a29bb4964fea29`.
The candidate manifest identifies exact bytes, source tree and toolchain.
Evidence-only commits do not publish a package or constitute registry validation.

| Tasks | State | Evidence |
| --- | --- | --- |
| A1 | Complete | Baseline main remote CI runs 38100192428/38100192499 |
| A2 | Blocked externally | Local npm ENEEDAUTH; publishing job received empty NPM_TOKEN and OIDC npm publish failed; npm scope ownership remains unverified |
| B1/B2 | Complete for candidate | Versioned335-export manifest, API/package review, compatibility policy |
| C1/C2 | Complete prepublication | Security regressions and package review; isolated durable SSE, filtered errors/telemetry, operational limits |
| C3 | Complete for candidate | Actual tarball and all3consumer dependency audit PASS; Commerce SDK updated, historic baseline preserved |
| D1/D2 | Complete | 193-file canonical public-ready package; two clean clones umask022/077 produced identical bytes |
| D3 | Complete for tarball | Real baseline0.0.0→RC upgrade, persisted state/terminals, type/CLI negatives, twice no-op migration, restart |
| D4 | Complete | Changelog, release/operations/API/compatibility/security guides shipped |
| E1 | Local and remote gates PASS | 252 unit,50 PG,15conformance selftests,12release selftests; conformance161PASS/0FAIL/0GAP/1N/A;21external groups and fresh adoption PASS |
| E2/E3 | Pending | RC not published; registry install and published-RC API/docs/security review required |
| F1/F2 | Pending | GA cannot promote before E2/E3 and new version/artifact gates |

Fresh external run: `020433ce-0603-443f-a4c1-1281b25fe282`; exported49
files are preserved under `reproduction/`. Consumers use the candidate package
through normal external installs. The archived original Phase8 package remains
unchanged and is the actual upgrade baseline.

An initial upgrade attempt was interrupted by coordinator provisioning that
restarted the shared database. Full rerun passed with stable infrastructure.
The first local Docker conformance attempt lacked the managed proxy CA; another
full attempt returned a generic Docker-case failure. Standalone generated
Docker execution passed with CA configured, then the complete conformance rerun
passed on the identical tarball. Initial failed attempts remain in workspace
scratch logs; no failed or skipped gate is counted as passing evidence.

Publication workflow is RC-only, requires all three trusted push workflows
successful at exactly main HEAD, downloads their canonical artifact, verifies
hashes, publishes `next` with provenance, and checks registry integrity and
fresh installed bytes before creating the tag/prerelease. There is no npm
publication receipt yet. Prepublication reviews explicitly do not satisfy
PRD published-RC review E3. No GA or npm availability is claimed.

## Remote execution and publication dependency

All three trusted push workflows passed on main
`7d4342f40d927b23503ce6202bbc2ecb447091d3`, reproducing the exact canonical
package hash recorded above:

- [CI](https://github.com/Caleul/vane/actions/runs/38101819997)
- [External consumers](https://github.com/Caleul/vane/actions/runs/38101819999)
- [Release readiness](https://github.com/Caleul/vane/actions/runs/38101819959)

[RC publication attempt](https://github.com/Caleul/vane/actions/runs/38102153910)
verified source gates and downloaded the canonical artifact, then failed at
`npm publish`. The publishing job received an empty `NPM_TOKEN` and tried its
OIDC fallback. Provider error text was intentionally withheld, so this evidence
does not identify a more specific npm error code. A subsequent anonymous npm
query returned E404 for `@lilka/vane@0.1.0-rc.1`; no release tag exists.

Configure a repository `NPM_TOKEN` with publish authority for `@lilka/vane`, or
complete npm trusted-publisher configuration for `Caleul/vane` and `release.yml`.
Scope ownership and first-publication bootstrapping must be verified with npm.
No token needs to be pasted into chat. Once configured, rerun **Publish reviewed
RC** on the current green main revision. The workflow enforces fresh exact-head
CI gates automatically. Then validate the published RC with an explicit
API/docs/security review before preparing and gating GA.

This report is an evidence-only revision; its directory is excluded from the
npm package. Later push workflows still need to pass at its exact source HEAD
before publication, even though package bytes remain identical.

## Reservation deadline fixture follow-up

The evidence-only head `12ee991` passed CI and release readiness, but external
run [38102238889](https://github.com/Caleul/vane/actions/runs/38102238889)
failed RB-05 (`units 1 != 0`). Its independent fresh adoption still passed. The
failure log did not identify which of two capacity assertions failed and did
not include persisted Saga state, so its exact branch cannot be reconstructed.

Two independent reviews found no premature fail-terminal publication in the
runtime: terminal follows all eligible compensations of that Saga. The old
one-second overdue fixture permitted expiry before Claim/Hold. A failed Claim
has no Hold to compensate; expiry belongs to a separate Saga. Merely polling
capacity to zero would mask this missing precondition.

The updated Phase9 consumer archive changes only the Reservation test. It
uses the documented public runOnce control, disables automatic workers and
scheduler for this one scenario, proves durable Claim/Hold before deadline,
then delays the external attempt across the persisted deadline. It still
asserts immediate zero capacity after the same Saga's fail terminal and adds
successful Hold compensation, cancelled Booking and no external ledger effect.
Exhaustion assertions are labelled; external fail and multiple attempts are
explicit. Runtime package bytes remain unchanged. The initial corrected full
Reservation execution passed8/8; strengthened final assertions and fresh
archived-consumer CI require current evidence before the RC gate can pass.

The original Phase8 archive is immutable. Existing proofs above identify the
older tested consumer source; new CI artifacts identify the updated source
hashes. This follow-up supersedes their Reservation fixture readiness claim,
while preserving the successful historical results for review.
