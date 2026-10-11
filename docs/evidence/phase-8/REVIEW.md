# Independent Phase 8 acceptance review

Verdict: **PASS for the executed Phase 8 scope**. Reviewed the exact Notion specification in `PHASE8-SPEC.md`, consumer implementations, public documentation/declarations, final scenario manifests and exported raw evidence. No mandatory FAIL/GAP or unresolved P0/P1 remains in the reviewed final run.

Final run: `6282d09a-bb44-4181-9b45-6dca4f3c5378`, completed 2026-10-10 at 01:39:51 UTC. Package source commit `12ee6a1182f7c6750e02cf3cf6dd4a3b5663ac2e`, tree `e4c8fa170d3d6a36bca533f9f3df0526e3678b59`, tarball SHA-256 `786c90654e9430cb32233d2b7647656c09a8cf8a2bbae54de2b1d2a6cf5ce043`.

## Identity and independent adoption

Verified the current tarball bytes, all three installed-package integrity reports, required scenario IDs, shared final run ID, current consumer source hashes and supplied public documentation hashes against the independent manifest. Fresh clean-copy reproduction ran literal documented install, typecheck, build, cleanup, migration, start and test commands. Real HTTP/SSE Event/View assertions passed. This reviewer read public guides, installed public declarations and external consumer code, with **zero core-source consultations**. Implementer source consultations remain explicitly separate in consumer READMEs and the friction register.

Measured time from clean adoption start to the first completed functional Event/View scenario: Todo 5,529 ms; Commerce 7,743 ms; Reservation 5,396 ms. These are observations of this environment, not product performance guarantees.

The final aggregate TD-06 combines the executed `TD-06-package` type/package fixtures with fresh independent adoption. Package-only tests were never substituted for the adoption obligation.

## Scenario-level coverage

| Groups | Executed obligations reviewed |
| --- | --- |
| TD-01–02 | Project/Todo identity, explicit reference, owner-only mutations, numeric Rule, filtered ordered pagination, invalid type/reference/duplicate identity/over-completion, unchanged protected rows on rejection. |
| TD-03 | Invalid reference and foreign-owner operation, actionable diagnostics, missing mandatory binding, actual nonzero negative subprocess exits and corrected declaration/binding reruns. The formatter-sensitive mutation was corrected and every invalid variant must differ from its baseline source. |
| TD-04–05 | Fresh PostgreSQL connection and stable schema/history after restart; actual SIGKILL at durable admission and committed Entity execution before Saga checkpoint; same stored envelope, single revision/effect and duplicate replay. |
| TD-06 | Installed public types and negative TypeScript fixtures plus independent clean-copy documentation reproduction. |
| CM-01–02 | Stock 2→1, coupon consumed once, one authorization, completed order and exact S3 content/hash; overstock, missing User/Coupon, actually consumed Coupon, decline, malformed/undeclared response and nonpositive values reject without undue charge. |
| CM-03–04 | Stable key/Event identity, bounded attempts/backoff and safe exhaustion with operational evidence; reverse-causal compensation, refund retry/exhaustion, remaining compensation continuation, actual Moto shutdown after authorization, immutable terminal after failure acknowledgment. |
| CM-05–07 | Runtime/gateway SIGKILL at committed Entity and committed payment effect barriers; persistent provider ledger; terminal-only SSE disconnect/restart/reconnect and fresh persistence reads; actual S3 round-trip, emulator restart loss/recreation, scoped cleanup and neighboring-schema preservation. |
| RB-01–02 | Successful reservation/confirmation/cancellation and **50/50** capacity-one races; allocating/cancelled losers cannot confirm or expire against the winner's capacity, with unchanged owner rows/ledger and zero forbidden admission. |
| RB-03–04 | Forged premature expiration rejected using trusted clock; scheduler restarts around persisted deadlines, late confirmation rejected and existing expiration Saga reused; **50/50** on/after-deadline races plus **10/10** predeadline confirmation contenders, checking the atomic decision counter and durable capacity. |
| RB-05–06 | Recovery within the deadline, overdue/exhausted failure and release, inspectable compensation failure; overlapping timed-out provider requests produce one append-only journaled effect; runtime/provider crashes preserve envelope/key and converge, including committed Release before checkpoint. |
| RB-07–08 | Exact-envelope duplicates, lease reclaim and stale-token fencing; publication exhaustion/list/retry preserving Event ID, failure resolution/pruning without replay or terminal mutation; invalid capacity/binding/policy/provider and changed adapter against existing pending work; privileged inspection absent from public routes and safe terminal reconnect. |

All **21 required scenario groups** pass in the final integrated run. Counts above are summaries of individually checked case IDs, not transferred framework conformance totals. Todo and Reservation AWS cases are explicit N/A because their concrete integrations do not use AWS.

## Raw evidence and limits

Verified all **49 exported evidence files** byte-for-byte against their SHA-256/length index and checked every actual process command has a portable exported log. Environment assignments remain literal README command records. See `evidence/manifest.json`, `evidence/independent-reproduction.json`, the three consumer JSON/Markdown reports, and `evidence/reproduction/6282d09a-bb44-4181-9b45-6dca4f3c5378/index.json`.

Reviewed the final framework check logs separately: PostgreSQL integration reports 48 passing tests and no skips/failures; final conformance reports 161 PASS, zero FAIL/GAP, one explicit future-distribution N/A and zero required blockers. Those results support the identified package but do not replace the new consumer scenarios.

The accepted P2 limits remain explicit: CLI help prints usable Usage but exits 1; untyped initial migrations must supply `previous: null`; logically equivalent left-nested OR CHECKs can cause startup comparison drift, with a documented public right-nested DSL workaround verified through repeated migration/start; Moto loses in-memory S3 objects on process restart and does not prove production AWS fidelity. No real AWS smoke, publication, merge or distributed-runtime claim is part of this review. The new CI workflow is configured to run the same scripts; this verdict concerns the actual local Docker/Node/PostgreSQL execution, not an unexecuted hosted CI run.

P1 issues were corrected and rerun, including generated Docker CA/ownership adoption failures, false evidence identity/coverage, delayed provider deduplication and Booking state/capacity theft. No ontological pivot, domain SQL workaround or private package import was required.
