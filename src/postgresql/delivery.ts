import { randomUUID } from "node:crypto";
import { type EventEnvelope, assertValidEventEnvelope } from "./envelope.js";
import { quotePostgreSqlIdentifier } from "./identifiers.js";
import type { PostgreSqlClientLike, PostgreSqlPoolLike } from "./runtime.js";
import type { PostgreSqlStorageIr } from "./storage-ir.js";

const OUTBOX_SEMANTIC_ID = "vane.infrastructure.outbox";

export interface ClaimOutboxRequest {
  readonly workerId: string;
  readonly limit: number;
  readonly leaseMilliseconds: number;
}

export interface OutboxClaim {
  readonly messageId: string;
  readonly eventId: string;
  readonly leaseToken: string;
  readonly leaseUntil: string;
  readonly attempt: number;
  readonly envelope: EventEnvelope;
}

export interface AcknowledgeOutboxRequest {
  readonly messageId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly publishedAt: string;
}

export interface RescheduleOutboxRequest {
  readonly messageId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly availableAt: string;
  readonly error: string;
}

export interface EventPublisher {
  publish(envelope: EventEnvelope): Promise<void>;
}

export interface DispatchOutboxRequest extends ClaimOutboxRequest {
  readonly publisher: EventPublisher;
  readonly retryAt: (claim: OutboxClaim, error: unknown) => string;
}

export interface DispatchOutboxReport {
  readonly claimed: number;
  readonly published: number;
  readonly rescheduled: number;
}

interface ClaimedOutboxRow {
  readonly message_id: string;
  readonly event_id: string;
  readonly lease_token: string;
  readonly lease_until: string | Date;
  readonly attempt_count: string | number | bigint;
  readonly payload: unknown;
}

export class InvalidOutboxClaimError extends Error {
  readonly code = "VANE_OUTBOX_CLAIM_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidOutboxClaimError";
  }
}

export class LostOutboxLeaseError extends Error {
  readonly code = "VANE_OUTBOX_LEASE_LOST" as const;
  readonly messageId: string;

  constructor(messageId: string) {
    super(
      `The lease for outbox message ${JSON.stringify(messageId)} is no longer owned by this worker.`,
    );
    this.name = "LostOutboxLeaseError";
    this.messageId = messageId;
  }
}

export class PostgreSqlOutboxDispatcher {
  readonly #pool: PostgreSqlPoolLike;
  readonly #relation: string;

  constructor(pool: PostgreSqlPoolLike, storage: PostgreSqlStorageIr) {
    this.#pool = pool;
    const table = storage.tables.find(
      (candidate) =>
        candidate.semanticId === OUTBOX_SEMANTIC_ID && candidate.technical,
    );
    if (!table) {
      throw new InvalidOutboxClaimError(
        `Storage IR has no technical table ${JSON.stringify(OUTBOX_SEMANTIC_ID)}.`,
      );
    }
    this.#relation = `${quotePostgreSqlIdentifier(storage.provider.namespace)}.${quotePostgreSqlIdentifier(table.name)}`;
  }

  async claim(request: ClaimOutboxRequest): Promise<readonly OutboxClaim[]> {
    validateClaimRequest(request);
    const leaseToken = randomUUID();

    return this.#inTransaction(async (client) => {
      const result = await client.query<ClaimedOutboxRow>(
        `WITH candidates AS (\n  SELECT message_id FROM ${this.#relation}\n  WHERE published_at IS NULL\n    AND available_at <= transaction_timestamp()\n    AND (lease_until IS NULL OR lease_until <= transaction_timestamp())\n  ORDER BY available_at, occurred_at, message_id\n  FOR UPDATE SKIP LOCKED\n  LIMIT $1\n)\nUPDATE ${this.#relation} AS outbox SET\n  status = 'publishing',\n  lease_owner = $2,\n  lease_token = $3,\n  lease_until = transaction_timestamp() + ($4::bigint * interval '1 millisecond'),\n  attempt_count = outbox.attempt_count + 1\nFROM candidates\nWHERE outbox.message_id = candidates.message_id\nRETURNING outbox.message_id, outbox.event_id, outbox.lease_token, outbox.lease_until, outbox.attempt_count, outbox.payload`,
        [
          request.limit,
          request.workerId,
          leaseToken,
          request.leaseMilliseconds,
        ],
      );

      return result.rows.map(toOutboxClaim);
    });
  }

  async acknowledge(request: AcknowledgeOutboxRequest): Promise<void> {
    assertUuid("messageId", request.messageId);
    assertNonEmpty("workerId", request.workerId);
    assertUuid("leaseToken", request.leaseToken);
    const publishedAt = normalizeInstant("publishedAt", request.publishedAt);
    const result = await this.#withClient((client) =>
      client.query(
        `UPDATE ${this.#relation} SET status = 'published', published_at = $4::timestamptz, lease_owner = NULL, lease_token = NULL, lease_until = NULL, last_error = NULL WHERE message_id = $1 AND lease_owner = $2 AND lease_token = $3 AND status = 'publishing' AND published_at IS NULL`,
        [request.messageId, request.workerId, request.leaseToken, publishedAt],
      ),
    );
    if (result.rowCount !== 1)
      throw new LostOutboxLeaseError(request.messageId);
  }

  async reschedule(request: RescheduleOutboxRequest): Promise<void> {
    assertUuid("messageId", request.messageId);
    assertNonEmpty("workerId", request.workerId);
    assertUuid("leaseToken", request.leaseToken);
    const availableAt = normalizeInstant("availableAt", request.availableAt);
    const safeError = sanitizeError(request.error);
    const result = await this.#withClient((client) =>
      client.query(
        `UPDATE ${this.#relation} SET status = 'pending', available_at = $4::timestamptz, last_error = $5, lease_owner = NULL, lease_token = NULL, lease_until = NULL WHERE message_id = $1 AND lease_owner = $2 AND lease_token = $3 AND status = 'publishing' AND published_at IS NULL`,
        [
          request.messageId,
          request.workerId,
          request.leaseToken,
          availableAt,
          safeError,
        ],
      ),
    );
    if (result.rowCount !== 1)
      throw new LostOutboxLeaseError(request.messageId);
  }

  async dispatch(
    request: DispatchOutboxRequest,
  ): Promise<DispatchOutboxReport> {
    const claims = await this.claim(request);
    let published = 0;
    let rescheduled = 0;

    for (const claim of claims) {
      try {
        await request.publisher.publish(claim.envelope);
      } catch (error) {
        await this.reschedule({
          messageId: claim.messageId,
          workerId: request.workerId,
          leaseToken: claim.leaseToken,
          availableAt: request.retryAt(claim, error),
          error: errorMessage(error),
        });
        rescheduled += 1;
        continue;
      }

      // A failure here deliberately leaves the published message leased. Once
      // the lease expires it can be published again; trying to turn an unknown
      // acknowledgement outcome into a normal retry would hide a lost lease.
      await this.acknowledge({
        messageId: claim.messageId,
        workerId: request.workerId,
        leaseToken: claim.leaseToken,
        publishedAt: new Date().toISOString(),
      });
      published += 1;
    }

    return { claimed: claims.length, published, rescheduled };
  }

  async #inTransaction<T>(
    work: (client: PostgreSqlClientLike) => Promise<T>,
  ): Promise<T> {
    return this.#withClient(async (client) => {
      let open = false;
      try {
        await client.query("BEGIN");
        open = true;
        const value = await work(client);
        await client.query("COMMIT");
        open = false;
        return value;
      } catch (error) {
        if (open) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Preserve the operation error.
          }
        }
        throw error;
      }
    });
  }

  async #withClient<T>(
    work: (client: PostgreSqlClientLike) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }
}

function toOutboxClaim(row: ClaimedOutboxRow): OutboxClaim {
  assertUuid("messageId", row.message_id);
  assertUuid("eventId", row.event_id);
  assertUuid("leaseToken", row.lease_token);
  const envelopeValue =
    typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  if (typeof envelopeValue !== "object" || envelopeValue === null) {
    throw new InvalidOutboxClaimError(
      `Outbox message ${JSON.stringify(row.message_id)} has no valid envelope.`,
    );
  }
  const envelope = envelopeValue as EventEnvelope;
  assertValidEventEnvelope(envelope);
  if (envelope.eventId !== row.event_id) {
    throw new InvalidOutboxClaimError(
      `Outbox message ${JSON.stringify(row.message_id)} does not match its eventId.`,
    );
  }
  return {
    messageId: row.message_id,
    eventId: row.event_id,
    leaseToken: row.lease_token,
    leaseUntil:
      row.lease_until instanceof Date
        ? row.lease_until.toISOString()
        : normalizeInstant("leaseUntil", row.lease_until),
    attempt: Number(row.attempt_count),
    envelope,
  };
}

function validateClaimRequest(request: ClaimOutboxRequest): void {
  assertNonEmpty("workerId", request.workerId);
  if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
    throw new InvalidOutboxClaimError("limit must be a positive safe integer.");
  }
  if (
    !Number.isSafeInteger(request.leaseMilliseconds) ||
    request.leaseMilliseconds <= 0
  ) {
    throw new InvalidOutboxClaimError(
      "leaseMilliseconds must be a positive safe integer.",
    );
  }
}

function assertNonEmpty(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new InvalidOutboxClaimError(`${field} must not be empty.`);
  }
}

function assertUuid(field: string, value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new InvalidOutboxClaimError(`${field} must be a UUID.`);
  }
}

function normalizeInstant(field: string, value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new InvalidOutboxClaimError(
      `${field} ${JSON.stringify(value)} is not a valid instant.`,
    );
  }
  return new Date(timestamp).toISOString();
}

function sanitizeError(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.slice(0, 1_000) || "Outbox publication failed.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Outbox publication failed.";
}
