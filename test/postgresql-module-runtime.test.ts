import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EntityEventOperationDeclaration } from "../src/declaration.js";
import { createEventEnvelope } from "../src/postgresql/envelope.js";
import { materializePostgreSql } from "../src/postgresql/materializer.js";
import { hashPostgreSqlStorageIr } from "../src/postgresql/migrations.js";
import {
  PostgreSqlModuleEventNotFoundError,
  PostgreSqlModuleRuntime,
  PostgreSqlModuleRuntimeConfigurationError,
  PostgreSqlModuleRuntimeStateError,
} from "../src/postgresql/module-runtime.js";
import type {
  PostgreSqlClientLike,
  PostgreSqlPoolLike,
  PostgreSqlQueryResult,
} from "../src/postgresql/runtime.js";
import type { PostgreSqlStorageIr } from "../src/postgresql/storage-ir.js";
import type {
  SemanticColumn,
  SemanticEntity,
  SemanticEntityEvent,
  SemanticModule,
  SemanticProjectIr,
} from "../src/semantic-ir.js";
import { SEMANTIC_PROJECT_IR_VERSION } from "../src/semantic-ir.js";

interface Receipt {
  readonly fingerprint: string;
  result: unknown;
  status: string;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemoryPostgreSqlPool implements PostgreSqlPoolLike {
  readonly receipts = new Map<string, Receipt>();
  readonly queries: string[] = [];
  outboxCount = 0;
  releaseCount = 0;
  revision = 0;
  serverVersionNumber = 160_015;
  mutationGate: Deferred | null = null;
  mutationStarted: Deferred | null = null;
  catalogRows: {
    readonly table_name: string;
    readonly column_name: string;
    udt_name: string;
    readonly is_nullable: string;
    readonly column_default: string | null;
    readonly is_identity: string;
  }[] = [];
  constraintRows: {
    readonly table_name: string;
    readonly object_name: string;
    readonly constraint_type: string;
    readonly column_names: readonly string[];
    readonly reference_table: string | null;
    readonly reference_columns: readonly string[] | null;
    readonly delete_action: string;
    readonly update_action: string;
    check_expression: string | null;
    readonly validated: boolean;
  }[] = [];
  indexRows: {
    readonly table_name: string;
    readonly object_name: string;
    readonly unique: boolean;
    readonly column_expressions: readonly string[];
    readonly predicate: string | null;
    readonly access_method: string;
  }[] = [];
  storageHash = "";

  constructor(storage?: PostgreSqlStorageIr) {
    if (storage) this.installStorage(storage);
  }

  installStorage(storage: PostgreSqlStorageIr): void {
    this.catalogRows = storage.tables.flatMap((table) =>
      table.columns.map((column) => ({
        table_name: table.name,
        column_name: column.name,
        udt_name: {
          text: "text",
          bigint: "int8",
          numeric: "numeric",
          boolean: "bool",
          date: "date",
          timestamptz: "timestamptz",
          uuid: "uuid",
          jsonb: "jsonb",
        }[column.type],
        is_nullable: column.nullable ? "YES" : "NO",
        column_default: column.defaultSql,
        is_identity: column.generated === "identity" ? "YES" : "NO",
      })),
    );
    this.constraintRows = storage.tables.flatMap((table) =>
      table.constraints.map((constraint) => ({
        table_name: table.name,
        object_name: constraint.name,
        constraint_type: {
          primaryKey: "p",
          unique: "u",
          check: "c",
          foreignKey: "f",
        }[constraint.kind],
        column_names: constraint.columns,
        reference_table: constraint.references?.table ?? null,
        reference_columns: constraint.references
          ? [constraint.references.column]
          : null,
        delete_action: "a",
        update_action: "a",
        check_expression: constraint.expression,
        validated: true,
      })),
    );
    this.indexRows = storage.tables.flatMap((table) =>
      table.indexes.map((index) => ({
        table_name: table.name,
        object_name: index.name,
        unique: index.unique,
        column_expressions: index.columns,
        predicate: index.where,
        access_method: "btree",
      })),
    );
    this.storageHash = hashPostgreSqlStorageIr(storage);
  }

  removePhysicalTable(name: string): void {
    this.catalogRows = this.catalogRows.filter(
      (row) => row.table_name !== name,
    );
  }

  async connect(): Promise<PostgreSqlClientLike> {
    return new MemoryPostgreSqlClient(this);
  }
}

class MemoryPostgreSqlClient implements PostgreSqlClientLike {
  readonly #database: MemoryPostgreSqlPool;

  constructor(database: MemoryPostgreSqlPool) {
    this.#database = database;
  }

  async query<Row extends object = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<PostgreSqlQueryResult<Row>> {
    this.#database.queries.push(sql);
    let rows: readonly Record<string, unknown>[] = [];
    let rowCount = 0;

    if (sql === "SHOW server_version_num") {
      rows = [
        { server_version_num: String(this.#database.serverVersionNumber) },
      ];
      rowCount = 1;
    } else if (sql.includes("information_schema.columns")) {
      const requested = new Set(values[1] as readonly string[]);
      rows = this.#database.catalogRows.filter((row) =>
        requested.has(row.table_name),
      );
      rowCount = rows.length;
    } else if (sql.includes("FROM pg_constraint AS constraint_entry")) {
      rows = this.#database.constraintRows;
      rowCount = rows.length;
    } else if (sql.includes("FROM pg_index AS index_entry")) {
      rows = this.#database.indexRows;
      rowCount = rows.length;
    } else if (sql.includes("SELECT target_hash")) {
      rows = [{ target_hash: this.#database.storageHash }];
      rowCount = 1;
    } else if (sql.includes("INSERT INTO") && sql.includes("__vane_mailbox")) {
      const eventId = String(values[0]);
      if (!this.#database.receipts.has(eventId)) {
        this.#database.receipts.set(eventId, {
          fingerprint: String(values[1]),
          status: "processing",
          result: null,
        });
        rows = [{ event_id: eventId }];
        rowCount = 1;
      }
    } else if (
      sql.includes("SELECT fingerprint, status, result") &&
      sql.includes("__vane_mailbox")
    ) {
      const receipt = this.#database.receipts.get(String(values[0]));
      if (receipt) {
        rows = [
          {
            fingerprint: receipt.fingerprint,
            result: receipt.result,
            status: receipt.status,
          },
        ];
        rowCount = 1;
      }
    } else if (sql.includes('RETURNING "__vane_revision" AS revision')) {
      this.#database.mutationStarted?.resolve();
      if (this.#database.mutationGate)
        await this.#database.mutationGate.promise;
      this.#database.revision += 1;
      rows = [{ revision: String(this.#database.revision) }];
      rowCount = 1;
    } else if (sql.includes("INSERT INTO") && sql.includes("__vane_outbox")) {
      this.#database.outboxCount += 1;
      rowCount = 1;
    } else if (sql.includes("UPDATE") && sql.includes("__vane_mailbox")) {
      const receipt = this.#database.receipts.get(String(values[0]));
      assert.ok(receipt);
      receipt.status = String(values[1]);
      receipt.result = JSON.parse(String(values[2]));
      rowCount = 1;
    }

    return { rows, rowCount } as PostgreSqlQueryResult<Row>;
  }

  release(): void {
    this.#database.releaseCount += 1;
  }
}

const idColumn: SemanticColumn = {
  name: "id",
  type: "uuid",
  identity: true,
  nullable: false,
  unique: false,
  generated: null,
  minLength: null,
  maxLength: null,
  minimum: null,
  maximum: null,
  default: null,
  hasDefault: false,
  references: null,
};

const quantityColumn: SemanticColumn = {
  ...idColumn,
  name: "quantity",
  type: "integer",
  identity: false,
};

const updateOperation: EntityEventOperationDeclaration = {
  kind: "update",
  identity: { kind: "input", input: "id" },
  values: [
    {
      column: "quantity",
      value: { kind: "input", input: "quantity" },
    },
  ],
};

const updateEvent: SemanticEntityEvent = {
  identity: "Order.Update",
  name: "Update",
  owner: { kind: "entity", entity: "Order" },
  persistence: { target: "owner", required: true },
  input: [
    { name: "id", type: "uuid", optional: false },
    { name: "quantity", type: "integer", optional: false },
  ],
  operation: updateOperation,
  publicResult: {
    success: "viewOnly",
    fail: { code: "stable", message: "safe", correlationId: true },
  },
};

const order: SemanticEntity = {
  name: "Order",
  identityColumn: "id",
  columns: [idColumn, quantityColumn],
  rules: [],
  events: [updateEvent],
};

function semanticModule(
  entities: readonly SemanticEntity[] = [order],
): SemanticModule {
  return {
    name: "Sales",
    imports: [],
    entities,
    views: [],
    antiCorruptionLayers: [],
    sagas: [],
  };
}

function storageFor(module: SemanticModule): PostgreSqlStorageIr {
  const project: SemanticProjectIr = {
    schema: "vane.semantic-project-ir",
    version: SEMANTIC_PROJECT_IR_VERSION,
    modules: [module],
  };
  const result = materializePostgreSql(project, {
    namespace: "vane",
    targetVersion: 16,
  });
  assert.equal(result.success, true);
  if (!result.success)
    throw new Error("PostgreSQL fixture did not materialize.");
  return result.ir;
}

function envelope(eventId: string, eventIdentity = "Order.Update") {
  return createEventEnvelope({
    eventId,
    eventIdentity,
    occurredAt: "2026-08-31T16:00:00.000Z",
    payload: {
      id: "10000000-0000-4000-8000-000000000001",
      quantity: 7,
    },
  });
}

describe("PostgreSQL Module runtime", () => {
  it("validates the plan and dispatches an Entity Event only by its identity", async () => {
    const module = semanticModule();
    const storage = storageFor(module);
    const database = new MemoryPostgreSqlPool(storage);
    const runtime = new PostgreSqlModuleRuntime({
      module,
      pool: database,
      storage,
    });

    await runtime.start();
    const result = await runtime.dispatch(
      envelope("10000000-0000-4000-8000-000000000010"),
    );

    assert.equal(runtime.state, "running");
    assert.equal(result.kind, "success");
    assert.equal(database.revision, 1);
    assert.equal(database.outboxCount, 1);
    assert.ok(database.queries.includes("SHOW server_version_num"));
    assert.ok(
      database.queries.some((sql) => sql.includes("attribute.attname::text")),
    );
    await runtime.stop();
  });

  it("rejects ambiguous and unknown Entity Event identities", async () => {
    const duplicateModule = semanticModule([order, { ...order }]);
    const storage = storageFor(semanticModule());
    const database = new MemoryPostgreSqlPool(storage);
    const ambiguous = new PostgreSqlModuleRuntime({
      module: duplicateModule,
      pool: database,
      storage,
    });
    await assert.rejects(
      ambiguous.start(),
      PostgreSqlModuleRuntimeConfigurationError,
    );
    assert.equal(database.queries.length, 0);

    const module = semanticModule();
    const runtime = new PostgreSqlModuleRuntime({
      module,
      pool: database,
      storage,
    });
    await runtime.start();
    await assert.rejects(
      runtime.dispatch(
        envelope("10000000-0000-4000-8000-000000000011", "Order.Missing"),
      ),
      PostgreSqlModuleEventNotFoundError,
    );
    await runtime.stop();
  });

  it("refuses missing plan/catalog tables and an incompatible PostgreSQL server", async () => {
    const module = semanticModule();
    const storage = storageFor(module);
    const database = new MemoryPostgreSqlPool(storage);
    const missingOwner: PostgreSqlStorageIr = {
      ...storage,
      tables: storage.tables.filter(
        (table) => table.semanticId !== "Sales.Order",
      ),
    };
    const invalidPlan = new PostgreSqlModuleRuntime({
      module,
      pool: database,
      storage: missingOwner,
    });
    await assert.rejects(
      invalidPlan.start(),
      PostgreSqlModuleRuntimeConfigurationError,
    );
    assert.equal(database.queries.length, 0);

    const driftedDatabase = new MemoryPostgreSqlPool(storage);
    const ownerTable = storage.tables.find(
      (table) => table.semanticId === "Sales.Order",
    );
    assert.ok(ownerTable);
    driftedDatabase.removePhysicalTable(ownerTable.name);
    const drifted = new PostgreSqlModuleRuntime({
      module,
      pool: driftedDatabase,
      storage,
    });
    await assert.rejects(
      drifted.start(),
      PostgreSqlModuleRuntimeConfigurationError,
    );
    assert.equal(drifted.state, "stopped");
    assert.ok(
      driftedDatabase.queries.some((sql) =>
        sql.includes("information_schema.columns"),
      ),
    );

    const oldDatabase = new MemoryPostgreSqlPool(storage);
    oldDatabase.serverVersionNumber = 150_015;
    const oldProvider = new PostgreSqlModuleRuntime({
      module,
      pool: oldDatabase,
      storage,
    });
    await assert.rejects(
      oldProvider.start(),
      PostgreSqlModuleRuntimeConfigurationError,
    );
    assert.equal(oldProvider.state, "stopped");
    assert.equal(oldDatabase.releaseCount, 1);
  });

  it("refuses type, constraint and installed-hash drift", async () => {
    const module = semanticModule();
    const storage = storageFor(module);

    const wrongType = new MemoryPostgreSqlPool(storage);
    const quantity = wrongType.catalogRows.find(
      (row) => row.column_name === "quantity",
    );
    assert.ok(quantity);
    quantity.udt_name = "text";
    await assert.rejects(
      new PostgreSqlModuleRuntime({ module, pool: wrongType, storage }).start(),
      PostgreSqlModuleRuntimeConfigurationError,
    );

    const missingConstraint = new MemoryPostgreSqlPool(storage);
    missingConstraint.constraintRows =
      missingConstraint.constraintRows.slice(1);
    await assert.rejects(
      new PostgreSqlModuleRuntime({
        module,
        pool: missingConstraint,
        storage,
      }).start(),
      PostgreSqlModuleRuntimeConfigurationError,
    );

    const alteredConstraint = new MemoryPostgreSqlPool(storage);
    const check = alteredConstraint.constraintRows.find(
      (constraint) => constraint.constraint_type === "c",
    );
    assert.ok(check);
    check.check_expression = "true";
    await assert.rejects(
      new PostgreSqlModuleRuntime({
        module,
        pool: alteredConstraint,
        storage,
      }).start(),
      PostgreSqlModuleRuntimeConfigurationError,
    );

    const wrongHash = new MemoryPostgreSqlPool(storage);
    wrongHash.storageHash = "0".repeat(64);
    await assert.rejects(
      new PostgreSqlModuleRuntime({ module, pool: wrongHash, storage }).start(),
      PostgreSqlModuleRuntimeConfigurationError,
    );
  });

  it("accepts PostgreSQL's canonical CHECK deparse without hiding drift", async () => {
    const module = semanticModule();
    const storage = storageFor(module);
    const database = new MemoryPostgreSqlPool(storage);
    for (const constraint of database.constraintRows) {
      if (constraint.constraint_type !== "f")
        Object.assign(constraint, { reference_columns: [] });
      if (constraint.check_expression?.includes(" IN ("))
        constraint.check_expression = `(${constraint.check_expression
          .replace(" IN (", " = ANY (ARRAY[")
          .replace(/'([^']*)'/gu, "'$1'::text")
          .replace(/\)$/u, "])")})`;
      else if (constraint.check_expression?.includes("> 0"))
        constraint.check_expression = `(${constraint.check_expression.replace(
          "> 0",
          "> (0)::integer",
        )})`;
    }

    const runtime = new PostgreSqlModuleRuntime({
      module,
      pool: database,
      storage,
    });
    await runtime.start();
    await runtime.stop();
  });

  it("accepts PostgreSQL boolean and canonical JSONB default deparse", async () => {
    const module = semanticModule();
    const initial = storageFor(module);
    const storage: PostgreSqlStorageIr = {
      ...initial,
      tables: initial.tables.map((table) =>
        table.semanticId === "Sales.Order"
          ? {
              ...table,
              columns: [
                ...table.columns,
                {
                  semanticId: "Sales.Order.active",
                  name: "active",
                  type: "boolean",
                  nullable: false,
                  defaultSql: "TRUE",
                  generated: null,
                  technical: false,
                },
                {
                  semanticId: "Sales.Order.metadata",
                  name: "metadata",
                  type: "jsonb",
                  nullable: false,
                  defaultSql: `'{\"a\":1,\"b\":2}'::jsonb`,
                  generated: null,
                  technical: false,
                },
              ],
            }
          : table,
      ),
    };
    const database = new MemoryPostgreSqlPool(storage);
    const active = database.catalogRows.find(
      ({ column_name }) => column_name === "active",
    );
    const metadata = database.catalogRows.find(
      ({ column_name }) => column_name === "metadata",
    );
    assert.ok(active);
    assert.ok(metadata);
    Object.assign(active, { column_default: "true" });
    Object.assign(metadata, {
      column_default: `'{\"b\": 2, \"a\": 1}'::jsonb`,
    });

    const runtime = new PostgreSqlModuleRuntime({
      module,
      pool: database,
      storage,
    });
    await runtime.start();
    await runtime.stop();
  });

  it("stops admission immediately and waits for every accepted transaction", async () => {
    const module = semanticModule();
    const storage = storageFor(module);
    const database = new MemoryPostgreSqlPool(storage);
    database.mutationGate = deferred();
    database.mutationStarted = deferred();
    const runtime = new PostgreSqlModuleRuntime({
      module,
      pool: database,
      storage,
    });
    await runtime.start();

    const accepted = runtime.dispatch(
      envelope("10000000-0000-4000-8000-000000000012"),
    );
    await database.mutationStarted.promise;
    const stopped = runtime.stop();
    assert.equal(runtime.state, "stopping");
    await assert.rejects(
      runtime.dispatch(envelope("10000000-0000-4000-8000-000000000013")),
      PostgreSqlModuleRuntimeStateError,
    );

    let drainFinished = false;
    void stopped.then(() => {
      drainFinished = true;
    });
    await Promise.resolve();
    assert.equal(drainFinished, false);
    database.mutationGate.resolve();
    await accepted;
    await stopped;
    assert.equal(runtime.state, "stopped");
    assert.equal(database.outboxCount, 1);
  });

  it("restarts against the same durable mailbox and returns its stored result", async () => {
    const module = semanticModule();
    const storage = storageFor(module);
    const database = new MemoryPostgreSqlPool(storage);
    const runtime = new PostgreSqlModuleRuntime({
      module,
      pool: database,
      storage,
    });
    const occurrence = envelope("10000000-0000-4000-8000-000000000014");

    await runtime.start();
    const first = await runtime.dispatch(occurrence);
    await runtime.stop();
    await runtime.start();
    const replay = await runtime.dispatch(occurrence);

    assert.equal(first.kind, "success");
    assert.equal(replay.kind, "duplicate");
    assert.equal(database.revision, 1);
    assert.equal(database.outboxCount, 1);
    assert.equal(
      database.queries.filter((sql) => sql === "SHOW server_version_num")
        .length,
      2,
    );
    await runtime.stop();
  });
});
