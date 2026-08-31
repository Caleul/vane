# Phase 2 implementation contract

This document freezes the integration boundary used while implementing phase 2.
It is normative for this branch and will become the completion guide when the
implementation is verified.

## Semantic Event operations

Every Entity Event declares exactly one persistent operation. The operation is
semantic and therefore belongs to declarations and Semantic IR v6, never to a
provider callback or ServiceConfiguration.

```ts
Create = Event({
  input: { id: "uuid", quantity: "integer" },
  operation: create({
    id: input("id"),
    quantity: input("quantity"),
    status: literal("created"),
  }),
});

RemoveStock = Event({
  input: { id: "uuid", quantity: "integer" },
  operation: update(input("id"), {
    quantity: subtract(column("quantity"), input("quantity")),
  }),
});

Delete = Event({
  input: { id: "uuid" },
  operation: remove(input("id")),
});

Materialize = Event({
  input: { id: "uuid", status: "string" },
  operation: upsert(input("id"), {
    status: input("status"),
  }),
});
```

The closed value AST is `input`, `literal`, the current owner `column`, `add`,
and `subtract`. Arithmetic is restricted to integer/decimal operands. Create and
upsert values cannot read the current row. Update cannot assign the identity.
Only the owner Entity is ever a mutation target. All references and result types
are validated before IR emission.

## PostgreSQL materialization

The PostgreSQL materializer consumes Semantic IR and produces a versioned,
deterministic Storage IR. PostgreSQL details never flow back into Semantic IR.
The reference target is PostgreSQL 16 or newer.

- one quoted table per Entity, qualified by Module;
- `text`, `bigint`, `numeric`, `boolean`, `date`, `timestamptz`, `uuid`, and
  `jsonb` mappings;
- real PK, unique, FK, default, generated, bounds and length constraints;
- Rules lowered to named CHECK constraints; SQL UNKNOWN is accepted when a
  referenced nullable Column is absent, while FALSE violates the Rule;
- provider incompatibilities fail with diagnostics and no partial Storage IR;
- technical revision/timestamps plus durable migrations, mailbox, outbox, Saga
  registration and failure-queue tables;
- byte-identical IR and SQL for equivalent semantic inputs.

Migration plans compare two Storage IR snapshots. Renames require an explicit
rename map; heuristics are forbidden. Every unsafe operation is classified and
application requires approval bound to the exact plan hash.

## Event transaction and delivery

`eventIdentity` identifies the semantic Event; `eventId` identifies one concrete
occurrence. The canonical envelope fingerprint detects reuse of an eventId with
different immutable content.

For success, mailbox claim, owner mutation, revision write, outbox append and
mailbox receipt share one transaction. Equal values still execute a physical
write and increment the technical revision. Invalid typed payloads and
Constraint/Rule failures are terminal safe failures and are deduplicated
without preserving the invalid mutation. Infrastructure failures roll back and
remain retryable.
The mailbox stores the canonical serialized envelope as text so even payloads
that PostgreSQL JSONB cannot represent can receive a durable terminal receipt.

Module startup compares complete catalog constraint and index definitions.
PostgreSQL's equivalent casts and `IN`/`ANY` deparse are canonicalized without
allowing a same-name definition change to pass preflight.

Outbox publication happens after commit. Claims use the PostgreSQL transaction
clock, leases and `FOR UPDATE SKIP LOCKED`; a crash after publish but before acknowledgement may
redeliver, so delivery is honestly at-least-once. Mailbox uniqueness makes the
protected database effect idempotent.

## Completion gate

Phase 2 is complete only when static/unit gates pass locally, PostgreSQL
integration tests pass in CI, phase-1 regressions remain green, migrations and
runtime are documented, the Notion roadmap is synchronized, and the final Codex
review reports no findings.
