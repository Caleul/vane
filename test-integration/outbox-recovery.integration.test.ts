import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";
import type { JsonValue } from "../src/declaration.js";
import {
  LostOutboxLeaseError,
  PostgreSqlOutboxDispatcher,
} from "../src/postgresql/delivery.js";
import { createEventEnvelope } from "../src/postgresql/envelope.js";
import { quotePostgreSqlIdentifier } from "../src/postgresql/identifiers.js";
import { materializePostgreSql } from "../src/postgresql/materializer.js";
import { renderPostgreSqlSchema } from "../src/postgresql/renderer.js";
import { PostgreSqlEventRuntime } from "../src/postgresql/runtime.js";
import type { PostgreSqlStorageIr } from "../src/postgresql/storage-ir.js";
import type { SemanticEntityEvent } from "../src/semantic-ir.js";
import { testDatabaseUrl, withTestDatabase } from "./database.js";
import { phaseTwoProject } from "./fixtures.js";

function createEnvelope(
  event: SemanticEntityEvent,
  name: string,
): ReturnType<typeof createEventEnvelope> {
  const payload: Readonly<Record<string, JsonValue>> = {
    available: 4,
    createdAt: "2026-08-31T12:00:00.000Z",
    name,
    price: 25,
    reserved: 0,
  };
  return createEventEnvelope({
    eventId: randomUUID(),
    eventIdentity: event.identity,
    occurredAt: "2026-08-31T12:00:00.000Z",
    payload,
  });
}

function outboxRelation(
  namespace: string,
  storage: PostgreSqlStorageIr,
): string {
  const table = storage.tables.find(
    ({ semanticId }) => semanticId === "vane.infrastructure.outbox",
  );
  assert.ok(table);
  return `${quotePostgreSqlIdentifier(namespace)}.${quotePostgreSqlIdentifier(table.name)}`;
}

describe("PostgreSQL outbox recovery", () => {
  it("prevents concurrent claims and recovers an expired lease after restart", async () => {
    await withTestDatabase("outbox_recovery", async ({ pool, schema }) => {
      const project = phaseTwoProject();
      const module = project.modules[0];
      const entity = module?.entities[0];
      assert.ok(module);
      assert.ok(entity);
      const create = entity.events.find(({ name }) => name === "Create");
      assert.ok(create);
      const materialized = materializePostgreSql(project, {
        namespace: schema,
        targetVersion: 16,
      });
      assert.equal(materialized.success, true);
      if (!materialized.success) throw new Error("Materialization failed.");
      await pool.query(renderPostgreSqlSchema(materialized.ir));

      const acceptedEnvelope = createEnvelope(create, "Outbox item");
      const runtime = new PostgreSqlEventRuntime(pool, materialized.ir);
      const result = await runtime.execute({
        module: module.name,
        entity,
        event: create,
        envelope: acceptedEnvelope,
      });
      assert.equal(result.kind, "success");

      const firstDispatcher = new PostgreSqlOutboxDispatcher(
        pool,
        materialized.ir,
      );
      const firstClaims = await firstDispatcher.claim({
        workerId: "worker-before-crash",
        limit: 1,
        leaseMilliseconds: 60_000,
      });
      assert.equal(firstClaims.length, 1);
      assert.equal(firstClaims[0]?.envelope.eventId, acceptedEnvelope.eventId);

      const competingClaims = await firstDispatcher.claim({
        workerId: "competing-worker",
        limit: 1,
        leaseMilliseconds: 60_000,
      });
      assert.deepEqual(competingClaims, []);

      await pool.query(
        `UPDATE ${outboxRelation(schema, materialized.ir)} SET lease_until = transaction_timestamp() - interval '1 second' WHERE event_id = $1`,
        [acceptedEnvelope.eventId],
      );

      const restartedPool = new Pool({ connectionString: testDatabaseUrl });
      try {
        const restartedDispatcher = new PostgreSqlOutboxDispatcher(
          restartedPool,
          materialized.ir,
        );
        const recovered = await restartedDispatcher.claim({
          workerId: "worker-after-restart",
          limit: 1,
          leaseMilliseconds: 60_000,
        });
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0]?.eventId, acceptedEnvelope.eventId);
        assert.equal(recovered[0]?.attempt, 2);

        const staleClaim = firstClaims[0];
        assert.ok(staleClaim);
        await assert.rejects(
          firstDispatcher.acknowledge({
            messageId: staleClaim.messageId,
            workerId: "worker-before-crash",
            leaseToken: staleClaim.leaseToken,
            publishedAt: "2099-08-31T12:00:03.100Z",
          }),
          LostOutboxLeaseError,
        );

        const recoveredClaim = recovered[0];
        assert.ok(recoveredClaim);
        await restartedDispatcher.acknowledge({
          messageId: recoveredClaim.messageId,
          workerId: "worker-after-restart",
          leaseToken: recoveredClaim.leaseToken,
          publishedAt: "2099-08-31T12:00:03.200Z",
        });
      } finally {
        await restartedPool.end();
      }

      const persisted = await pool.query<{
        attempt_count: string;
        published_at: Date | null;
        status: string;
      }>(
        `SELECT attempt_count::text, published_at, status FROM ${outboxRelation(schema, materialized.ir)} WHERE event_id = $1`,
        [acceptedEnvelope.eventId],
      );
      assert.equal(persisted.rows[0]?.attempt_count, "2");
      assert.ok(persisted.rows[0]?.published_at instanceof Date);
      assert.equal(persisted.rows[0]?.status, "published");
    });
  });
});
