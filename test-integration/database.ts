import { randomUUID } from "node:crypto";
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

const databaseUrl = process.env.VANE_TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "VANE_TEST_DATABASE_URL is required for PostgreSQL integration tests.",
  );
}

export const testDatabaseUrl = databaseUrl;

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export interface TestDatabase {
  readonly pool: Pool;
  readonly schema: string;
  readonly qualifiedSchema: string;
  connect(): Promise<PoolClient>;
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export async function withTestDatabase(
  name: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const normalizedName = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .slice(0, 20);
  const schema = `vane_${normalizedName}_${suffix}`;
  const qualifiedSchema = quoteIdentifier(schema);
  const pool = new Pool({
    application_name: "vane-phase-2-integration",
    connectionString: databaseUrl,
    max: 24,
  });

  await pool.query(`CREATE SCHEMA ${qualifiedSchema}`);

  try {
    await run({
      pool,
      schema,
      qualifiedSchema,
      connect: () => pool.connect(),
      query: <Row extends QueryResultRow>(text: string, values?: unknown[]) =>
        pool.query<Row>(text, values),
    });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${qualifiedSchema} CASCADE`);
    await pool.end();
  }
}
