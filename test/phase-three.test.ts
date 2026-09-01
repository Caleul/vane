import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContractIr } from "../src/contract-ir.js";
import {
  type EventEnvelope,
  InMemoryTerminalResultStore,
  type PostgreSqlClientLike,
  type PostgreSqlPoolLike,
  type PostgreSqlQueryResult,
  type PostgreSqlStorageIr,
  PostgreSqlViewRuntime,
  PublicHttpRuntime,
  type SemanticModule,
  generateOpenApi,
  materializeContract,
  serializeContractIr,
  serializeOpenApi,
} from "../src/index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION = "22222222-2222-4222-8222-222222222222";
const SAGA = "33333333-3333-4333-8333-333333333333";
const UUID_V7 = "01890f47-2f9c-7cc1-98d8-f7c31c1b4a21";

const module: SemanticModule = {
  name: "Sales",
  imports: [],
  entities: [
    {
      name: "Order",
      identityColumn: "id",
      columns: [
        column("id", "uuid"),
        column("customerId", "uuid"),
        column("total", "decimal"),
      ],
      rules: [],
      events: [
        {
          identity: "Order.Place",
          name: "Place",
          owner: { kind: "entity", entity: "Order" },
          persistence: { target: "owner", required: true },
          input: [
            { name: "id", type: "uuid", optional: false },
            { name: "customerId", type: "uuid", optional: false },
            { name: "total", type: "decimal", optional: false },
          ],
          operation: {
            kind: "create",
            values: [
              { column: "id", value: { kind: "input", input: "id" } },
              {
                column: "customerId",
                value: { kind: "input", input: "customerId" },
              },
              { column: "total", value: { kind: "input", input: "total" } },
            ],
          },
          publicResult: {
            success: "viewOnly",
            fail: { code: "stable", message: "safe", correlationId: true },
          },
        },
      ],
    },
  ],
  views: [
    {
      name: "OrderDetails",
      input: [{ name: "id", type: "uuid", optional: false }],
      output: [
        {
          name: "id",
          type: "uuid",
          nullable: false,
          expression: { kind: "column", entity: "Order", column: "id" },
        },
        {
          name: "total",
          type: "decimal",
          nullable: false,
          expression: { kind: "column", entity: "Order", column: "total" },
        },
      ],
      query: {
        root: "Order",
        relations: [],
        where: {
          kind: "comparison",
          operator: "eq",
          left: { kind: "column", entity: "Order", column: "id" },
          right: { kind: "input", input: "id" },
        },
        orderBy: [],
        pagination: null,
      },
      persistence: { allowed: false },
      publicResult: { kind: "view" },
    },
  ],
  antiCorruptionLayers: [],
  sagas: [],
};

const contractConfiguration = {
  basePath: "/api",
  events: [
    {
      event: "Order.Place",
      terminal: {
        view: "OrderDetails",
        input: { id: { kind: "eventInput" as const, input: "id" } },
      },
    },
  ],
  views: [{ view: "OrderDetails" }],
};

describe("phase 3 Contract IR and OpenAPI", () => {
  it("materializes deterministic internal identities and public paths", () => {
    const first = materializeContract(module, contractConfiguration);
    const second = materializeContract(module, {
      ...contractConfiguration,
      views: [...contractConfiguration.views].reverse(),
      events: [...contractConfiguration.events].reverse(),
    });
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    if (!first.success || !second.success) return;
    assert.equal(serializeContractIr(first.ir), serializeContractIr(second.ir));
    assert.deepEqual(
      first.ir.operations.map(({ kind, identity, path }) => ({
        kind,
        identity,
        path,
      })),
      [
        {
          kind: "event",
          identity: "Order.Place",
          path: "/api/events/Order.Place",
        },
        {
          kind: "view",
          identity: "OrderDetails",
          path: "/api/views/OrderDetails",
        },
      ],
    );
  });

  it("rejects invalid terminal mappings and path collisions without partial IR", () => {
    const result = materializeContract(module, {
      events: [
        {
          event: "Order.Place",
          path: "/same",
          terminal: { view: "OrderDetails", input: {} },
        },
      ],
      views: [{ view: "OrderDetails", path: "/same" }],
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["VANE_CONTRACT_TERMINAL_INPUT_REQUIRED", "VANE_CONTRACT_PATH_COLLISION"],
    );
  });

  it("rejects non-canonical paths and incomplete datetime literals", () => {
    const badPath = materializeContract(module, {
      views: [{ view: "OrderDetails", path: "/api/../orders" }],
    });
    assert.equal(badPath.success, false);
    if (!badPath.success)
      assert.equal(badPath.diagnostics[0]?.code, "VANE_CONTRACT_PATH_INVALID");

    const dateModule: SemanticModule = {
      ...module,
      views: module.views.map((view) => ({
        ...view,
        input: [
          ...view.input,
          { name: "at", type: "datetime" as const, optional: false },
        ],
      })),
    };
    const badDatetime = materializeContract(dateModule, {
      events: [
        {
          event: "Order.Place",
          terminal: {
            view: "OrderDetails",
            input: {
              id: { kind: "eventInput", input: "id" },
              at: { kind: "literal", value: "2026-09-01" },
            },
          },
        },
      ],
    });
    assert.equal(badDatetime.success, false);
    if (!badDatetime.success)
      assert.equal(
        badDatetime.diagnostics[0]?.code,
        "VANE_CONTRACT_TERMINAL_LITERAL_TYPE",
      );

    const jsonModule: SemanticModule = {
      ...module,
      views: module.views.map((view) => ({
        ...view,
        input: [
          ...view.input,
          { name: "filter", type: "json" as const, optional: false },
        ],
      })),
    };
    const badJson = materializeContract(jsonModule, {
      events: [
        {
          event: "Order.Place",
          terminal: {
            view: "OrderDetails",
            input: {
              id: { kind: "eventInput", input: "id" },
              filter: { kind: "literal", value: { value: "\ud800" } },
            },
          },
        },
      ],
    });
    assert.equal(badJson.success, false);
    if (!badJson.success)
      assert.equal(
        badJson.diagnostics[0]?.code,
        "VANE_CONTRACT_TERMINAL_LITERAL_TYPE",
      );
  });

  it("generates byte-identical OpenAPI with typed View, Event and SSE contracts", () => {
    const materialized = materializeContract(module, contractConfiguration);
    assert.equal(materialized.success, true);
    if (!materialized.success) return;
    const first = generateOpenApi(materialized.ir);
    const second = generateOpenApi(materialized.ir);
    assert.equal(serializeOpenApi(first), serializeOpenApi(second));
    assert.ok(first.paths["/api/events/Order.Place"]);
    assert.ok(first.paths["/api/views/OrderDetails"]);
    assert.ok(first.paths["/api/sagas/{sagaId}"]);
    assert.equal(JSON.stringify(first).includes("revision"), false);
  });

  it("generates unique operation IDs for repeated public exposures", () => {
    const materialized = materializeContract(module, {
      views: [
        { view: "OrderDetails", path: "/orders" },
        { view: "OrderDetails", path: "/order-search" },
      ],
    });
    assert.equal(materialized.success, true);
    if (!materialized.success) return;
    const document = generateOpenApi(materialized.ir);
    const operationIds = ["/orders", "/order-search"].map(
      (path) =>
        (
          document.paths[path] as {
            readonly post: { readonly operationId: string };
          }
        ).post.operationId,
    );
    assert.equal(new Set(operationIds).size, operationIds.length);
  });
});

describe("phase 3 PostgreSQL View runtime", () => {
  it("executes the declared projection and filter with parameterized SQL", async () => {
    const queries: { text: string; values: readonly unknown[] }[] = [];
    const client: PostgreSqlClientLike = {
      async query<Row extends object>(
        text: string,
        values: unknown[] = [],
      ): Promise<PostgreSqlQueryResult<Row>> {
        queries.push({ text, values });
        return {
          rows: [{ id: ID, total: "42.50" }] as unknown as Row[],
          rowCount: 1,
        };
      },
      release() {},
    };
    const pool: PostgreSqlPoolLike = {
      async connect() {
        return client;
      },
    };
    const runtime = new PostgreSqlViewRuntime(module, pool, storage);
    const result = await runtime.execute({
      view: "OrderDetails",
      input: { id: UUID_V7 },
    });
    assert.deepEqual(result, {
      kind: "view",
      view: "OrderDetails",
      rows: [{ id: ID, total: 42.5 }],
    });
    assert.deepEqual(queries, [
      {
        text: 'SELECT "v0"."id" AS "id", "v0"."total" AS "total" FROM "public"."sales_order" AS "v0" WHERE ("v0"."id" = $1::uuid)',
        values: [UUID_V7],
      },
    ]);
  });

  it("rejects invalid input before opening a database connection", async () => {
    let connected = false;
    const pool: PostgreSqlPoolLike = {
      async connect() {
        connected = true;
        throw new Error("must not connect");
      },
    };
    const runtime = new PostgreSqlViewRuntime(module, pool, storage);
    await assert.rejects(runtime.execute({ view: "OrderDetails", input: {} }), {
      code: "VANE_VIEW_INPUT_INVALID",
    });
    assert.equal(connected, false);
  });

  it("resolves imported Entities through their declaring Module", async () => {
    const catalog: SemanticModule = {
      name: "Catalog",
      imports: [],
      entities: [
        {
          name: "Product",
          identityColumn: "id",
          columns: [column("id", "uuid")],
          rules: [],
          events: [],
        },
      ],
      views: [],
      antiCorruptionLayers: [],
      sagas: [],
    };
    const sales: SemanticModule = {
      name: "Sales",
      imports: ["Catalog"],
      entities: [],
      views: [
        {
          name: "ProductDetails",
          input: [{ name: "id", type: "uuid", optional: false }],
          output: [
            {
              name: "id",
              type: "uuid",
              nullable: false,
              expression: { kind: "column", entity: "Product", column: "id" },
            },
          ],
          query: {
            root: "Product",
            relations: [],
            where: {
              kind: "comparison",
              operator: "eq",
              left: { kind: "column", entity: "Product", column: "id" },
              right: { kind: "input", input: "id" },
            },
            orderBy: [],
            pagination: null,
          },
          persistence: { allowed: false },
          publicResult: { kind: "view" },
        },
      ],
      antiCorruptionLayers: [],
      sagas: [],
    };
    let sql = "";
    const pool: PostgreSqlPoolLike = {
      async connect() {
        return {
          async query<Row extends object>(text: string) {
            sql = text;
            return { rows: [{ id: ID }] as unknown as Row[], rowCount: 1 };
          },
          release() {},
        };
      },
    };
    const importedStorage: PostgreSqlStorageIr = {
      ...storage,
      tables: [
        {
          semanticId: "Catalog.Product",
          module: "Catalog",
          name: "catalog_product",
          technical: false,
          columns: [physical("Catalog.Product.id", "id", "uuid")],
          constraints: [],
          indexes: [],
        },
      ],
    };
    const runtime = new PostgreSqlViewRuntime(sales, pool, importedStorage, [
      sales,
      catalog,
    ]);
    await runtime.execute({ view: "ProductDetails", input: { id: ID } });
    assert.match(sql, /FROM "public"\."catalog_product"/u);
  });

  it("does not require unused imported Modules at runtime", async () => {
    const ownerWithUnusedImport: SemanticModule = {
      ...module,
      imports: ["UnusedCatalog"],
    };
    let connected = false;
    const pool: PostgreSqlPoolLike = {
      async connect() {
        connected = true;
        return {
          async query<Row extends object>() {
            return {
              rows: [{ id: ID, total: "1" }] as unknown as Row[],
              rowCount: 1,
            };
          },
          release() {},
        };
      },
    };
    const result = await new PostgreSqlViewRuntime(
      ownerWithUnusedImport,
      pool,
      storage,
    ).execute({ view: "OrderDetails", input: { id: ID } });
    assert.equal(connected, true);
    assert.equal(result.kind, "view");
  });

  it("rejects unsupported PostgreSQL aggregate types before connecting", async () => {
    const aggregateModule: SemanticModule = {
      ...module,
      views: module.views.map((view) => ({
        ...view,
        input: [],
        output: [
          {
            name: "minimumId",
            type: "uuid" as const,
            nullable: false,
            expression: {
              kind: "aggregate" as const,
              function: "min" as const,
              value: { kind: "column" as const, entity: "Order", column: "id" },
            },
          },
        ],
        query: { ...view.query, where: null, orderBy: [] },
      })),
    };
    let connected = false;
    const pool: PostgreSqlPoolLike = {
      async connect() {
        connected = true;
        throw new Error("must not connect");
      },
    };
    await assert.rejects(
      new PostgreSqlViewRuntime(aggregateModule, pool, storage).execute({
        view: "OrderDetails",
        input: {},
      }),
      { code: "VANE_VIEW_RUNTIME_CONFIGURATION" },
    );
    assert.equal(connected, false);
  });

  it("compiles null equality as SQL null predicates", async () => {
    const nullableView: SemanticModule = {
      ...module,
      entities: module.entities.map((entity) => ({
        ...entity,
        columns: entity.columns.map((field) =>
          field.name === "total" ? { ...field, nullable: true } : field,
        ),
      })),
      views: module.views.map((view) => ({
        ...view,
        output: view.output.map((field) =>
          field.name === "total" ? { ...field, nullable: true } : field,
        ),
        query: {
          ...view.query,
          where: {
            kind: "comparison" as const,
            operator: "eq" as const,
            left: { kind: "column" as const, entity: "Order", column: "total" },
            right: { kind: "literal" as const, value: null },
          },
        },
      })),
    };
    let query: { text: string; values: readonly unknown[] } | undefined;
    const pool: PostgreSqlPoolLike = {
      async connect() {
        return {
          async query<Row extends object>(text: string, values = []) {
            query = { text, values };
            return {
              rows: [{ id: ID, total: null }] as unknown as Row[],
              rowCount: 1,
            };
          },
          release() {},
        };
      },
    };
    await new PostgreSqlViewRuntime(nullableView, pool, storage).execute({
      view: "OrderDetails",
      input: { id: ID },
    });
    assert.match(query?.text ?? "", /"v0"\."total" IS NULL/u);
    assert.deepEqual(query?.values, []);
  });

  it("rejects zero for a dynamic LIMIT before opening the database", async () => {
    const paginated: SemanticModule = {
      ...module,
      views: module.views.map((view) => ({
        ...view,
        input: [
          ...view.input,
          { name: "limit", type: "integer" as const, optional: false },
        ],
        query: {
          ...view.query,
          pagination: { limit: { kind: "input" as const, input: "limit" } },
        },
      })),
    };
    let connected = false;
    const pool: PostgreSqlPoolLike = {
      async connect() {
        connected = true;
        throw new Error("must not connect");
      },
    };
    await assert.rejects(
      new PostgreSqlViewRuntime(paginated, pool, storage).execute({
        view: "OrderDetails",
        input: { id: ID, limit: 0 },
      }),
      { code: "VANE_VIEW_INPUT_INVALID" },
    );
    assert.equal(connected, false);
  });

  it("rejects PostgreSQL-incompatible text before connecting", async () => {
    const stringInputModule: SemanticModule = {
      ...module,
      views: module.views.map((view) => ({
        ...view,
        input: [
          ...view.input,
          { name: "note", type: "string" as const, optional: false },
          { name: "filter", type: "json" as const, optional: true },
        ],
      })),
    };
    let connected = false;
    const pool: PostgreSqlPoolLike = {
      async connect() {
        connected = true;
        throw new Error("must not connect");
      },
    };
    await assert.rejects(
      new PostgreSqlViewRuntime(stringInputModule, pool, storage).execute({
        view: "OrderDetails",
        input: { id: ID, note: "invalid\0text" },
      }),
      { code: "VANE_VIEW_INPUT_INVALID" },
    );
    await assert.rejects(
      new PostgreSqlViewRuntime(stringInputModule, pool, storage).execute({
        view: "OrderDetails",
        input: { id: ID, note: "valid", filter: { value: "\ud800" } },
      }),
      { code: "VANE_VIEW_INPUT_INVALID" },
    );
    assert.equal(connected, false);
  });
});

describe("phase 3 public HTTP boundary", () => {
  it("returns 404 for an unknown saga without creating a waiter", async () => {
    const terminals = new InMemoryTerminalResultStore();
    const runtime = new PublicHttpRuntime({
      contract: successfulContract(),
      terminals,
      events: {
        async dispatch() {
          throw new Error("must not dispatch");
        },
      },
      views: {
        async execute() {
          throw new Error("must not execute");
        },
      },
    });
    const result = await runtime.handle({
      method: "GET",
      path: `/api/sagas/${UUID_V7}`,
    });
    assert.equal(result.status, 404);
    assert.equal(JSON.parse(result.body).code, "VANE_SAGA_NOT_FOUND");
  });

  it("rejects PostgreSQL-incompatible View text at HTTP admission", async () => {
    const stringInputModule: SemanticModule = {
      ...module,
      views: module.views.map((view) => ({
        ...view,
        input: [
          ...view.input,
          { name: "note", type: "string" as const, optional: false },
          { name: "filter", type: "json" as const, optional: true },
        ],
      })),
    };
    const materialized = materializeContract(stringInputModule, {
      views: [{ view: "OrderDetails" }],
    });
    assert.equal(materialized.success, true);
    if (!materialized.success) return;
    let executed = false;
    const runtime = new PublicHttpRuntime({
      contract: materialized.ir,
      terminals: new InMemoryTerminalResultStore(),
      events: {
        async dispatch() {
          throw new Error("must not dispatch");
        },
      },
      views: {
        async execute() {
          executed = true;
          throw new Error("must not execute");
        },
      },
    });
    const result = await runtime.handle({
      method: "POST",
      path: "/views/OrderDetails",
      body: { id: ID, note: "invalid\0text" },
    });
    assert.equal(result.status, 400);
    assert.equal(executed, false);
    const malformedJson = await runtime.handle({
      method: "POST",
      path: "/views/OrderDetails",
      body: { id: ID, note: "valid", filter: { value: "\ud800" } },
    });
    assert.equal(malformedJson.status, 400);
    assert.equal(executed, false);
  });

  it("accepts canonical UUIDv7 input through the public boundary", async () => {
    const terminals = new InMemoryTerminalResultStore();
    const runtime = new PublicHttpRuntime({
      contract: successfulContract(),
      terminals,
      events: {
        async dispatch() {
          throw new Error("must not dispatch");
        },
      },
      views: {
        async execute(request) {
          assert.deepEqual(request.input, { id: UUID_V7 });
          return { kind: "view", view: request.view, rows: [] };
        },
      },
    });
    const result = await runtime.handle({
      method: "POST",
      path: "/api/views/OrderDetails",
      body: { id: UUID_V7 },
    });
    assert.equal(result.status, 200);
  });

  it("omits absent optional Event inputs from terminal View input", async () => {
    const optionalModule: SemanticModule = {
      ...module,
      entities: module.entities.map((entity) => ({
        ...entity,
        events: entity.events.map((event) => ({
          ...event,
          input: [
            ...event.input,
            { name: "note", type: "string" as const, optional: true },
          ],
        })),
      })),
      views: module.views.map((view) => ({
        ...view,
        input: [
          ...view.input,
          { name: "note", type: "string" as const, optional: true },
        ],
      })),
    };
    const materialized = materializeContract(optionalModule, {
      events: [
        {
          event: "Order.Place",
          terminal: {
            view: "OrderDetails",
            input: {
              id: { kind: "eventInput", input: "id" },
              note: { kind: "eventInput", input: "note" },
            },
          },
        },
      ],
    });
    assert.equal(materialized.success, true);
    if (!materialized.success) return;
    const ids = [CORRELATION, ID, SAGA];
    const runtime = new PublicHttpRuntime({
      contract: materialized.ir,
      terminals: new InMemoryTerminalResultStore(),
      uuid: () => ids.shift() ?? randomId(),
      events: {
        async dispatch(value) {
          return { kind: "success", eventId: value.eventId, revision: "1" };
        },
      },
      views: {
        async execute(request) {
          assert.deepEqual(request.input, { id: ID });
          assert.equal(Object.hasOwn(request.input, "note"), false);
          return { kind: "view", view: request.view, rows: [] };
        },
      },
    });
    const accepted = await runtime.handle({
      method: "POST",
      path: "/events/Order.Place",
      body: { id: ID, customerId: CORRELATION, total: 1 },
    });
    assert.equal(accepted.status, 202);
  });

  it("returns 202 and exposes only the terminal View through SSE", async () => {
    const contract = successfulContract();
    const terminals = new InMemoryTerminalResultStore();
    const ids = [CORRELATION, ID, SAGA];
    let envelope: EventEnvelope | undefined;
    const runtime = new PublicHttpRuntime({
      contract,
      terminals,
      uuid: () => ids.shift() ?? randomId(),
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      events: {
        async dispatch(value) {
          envelope = value;
          return { kind: "success", eventId: value.eventId, revision: "99" };
        },
      },
      views: {
        async execute(request) {
          assert.deepEqual(request, {
            view: "OrderDetails",
            input: { id: ID },
          });
          return {
            kind: "view",
            view: "OrderDetails",
            rows: [{ id: ID, total: 42.5 }],
          };
        },
      },
    });
    const accepted = await runtime.handle({
      method: "POST",
      path: "/api/events/Order.Place",
      body: { id: ID, customerId: CORRELATION, total: 42.5 },
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(JSON.parse(accepted.body), { sagaId: SAGA });
    assert.equal(accepted.body.includes("revision"), false);
    const streamed = await runtime.handle({
      method: "GET",
      path: `/api/sagas/${SAGA}`,
    });
    assert.equal(streamed.status, 200);
    assert.match(streamed.body, /^event: view\n/u);
    assert.equal(streamed.body.includes("revision"), false);
    assert.equal(envelope?.eventIdentity, "Order.Place");
    assert.equal(envelope?.sagaId, SAGA);
  });

  it("publishes safe fail terminals and rejects undeclared input", async () => {
    const contract = successfulContract();
    const terminals = new InMemoryTerminalResultStore();
    const ids = [randomId(), CORRELATION, ID, SAGA];
    const runtime = new PublicHttpRuntime({
      contract,
      terminals,
      uuid: () => ids.shift() ?? randomId(),
      events: {
        async dispatch(value) {
          return {
            kind: "fail",
            eventId: value.eventId,
            fail: {
              code: "VANE_EVENT_RULE_VIOLATION",
              message: "The Entity Rule rejected the change.",
              correlationId: value.correlationId,
            },
          };
        },
      },
      views: {
        async execute() {
          throw new Error("must not execute");
        },
      },
    });
    const invalid = await runtime.handle({
      method: "POST",
      path: "/api/events/Order.Place",
      body: { id: ID, customerId: CORRELATION, total: 1, secret: "no" },
    });
    assert.equal(invalid.status, 400);
    const accepted = await runtime.handle({
      method: "POST",
      path: "/api/events/Order.Place",
      body: { id: ID, customerId: CORRELATION, total: 1 },
    });
    assert.equal(accepted.status, 202);
    const streamed = await runtime.handle({
      method: "GET",
      path: `/api/sagas/${SAGA}`,
    });
    assert.match(streamed.body, /^event: fail\n/u);
    assert.equal(streamed.body.includes("stack"), false);
  });
});

function successfulContract(): ContractIr {
  const result = materializeContract(module, contractConfiguration);
  assert.equal(result.success, true);
  if (!result.success) throw new Error("fixture contract must compile");
  return result.ir;
}

function column(name: string, type: "uuid" | "decimal") {
  return {
    name,
    type,
    identity: name === "id",
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
  } as const;
}

function randomId(): string {
  return "44444444-4444-4444-8444-444444444444";
}

const storage: PostgreSqlStorageIr = {
  schema: "vane.postgresql-storage-ir",
  version: 1,
  provider: { name: "postgresql", minimumVersion: 16, namespace: "public" },
  tables: [
    {
      semanticId: "Sales.Order",
      module: "Sales",
      name: "sales_order",
      technical: false,
      columns: [
        physical("Sales.Order.id", "id", "uuid"),
        physical("Sales.Order.customerId", "customer_id", "uuid"),
        physical("Sales.Order.total", "total", "numeric"),
      ],
      constraints: [],
      indexes: [],
    },
  ],
};

function physical(semanticId: string, name: string, type: "uuid" | "numeric") {
  return {
    semanticId,
    name,
    type,
    nullable: false,
    defaultSql: null,
    generated: null,
    technical: false,
  } as const;
}
