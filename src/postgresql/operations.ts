import { quotePostgreSqlIdentifier as quote } from "./identifiers.js";
import type { PostgreSqlPoolLike } from "./runtime.js";
import { PostgreSqlSagaStore } from "./saga-runtime.js";
import type { PostgreSqlStorageIr } from "./storage-ir.js";

export class OperationalError extends Error {}
/** Privileged internal API. Deliberately not installed on the public HTTP server. */
export class PostgreSqlOperations {
  readonly #failures: string;
  readonly #sagas: PostgreSqlSagaStore;
  readonly #outbox: string;
  constructor(
    readonly pool: PostgreSqlPoolLike,
    storage: PostgreSqlStorageIr,
  ) {
    const table = (name: string) => {
      const t = storage.tables.find(
        (t) => t.semanticId === `vane.infrastructure.${name}`,
      );
      if (!t) throw new OperationalError("Missing technical storage.");
      return `${quote(storage.provider.namespace)}.${quote(t.name)}`;
    };
    this.#failures = table("failures");
    this.#outbox = table("outbox");
    this.#sagas = new PostgreSqlSagaStore(pool, storage);
  }
  async inspectSaga(sagaId: string) {
    const state = await this.#sagas.read(sagaId);
    if (!state) throw new OperationalError("Saga not found.");
    return {
      sagaId,
      correlationId: state.correlationId,
      planHash: state.planHash,
      status: state.status,
      steps: state.steps.map((s) => ({
        name: s.name,
        eventId: s.envelope.eventId,
        eventIdentity: s.envelope.eventIdentity,
        causedByEventIds: s.causedByEventIds,
        status: s.status,
        attempts: s.attempts ?? 0,
        retryAt: s.retryAt ?? null,
        failCode: s.fail?.code ?? null,
        compensationStatus: s.compensationStatus,
        compensationEventId: s.compensation?.eventId ?? null,
        compensationAttempts: s.compensationAttempts ?? 0,
        compensationRetryAt: s.compensationRetryAt ?? null,
        compensationFailCode: s.compensationFail?.code ?? null,
      })),
    };
  }
  async failures(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new OperationalError("Invalid limit.");
    const c = await this.pool.connect();
    try {
      return (
        await c.query(
          `SELECT failure_id,event_id,event_identity,code,correlation_id,causation_id,saga_id,status,attempt_count,occurred_at,resolved_at FROM ${this.#failures} ORDER BY occurred_at,failure_id LIMIT $1`,
          [limit],
        )
      ).rows;
    } finally {
      c.release();
    }
  }
  /** Acknowledges an investigated failure. Never replays compensated business effects. */
  async resolveFailure(failureId: string): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      return (
        (
          await c.query(
            `UPDATE ${this.#failures} SET status='resolved',resolved_at=clock_timestamp() WHERE failure_id=$1 AND status IN ('pending','dead') RETURNING failure_id`,
            [failureId],
          )
        ).rowCount === 1
      );
    } finally {
      c.release();
    }
  }
  /** Requeue only a failed publication, retaining its original idempotency key. */
  async retryOutboxFailure(failureId: string): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const failure = await c.query<{ event_id: string }>(
        `SELECT event_id FROM ${this.#failures} WHERE failure_id=$1 AND code='VANE_OUTBOX_EXHAUSTED' AND status IN ('pending','dead') FOR UPDATE`,
        [failureId],
      );
      const eventId = failure.rows[0]?.event_id;
      if (!eventId) {
        await c.query("ROLLBACK");
        return false;
      }
      const changed = await c.query(
        `UPDATE ${this.#outbox} SET status='pending',attempt_count=0,available_at=clock_timestamp(),last_error=NULL WHERE event_id=$1 AND status='failed' RETURNING event_id`,
        [eventId],
      );
      if (changed.rowCount !== 1) {
        await c.query("ROLLBACK");
        return false;
      }
      await c.query(
        `UPDATE ${this.#failures} SET status='resolved',resolved_at=clock_timestamp() WHERE failure_id=$1`,
        [failureId],
      );
      await c.query("COMMIT");
      return true;
    } catch (error) {
      await c.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      c.release();
    }
  }

  async queues() {
    const c = await this.pool.connect();
    try {
      return {
        outbox: (
          await c.query(
            `SELECT status,count(*)::integer AS count FROM ${this.#outbox} GROUP BY status ORDER BY status`,
          )
        ).rows,
        failures: (
          await c.query(
            `SELECT status,count(*)::integer AS count FROM ${this.#failures} GROUP BY status ORDER BY status`,
          )
        ).rows,
        sagas: (
          await c.query(
            `SELECT state->>'status' AS status,count(*)::integer AS count FROM ${this.#sagas.table} GROUP BY state->>'status' ORDER BY status`,
          )
        ).rows,
      };
    } finally {
      c.release();
    }
  }
  /** Explicit retention of resolved failure metadata only. Deduplication and Saga
   * receipts are retained indefinitely to preserve recovery and terminal replay. */
  async pruneResolvedFailures(before: string, limit = 100): Promise<number> {
    if (
      !Number.isFinite(Date.parse(before)) ||
      Date.parse(before) > Date.now() ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new OperationalError("Invalid retention boundary.");
    const c = await this.pool.connect();
    try {
      return (
        (
          await c.query(
            `WITH old AS (SELECT failure_id FROM ${this.#failures} WHERE status='resolved' AND resolved_at < $1::timestamptz ORDER BY resolved_at,failure_id LIMIT $2 FOR UPDATE SKIP LOCKED) DELETE FROM ${this.#failures} f USING old WHERE f.failure_id=old.failure_id`,
            [before, limit],
          )
        ).rowCount ?? 0
      );
    } finally {
      c.release();
    }
  }
}
