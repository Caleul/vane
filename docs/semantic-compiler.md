# Semantic compiler boundary

Vane uses a mandatory two-stage compiler:

1. `Module -> Semantic IR`
2. `Semantic IR + ServiceConfiguration + profile -> materialization IRs`

This repository currently implements the first executable slices of stage one:
the static TypeScript parser and the `ModuleDeclaration -> Semantic IR`
compiler. `ModuleDeclaration` remains an internal boundary; it is not the final
user-facing DSL.

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

Source parser diagnostics also carry a one-based file, line, and column range.
The parser reads the TypeScript AST directly. It never imports, transpiles, or
executes the user's module.

## Provisional static grammar

The parser recognizes named imports from `@lilka/vane`, including aliases, and
the decorators `@Module`, `@Entity`, `@Column`, `@Rule`, and `@Event`. The first
slice intentionally keeps all Entities in one source file.

```ts
import {
  Module,
  Entity,
  Column,
  Rule,
  Event,
  column,
  gt,
  optional,
} from "@lilka/vane";

@Entity()
class Subscription {
  @Column({ type: "uuid", identity: true, generated: "uuid" })
  id!: string;

  @Column({ type: "date" }) startDate!: Date;
  @Column({ type: "date" }) endDate!: Date;

  @Rule({ expression: gt(column("endDate"), column("startDate")) })
  EndsAfterStart() {}

  @Event({ input: { startDate: "date", couponCode: optional("string") } })
  CreateSubscription() {}
}

@Module({ entities: [Subscription] })
class Sales {}
```

Rule values use `column("name")` and `literal(value)`. Comparisons use `eq`,
`neq`, `gt`, `gte`, `lt`, and `lte`; expressions compose with `and`, `or`, and
`not`. Column references accept `Customer.id` or
`{ entity: Customer, column: "id" }`.

Decorator configuration must consist of inline object and array literals,
literal scalar values, Entity identifiers, and the recognized helper calls.
Variables, spreads, shorthand properties, computed properties, and arbitrary
function calls are rejected because interpreting them would require execution.

This grammar is deliberately provisional. It establishes the safe parser
boundary and executable invariants; it does not freeze the final DSL ergonomics.

## Deliberately deferred

- persistence operation grammar;
- Views and their query grammar;
- ACL Events;
- Saga graphs;
- ServiceConfiguration and provider capability negotiation;
- Runtime, Storage, Contract, and Infrastructure IRs.

Each item should enter the compiler only with executable invariants and tests.
