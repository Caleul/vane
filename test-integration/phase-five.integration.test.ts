import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import {
  type ServiceProfile,
  applyPostgreSqlMigrationPlan,
  compileServiceConfiguration,
  createPostgreSqlMigrationPlan,
  createServiceRuntime,
  env,
} from "../src/index.js";
import { phaseFiveConfiguration } from "../test/phase-five-fixture.js";
import { withTestDatabase } from "./database.js";

async function fixture(
  run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  options: {
    security?: NonNullable<ServiceProfile["http"]>["security"];
    timeout?: number;
    slow?: boolean;
  } = {},
) {
  await withTestDatabase("phase_five", async (database) => {
    const context = await setup(database, options);
    try {
      await run(context);
    } finally {
      context.server.closeAllConnections();
      await new Promise<void>((r) => context.server.close(() => r()));
      await context.runtime.stop();
      context.gateway.closeAllConnections();
      await new Promise<void>((r) => context.gateway.close(() => r()));
    }
  });
}
async function setup(
  database: Parameters<Parameters<typeof withTestDatabase>[1]>[0],
  options: {
    security?: NonNullable<ServiceProfile["http"]>["security"];
    timeout?: number;
    slow?: boolean;
  },
) {
  const calls: string[] = [];
  const gateway = createServer((request, response) => {
    calls.push(String(request.headers["idempotency-key"]));
    assert.equal(request.headers.authorization, "Bearer private-gateway-token");
    const send = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ reference: "private-provider-result" }));
    };
    if (options.slow) setTimeout(send, 80);
    else send();
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  assert.ok(address && typeof address !== "string");
  const base = phaseFiveConfiguration();
  const p = base.profiles.development;
  assert.ok(p.topology && p.http && p.acls);
  const mapping = p.acls["Sales.Gateway.Authorize"];
  assert.ok(mapping);
  const configuration = phaseFiveConfiguration({
    topology: {
      ...p.topology,
      service: {
        ...p.topology.service,
        persistence: {
          ...p.topology.service.persistence,
          namespace: database.schema,
        },
      },
    },
    http: { ...p.http, security: options.security ?? p.http.security },
    acls: {
      "Sales.Gateway.Authorize": {
        ...mapping,
        headers: { Authorization: env("GATEWAY_TOKEN") },
      },
    },
    ...(options.timeout
      ? {
          policies: {
            events: {
              "Sales.Gateway.Authorize": { timeoutMs: options.timeout },
            },
          },
        }
      : {}),
  });
  const compiled = compileServiceConfiguration(configuration, "test");
  assert.ok(compiled.success, JSON.stringify(compiled));
  await applyPostgreSqlMigrationPlan(
    database.pool,
    createPostgreSqlMigrationPlan({
      previous: null,
      next: compiled.plan.storage,
    }),
  );
  const runtime = await createServiceRuntime(configuration, "test", {
    pool: database.pool,
    resolveSecret: async (reference) => {
      if (reference.kind !== "literal" && reference.name === "GATEWAY_URL")
        return `http://127.0.0.1:${address.port}`;
      if (reference.kind !== "literal" && reference.name === "GATEWAY_TOKEN")
        return "Bearer private-gateway-token";
      if (reference.kind !== "literal" && reference.name === "PUBLIC_TOKEN")
        return "public-token";
      throw new Error("unexpected secret");
    },
  });
  await Promise.all([runtime.start(), runtime.start()]);
  const server = createServer((req, res) => void runtime.handler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const publicAddress = server.address();
  assert.ok(publicAddress && typeof publicAddress !== "string");
  return {
    runtime,
    server,
    gateway,
    calls,
    url: `http://127.0.0.1:${publicAddress.port}`,
    configuration,
    database,
  };
}

describe("phase five configured runtime", () => {
  it("executes HTTP -> configured ACL -> PostgreSQL Saga -> terminal View", async () =>
    fixture(async ({ runtime, url, calls }) => {
      const contract = runtime.plan.contracts[0];
      assert.ok(contract);
      const operation = contract.operations.find((o) => o.kind === "event");
      assert.ok(operation && operation.kind === "event");
      const response = await fetch(`${url}${operation.path}`, {
        method: "POST",
        body: JSON.stringify({ id: randomUUID() }),
      });
      assert.equal(response.status, 202);
      const accepted = (await response.json()) as { sagaId: string };
      const module = runtime.modules[0];
      assert.ok(module);
      while (await module.sagas.runOnce()) {}
      const terminal = await fetch(
        `${url}${operation.terminal.streamPath.replace("{sagaId}", accepted.sagaId)}`,
      );
      assert.equal(terminal.status, 200);
      const text = await terminal.text();
      assert.match(text, /complete/);
      assert.ok(!text.includes("private-provider-result"));
      assert.ok(!text.includes("private-gateway-token"));
      assert.equal(calls.length, 1);
      await runtime.stop();
      assert.equal(runtime.state, "stopped");
      assert.equal(
        (await fetch(`${url}${operation.path}`, { method: "POST" })).status,
        503,
      );
    }));
  it("enforces per-ACL timeout and compensates before terminal fail", async () =>
    fixture(
      async ({ runtime, url }) => {
        const op = runtime.plan.contracts[0]?.operations.find(
          (o) => o.kind === "event",
        );
        assert.ok(op && op.kind === "event");
        const id = randomUUID();
        const res = await fetch(`${url}${op.path}`, {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        const { sagaId } = (await res.json()) as { sagaId: string };
        const module = runtime.modules[0];
        assert.ok(module);
        while (await module.sagas.runOnce()) {}
        const terminal = await module.store.wait(sagaId);
        assert.equal(terminal.kind, "fail");
        const view = await module.views.execute({
          view: "Receipt",
          input: { id },
        });
        assert.equal(view.rows[0]?.status, "cancelled");
      },
      { slow: true, timeout: 10 },
    ));
  it("applies bearer authentication, CORS and explicit service rate limiting", async () =>
    fixture(
      async ({ runtime, url }) => {
        const op = runtime.plan.contracts[0]?.operations.find(
          (o) => o.kind === "view",
        );
        assert.ok(op);
        assert.equal(
          (await fetch(`${url}${op.path}`, { method: "POST", body: "{}" }))
            .status,
          401,
        );
        assert.equal(
          (
            await fetch(`${url}${op.path}`, {
              method: "POST",
              headers: {
                origin: "https://untrusted.example",
                authorization: "Bearer public-token",
              },
              body: "{}",
            })
          ).status,
          403,
        );
        const preflight = await fetch(`${url}${op.path}`, {
          method: "OPTIONS",
          headers: { origin: "https://allowed.example" },
        });
        assert.equal(preflight.status, 204);
        const options = {
          method: "POST",
          headers: {
            authorization: "Bearer public-token",
            origin: "https://allowed.example",
          },
          body: JSON.stringify({ id: randomUUID() }),
        };
        const first = await fetch(`${url}${op.path}`, options);
        assert.equal(first.status, 200);
        assert.equal(
          first.headers.get("access-control-allow-origin"),
          "https://allowed.example",
        );
        assert.equal((await fetch(`${url}${op.path}`, options)).status, 429);
      },
      {
        security: {
          authentication: { bearer: env("PUBLIC_TOKEN") },
          authorization: "allow",
          cors: ["https://allowed.example"],
          rateLimit: { requests: 1, windowMs: 10000 },
        },
      },
    ));
  it("denies authorization explicitly", async () =>
    fixture(
      async ({ url }) => {
        assert.equal(
          (
            await fetch(`${url}/sales/views/Receipt`, {
              method: "POST",
              body: "{}",
            })
          ).status,
          403,
        );
      },
      {
        security: {
          authentication: "none",
          authorization: "deny",
          cors: [],
          rateLimit: null,
        },
      },
    ));
  it("refuses startup against an unmigrated schema", async () =>
    withTestDatabase("phase5_bad", async (database) => {
      const c = phaseFiveConfiguration();
      const p = c.profiles.development;
      assert.ok(p.topology);
      const configured = phaseFiveConfiguration({
        topology: {
          ...p.topology,
          service: {
            ...p.topology.service,
            persistence: {
              ...p.topology.service.persistence,
              namespace: database.schema,
            },
          },
        },
      });
      const runtime = await createServiceRuntime(configured, "test", {
        pool: database.pool,
        resolveSecret: async () => "https://example.invalid",
      });
      await assert.rejects(runtime.start(), /startup failed/);
      assert.equal(runtime.state, "stopped");
    }));
});
