# Semantic compiler boundary

Vane has a mandatory two-stage compiler:

1. `TypeScript DSL -> declarations -> Semantic IR`
2. `Semantic IR + ServiceConfiguration + profile -> materialization IRs`

Stage one is the executable specification. It preserves meaning and rejects an
invalid model without selecting a database, framework, protocol, queue,
credential, retry policy, or deployment topology. Those choices require a
`ServiceConfiguration` and belong to stage two.

## Public TypeScript DSL

`@lilka/vane` exports the decorators and helpers accepted by the static parser.
The same API is checked by TypeScript fixtures, so examples cannot drift away
from the package surface.

```ts
import {
  Column,
  Entity,
  Event,
  Module,
  Rule,
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

The parser reads the TypeScript AST directly. It never imports, transpiles, or
executes the user's source. Decorator configuration must therefore consist of
inline objects and arrays, literal values, class identifiers, and recognized
helper calls. Variables, spreads, shorthand properties, computed properties,
and arbitrary function calls are rejected with source locations.

Column constraints include nullability, uniqueness, identity, reference,
generation, string length, numeric bounds, and static defaults. Contradictions
such as nullable identities, an incompatible generator, `minLength >
maxLength`, or generation combined with a default fail semantic compilation.

## Typed references

TypeScript cannot infer static properties from property decorators. Vane uses
helpers that check member names against the referenced class instead:

```ts
@Column({ type: "uuid", references: reference(Customer, "id") })
customerId!: string;

field(Order, "customerId");
eventRef(Order, "Cancel");
event(Order, "Place", { compensateWith: eventRef(Order, "Cancel") });
```

The parser continues to understand the earlier `Customer.id` and `Order.Place`
forms for source compatibility, but the helper form is the public, type-checked
grammar.

## Views and explicit relations

A View owns its query, never persists, and is the only successful public result
shape. Output types and nullability are inferred from projected Columns and
aggregates.

```ts
@View({
  input: { customerId: "uuid", limit: "integer" },
  output: {
    orderId: field(Order, "id"),
    customerName: field(Customer, "name"),
  },
  query: {
    root: Order,
    relations: {
      customer: relation(
        field(Order, "customerId"),
        field(Customer, "id"),
      ),
    },
    where: eq(field(Order, "customerId"), input("customerId")),
    orderBy: [desc(field(Customer, "name"))],
    pagination: { limit: input("limit") },
  },
})
class OrderDetails {}
```

Every relation must follow an actual Column reference, use compatible types,
and form a connected path from the query root. Vane does not infer joins.
Filters use typed Columns, declared inputs, literals, comparison operators, and
logical composition. Ordering and pagination remain ordered query properties.

`count`, `sum`, `avg`, `min`, and `max` are supported. Until grouping has its
own semantic vocabulary, a View cannot mix scalar and aggregate outputs or
order an aggregate-only result by an ungrouped Column. Rejection is preferable
to accidental SQL semantics.

## Anti-Corruption Layers and terminal outcomes

An ACL owns Events that interpret external results as `success` or `fail` but
does not define how the external system is reached. Result names and fields are
semantic; endpoints, protocols, credentials, status mappings, timeouts, retries,
and idempotency belong to `ServiceConfiguration`.

Every Entity and ACL Event records a common public terminal contract in the
Semantic IR: success can only be exposed as a View; fail requires a stable code,
a safe message, and correlation identity. The IR does not expose raw exceptions
or ACL payloads as public success responses.

## Sagas

A Saga is a causal DAG of Entity or ACL Events. Steps do not return awaited
intermediate values. Compensation references another known Event, every branch
converges on one terminal step, and only the final View or fail is visible.

```ts
@Saga({
  input: { orderId: "uuid" },
  steps: {
    place: event(Order, "Place", {
      compensateWith: eventRef(Order, "Cancel"),
    }),
    authorize: event(PaymentGateway, "Authorize", {
      causedBy: ["place"],
    }),
  },
  terminal: { step: "authorize", view: PaymentReceipt },
})
class PlaceOrder {}
```

The IR preserves causal identifiers, durable Saga state, terminal-only stream
visibility, and internal intermediate results. A later materializer decides how
to store and transport those guarantees.

## Module composition

Modules compose explicitly across source files:

```ts
@Module({ entities: [Customer] })
class Core {}

@Module({ imports: [Core], entities: [Order], views: [OrderDetails] })
class Sales {}
```

Use `compileProjectSources` for source files or `compileSemanticProject` for
declarations. The project compiler rejects unknown, duplicate, self, and cyclic
imports. Entity references, View relations, Saga Events, and terminal Views may
resolve through the transitive import graph. Same-named visible concepts are
rejected instead of selected by import order.

## Determinism and failure model

Declarations are normalized before serialization. Semantically equivalent
input order produces byte-identical output from `serializeSemanticIr` and
`serializeSemanticProjectIr`.

Validation is all-or-nothing. Failures contain a stable code, semantic path,
cause, likely correction, and source location when compiled from TypeScript.
No failure exposes a partial IR to a downstream materializer.

## Stage-two boundary

The following remain deliberately outside Semantic IR:

- database schemas, migrations, transactions, locks, and provider capability;
- HTTP, SSE, queues, serialization, status codes, and generated contracts;
- ACL endpoints, credentials, timeout, retry, and idempotency mappings;
- Saga storage engines, workers, schedules, and telemetry exporters;
- runtime framework and infrastructure topology.

They are not missing phase-one semantics. They are materialization decisions
that cannot be compiled correctly before `ServiceConfiguration` exists.
