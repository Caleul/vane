import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";
import { phaseFiveConfiguration } from "../test/phase-five-fixture.js";
import { testDatabaseUrl, withTestDatabase } from "./database.js";

it("CLI migrates, runs, inspects and replays terminal SSE across real process restart", async () =>
  withTestDatabase("cli_phase6", async (db) => {
    const dir = await mkdtemp(join(tmpdir(), "vane-cli-integration-"));
    const gateway = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reference: "never-public" }));
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const a = gateway.address();
    assert.ok(a && typeof a !== "string");
    const base = phaseFiveConfiguration();
    const p = base.profiles.development;
    assert.ok(p.topology);
    const config = phaseFiveConfiguration({
      topology: {
        ...p.topology,
        service: {
          ...p.topology.service,
          persistence: {
            ...p.topology.service.persistence,
            namespace: db.schema,
          },
        },
      },
    });
    const file = join(dir, "config.mjs");
    await writeFile(file, `export default ${JSON.stringify(config)}`);
    const cli = resolve("dist-integration/src/cli.js");
    const common = ["--config", file, "--profile", "test", "--json"];
    const env = {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      GATEWAY_URL: `http://127.0.0.1:${a.port}`,
    };
    const invoke = async (...args: string[]) =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            [cli, ...args, ...common],
            { env, timeout: 10000 },
          )
        ).stdout,
      );
    const children: ReturnType<typeof spawn>[] = [];
    const start = async () => {
      const child = spawn(
        process.execPath,
        [cli, "dev", "--port", "0", ...common],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(child);
      const exited = once(child, "exit");
      const ready = await new Promise<{ address: { port: number } }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error("dev readiness timeout"));
          }, 10000);
          let buffer = "";
          child.once("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("dev exited before readiness"));
          });
          child.stdout.on("data", (chunk) => {
            buffer += String(chunk);
            const line = buffer.split("\n")[0];
            if (buffer.includes("\n") && line) {
              clearTimeout(timer);
              resolve(JSON.parse(line));
            }
          });
        },
      );
      return { child, exited, url: `http://127.0.0.1:${ready.address.port}` };
    };
    try {
      const migration = await invoke("migrate", "diff");
      const migrationPath = join(dir, "migration.json");
      await writeFile(migrationPath, JSON.stringify(migration));
      assert.equal(
        (await invoke("migrate", "apply", "--migration", migrationPath)).status,
        "applied",
      );
      assert.equal(
        (await invoke("migrate", "apply", "--migration", migrationPath)).status,
        "already-applied",
      );
      const first = await start();
      const response = await fetch(`${first.url}/sales/events/Order.Place`, {
        method: "POST",
        body: JSON.stringify({ id: randomUUID() }),
      });
      assert.equal(response.status, 202);
      const { sagaId } = (await response.json()) as { sagaId: string };
      const stream = await fetch(`${first.url}/sales/sagas/${sagaId}`, {
        signal: AbortSignal.timeout(10000),
      });
      const terminal = await stream.text();
      assert.match(terminal, /complete/);
      assert.ok(!terminal.includes("never-public"));
      const inspection = await invoke("inspect", "saga", sagaId);
      assert.equal(inspection.status, "terminal");
      assert.equal(inspection.steps.length, 3);
      first.child.kill("SIGTERM");
      assert.equal((await first.exited)[0], 0);
      const second = await start();
      const replay = await fetch(`${second.url}/sales/sagas/${sagaId}`, {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(await replay.text(), terminal);
      second.child.kill("SIGTERM");
      assert.equal((await second.exited)[0], 0);
    } finally {
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGKILL");
      gateway.closeAllConnections();
      await new Promise<void>((r) => gateway.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  }));
