# Phase 3 design: Views and public contracts

## Scope

Phase 3 materializes the View declarations already preserved by Semantic IR and
adds the first public contract boundary. It covers FR-VIEW-001–007 and
FR-HTTP-002–008. Route exposure is accepted as an explicit compiler input in
this phase; phase 5 ServiceConfiguration will resolve profiles and providers
into that same input.

## Boundaries

- A View owns its query. There is no independent Query declaration or runtime.
- PostgreSQL is the execution authority for filters, joins, ordering,
  pagination, projection and aggregation.
- Event persistence results (including revisions) are internal. A public Event
  receives `202` plus a `sagaId`; its terminal channel receives only a View or
  a safe fail.
- Public names and paths never replace the internal `Owner.Event` and View
  identities recorded by the contract IR.
- The contract IR and OpenAPI are deterministic, versioned and content-hashed.
- The terminal store is an interface. Phase 3 includes an in-process
  implementation with abortable waits, five-minute retention and a bounded
  entry count; phase 4 will bind it to the durable Saga runtime.

## Public flow

```text
POST public Event
  -> validate contract input
  -> 202 { sagaId }
  -> dispatch owner Event
  -> execute configured terminal View after successful persistence
  -> publish exactly one terminal View or safe fail

POST public View
  -> validate typed input
  -> execute its declared PostgreSQL query
  -> 200 typed View rows

GET Saga terminal stream
  -> reject unknown or expired sagaId
  -> cancel the wait when the client disconnects
  -> SSE event: view | fail
  -> close
```

No progress, retry, compensation, revision, SQL detail or stack trace crosses
the public boundary.
