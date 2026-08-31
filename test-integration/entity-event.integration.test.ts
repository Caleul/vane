import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import type { JsonValue } from "../src/declaration.js";
import { createEventEnvelope } from "../src/postgresql/envelope.js";
import { quotePostgreSqlIdentifier } from "../src/postgresql/identifiers.js";
import { materializePostgreSql } from "../src/postgresql/materializer.js";
import { renderPostgreSqlSchema } from "../src/postgresql/renderer.js";
import {
  EventIdCollisionError,
  PostgreSqlEventRuntime,
} from "../src/postgresql/runtime.js";
import type {
  PostgreSqlStorageIr,
  PostgreSqlTable,
} from "../src/postgresql/storage-ir.js";
import type {
  SemanticEntity,
  SemanticEntityEvent,
} from "../src/semantic-ir.js";
import { withTestDatabase } from "./database.js";
import { phaseTwoProject } from "./fixtures.js";

interface RuntimeFixture {
  readonly entity: SemanticEntity;
  readonly runtime: PostgreSqlEventRuntime;
  readonly storage: PostgreSqlStorageIr;
  readonly table: PostgreSqlTable;
}

async function runtimeFixture(
  pool: Pool,
  namespace: string,
): Promise<RuntimeFixture> {
  const project = phaseTwoProject();
  const entity = project.modules[0]?.entities[0];
  assert.ok(entity);
  const materialized = materializePostgreSql(project, {
    namespace,
    targetVersion: 16,
  });
  assert.equal(materialized.success, true);
  if (!materialized.success) throw new Error("Materialization failed.");
  await pool.query(renderPostgreSqlSchema(materialized.ir));
  const table = materialized.ir.tables.find(
    ({ semanticId }) => semanticId === "Inventory.StockItem",
  );
  assert.ok(table);
  return {
    entity,
    runtime: new PostgreSqlEventRuntime(pool, materialized.ir),
    storage: materialized.ir,
    table,
  };
}

function event(entity: SemanticEntity, name: string): SemanticEntityEvent {
  const candidate = entity.events.find((item) => item.name === name);
  assert.ok(candidate);
  return candidate;
}

function envelope(
  eventIdentity: string,
  payload: Readonly<Record<string, JsonValue>>,
  eventId: string = randomUUID(),
) {
  return createEventEnvelope({
    eventId,
    eventIdentity,
    occurredAt: "2026-08-31T12:00:00.000Z",
    payload,
  });
}

function relation(namespace: string, table: PostgreSqlTable): string {
  return `${quotePostgreSqlIdentifier(namespace)}.${quotePostgreSqlIdentifier(table.name)}`;
}

function technicalRelation(
  namespace: string,
  storage: PostgreSqlStorageIr,
  semanticId: string,
): string {
  const table = storage.tables.find(
    (candidate) => candidate.technical && candidate.semanticId === semanticId,
  );
  assert.ok(table);
  return relation(namespace, table);
}

function createPayload(name: string): Readonly<Record<string, JsonValue>> {
  return {
    available: 5,
    createdAt: "2026-08-31T12:00:00.000Z",
    name,
    price: 10.5,
    reserved: 1,
  };
}

describe("PostgreSQL Entity Event runtime", () => {
  it("deduplicates invalid typed input as a terminal fail without side effects", async () => {
    await withTestDatabase("event_invalid", async ({ pool, schema }) => {
      const fixture = await runtimeFixture(pool, schema);
      const create = event(fixture.entity, "Create");
      const invalid = envelope(create.identity, {
        ...createPayload("Invalid\0name"),
      });

      const first = await fixture.runtime.execute({
        module: "Inventory",
        entity: fixture.entity,
        event: create,
        envelope: invalid,
      });
      assert.equal(first.kind, "fail");
      if (first.kind === "fail")
        assert.equal(first.fail.code, "VANE_EVENT_INPUT_INVALID");
      assert.equal(
        (
          await fixture.runtime.execute({
            module: "Inventory",
            entity: fixture.entity,
            event: create,
            envelope: invalid,
          })
        ).kind,
        "duplicate",
      );

      const invalidDate = envelope(create.identity, {
        ...createPayload("Invalid date"),
        createdAt: "2023-02-29T00:00:00.000Z",
      });
      const dateFailure = await fixture.runtime.execute({
        module: "Inventory",
        entity: fixture.entity,
        event: create,
        envelope: invalidDate,
      });
      assert.equal(dateFailure.kind, "fail");
      if (dateFailure.kind === "fail")
        assert.equal(dateFailure.fail.code, "VANE_EVENT_INPUT_INVALID");

      const ownerCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${relation(schema, fixture.table)}`,
      );
      const outboxCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${technicalRelation(schema, fixture.storage, "vane.infrastructure.outbox")}`,
      );
      assert.equal(ownerCount.rows[0]?.count, "0");
      assert.equal(outboxCount.rows[0]?.count, "0");
    });
  });

  it("deduplicates concurrent deliveries and rejects eventId collisions", async () => {
    await withTestDatabase("event_dedupe", async ({ pool, schema }) => {
      const fixture = await runtimeFixture(pool, schema);
      const create = event(fixture.entity, "Create");
      const acceptedEnvelope = envelope(create.identity, createPayload("Desk"));

      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          fixture.runtime.execute({
            module: "Inventory",
            entity: fixture.entity,
            event: create,
            envelope: acceptedEnvelope,
          }),
        ),
      );

      assert.equal(results.filter(({ kind }) => kind === "success").length, 1);
      assert.equal(
        results.filter(({ kind }) => kind === "duplicate").length,
        11,
      );
      const ownerCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${relation(schema, fixture.table)}`,
      );
      const outboxCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${technicalRelation(schema, fixture.storage, "vane.infrastructure.outbox")}`,
      );
      assert.equal(ownerCount.rows[0]?.count, "1");
      assert.equal(outboxCount.rows[0]?.count, "1");

      const collision = envelope(
        create.identity,
        createPayload("Different payload"),
        acceptedEnvelope.eventId,
      );
      await assert.rejects(
        fixture.runtime.execute({
          module: "Inventory",
          entity: fixture.entity,
          event: create,
          envelope: collision,
        }),
        EventIdCollisionError,
      );
    });
  });

  it("rolls back Rule violations and deduplicates the terminal fail", async () => {
    await withTestDatabase("event_rule", async ({ pool, schema }) => {
      const fixture = await runtimeFixture(pool, schema);
      const create = event(fixture.entity, "Create");
      const reserve = event(fixture.entity, "Reserve");
      await fixture.runtime.execute({
        module: "Inventory",
        entity: fixture.entity,
        event: create,
        envelope: envelope(create.identity, createPayload("Monitor")),
      });
      const owner = relation(schema, fixture.table);
      const row = await pool.query<{ id: string; reserved: string }>(
        `SELECT id::text, reserved::text FROM ${owner}`,
      );
      const ownerId = row.rows[0]?.id;
      assert.ok(ownerId);

      const failedEnvelope = envelope(reserve.identity, {
        amount: 5,
        id: ownerId,
      });
      const failed = await fixture.runtime.execute({
        module: "Inventory",
        entity: fixture.entity,
        event: reserve,
        envelope: failedEnvelope,
      });
      assert.equal(failed.kind, "fail");
      if (failed.kind === "fail") {
        assert.equal(failed.fail.code, "VANE_EVENT_RULE_VIOLATION");
        assert.equal(failed.fail.correlationId, failedEnvelope.correlationId);
      }
      const duplicate = await fixture.runtime.execute({
        module: "Inventory",
        entity: fixture.entity,
        event: reserve,
        envelope: failedEnvelope,
      });
      assert.equal(duplicate.kind, "duplicate");

      const after = await pool.query<{ reserved: string; revision: string }>(
        `SELECT reserved::text, __vane_revision::text AS revision FROM ${owner}`,
      );
      assert.deepEqual(after.rows[0], { reserved: "1", revision: "1" });
      const outboxCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${technicalRelation(schema, fixture.storage, "vane.infrastructure.outbox")}`,
      );
      assert.equal(outboxCount.rows[0]?.count, "1");
    });
  });

  it("performs equal-value writes and atomically rolls back when outbox append fails", async () => {
    await withTestDatabase("event_atomicity", async ({ pool, schema }) => {
      const fixture = await runtimeFixture(pool, schema);
      const create = event(fixture.entity, "Create");
      const rename = event(fixture.entity, "Rename");
      await fixture.runtime.execute({
        module: "Inventory",
        entity: fixture.entity,
        event: create,
        envelope: envelope(create.identity, createPayload("Laptop")),
      });
      const owner = relation(schema, fixture.table);
      const initial = await pool.query<{ id: string }>(
        `SELECT id::text FROM ${owner}`,
      );
      const ownerId = initial.rows[0]?.id;
      assert.ok(ownerId);

      const equalWrite = await fixture.runtime.execute({
        module: "Inventory",
        entity: fixture.entity,
        event: rename,
        envelope: envelope(rename.identity, { id: ownerId, name: "Laptop" }),
      });
      assert.equal(equalWrite.kind, "success");
      if (equalWrite.kind === "success") assert.equal(equalWrite.revision, "2");

      const outbox = technicalRelation(
        schema,
        fixture.storage,
        "vane.infrastructure.outbox",
      );
      await pool.query(
        `ALTER TABLE ${outbox} ADD CONSTRAINT reject_new_outbox CHECK (false) NOT VALID`,
      );
      const infrastructureFailure = envelope(rename.identity, {
        id: ownerId,
        name: "Must roll back",
      });
      await assert.rejects(
        fixture.runtime.execute({
          module: "Inventory",
          entity: fixture.entity,
          event: rename,
          envelope: infrastructureFailure,
        }),
      );

      const after = await pool.query<{
        name: string;
        revision: string;
      }>(`SELECT name, __vane_revision::text AS revision FROM ${owner}`);
      assert.deepEqual(after.rows[0], { name: "Laptop", revision: "2" });
      const mailbox = technicalRelation(
        schema,
        fixture.storage,
        "vane.infrastructure.mailbox",
      );
      const receipt = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${mailbox} WHERE event_id = $1`,
        [infrastructureFailure.eventId],
      );
      assert.equal(receipt.rows[0]?.count, "0");
    });
  });
});
