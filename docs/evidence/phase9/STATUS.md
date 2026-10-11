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
| A2 | External dependency | Local npm ENEEDAUTH; GitHub secret listing HTTP403, not evidence of absent secrets; npm scope ownership unverified |
| B1/B2 | Complete for candidate | Versioned335-export manifest, API/package review, compatibility policy |
| C1/C2 | Complete prepublication | Security regressions and package review; isolated durable SSE, filtered errors/telemetry, operational limits |
| C3 | Complete for candidate | Actual tarball and all3consumer dependency audit PASS; Commerce SDK updated, historic baseline preserved |
| D1/D2 | Complete | 193-file canonical public-ready package; two clean clones umask022/077 produced identical bytes |
| D3 | Complete for tarball | Real baseline0.0.0→RC upgrade, persisted state/terminals, type/CLI negatives, twice no-op migration, restart |
| D4 | Complete | Changelog, release/operations/API/compatibility/security guides shipped |
| E1 | Local gates PASS; remote pending | 252 unit,50 PG,15conformance selftests,12release selftests; conformance161PASS/0FAIL/0GAP/1N/A;21external groups and fresh adoption PASS |
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
