import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  arch,
  availableParallelism,
  cpus,
  platform,
  release,
  totalmem,
} from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { hash, withReference } from "./generated-reference.mjs";
const machine = () => ({
  node: process.version,
  platform: platform(),
  arch: arch(),
  osRelease: release(),
  cpu: cpus()[0]?.model,
  cpuCount: cpus().length,
  availableParallelism: availableParallelism(),
  memoryBytes: totalmem(),
});
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    min: sorted[0],
    median:
      (sorted[Math.floor((sorted.length - 1) / 2)] +
        sorted[Math.ceil((sorted.length - 1) / 2)]) /
      2,
    max: sorted.at(-1),
    raw: values,
  };
};
const evidence = async (c, method, values) =>
  JSON.stringify({
    method,
    unit: "milliseconds",
    machine: machine(),
    package: c.metadata.name,
    packageVersion: c.metadata.version,
    tarballSha256: hash(await readFile(c.tarball)),
    inputHash: c.plan.inputHash,
    sourceHashes: c.sourceHashes,
    measurement: summary(values),
  });
export const cases = [
  {
    id: "performance.reference-validation",
    requirements: ["EE-PERF-001"],
    kind: "positive",
    run: (context) =>
      withReference(
        context,
        async (c) => {
          const samples = [];
          for (let i = 0; i < 3; i++) {
            const start = performance.now();
            const output = await promisify(execFile)(
              process.execPath,
              [
                join(c.installed, c.metadata.bin["entity-event"]),
                "validate",
                "--config",
                join(c.dir, "configuration.mjs"),
                "--json",
              ],
              { cwd: c.dir, env: c.env, timeout: 10000 },
            );
            const result = JSON.parse(output.stdout);
            samples.push(performance.now() - start);
            assert.equal(result.success, true);
          }
          assert.ok(
            samples.every((value) => value <= 5000),
            JSON.stringify(samples),
          );
          return evidence(
            c,
            "3 cold Node child-process installed CLI validate invocations across all3official Sales/Billing profiles; wallclock includes startup and compilation; each<=5000",
            samples,
          );
        },
        { database: false },
      ),
  },
  {
    id: "performance.dispatcher-overhead",
    requirements: ["EE-PERF-002"],
    kind: "positive",
    requires: "postgresql",
    run: (context) =>
      withReference(context, async (c) => {
        await c.migrate();
        let io = 0;
        // Each Event's public pool connection/query awaits are sequential. Their
        // nonoverlapping elapsed boundaries exclude driver/database/network waiting.
        let activeIo = 0;
        const measureIo = async (work) => {
          assert.equal(activeIo, 0, "I/O timing regions must never overlap");
          activeIo++;
          const started = performance.now();
          try {
            return await work();
          } finally {
            io += performance.now() - started;
            activeIo--;
          }
        };
        const pool = {
          connect: async () => {
            const client = await measureIo(() => c.pool.connect());
            return {
              query: (text, values) =>
                measureIo(() => client.query(text, values)),
              release: () => client.release(),
            };
          },
        };
        const module = c.configuration.project.modules.find(
          (m) => m.name === "Sales",
        );
        const runtime = new c.api.PostgreSqlModuleRuntime({
          module,
          pool,
          storage: c.plan.storage,
        });
        const total = [];
        const database = [];
        const residual = [];
        try {
          await runtime.start();
          for (let i = 0; i < 120; i++) {
            const envelope = c.api.createEventEnvelope({
              eventId: randomUUID(),
              eventIdentity: "Order.Place",
              occurredAt: new Date().toISOString(),
              payload: { id: randomUUID(), amount: 500, minimum: 100 },
            });
            io = 0;
            const start = performance.now();
            const result = await runtime.dispatch(envelope);
            const elapsed = performance.now() - start;
            assert.equal(result.kind, "success");
            const overhead = elapsed - io;
            assert.ok(
              overhead >= 0,
              "Nonoverlapping I/O accounting must not exceed total",
            );
            if (i >= 20) {
              total.push(elapsed);
              database.push(io);
              residual.push(overhead);
            }
          }
        } finally {
          await runtime.stop();
        }
        assert.ok(
          summary(residual).median < 10,
          JSON.stringify(summary(residual)),
        );
        return JSON.stringify({
          ...JSON.parse(
            await evidence(
              c,
              "Public PostgreSqlModuleRuntime.dispatch:20warmup+100sequential real Events; residual=total minus nonoverlapping awaited pool.connect/query durations; DB/network excluded; residual JS work retained; median<10",
              residual,
            ),
          ),
          totalWallMs: summary(total),
          excludedIoMs: summary(database),
        });
      }),
  },
  {
    id: "performance.persisted-sse-latency",
    requirements: ["EE-PERF-003"],
    kind: "positive",
    requires: "postgresql",
    run: (context) =>
      withReference(context, async (c) => {
        await c.migrate();
        const module = c.configuration.project.modules.find(
          (m) => m.name === "Sales",
        );
        const events = new c.api.PostgreSqlModuleRuntime({
          module,
          pool: c.pool,
          storage: c.plan.storage,
        });
        const views = new c.api.PostgreSqlViewRuntime(
          module,
          c.pool,
          c.plan.storage,
          c.configuration.project.modules,
        );
        const store = new c.api.PostgreSqlSagaStore(c.pool, c.plan.storage);
        const compiled = c.api.materializeContract(module, {
          events: [
            {
              event: "Order.Place",
              terminal: {
                view: "OrderDetails",
                input: { id: { kind: "eventInput", input: "id" } },
              },
            },
          ],
        });
        assert.equal(compiled.success, true);
        const http = new c.api.PublicHttpRuntime({
          contract: compiled.ir,
          events,
          views,
          terminals: store,
        });
        const server = createServer(c.api.createNodeHttpHandler(http));
        const samples = [];
        try {
          await events.start();
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          const base = `http://127.0.0.1:${server.address().port}`;
          const operation = compiled.ir.operations.find(
            (operation) => operation.kind === "event",
          );
          for (let i = 0; i < 20; i++) {
            const sagaId = randomUUID();
            await store.register(sagaId);
            const id = randomUUID();
            assert.equal(
              (
                await events.dispatch(
                  c.api.createEventEnvelope({
                    eventId: randomUUID(),
                    eventIdentity: "Order.Place",
                    sagaId,
                    occurredAt: new Date().toISOString(),
                    payload: { id, amount: 500, minimum: 100 },
                  }),
                )
              ).kind,
              "success",
            );
            const terminalView = await views.execute({
              view: "OrderDetails",
              input: { id },
            });
            assert.deepEqual(terminalView.rows, [
              { id, amount: 500, status: "placed" },
            ]);
            const controller = new AbortController();
            const reception = fetch(
              base + operation.terminal.streamPath.replace("{sagaId}", sagaId),
              {
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(5000),
                ]),
              },
            )
              .then(async (response) => {
                assert.equal(response.status, 200);
                const body = await response.text();
                const received = performance.now();
                assert.match(body, /^event: view\ndata: /);
                return { body, received };
              })
              .catch((error) => ({ error }));
            try {
              await delay(20);
              const started = performance.now();
              await store.publish(sagaId, {
                kind: "view",
                view: "OrderDetails",
                data: terminalView.rows,
              });
              const result = await reception;
              if (result.error) throw result.error;
              assert.deepEqual(
                JSON.parse(result.body.split("\ndata: ")[1].trim()).data,
                terminalView.rows,
              );
              assert.equal((await store.read(sagaId)).status, "terminal");
              samples.push(result.received - started);
            } finally {
              controller.abort();
              await reception;
            }
          }
          assert.ok(
            samples.every((value) => value <= 1000),
            JSON.stringify(samples),
          );
          return evidence(
            c,
            "20 nominal sequential loopback SSE clients subscribed before real durable terminal publish; timestamp immediately BEFORE publish autocommit through received complete parsed frame: conservative upper bound includes persistence itself; each<=1000; no simulated store",
            samples,
          );
        } finally {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
          await events.stop();
        }
      }),
  },
];
