# ACL and durable Saga runtime

The semantic DSL remains unchanged. Declare `ACLEvent` inside `@ACL` and use
`event(Owner, "Name", { causedBy, compensateWith })` in `@Saga`. A Saga's terminal
View executes only after its required Events have succeeded.

## Materialization and explicit wiring

The following wiring assumes a compiled `module`, migrated PostgreSQL `storage`
and a `pool` with at least two available connections per concurrent Saga worker
(one owns the Saga lock while the other performs Entity/View work).

```ts
import {
  AclEventRuntime, httpAclAdapter, materializeSagaPlan,
  PostgreSqlModuleRuntime, PostgreSqlViewRuntime,
  PostgreSqlSagaStore, PostgreSqlSagaRuntime,
  PostgreSqlPublicSagaAdmission, PublicHttpRuntime, materializeContract,
} from "@lilka/vane";

const gateway = httpAclAdapter({
  eventIdentity: "Gateway.Authorize",
  version: "1", // change when the provider interpretation changes
  url: process.env.GATEWAY_URL!,
  idempotencyHeader: "Idempotency-Key",
  headers: () => ({ authorization: `Bearer ${process.env.GATEWAY_TOKEN}` }),
  responses: [
    { status: 200, result: "approved", fields: { reference: "external_reference" } },
    { status: 402, result: "declined", fields: {} },
  ],
});
const acls = new AclEventRuntime(
  module.antiCorruptionLayers.flatMap(acl => acl.events), [gateway],
);
const plan = materializeSagaPlan(module, "PlaceOrder", {}, [gateway]);
const events = new PostgreSqlModuleRuntime({ module, storage, pool });
const views = new PostgreSqlViewRuntime(module, pool, storage);
await events.start();
const terminals = new PostgreSqlSagaStore(pool, storage);
const sagas = new PostgreSqlSagaRuntime({ plans: [plan], store: terminals, events, acls, views });
const contract = materializeContract(module, {
  events: [{ event: "Order.Place", saga: "PlaceOrder", terminal: {
    view: "Receipt", input: { id: { kind: "eventInput", input: "id" } },
  } }],
});
if (!contract.success) throw new Error("Invalid public contract");
const http = new PublicHttpRuntime({
  contract: contract.ir, events, views, terminals,
  admission: new PostgreSqlPublicSagaAdmission(sagas, { "Order.Place": plan }),
});
// Pass http to createNodeHttpHandler and bind the Node server explicitly.
// start() returns the worker's lifetime promise; handle rejection in supervision.
const worker = sagas.start();
// During shutdown: stop admitting HTTP requests, then:
await sagas.stop();
await worker;
await events.stop();
```

The HTTP adapter requires the actual remote provider to honor the configured
idempotency header. It always uses the persisted Event ID, rejects redirects,
bounds the response body and maps only listed fields into the declared ACL
result. Authentication is resolved at execution time and never serialized.
The ACL runtime rejects undeclared/malformed results and returns fixed safe
errors for rejection, timeout, invalid output and transport failure.

## Inputs and public exposure

By default, steps, compensation Events and the final View take matching named
fields from Saga input. Missing or incompatible required fields fail plan
materialization. Explicit mappings can rename inputs or supply typed literals:

```ts
materializeSagaPlan(module, "PlaceOrder", {
  steps: { place: { id: { kind: "input", name: "orderId" } } },
  compensations: { place: { id: { kind: "input", name: "orderId" } } },
  terminal: { id: { kind: "input", name: "orderId" } },
}, [gateway]);
```

ACL interpreted success data is retained internally. This phase's bindings read
Saga input or literals; they do not expose awaited intermediate Event returns.
Public Saga exposure requires one root Event with the same input contract as the
Saga and the same terminal View. Multi-root DAGs can be admitted explicitly with
`sagas.admit(plan, input)`. The public contract is now Contract IR v2; Semantic IR
and PostgreSQL Storage IR versions are unchanged.

Named public Sagas and ACL-owned public Events use durable admission. Ordinary
Entity Events without a `saga` association retain the phase-three direct execution
path, including in mixed contracts. Adding an admission binding for the same
Event identity does not opt a plain route into an undeclared Saga. For durable
orchestration of one Entity Event, explicitly expose a single-step Saga.
Durable terminal retention alone does not make legacy direct execution recoverable.

The PostgreSQL admission adapter validates root and terminal binding **sources**
against the public contract at HTTP construction, before serving requests. An
input-to-literal or input-to-different-input mismatch is rejected even when a
particular request happens to contain equal values.

## Recovery and operational state

`runOnce()` advances one durable transition and can be used by an explicit
scheduler instead of the polling worker. Session advisory locks serialize
workers for a Saga without holding a database transaction during external I/O.
Ready branches execute in deterministic order; each join waits for all parents.
The record retains every parent ID, with a deterministic direct `causationId`
(the last parent in sorted step-name order) in the existing envelope format.

A crash can occur after an Event commits and before its Saga checkpoint. The
next worker reuses the complete stored envelope. Entity mailbox deduplication
prevents repeating the owner mutation. ACL recovery reuses the same external
idempotency key. Exactly-once external execution is not promised.

Compensation runs for completed steps in reverse topological order. A failed
compensation is recorded and the remaining compensations still run. The final
public failure is safe; operational details stay in `store.read(sagaId)`.
A View failure also enters compensation. Infrastructure exceptions preserve the
executing state and reject the worker call; explicit supervision can restart it.

Keep historical plans/adapters installed until their pending Sagas complete.
Workers select installed Saga identities and plan hashes only, so changed plans cannot silently
reinterpret accepted work. Plan content, Event/View semantic fingerprints and adapter versions are checked
before execution. Historical plans require runtimes with the matching semantics;
a current runtime cannot reinterpret an older plan. Use `store.read(sagaId)` to inspect the required hash.

A partial index on Saga identity and processing order contains only running or
compensating states, so polling does not scan retained terminal history. The
plan hash remains a filter within the active rows for the installed identities.
Regenerate and apply the normal storage migration to add this index to existing
installations; accepted state and terminal history are preserved. Existing migration
safety rules classify index creation on an installed table as unsafe and require
an approval artifact bound to the exact plan hash.

The existing Saga table is used through normal migrations; there is no startup
DDL. State and terminal results remain retained until an explicit future
retention operation. Terminal waits poll every 50 ms by default, survive runtime
recreation, and can be cancelled with an AbortSignal. SSE returns one View/fail
and closes; it never emits progress, compensation, retries or raw ACL payloads.
