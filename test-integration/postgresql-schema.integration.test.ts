import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quotePostgreSqlIdentifier } from "../src/postgresql/identifiers.js";
import { materializePostgreSql } from "../src/postgresql/materializer.js";
import { renderPostgreSqlSchema } from "../src/postgresql/renderer.js";
import type {
  PostgreSqlStorageIr,
  PostgreSqlTable,
} from "../src/postgresql/storage-ir.js";
import { withTestDatabase } from "./database.js";
import { phaseTwoProject } from "./fixtures.js";

function materialize(namespace: string): PostgreSqlStorageIr {
  const result = materializePostgreSql(phaseTwoProject(), {
    namespace,
    targetVersion: 16,
  });
  assert.equal(
    result.success,
    true,
    result.success
      ? undefined
      : result.diagnostics.map(({ message }) => message).join("\n"),
  );
  if (!result.success) throw new Error("PostgreSQL materialization failed.");
  return result.ir;
}

function entityTable(ir: PostgreSqlStorageIr): PostgreSqlTable {
  const table = ir.tables.find(
    ({ semanticId }) => semanticId === "Inventory.StockItem",
  );
  assert.ok(table);
  return table;
}

function columnName(table: PostgreSqlTable, semanticName: string): string {
  const column = table.columns.find(({ semanticId }) =>
    semanticId.endsWith(`.${semanticName}`),
  );
  assert.ok(column, `Missing materialized Column ${semanticName}.`);
  return quotePostgreSqlIdentifier(column.name);
}

function isPostgreSqlError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

describe("PostgreSQL schema materialization", () => {
  it("applies generated DDL and round-trips every phase-2 Column type", async () => {
    await withTestDatabase("schema_types", async ({ pool, schema }) => {
      const ir = materialize(schema);
      await pool.query(renderPostgreSqlSchema(ir));

      const table = entityTable(ir);
      const qualifiedTable = `${quotePostgreSqlIdentifier(schema)}.${quotePostgreSqlIdentifier(table.name)}`;
      const available = columnName(table, "available");
      const createdAt = columnName(table, "createdAt");
      const expiresOn = columnName(table, "expiresOn");
      const name = columnName(table, "name");
      const price = columnName(table, "price");
      const reserved = columnName(table, "reserved");

      const inserted = await pool.query<{
        active: boolean;
        attributes: { fragile: boolean; labels: string[] };
        available: string;
        created_at: Date;
        expires_on: string;
        id: string;
        name: string;
        price: string;
        reserved: string;
      }>(
        `INSERT INTO ${qualifiedTable} (${available}, ${createdAt}, ${expiresOn}, ${name}, ${price}, ${reserved})
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING
           ${columnName(table, "active")} AS active,
           ${columnName(table, "attributes")} AS attributes,
           ${available}::text AS available,
           ${createdAt} AS created_at,
           ${expiresOn}::text AS expires_on,
           ${columnName(table, "id")}::text AS id,
           ${name} AS name,
           ${price}::text AS price,
           ${reserved}::text AS reserved`,
        [12, "2026-08-31T12:30:00.000Z", "2027-01-02", "Keyboard", "199.90", 2],
      );

      assert.deepEqual(inserted.rows[0], {
        active: true,
        attributes: { fragile: false, labels: ["new"] },
        available: "12",
        created_at: new Date("2026-08-31T12:30:00.000Z"),
        expires_on: "2027-01-02",
        id: inserted.rows[0]?.id,
        name: "Keyboard",
        price: "199.90",
        reserved: "2",
      });
      assert.match(inserted.rows[0]?.id ?? "", /^[0-9a-f-]{36}$/);
    });
  });

  it("enforces Column constraints, multi-Column Rules and uniqueness in PostgreSQL", async () => {
    await withTestDatabase("schema_rules", async ({ pool, schema }) => {
      const ir = materialize(schema);
      await pool.query(renderPostgreSqlSchema(ir));
      const table = entityTable(ir);
      const qualifiedTable = `${quotePostgreSqlIdentifier(schema)}.${quotePostgreSqlIdentifier(table.name)}`;
      const available = columnName(table, "available");
      const createdAt = columnName(table, "createdAt");
      const name = columnName(table, "name");
      const price = columnName(table, "price");
      const reserved = columnName(table, "reserved");
      const insert = `INSERT INTO ${qualifiedTable} (${available}, ${createdAt}, ${name}, ${price}, ${reserved}) VALUES ($1, $2, $3, $4, $5)`;

      await pool.query(insert, [
        5,
        "2026-08-31T12:30:00.000Z",
        "Mouse",
        "20.00",
        1,
      ]);

      await assert.rejects(
        pool.query(insert, [
          1,
          "2026-08-31T12:30:00.000Z",
          "Mouse",
          "20.00",
          0,
        ]),
        (error) => isPostgreSqlError(error, "23505"),
      );
      await assert.rejects(
        pool.query(insert, [1, "2026-08-31T12:30:00.000Z", "", "20.00", 0]),
        (error) => isPostgreSqlError(error, "23514"),
      );
      await assert.rejects(
        pool.query(insert, [
          1,
          "2026-08-31T12:30:00.000Z",
          "Invalid stock",
          "20.00",
          2,
        ]),
        (error) => isPostgreSqlError(error, "23514"),
      );
      await assert.rejects(
        pool.query(insert, [
          1,
          "2026-08-31T12:30:00.000Z",
          "Negative",
          "-0.01",
          0,
        ]),
        (error) => isPostgreSqlError(error, "23514"),
      );
    });
  });
});
