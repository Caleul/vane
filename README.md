# Vane

Vane is the reference implementation of **Entity Event**: a model and framework
for defining software through persistent Entities and the Events that happen to
them.

Vane currently implements the semantic compiler, PostgreSQL persistence and
public View/HTTP contracts, durable ACL/Saga execution and ServiceConfiguration:

```text
declarative module -> semantic validation -> deterministic Semantic IR
Semantic IR -> PostgreSQL Storage IR -> schema / migrations / runtime
Semantic IR + exposure -> Contract IR -> View SQL / HTTP / OpenAPI / terminal SSE
Semantic Saga + adapter bindings -> Saga plan -> durable execution / compensation
Semantic Project + ServiceConfiguration + profile -> Runtime / Storage / Contract / Infrastructure IR
```

Phase 5 adds typed profiles, explicit providers, capability negotiation, policy
precedence, safe inspection, CLI generation and configured monolithic bootstrap.
Production hardening continues in phase 6.

## Current guarantees

- a Module has a stable name;
- Modules compose through explicit, validated and deterministic imports;
- an Entity maps to a persistent concept and has exactly one identity Column;
- an Event owned by an Entity receives the stable identity `Entity.Event`;
- an Entity Event declares one owner-only `create`, `update`, `delete`, or
  `upsert` operation, including atomic numeric changes;
- an Event owned by an Anti-Corruption Layer receives the stable identity
  `ACL.Event` and interprets external results only as `success` or `fail`;
- a Saga is a validated causal DAG of Entity/ACL Events whose branches converge
  on one terminal step, exposing only a final View or fail;
- a Rule references at least two Columns from its own Entity;
- a View has typed input and output, owns its query, never persists, and is a
  public result; relations follow explicit Column references;
- the exported decorator/helper DSL is checked by positive and negative
  TypeScript fixtures;
- invalid definitions return actionable diagnostics and never a partial IR;
- equivalent declaration orders produce byte-identical serialized IR;
- the Semantic IR contains no runtime, provider, transport, credential, or
  infrastructure decisions.
- PostgreSQL Storage IR and DDL deterministically materialize all Entity Column
  types, constraints, references and Rules;
- content-addressed migration plans require approval bound to the exact hash for
  unsafe or destructive changes, with explicit rename maps;
- mailbox deduplication, owner mutation and outbox append share a transaction;
- outbox claims use recoverable leases and honestly provide at-least-once
  delivery.
- PostgreSQL executes each View-owned query with validated input and
  parameterized filters, joins, ordering and pagination;
- versioned Contract IR preserves internal identities while mapping explicit
  public paths and terminal Views;
- deterministic OpenAPI describes typed Event, View, safe fail and terminal SSE
  contracts;
- public Events return only `202` plus `sagaId`; their terminal stream exposes
  only the final View or safe fail, never revisions or operational progress.

## Development

Vane requires Node.js 24 or newer.

```bash
npm install
npm run verify
```

The PostgreSQL integration gate requires PostgreSQL 16 or newer:

```bash
VANE_TEST_DATABASE_URL=postgresql://user:password@localhost:5432/vane \
  npm run test:integration
```

See [the semantic compiler boundary](docs/semantic-compiler.md) for the public
grammar, [the phase 1 completion matrix](docs/phase-1-completion.md) for the
semantic baseline, and [the phase 2 completion gate](docs/phase-2-completion.md)
for PostgreSQL/runtime traceability. The [PostgreSQL guide](docs/postgresql.md)
covers materialization, migrations, dispatch and outbox delivery. The
[phase 3 completion gate](docs/phase-3-completion.md) covers executable Views,
HTTP, OpenAPI and terminal-only public results.

The [phase 4 completion gate](docs/phase-4-completion.md) covers executable ACL
Events, durable Saga admission, causal DAGs, compensation and terminal SSE after
restart. See [the Saga runtime guide](docs/sagas.md) for explicit adapter wiring,
input bindings and recovery guarantees.

See [ServiceConfiguration](docs/service-configuration.md) for profiles, provider
selection, policies, ACL/HTTP configuration, secret bindings, CLI and deployment
artifacts. The [phase 5 completion gate](docs/phase-5-completion.md) records
validation and the exact runtime boundary for policies deferred to phase 6.
