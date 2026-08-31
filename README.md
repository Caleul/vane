# Vane

Vane is the reference implementation of **Entity Event**: a model and framework
for defining software through persistent Entities and the Events that happen to
them.

Phase 1 is an executable specification of the first compiler boundary:

```text
declarative module -> semantic validation -> deterministic Semantic IR
```

Runtime, storage, contracts, and infrastructure belong to a second compilation
stage and are intentionally absent from this slice.

## Current guarantees

- a Module has a stable name;
- Modules compose through explicit, validated and deterministic imports;
- an Entity maps to a persistent concept and has exactly one identity Column;
- an Event owned by an Entity receives the stable identity `Entity.Event`;
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

## Development

Vane requires Node.js 24 or newer.

```bash
npm install
npm run verify
```

See [the semantic compiler boundary](docs/semantic-compiler.md) for the public
grammar and [the phase 1 completion matrix](docs/phase-1-completion.md) for PRD
traceability. Persistence, generated contracts, ACL/Saga execution,
ServiceConfiguration, and production hardening continue in phases 2–6.
