# Vane

Vane is the reference implementation of **Entity Event**: a model and framework
for defining software through persistent Entities and the Events that happen to
them.

The project is in its first implementation phase. The current executable slice
focuses on the first compiler boundary:

```text
declarative module -> semantic validation -> deterministic Semantic IR
```

Runtime, storage, contracts, and infrastructure belong to a second compilation
stage and are intentionally absent from this slice.

## Current guarantees

- a Module has a stable name;
- an Entity maps to a persistent concept and has exactly one identity Column;
- an Event owned by an Entity receives the stable identity `Entity.Event`;
- an Event owned by an Anti-Corruption Layer receives the stable identity
  `ACL.Event` and interprets external results only as `success` or `fail`;
- a Rule references at least two Columns from its own Entity;
- a View has typed input and output, owns its query, never persists, and is a
  public result;
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

The public TypeScript DSL is not frozen yet. The structures currently accepted
by `compileSemanticIr` are the parser/compiler boundary, not a promise that end
users will author raw objects or that the final syntax will avoid decorators.
