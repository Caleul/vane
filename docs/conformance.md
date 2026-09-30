# Entity Event v0.1 candidate conformance

This suite is an independent, source-grounded **Phase 7 candidate gate**.
Completion is established by its executed report, not by the existence of tests.
Required missing evidence is a blocker; Phase 8 external validation and Phase 9
release work remain separate. Passing the
existing Vane unit/integration suite is valuable regression evidence but does not
silently satisfy this suite.

## Normative baseline and traceability

`conformance/catalog.json` contains stable EE identifiers, source references,
category, applicability, precondition, action, observable expectation and the
required independent case IDs. The 130 numbered functional requirements retain
their suffix (`FR-EVT-001` → `EE-EVT-001`). Additional IDs cover unnumbered
nonfunctional, vocabulary, artifact, reference, CLI and decided-pivot obligations.
IDs must not be renumbered when tests change.

Authority: Vocabulary → functional PRD v0.1 → Validation & Release Phase 7;
explicitly decided implementation pivots refine the public grammar. The old
illustrative member-decorator grammar is superseded by public member factories.
The sources and all 450 captured clause dispositions are in
`conformance/source-inventory.json` and `conformance/source-map.json`.
Context, duplicate obligations, historical assertions and process requirements
have explicit dispositions. Future productive distributed deployment is N/A;
preserving boundaries/mapping in IR remains required. Shared physical databases
are not silently waived merely because productive distribution is future scope.

The [generated evidence matrix](conformance-matrix.md) maps requirement → cases
and outstanding evidence. Run `node conformance/generate-matrix.mjs` after an
intentional mapping change, then format `conformance/catalog.json` with Biome.
The catalog and mapping must be reviewed together; generating a map does not
constitute evidence. Every mapped case is conjunctive, and a missing mapped case
is a runner error. Explicit `evidenceGap` prevents a narrow test from certifying
an entire broader requirement.

## Run against the actual packaged API

Requires Node 24+, npm and (for database evidence) a disposable PostgreSQL 16+
database. Generated-image evidence additionally requires a working Docker
engine on Linux and `VANE_CONFORMANCE_DOCKER=1`; otherwise that requirement
remains GAP. CI exercises this on its disposable runner with host networking so
the generated application can reach the test-only PostgreSQL and ACL servers.
Use a test-only database URL; the suite creates randomly named schemas
and drops only those schemas in `finally` blocks. Never use production.

```sh
npm ci
npm run verify
npm run test:conformance:package
VANE_CONFORMANCE_DATABASE_URL=postgresql://user:password@localhost:5432/vane_conformance \
  npm run conformance -- --out /tmp/conformance-report.json
```

`pack-and-run.mjs` packs the built library, installs the tarball into a fresh OS
temporary consumer outside the repository, then invokes the suite. Its writable
cache defaults to the OS temporary directory; set `VANE_CONFORMANCE_NPM_CACHE`
to choose another test cache. It does not
use workspace links, import `src/*`, use internal fixtures or load private
snapshots. The package remains `private: true`, version `0.0.0`; packing for tests
is not publishing a release. Package integrity SHA-256, source commit (including
an explicit dirty marker), catalog hash, Node/package versions and actual
PostgreSQL version are report metadata. An unexercised PostgreSQL version is null.

The wrapper also passes the exact tarball path to generated-application cases.
The runner verifies its bytes against `--tarball-sha256` before exposing it to
the adapter; an independently supplied `--tarball-path` requires that hash.

For machine-only stdout, build once and invoke the wrapper directly:

```sh
npm run build
node conformance/pack-and-run.mjs --json --out /tmp/report.json
node conformance/pack-and-run.mjs --category semantic
node conformance/pack-and-run.mjs --id EE-ENT-002
```

The runner can also target an already installed package:

```sh
node conformance/runner.mjs --package-root /tmp/consumer/node_modules/@lilka/vane \
  --commit <tested-commit-sha> --json
```

`--category` accepts semantic, persistence, runtime, contract, saga or operations;
`--id` can repeat. Unknown/empty filters fail closed. Filtered reports are always
marked as such and cannot claim the full release gate, even when their exit is 0.

## Results and evidence limits

- PASS: all mapped assertions passed and no broader evidence gap is recorded
- FAIL: a normative assertion failed (classified BUG, subject to reproduction)
- GAP: evidence is missing, partial or its prerequisite unavailable (classified
  MISSING **evidence**, not automatically a missing product capability)
- N/A: explicitly outside current scope, with a versioned rationale

Exit 0 means the selected required requirements pass; exit 1 means at least one
required FAIL/GAP; exit 2 means invalid invocation, adapter/setup/catalog error.
JSON and human reports include requirement, status, duration, case IDs and
observable evidence. Assertion values/errors are deliberately not dumped into
reports because a failed secrecy test can itself contain credentials. Reproduce
the named case to investigate locally without publishing sensitive output.
Each asynchronous case has a 60-second default ceiling; explicitly declared
case budgets may extend up to 5 minutes for cold image build/run evidence. The
packaged CLI has a 10-minute process ceiling. These are execution safety budgets, not normative performance
measurements. Cases must still bound and clean up their own I/O.

No waiver mechanism currently converts a missing requirement into a pass. Any
exception must be a reviewed versioned change with explicit scope and authority;
conceptual ambiguity returns to the normative baseline before changing tests.
Performance gates remain unmeasured until representative hardware, warmup,
sample sizes and timing boundaries are specified and recorded. Reference-app
review and operational process/signal evidence cannot be inferred from compiler
metadata or doubles. Every GAP includes a reproducible precondition/action in the
catalog; the matrix identifies which additional evidence is still required.

The `conformance` CI job is intentionally a strict candidate gate. It uploads
JSON even on failure; a red gate remains red while required gaps or bugs exist.
Harness self-tests and the preexisting regression jobs can pass independently.

## Sanity and another implementation

`npm run test:conformance:package` executes the real tarball adapter and the
intentionally invalid adapter. The latter silently creates a missing identity.
The sanity assertion requires the normal adapter to PASS EE-ENT-002 and the
mutant to FAIL that exact requirement; an unrelated GAP/nonzero result cannot
satisfy the check.

An alternative implementation supplies an ESM module exporting
`async createAdapter({packageRoot})`. It returns `{name, api, packageRoot, package,
cli}`; `cli(args, options)` returns `{status, stdout, stderr}`. `api` implements the
public operations consumed by the cases (semantic compilation, materialization,
public runtime/contract/configuration ports). An implementation with different
public names can translate into this documented adapter contract; adapters may
not inspect private state to manufacture a pass. The Entity Event IDs, normative
fixtures and expected observations stay unchanged. This first adapter contract
is Vane-shaped, not a claim of a universal cross-language protocol. Public DSL
and TypeScript consumer fixtures import `@lilka/vane`; another implementation
needs an installed public compatibility facade/alias for those names and types,
or a reviewed adapter extension translating these fixtures without weakening
their observations. The report must identify the actual target and facade. Use `--adapter <module>`.
The included adapter resolves only the installed package's declared root export
and `entity-event` bin, verifies they remain within the package, and does not
fall back to source. PostgreSQL cases additionally load the installed public `pg`
driver and use public runtime/provider objects; SQL asserts observable database
state, not compiler-private snapshots.

Phases 8 (dogfood/Moto/general local integration tooling) and 9 (release/API
policy/publication), and any future general-purpose harness product, are outside
this change.
