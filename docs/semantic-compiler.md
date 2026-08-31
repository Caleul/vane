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
persists its owner, that an Event belongs to an Anti-Corruption Layer and
interprets external results, that a View is a non-persistent public result, and
that a Saga requires a durable causal DAG with terminal-only visibility. It
cannot choose PostgreSQL, NestJS, HTTP, SSE, a queue, retry policy, credentials,
or deployment topology.

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
the decorators `@Module`, `@Entity`, `@Column`, `@Rule`, `@Event`, `@View`,
`@ACL`, and `@Saga`. The first slices intentionally keep all declarations in
one source file.

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

Views declare typed input, an output whose types are derived from projections,
and a mandatory query owned by the View:

```ts
@View({
  input: {
    customerId: "uuid",
    pageSize: "integer",
    offset: optional("integer"),
  },
  output: {
    id: Order.id,
    total: Order.total,
  },
  query: {
    root: Order,
    where: and(
      eq(Order.customerId, input("customerId")),
      gt(Order.total, literal(0)),
    ),
    orderBy: [desc(Order.createdAt)],
    pagination: {
      limit: input("pageSize"),
      offset: input("offset"),
    },
  },
})
class OrderDetails {}

@Module({ entities: [Order], views: [OrderDetails] })
class Sales {}
```

View output supports direct Column projections and `count`, `sum`, `avg`,
`min`, and `max`. Filters use Entity Column references, declared inputs, static
literals, comparisons, and logical operators. Ordering and pagination remain
ordered query properties. The Semantic IR records that a View cannot persist
and is a public result. Each output contract also preserves nullability:
projected Columns inherit it, `count` is non-null, and the other aggregates are
nullable because an empty result set has no aggregate value.

Until grouping has an explicit grammar, an aggregate View may contain only
aggregate outputs and cannot order by ungrouped Columns. Mixing `Order.id` with
`count(Order.id)` is rejected instead of assigning accidental SQL semantics.

This slice accepts only Columns from the query root. Relation navigation is
deliberately rejected until the compiler has an explicit relation path it can
validate; accepting `User.orders.total` without that guarantee would silently
invent query semantics.

Anti-Corruption Layers declare external Events without declaring how the
external system is reached:

```ts
@ACL()
class PaymentGateway {
  @Event({
    input: {
      amount: "decimal",
      currency: "string",
    },
    results: {
      approved: success({
        transactionId: "string",
        authorizationCode: "string",
      }),
      declined: fail({
        declineCode: "string",
        reason: optional("string"),
      }),
    },
  })
  Authorize() {}
}

@Module({
  entities: [Payment],
  antiCorruptionLayers: [PaymentGateway],
})
class Payments {}
```

The result names belong to the ubiquitous language at the boundary. Each one
is interpreted as the Event's `success` or `fail` and can carry typed semantic
data. An ACL Event must declare at least one interpretation of each terminal
outcome. The Semantic IR records the stable identity
`PaymentGateway.Authorize`; it does not contain endpoint, protocol,
credentials, status codes, serialization, timeout, retry, or idempotency.
Those mappings require ServiceConfiguration in compiler stage two.

Sagas declare causal Event graphs. A step names an Event occurrence;
`causedBy` creates directed causal edges without introducing `await` or an
intermediate return value. Compensation references another existing Event:

```ts
@Saga({
  input: { orderId: "uuid" },
  steps: {
    place: event(Order.Place, {
      compensateWith: Order.Cancel,
    }),
    authorize: event(PaymentGateway.Authorize, {
      causedBy: ["place"],
    }),
    capture: event(Payment.Capture, {
      causedBy: ["authorize"],
      compensateWith: Payment.Refund,
    }),
  },
  terminal: {
    step: "capture",
    view: PaymentReceipt,
  },
})
class PlaceOrder {}

@Module({
  entities: [Order, Payment],
  views: [PaymentReceipt],
  antiCorruptionLayers: [PaymentGateway],
  sagas: [PlaceOrder],
})
class Sales {}
```

The compiler validates every Entity/ACL Event, compensation, causal predecessor,
terminal step, and terminal View. Cycles are rejected. Every branch must
converge on one sink, which must be the selected terminal step. The Semantic IR
records the required causal identifiers and durable Saga state without choosing
their provider. It also fixes Saga Stream visibility to the final View or
terminal fail; intermediate steps, retries, and compensations remain internal.

Decorator configuration must consist of inline object and array literals,
literal scalar values, Entity identifiers, and the recognized helper calls.
Variables, spreads, shorthand properties, computed properties, and arbitrary
function calls are rejected because interpreting them would require execution.

This grammar is deliberately provisional. It establishes the safe parser
boundary and executable invariants; it does not freeze the final DSL ergonomics.

## Deliberately deferred

- persistence operation grammar;
- View relation navigation and joins;
- ServiceConfiguration and provider capability negotiation;
- Runtime, Storage, Contract, and Infrastructure IRs.

Each item should enter the compiler only with executable invariants and tests.
