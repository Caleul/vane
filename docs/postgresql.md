# PostgreSQL persistence and runtime

Phase 2 materializes a compiled Semantic Project IR into deterministic
PostgreSQL artifacts. The provider targets PostgreSQL 16 or newer and accepts a
`pg.Pool` through a small structural interface; credentials never enter either
Semantic IR or Storage IR.

## Materialize and migrate

```ts
import {
  applyPostgreSqlMigrationPlan,
  approvePostgreSqlMigrationPlan,
  createPostgreSqlMigrationPlan,
  materializePostgreSql,
} from "@lilka/vane";

const result = materializePostgreSql(semanticProjectIr, {
  namespace: "application",
  targetVersion: 16,
});

if (!result.success) throw new Error(JSON.stringify(result.diagnostics));

const plan = createPostgreSqlMigrationPlan({
  previous: previousStorageIr,
  next: result.ir,
  renames: {
    tables: [],
    columns: [],
  },
});

const approval =
  plan.classification === "safe"
    ? undefined
    : approvePostgreSqlMigrationPlan(plan, {
        classification: plan.classification,
        reason: "Reviewed against the release data migration plan.",
      });

await applyPostgreSqlMigrationPlan(pool, plan, approval);
```

Storage IR is the physical snapshot. Migration IDs and plans are derived from
canonical content, not timestamps. A rename is accepted only through an exact
rename map. Unsafe or destructive plans require an approval artifact containing
the same plan hash and classification; editing the plan invalidates approval.
Migration DDL and its immutable history entry share one reserved PostgreSQL
connection and transaction. A namespace-scoped advisory lock serializes the
initial bootstrap and later plans, and history records a monotonic apply order.

## Dispatch Entity Events

```ts
import {
  PostgreSqlModuleRuntime,
  createEventEnvelope,
} from "@lilka/vane";

const runtime = new PostgreSqlModuleRuntime({
  module: semanticProjectIr.modules[0],
  pool,
  storage: result.ir,
});

await runtime.start();

const terminal = await runtime.dispatch(
  createEventEnvelope({
    eventId: crypto.randomUUID(),
    eventIdentity: "Stock.Remove",
    occurredAt: new Date().toISOString(),
    payload: { id: stockId, quantity: 2 },
  }),
);

await runtime.stop();
```

`start()` validates the compiled plan, PostgreSQL version, installed Storage IR
hash, Column shape and named constraints/indexes before accepting work.
It compares their definitions too, canonicalizing known equivalent PostgreSQL
deparse forms before deciding whether drift exists.
Dispatch resolves `Entity.Event` inside the configured Module; the lower-level
executor is intentionally not part of the package API. `stop()` rejects new
work and waits for in-flight transactions, while mailbox/outbox state remains
durable for the next process.

Each occurrence has a global `eventId` and canonical fingerprint. Mailbox claim,
owner mutation, technical revision, outbox append and terminal receipt are one
transaction. A retry with the same envelope returns the saved receipt without
repeating the protected effect; the same `eventId` with different immutable
content is an explicit collision. Typed-input, Constraint and Rule failures
become safe, deduplicated terminal failures. Infrastructure failures roll back
and remain retryable.

## Publish the outbox

```ts
import { PostgreSqlOutboxDispatcher } from "@lilka/vane";

const dispatcher = new PostgreSqlOutboxDispatcher(pool, result.ir);
const report = await dispatcher.dispatch({
  workerId: "worker-1",
  limit: 100,
  leaseMilliseconds: 30_000,
  publisher,
  retryAt: () => new Date(Date.now() + 5_000).toISOString(),
});
```

Claims use the PostgreSQL transaction clock, `FOR UPDATE SKIP LOCKED` and
worker/token fencing. Publishing happens
after the Entity transaction commits. A crash after publish and before
acknowledgement can redeliver, so the guarantee is deliberately at-least-once;
the receiving mailbox provides one protected database effect per `eventId`.

## Verification

```bash
npm run verify
VANE_TEST_DATABASE_URL=postgresql://user:password@localhost:5432/vane \
  npm run test:integration
```

The integration gate applies real DDL and migrations, exercises rollback,
concurrent deduplication, equal-value writes, constraint/Rule failures and
outbox lease recovery against PostgreSQL 16+.
