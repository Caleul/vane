import { createHash } from "node:crypto";
import {
  quotePostgreSqlIdentifier,
  toPostgreSqlIdentifier,
} from "./identifiers.js";
import {
  POSTGRESQL_MIGRATION_HISTORY_TABLE,
  type PostgreSqlMigrationClassification,
  type PostgreSqlMigrationPlan,
  hashPostgreSqlStorageIr,
  verifyPostgreSqlMigrationPlanHash,
} from "./migrations.js";
import type { PostgreSqlClientLike, PostgreSqlPoolLike } from "./runtime.js";

export interface PostgreSqlMigrationQueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount?: number | null;
}

export interface PostgreSqlMigrationClient extends PostgreSqlClientLike {}

export interface PostgreSqlMigrationDatabase extends PostgreSqlPoolLike {
  connect(): Promise<PostgreSqlMigrationClient>;
}

export interface PostgreSqlMigrationApproval {
  readonly planHash: string;
  readonly classification: "unsafe" | "destructive";
  readonly reason: string;
}

export interface PostgreSqlMigrationApprovalInput {
  readonly classification: "unsafe" | "destructive";
  readonly reason: string;
}

export type PostgreSqlMigrationApplicationResult =
  | {
      readonly status: "no-op";
      readonly planHash: string;
      readonly appliedSteps: 0;
    }
  | {
      readonly status: "already-applied";
      readonly planHash: string;
      readonly appliedSteps: 0;
    }
  | {
      readonly status: "applied";
      readonly planHash: string;
      readonly appliedSteps: number;
    };

export class PostgreSqlMigrationApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgreSqlMigrationApprovalError";
  }
}

export class PostgreSqlMigrationHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgreSqlMigrationHistoryError";
  }
}

export function approvePostgreSqlMigrationPlan(
  plan: PostgreSqlMigrationPlan,
  input: PostgreSqlMigrationApprovalInput,
): PostgreSqlMigrationApproval {
  assertPlanIntegrity(plan);
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new PostgreSqlMigrationApprovalError(
      "A migration approval must record a non-empty reason.",
    );
  }
  if (plan.classification === "safe") {
    throw new PostgreSqlMigrationApprovalError(
      "Safe migration plans do not require an approval artifact.",
    );
  }
  if (input.classification !== plan.classification) {
    throw new PostgreSqlMigrationApprovalError(
      `Approval classification ${input.classification} does not match ${plan.classification}.`,
    );
  }
  return {
    planHash: plan.hash,
    classification: input.classification,
    reason,
  };
}

export async function applyPostgreSqlMigrationPlan(
  database: PostgreSqlMigrationDatabase,
  plan: PostgreSqlMigrationPlan,
  approval?: PostgreSqlMigrationApproval,
): Promise<PostgreSqlMigrationApplicationResult> {
  assertPlanIntegrity(plan);
  assertApproval(plan, approval);
  if (plan.noOp) {
    return { status: "no-op", planHash: plan.hash, appliedSteps: 0 };
  }

  const client = await database.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0));",
      [`vane:migrations:${plan.namespace}`],
    );
    await client.query(
      `CREATE SCHEMA IF NOT EXISTS ${quotePostgreSqlIdentifier(plan.namespace)};`,
    );
    await client.query(renderHistoryBootstrap(plan.namespace));
    await client.query(
      `LOCK TABLE ${qualified(plan.namespace, POSTGRESQL_MIGRATION_HISTORY_TABLE)} IN EXCLUSIVE MODE;`,
    );

    const existing = await client.query(
      `SELECT "plan_hash" FROM ${qualified(plan.namespace, POSTGRESQL_MIGRATION_HISTORY_TABLE)} WHERE "plan_hash" = $1;`,
      [plan.hash],
    );
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      transactionStarted = false;
      return {
        status: "already-applied",
        planHash: plan.hash,
        appliedSteps: 0,
      };
    }

    const head = await client.query(
      `SELECT "target_hash" FROM ${qualified(plan.namespace, POSTGRESQL_MIGRATION_HISTORY_TABLE)} ORDER BY "applied_order" DESC LIMIT 1;`,
    );
    const currentTarget = head.rows[0]?.target_hash;
    if (
      currentTarget === undefined &&
      plan.sourceHash !== hashPostgreSqlStorageIr(null)
    ) {
      throw new PostgreSqlMigrationHistoryError(
        `Migration source ${plan.sourceHash} has no applied predecessor in migration history.`,
      );
    }
    if (
      typeof currentTarget === "string" &&
      currentTarget !== plan.sourceHash
    ) {
      throw new PostgreSqlMigrationHistoryError(
        `Migration source ${plan.sourceHash} does not match applied head ${currentTarget}.`,
      );
    }

    for (const step of plan.steps) await client.query(step.sql);
    await client.query(
      `INSERT INTO ${qualified(plan.namespace, POSTGRESQL_MIGRATION_HISTORY_TABLE)} ("plan_hash", "source_hash", "target_hash", "classification", "sql_hash", "approval_reason") VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        plan.hash,
        plan.sourceHash,
        plan.targetHash,
        plan.classification,
        sha256(plan.sql),
        approval?.reason ?? null,
      ],
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return {
      status: "applied",
      planHash: plan.hash,
      appliedSteps: plan.steps.length,
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original migration failure.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function assertPlanIntegrity(plan: PostgreSqlMigrationPlan): void {
  if (!verifyPostgreSqlMigrationPlanHash(plan)) {
    throw new PostgreSqlMigrationApprovalError(
      "Migration plan content does not match its SHA-256 hash.",
    );
  }
}

function assertApproval(
  plan: PostgreSqlMigrationPlan,
  approval: PostgreSqlMigrationApproval | undefined,
): void {
  if (plan.classification === "safe") return;
  if (!approval) {
    throw new PostgreSqlMigrationApprovalError(
      `${plan.classification} migration ${plan.hash} requires explicit approval.`,
    );
  }
  if (approval.planHash !== plan.hash) {
    throw new PostgreSqlMigrationApprovalError(
      `Approval for ${approval.planHash} cannot authorize plan ${plan.hash}.`,
    );
  }
  if (approval.classification !== plan.classification) {
    throw new PostgreSqlMigrationApprovalError(
      `Approval classification ${approval.classification} does not authorize ${plan.classification}.`,
    );
  }
  if (approval.reason.trim().length === 0) {
    throw new PostgreSqlMigrationApprovalError(
      "Migration approval reason cannot be empty.",
    );
  }
}

function renderHistoryBootstrap(namespace: string): string {
  const primaryKey = toPostgreSqlIdentifier(
    [POSTGRESQL_MIGRATION_HISTORY_TABLE],
    "pk",
  );
  return [
    `CREATE TABLE IF NOT EXISTS ${qualified(namespace, POSTGRESQL_MIGRATION_HISTORY_TABLE)} (`,
    '  "plan_hash" text NOT NULL,',
    '  "applied_order" bigint GENERATED ALWAYS AS IDENTITY,',
    '  "source_hash" text NOT NULL,',
    '  "target_hash" text NOT NULL,',
    '  "classification" text NOT NULL,',
    '  "sql_hash" text NOT NULL,',
    '  "approval_reason" text,',
    '  "applied_at" timestamptz DEFAULT clock_timestamp() NOT NULL,',
    `  CONSTRAINT ${quotePostgreSqlIdentifier(primaryKey)} PRIMARY KEY ("plan_hash")`,
    ");",
  ].join("\n");
}

function qualified(namespace: string, name: string): string {
  return `${quotePostgreSqlIdentifier(namespace)}.${quotePostgreSqlIdentifier(name)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function requiresPostgreSqlMigrationApproval(
  classification: PostgreSqlMigrationClassification,
): classification is "unsafe" | "destructive" {
  return classification !== "safe";
}
