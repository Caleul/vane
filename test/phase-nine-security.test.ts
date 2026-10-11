import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type DurableSagaState,
  RuntimeTelemetry,
  type TelemetryRecord,
  createServiceRuntime,
  localSecret,
} from "../src/index.js";
import { phaseFiveConfiguration } from "./phase-five-fixture.js";

describe("phase nine security boundaries", () => {
  it("scopes retained SSE to the Module's exposed terminal Views while retaining application-admitted public Views", async () => {
    const base = phaseFiveConfiguration();
    const sales = base.project.modules[0];
    const receipt = sales?.views[0];
    const saga = sales?.sagas[0];
    const profile = base.profiles.development;
    const gatewayMapping = profile.acls?.["Sales.Gateway.Authorize"];
    assert.ok(
      sales && receipt && saga && profile.topology?.kind === "monolith",
    );
    assert.ok(gatewayMapping);
    const internalSaga = {
      ...saga,
      name: "InternalOrder",
      terminal: {
        ...saga.terminal,
        success: { kind: "view" as const, view: "PrivateReceipt" },
      },
    };
    const configuration = {
      ...base,
      project: {
        ...base.project,
        modules: [
          {
            ...sales,
            views: [...sales.views, { ...receipt, name: "PrivateReceipt" }],
            sagas: [
              ...sales.sagas,
              internalSaga,
              { ...saga, name: "ApplicationConfirm" },
            ],
          },
          { ...sales, name: "Other" },
        ],
      },
      profiles: {
        ...base.profiles,
        development: {
          ...profile,
          topology: {
            ...profile.topology,
            service: {
              ...profile.topology.service,
              modules: ["Sales", "Other"],
            },
          },
          acls: {
            ...profile.acls,
            "Other.Gateway.Authorize": gatewayMapping,
          },
        },
      },
    };
    const runtime = await createServiceRuntime(configuration, "test", {
      pool: {
        connect: async () => {
          throw Error("Unexpected database access");
        },
      },
      resolveSecret: () => "https://gateway.invalid",
    });
    const module = runtime.modules.find((entry) => entry.name === "Sales");
    assert.ok(module);
    const stateFor = (
      moduleName: string,
      sagaName: string,
      view: string,
    ): DurableSagaState => {
      const plan = runtime.plan.runtime.sagas.find(
        (plan) => plan.module === moduleName && plan.saga === sagaName,
      );
      assert.ok(plan);
      return {
        schema: "vane.saga-state",
        version: 1,
        planHash: plan.hash,
        correlationId: "10000000-0000-4000-8000-000000000001",
        input: {},
        status: "terminal",
        steps: [],
        fail: null,
        terminal: {
          kind: "view",
          view,
          data: [{ value: "private-cross-module-sentinel" }],
        },
      };
    };
    let state = stateFor("Other", "PlaceOrder", "Receipt");
    let waits = 0;
    module.store.read = async () => state;
    module.store.wait = async () => {
      waits++;
      assert.ok(state.terminal);
      return state.terminal;
    };
    const request = {
      method: "GET",
      path: "/sales/sagas/10000000-0000-4000-8000-000000000001",
    };
    const crossModule = await module.http.handle(request);
    assert.equal(crossModule.status, 404);
    assert.ok(!crossModule.body.includes("private-cross-module-sentinel"));
    state = stateFor("Sales", "InternalOrder", "PrivateReceipt");
    assert.equal((await module.http.handle(request)).status, 404);
    assert.equal(waits, 0);
    state = stateFor("Sales", "ApplicationConfirm", "Receipt");
    const application = await module.http.handle(request);
    assert.equal(application.status, 200);
    assert.match(application.body, /^event: view\n/);
    assert.equal(waits, 1);
    assert.equal((await module.http.handle(request)).body, application.body);
    // Privileged inspection retains access; only the public streaming adapter is scoped.
    state = stateFor("Sales", "InternalOrder", "PrivateReceipt");
    assert.equal((await module.store.read("any"))?.terminal?.kind, "view");
  });
  it("CLI help exits zero without loading configuration and command exceptions never print secret text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vane-security-cli-"));
    const config = join(directory, "trusted.mjs");
    const marker = join(directory, "loaded");
    const sentinel = "private-cli-security-sentinel";
    try {
      await writeFile(
        config,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); throw new Error(${JSON.stringify(sentinel)});`,
      );
      const executable = fileURLToPath(
        new URL("../src/cli.js", import.meta.url),
      );
      const invoke = (...args: string[]) =>
        spawnSync(process.execPath, [executable, ...args], {
          encoding: "utf8",
        });
      for (const args of [
        ["--help"],
        ["-h"],
        ["validate", "--config", config, "--help"],
      ]) {
        const result = invoke(...args);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /Usage: entity-event/);
        assert.equal(result.stderr, "");
        await assert.rejects(readFile(marker), { code: "ENOENT" });
      }
      const invalid = invoke("unknown-command", "--config", config);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /Usage: entity-event/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const failed = invoke(
        "validate",
        "--config",
        config,
        "--profile",
        "test",
      );
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /Configuration command failed/);
      assert.ok(!`${failed.stdout}${failed.stderr}`.includes(sentinel));
      assert.equal(await readFile(marker, "utf8"), "loaded");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("redacts credential aliases and arbitrary error text before invoking a telemetry exporter", () => {
    const records: TelemetryRecord[] = [];
    const telemetry = new RuntimeTelemetry(
      { exporter: "json", redact: ["contact.email"] },
      (record) => records.push(record),
    );
    const sentinel = "private-security-sentinel";
    telemetry.record("publication", {
      eventId: "10000000-0000-4000-8000-000000000001",
      nested: [
        {
          accessToken: sentinel,
          "X-API-Key": sentinel,
          client_secret: sentinel,
          AWS_SECRET_ACCESS_KEY: sentinel,
          "Set-Cookie": sentinel,
          connectionString: `postgres://user:${sentinel}@database.invalid/db`,
          endpoint: `https://provider.invalid/?token=${sentinel}`,
          error: { message: sentinel, cause: sentinel },
          message: sentinel,
          stack: sentinel,
          "contact.email": sentinel,
          attempts: 3,
        },
      ],
    });
    assert.equal(records.length, 1);
    assert.ok(!JSON.stringify(records).includes(sentinel));
    assert.equal(
      records[0]?.attributes.eventId,
      "10000000-0000-4000-8000-000000000001",
    );
    assert.equal(
      (records[0]?.attributes.nested as { attempts: number }[])[0]?.attempts,
      3,
    );
    assert.equal(telemetry.metrics()["publication.success"]?.count, 1);
  });

  it("enforces bearer/CORS gates before parsing input or accessing public HTTP/SSE and keeps operations private", async () => {
    const profile = phaseFiveConfiguration().profiles.development;
    assert.ok(profile.http);
    const sentinel = "private-http-security-sentinel";
    const configuration = phaseFiveConfiguration({
      http: {
        ...profile.http,
        security: {
          authentication: { bearer: localSecret(sentinel) },
          authorization: "allow",
          cors: ["https://allowed.invalid"],
          rateLimit: null,
        },
      },
    });
    let databaseAccesses = 0;
    const runtime = await createServiceRuntime(configuration, "test", {
      pool: {
        connect: async () => {
          databaseAccesses++;
          throw new Error(sentinel);
        },
      },
      resolveSecret: (reference) =>
        reference.kind === "literal"
          ? reference.value
          : "https://gateway.invalid",
    });
    // Authentication is tested against the real configured Node handler. The
    // schema bootstrap is isolated here; real PostgreSQL lifecycle is covered by
    // the existing service integration suite.
    for (const module of runtime.modules) module.events.start = async () => {};
    await runtime.start();
    const server = createServer((request, response) => {
      void runtime.handler(request, response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const path of [
        "/sales/events/Order.Place",
        "/sales/sagas/10000000-0000-4000-8000-000000000001",
      ]) {
        const response = await fetch(base + path, {
          method: path.includes("/events/") ? "POST" : "GET",
          headers: { authorization: "Bearer wrong-token" },
          ...(path.includes("/events/") ? { body: "invalid JSON" } : {}),
        });
        assert.equal(response.status, 401);
        assert.ok(!(await response.text()).includes(sentinel));
      }
      const blockedOrigin = await fetch(`${base}/sales/views/Receipt`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sentinel}`,
          origin: "https://blocked.invalid",
        },
        body: "{}",
      });
      assert.equal(blockedOrigin.status, 403);
      assert.ok(!(await blockedOrigin.text()).includes(sentinel));
      const invalidInput = await fetch(`${base}/sales/views/Receipt`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sentinel}`,
          origin: "https://allowed.invalid",
        },
        body: "{}",
      });
      assert.equal(invalidInput.status, 400);
      assert.equal(
        invalidInput.headers.get("access-control-allow-origin"),
        "https://allowed.invalid",
      );
      assert.ok(!(await invalidInput.text()).includes(sentinel));
      for (const path of [
        "/inspect",
        "/failures",
        "/sales/inspect",
        "/sales/failures",
      ]) {
        const response = await fetch(base + path, {
          headers: { authorization: `Bearer ${sentinel}` },
        });
        assert.equal(response.status, 404);
        assert.ok(!(await response.text()).includes(sentinel));
      }
      assert.equal(databaseAccesses, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.stop();
    }
  });
});
