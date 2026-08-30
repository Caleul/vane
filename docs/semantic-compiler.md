# Semantic compiler boundary

Vane uses a mandatory two-stage compiler:

1. `Module -> Semantic IR`
2. `Semantic IR + ServiceConfiguration + profile -> materialization IRs`

This repository currently implements only the first executable slice of stage
one. `ModuleDeclaration` is the boundary expected from a future static parser;
it is not the final user-facing DSL.

## Why this boundary exists

The Semantic IR must preserve meaning without choosing how that meaning is
executed. It can state that an Event belongs to an Entity and necessarily
persists its owner. It cannot choose PostgreSQL, NestJS, HTTP, SSE, a queue,
retry policy, credentials, or deployment topology.

Those choices require a `ServiceConfiguration` and belong to stage two.

## Determinism

Declarations are normalized into a canonical order before serialization. Given
semantically equivalent input ordering, `serializeSemanticIr` must return the
same bytes. This property is foundational for reproducible generation, schema
snapshots, diffs, cache keys, and later migration planning.

## Failure model

Semantic validation is all-or-nothing. A failed compilation returns diagnostics
with a code, semantic path, cause, and likely correction. It never exposes a
partial IR that a downstream materializer could accidentally consume.

## Deliberately deferred

- parsing decorators from the TypeScript AST;
- persistence operation grammar;
- Views and their query grammar;
- ACL Events;
- Saga graphs;
- ServiceConfiguration and provider capability negotiation;
- Runtime, Storage, Contract, and Infrastructure IRs.

Each item should enter the compiler only with executable invariants and tests.
