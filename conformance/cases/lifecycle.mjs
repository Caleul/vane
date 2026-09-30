import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const q = (name) => `"${name.replaceAll('"', '""')}"`;
async function bounded(promise, label, ms = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(context, run) {
  const { api, packageRoot, databaseUrl, cli } = context;
  if (!databaseUrl)
    throw Object.assign(
      new Error(
        "VANE_CONFORMANCE_DATABASE_URL is required for process lifecycle evidence",
      ),
      { code: "CONFORMANCE_GAP" },
    );
  const { Pool } = createRequire(resolve(packageRoot, "package.json"))("pg");
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const dir = await mkdtemp(join(tmpdir(), "vane-conformance-lifecycle-"));
  const namespace = `vane_lifecycle_${randomUUID().replaceAll("-", "")}`;
  const children = [];
  const sentinel = `synthetic-secret-${randomUUID()}`;
  const env = {
    ...process.env,
    LIFECYCLE_DATABASE: databaseUrl,
    LIFECYCLE_AUTH: sentinel,
  };
  const outputs = [];
  let databaseReady = false;
  try {
    const version = await pool.query("SHOW server_version_num");
    context.postgresqlVersion = version.rows[0].server_version_num;
    databaseReady = true;
    const project = api.compileProjectSources([
      {
        fileName: "postgres-registry.vane.ts",
        sourceText: await readFile(
          new URL("../fixtures/postgres-registry.vane.ts", import.meta.url),
          "utf8",
        ),
      },
    ]);
    assert.equal(project.success, true, JSON.stringify(project.diagnostics));
    const config = api.serviceConfiguration({
      application: "independent-lifecycle",
      project: project.ir,
      providers: api.BUILTIN_PROVIDERS,
      profiles: {
        test: {
          environment: "test",
          topology: api.monolith({
            name: "registry",
            modules: ["Registry"],
            runtime: api.node(),
            persistence: {
              provider: api.postgres(),
              namespace,
              targetVersion: 16,
              connection: api.env("LIFECYCLE_DATABASE"),
            },
          }),
          communication: {
            mailbox: api.postgresMailbox(),
            outbox: api.postgresOutbox(),
            deduplication: api.postgresDeduplication(),
            saga: api.postgresSaga(),
            failureQueue: api.postgresFailureQueue(),
          },
          http: {
            provider: api.http(),
            sagaStream: api.sse(),
            security: {
              authentication: { bearer: api.env("LIFECYCLE_AUTH") },
              authorization: "allow",
              cors: [],
              rateLimit: null,
            },
          },
          contracts: {
            Registry: {
              basePath: "/registry",
              views: [{ view: "ParcelCard" }],
              events: [
                {
                  event: "Parcel.Register",
                  saga: "RegisterParcel",
                  terminal: {
                    view: "ParcelCard",
                    input: { id: { kind: "eventInput", input: "id" } },
                  },
                },
              ],
            },
          },
        },
      },
    });
    const compiled = api.compileServiceConfiguration(config, "test");
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
    const plan = compiled.plan;
    const path = join(dir, "configuration.mjs");
    await writeFile(path, `export default ${JSON.stringify(config)};\n`);
    const common = ["--config", path, "--profile", "test", "--json"];
    const invoke = async (args, expected = 0) => {
      const result = await cli([...args, ...common], { env });
      outputs.push(result.stdout, result.stderr);
      assert.equal(
        result.status,
        expected,
        `${args.join(" ")}: ${result.stderr}`,
      );
      assert.ok(
        !`${result.stdout}${result.stderr}`.includes(sentinel),
        "CLI output exposes configured credential",
      );
      return expected === 0 ? JSON.parse(result.stdout) : result;
    };
    const metadata = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );
    const bin = resolve(packageRoot, metadata.bin["entity-event"]);
    const start = async () => {
      const child = spawn(
        process.execPath,
        [bin, "dev", "--port", "0", ...common],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const record = { child, stdout: "", stderr: "", exit: null };
      children.push(record);
      const exited = new Promise((resolve, reject) => {
        child.once("exit", (code, signal) => {
          record.exit = { code, signal };
          resolve(record.exit);
        });
        child.once("error", reject);
      });
      record.exited = exited;
      const ready = new Promise((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          record.stdout += String(chunk);
          if (record.stdout.includes("\n")) {
            try {
              resolve(JSON.parse(record.stdout.split("\n")[0]));
            } catch (error) {
              reject(error);
            }
          }
        });
        child.stderr.on("data", (chunk) => {
          record.stderr += String(chunk);
        });
        child.once("error", reject);
        child.once("exit", () =>
          reject(
            new Error(`Public dev exited before readiness: ${record.stderr}`),
          ),
        );
      });
      const readiness = await bounded(ready, "Public dev readiness timed out");
      assert.equal(readiness.state, "running");
      record.url = `http://127.0.0.1:${readiness.address.port}`;
      return record;
    };
    const stop = async (record, signal = "SIGTERM") => {
      assert.ok(record.child.kill(signal));
      const result = await bounded(
        record.exited,
        "Public dev did not stop after signal",
      );
      outputs.push(record.stdout, record.stderr);
      assert.ok(!`${record.stdout}${record.stderr}`.includes(sentinel));
      if (signal === "SIGTERM") assert.equal(result.code, 0, record.stderr);
      else assert.equal(result.signal, signal);
    };
    const relation = (id) => {
      const table = plan.storage.tables.find((t) => t.semanticId === id);
      assert.ok(table);
      return `${q(namespace)}.${q(table.name)}`;
    };
    const auth = { authorization: `Bearer ${sentinel}` };
    const admit = async (record, payload) => {
      const response = await fetch(
        `${record.url}/registry/events/Parcel.Register`,
        {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        },
      );
      assert.equal(response.status, 202);
      return response.json();
    };
    const terminal = async (record, sagaId) => {
      const response = await fetch(`${record.url}/registry/sagas/${sagaId}`, {
        headers: auth,
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal((body.match(/^event:/gm) || []).length, 1);
      assert.match(body, /^event: view\n/);
      return { body, data: JSON.parse(body.split("\ndata: ")[1].trim()) };
    };
    const migrate = async () => {
      const migration = await invoke(["migrate", "diff"]);
      const migrationPath = join(dir, "migration.json");
      await writeFile(migrationPath, JSON.stringify(migration));
      assert.equal(
        (await invoke(["migrate", "apply", "--migration", migrationPath]))
          .status,
        "applied",
      );
      return { migration, migrationPath };
    };
    return await run({
      api,
      pool,
      namespace,
      dir,
      plan,
      invoke,
      start,
      stop,
      relation,
      auth,
      admit,
      terminal,
      migrate,
      outputs,
      sentinel,
    });
  } finally {
    const errors = [];
    for (const record of children) {
      if (!record.exit) record.child.kill("SIGKILL");
      try {
        await bounded(record.exited, "Child cleanup timed out", 5000);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      if (databaseReady)
        await pool.query(`DROP SCHEMA IF EXISTS ${q(namespace)} CASCADE`);
    } catch (error) {
      errors.push(error);
    }
    try {
      await bounded(pool.end(), "Pool cleanup timed out", 5000);
    } catch (error) {
      errors.push(error);
    }
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    assert.equal(
      errors.length,
      0,
      errors.map((error) => error.message).join("; "),
    );
  }
}
const pg = (id, requirements, run) => ({
  id: `lifecycle.${id}`,
  requirements,
  kind: "positive",
  requires: "postgresql",
  run: (context) => fixture(context, run),
});
export const cases = [
  pg(
    "operational-cli",
    [
      "EE-CMD-004",
      "EE-CMD-005",
      "EE-CMD-006",
      "EE-CMD-007",
      "EE-CMD-008",
      "EE-CLI-004",
    ],
    async (c) => {
      await c.invoke(["validate"]);
      await c.invoke(["plan"]);
      await c.invoke(["generate", "--out", join(c.dir, "generated")]);
      const { migration, migrationPath } = await c.migrate();
      assert.ok(migration.steps.length);
      assert.ok(migration.hash);
      assert.equal(
        (await c.invoke(["migrate", "apply", "--migration", migrationPath]))
          .status,
        "already-applied",
      );
      const snapshot = join(c.dir, "snapshot.json");
      await writeFile(snapshot, JSON.stringify(c.plan.storage));
      const noOp = await c.invoke(["migrate", "diff", "--previous", snapshot]);
      assert.equal(noOp.noOp, true);
      assert.equal(noOp.steps.length, 0);
      const inspected = await c.invoke([
        "inspect",
        "event",
        "Registry.Parcel.Register",
      ]);
      assert.equal(inspected.policy.event, "Registry.Parcel.Register");
      assert.deepEqual(await c.invoke(["failures", "list"]), []);
      const running = await c.start();
      const id = randomUUID();
      const { sagaId } = await c.admit(running, {
        id,
        label: "cli functional",
      });
      const final = await c.terminal(running, sagaId);
      assert.deepEqual(final.data.data, [
        { id, label: "cli functional", active: false },
      ]);
      const saga = await c.invoke(["inspect", "saga", sagaId]);
      assert.equal(saga.status, "terminal");
      assert.equal(saga.steps.length, 2);
      await c.stop(running);
      for (const args of [
        ["validate", "unexpected"],
        ["plan", "unexpected"],
        ["generate"],
        ["migrate", "apply", "--migration", join(c.dir, "missing.json")],
        ["dev", "--port", "-1"],
        ["inspect", "event", "Unknown.Event"],
        ["failures", "unknown"],
      ])
        await c.invoke(args, 1);
      assert.ok(c.outputs.every((output) => !output.includes(c.sentinel)));
      return "Installed CLI performs migration diff/apply/idempotent apply/no-op snapshot diff, starts functional HTTP service, inspects Event/Saga, and keeps configured credential out of all successful/failing CLI families";
    },
  ),
  pg(
    "graceful-and-abrupt-process-restart",
    ["EE-RUN-004", "EE-RUN-005", "EE-NFR-007"],
    async (c) => {
      await c.migrate();
      const owner = c.relation("Registry.Parcel");
      const sagas = c.relation("vane.infrastructure.sagas");
      const mailbox = c.relation("vane.infrastructure.mailbox");
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        const first = await c.start();
        const locker = await c.pool.connect();
        let locked = false;
        let sagaId;
        const id = randomUUID();
        const label = `accepted-${signal}`;
        try {
          await locker.query("BEGIN");
          locked = true;
          await locker.query(`LOCK TABLE ${owner} IN ACCESS EXCLUSIVE MODE`);
          ({ sagaId } = await c.admit(first, { id, label }));
          const accepted = (
            await c.pool.query(`SELECT state FROM ${sagas} WHERE saga_id=$1`, [
              sagaId,
            ])
          ).rows[0];
          assert.ok(accepted);
          assert.notEqual(accepted.state.status, "terminal");
          assert.ok(first.child.kill(signal));
          // Allow a shutdown handler to begin while the accepted DB work is blocked.
          await delay(40);
          await locker.query("COMMIT");
          locked = false;
          const exit = await bounded(
            first.exited,
            "Old process did not terminate",
          );
          if (signal === "SIGTERM") assert.equal(exit.code, 0, first.stderr);
          else assert.equal(exit.signal, "SIGKILL");
        } finally {
          if (locked) await locker.query("ROLLBACK");
          locker.release();
        }
        const second = await c.start();
        assert.notEqual(second.child.pid, first.child.pid);
        try {
          const result = await c.terminal(second, sagaId);
          assert.deepEqual(result.data.data, [{ id, label, active: false }]);
          assert.equal(
            (
              await c.pool.query(`SELECT active FROM ${owner} WHERE id=$1`, [
                id,
              ])
            ).rows[0].active,
            false,
          );
          const receipts = (
            await c.pool.query(
              `SELECT event_identity FROM ${mailbox} WHERE payload::jsonb->>'sagaId'=$1 ORDER BY event_identity`,
              [sagaId],
            )
          ).rows;
          assert.deepEqual(
            receipts.map((r) => r.event_identity),
            ["Parcel.Activate", "Parcel.Register"],
          );
          assert.equal(
            (await c.terminal(second, sagaId)).body,
            result.body,
            "Terminal replay after restart is stable",
          );
        } finally {
          await c.stop(second);
        }
      }
      return "Public dev OS processes accept durable work while persistence blocked; SIGTERM exits cleanly and SIGKILL interrupts; different replacement processes recover both accepted Sagas with exactly two protected receipts and stable terminal replay";
    },
  ),
];
