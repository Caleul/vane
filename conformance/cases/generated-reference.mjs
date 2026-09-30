import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
export async function withReference(context, run, { database = true } = {}) {
  if (!context.tarballPath)
    throw Object.assign(
      new Error(
        "Original tested tarball is required for independent reference installation",
      ),
      { code: "CONFORMANCE_GAP" },
    );
  if (database && !context.databaseUrl)
    throw Object.assign(
      new Error("VANE_CONFORMANCE_DATABASE_URL is required"),
      { code: "CONFORMANCE_GAP" },
    );
  const dir = await mkdtemp(join(tmpdir(), "vane-reference-conformance-"));
  const namespace = `vane_ref_${randomUUID().replaceAll("-", "")}`;
  const children = [];
  let pool;
  try {
    await cp(new URL("../../examples/sales-billing/", import.meta.url), dir, {
      recursive: true,
    });
    await exec("npm", ["init", "-y"], { cwd: dir, timeout: 30000 });
    await exec(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        process.env.VANE_CONFORMANCE_NPM_CACHE ??
          join(tmpdir(), "vane-npm-cache"),
        context.tarballPath,
      ],
      { cwd: dir, timeout: 60000 },
    );
    const installed = join(dir, "node_modules/@lilka/vane");
    const metadata = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    const api = await import(
      pathToFileURL(join(installed, metadata.exports["."].import)).href
    );
    const env = {
      ...process.env,
      DATABASE_URL: context.databaseUrl ?? "",
      VANE_NAMESPACE: namespace,
      PAYMENT_GATEWAY_PORT: "0",
      PAYMENT_GATEWAY_URL: "http://127.0.0.1:1",
    };
    // Configuration executes in a child under this env; parent reads its serialized public output.
    const configFile = join(dir, "configuration.mjs");
    const config = (
      await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import configuration from ${JSON.stringify(pathToFileURL(configFile).href)};console.log(JSON.stringify(configuration));`,
        ],
        { cwd: dir, env, timeout: 10000 },
      )
    ).stdout;
    const configuration = JSON.parse(config);
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        [
          "billing.vane.ts",
          "sales.vane.ts",
          "configuration.mjs",
          "quickstart.mjs",
        ].map(async (name) => [name, hash(await readFile(join(dir, name)))]),
      ),
    );
    const compile = api.compileServiceConfiguration(configuration, "test");
    assert.equal(compile.success, true, JSON.stringify(compile.diagnostics));
    const plan = compile.plan;
    const cli = async (args) => {
      const result = await exec(
        process.execPath,
        [
          join(installed, metadata.bin["entity-event"]),
          ...args,
          "--config",
          configFile,
          "--profile",
          "test",
          "--json",
        ],
        { cwd: dir, env, timeout: 15000 },
      );
      return JSON.parse(result.stdout);
    };
    const start = async (command, args, extra = {}) => {
      const child = spawn(command, args, {
        cwd: dir,
        env: { ...env, ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.exited = new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", (error) => resolve({ error }));
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error(`Generated process readiness timeout: ${stderr}`)),
          15000,
        );
        const fail = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        child.once("error", fail);
        child.once("exit", () =>
          fail(
            new Error(`Generated process exited before readiness: ${stderr}`),
          ),
        );
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
          if (stdout.includes("\n")) {
            try {
              const value = JSON.parse(stdout.split("\n")[0]);
              clearTimeout(timer);
              resolve(value);
            } catch (error) {
              fail(error);
            }
          }
        });
      });
      return { child, ready, url: `http://127.0.0.1:${ready.address.port}` };
    };
    if (database) {
      const { Pool } = createRequire(join(installed, "package.json"))("pg");
      pool = new Pool({
        connectionString: context.databaseUrl,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      });
      const version = await pool.query("SHOW server_version_num");
      context.postgresqlVersion = version.rows[0].server_version_num;
    }
    const gateway = async () => {
      const result = await start(process.execPath, [join(dir, "gateway.mjs")]);
      env.PAYMENT_GATEWAY_URL = result.url;
      return result;
    };
    const migrate = async () => {
      const migration = await cli(["migrate", "diff"]);
      const file = join(dir, "migration.json");
      await writeFile(file, JSON.stringify(migration));
      assert.equal(
        (await cli(["migrate", "apply", "--migration", file])).status,
        "applied",
      );
    };
    return await run({
      api,
      dir,
      installed,
      metadata,
      configuration,
      plan,
      env,
      cli,
      start,
      pool,
      namespace,
      gateway,
      migrate,
      tarball: context.tarballPath,
      sourceHashes,
    });
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      let deadline;
      try {
        await Promise.race([
          child.exited,
          new Promise((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Child cleanup deadline exceeded")),
              7000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        clearTimeout(deadline);
      }
    }
    try {
      if (pool)
        await pool.query(`DROP SCHEMA IF EXISTS ${quote(namespace)} CASCADE`);
    } finally {
      if (pool) await pool.end();
      await rm(dir, { recursive: true, force: true });
    }
  }
}
export async function exerciseReference(url) {
  const id = randomUUID();
  const admitted = await fetch(`${url}/sales/events/Order.Place`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, amount: 500, minimum: 100 }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(admitted.status, 202);
  const { sagaId } = await admitted.json();
  const stream = await fetch(`${url}/sales/sagas/${sagaId}`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(stream.status, 200);
  const text = await stream.text();
  assert.equal((text.match(/^event:/gm) || []).length, 1);
  assert.match(text, /^event: view\n/);
  const order = JSON.parse(text.split("\ndata: ")[1].trim());
  assert.deepEqual(order.data, [{ id, amount: 500, status: "complete" }]);
  const read = await fetch(`${url}/billing/views/PaymentReceipt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(read.status, 200);
  const receipt = await read.json();
  assert.deepEqual(receipt, [{ id, amount: 500, status: "created" }]);
  return { sagaId, id };
}
export async function writeGenerated(c) {
  const dir = join(c.dir, "generated");
  await c.cli(["generate", "--out", dir]);
  await copyFile(c.tarball, join(dir, "vane.tgz"));
  const deployment = JSON.parse(
    await readFile(join(dir, "deploy-plan.json"), "utf8"),
  );
  const env = { PORT: "0" };
  for (const binding of deployment.secrets)
    env[binding.containerEnvironment] =
      binding.slot === "persistence.connection"
        ? c.env.DATABASE_URL
        : c.env.PAYMENT_GATEWAY_URL;
  return { dir, env };
}
export const cases = [
  {
    id: "generated.artifact-provenance",
    requirements: ["EE-ART-002"],
    kind: "positive",
    run: (context) =>
      withReference(
        context,
        async (c) => {
          const config = structuredClone(c.configuration);
          const sentinel = `secret-${randomUUID()}`;
          config.profiles.development.topology.service.persistence.connection =
            c.api.localSecret(sentinel);
          const compiled = c.api.compileServiceConfiguration(config, "test");
          assert.equal(compiled.success, true);
          const files = c.api.generateServiceDeployment(
            compiled.plan,
            config.project,
          );
          const manifest = JSON.parse(files["artifacts.json"]);
          assert.equal(manifest.version, 2);
          assert.equal(manifest.generator.version, c.metadata.version);
          assert.equal(manifest.inputHash, compiled.plan.inputHash);
          for (const [name, content] of Object.entries(files)) {
            assert.ok(!content.includes(sentinel));
            if (name === "artifacts.json") continue;
            assert.equal(manifest.files[name], hash(content));
            if (name.endsWith(".provenance.json")) continue;
            const sidecar = manifest.companions[name];
            assert.equal(sidecar, `${name}.provenance.json`);
            const provenance = JSON.parse(files[sidecar]);
            assert.equal(provenance.inputHash, compiled.plan.inputHash);
            assert.equal(provenance.contentHash, hash(content));
            assert.equal(provenance.generator.version, c.metadata.version);
            assert.ok(provenance.versions.servicePlan > 0);
          }
          assert.ok(Array.isArray(JSON.parse(files["contract-ir.json"])));
          return "Every generated payload has linked version/input-hash/generator/UTF8-byte-hash sidecar; manifest has explicit self provenance without recursive hash; native JSON IR shapes and secret exclusion preserved";
        },
        { database: false },
      ),
  },
  {
    id: "generated.reference-bootstrap",
    requirements: ["EE-ART-001", "EE-REF-001"],
    kind: "positive",
    requires: "postgresql",
    run: (context) =>
      withReference(context, async (c) => {
        assert.deepEqual(
          c.configuration.project.modules.map((m) => m.name).sort(),
          ["Billing", "Sales"],
        );
        for (const profile of ["development", "test", "production"]) {
          const compiled = c.api.compileServiceConfiguration(
            c.configuration,
            profile,
          );
          assert.equal(
            compiled.success,
            true,
            JSON.stringify(compiled.diagnostics),
          );
          assert.ok(compiled.plan.runtime.ownership.length >= 2);
          assert.equal(compiled.plan.infrastructure.services.length, 1);
          assert.equal(compiled.plan.infrastructure.topology, "monolith");
          assert.deepEqual(compiled.plan.runtime.plannedAllocation, [
            {
              name: "billing-api",
              modules: ["Billing"],
              database: "shared-commerce",
              entities: ["Billing.Payment"],
            },
            {
              name: "sales-api",
              modules: ["Sales"],
              database: "shared-commerce",
              entities: ["Sales.Order"],
            },
          ]);
        }
        const sales = c.configuration.project.modules.find(
          (m) => m.name === "Sales",
        );
        const billing = c.configuration.project.modules.find(
          (m) => m.name === "Billing",
        );
        assert.equal(sales.entities[0].name, "Order");
        assert.equal(billing.entities[0].name, "Payment");
        assert.ok(sales.entities[0].rules.some((r) => r.columns.length === 2));
        assert.ok(sales.sagas.some((s) => s.name === "PlaceOrder"));
        assert.equal(
          billing.antiCorruptionLayers[0].events[0].identity,
          "PaymentGateway.Authorize",
        );
        await c.gateway();
        await c.migrate();
        const generated = await writeGenerated(c);
        // Generated application resolves the independently installed public package in its parent.
        const running = await c.start(
          process.execPath,
          [join(generated.dir, "bootstrap.mjs")],
          generated.env,
        );
        await exerciseReference(running.url);
        return `Original tarball ${hash(await readFile(c.tarball))} installed in independent consumer; official Sales/Billing all3profiles compile, generated bootstrap/provider ACL wiring completes real Order/Payment Saga and Views with PostgreSQL`;
      }),
  },
  {
    id: "generated.literal-quickstart",
    requirements: ["EE-DOC-001"],
    kind: "positive",
    requires: "postgresql",
    run: (context) =>
      withReference(context, async (c) => {
        const readme = await readFile(join(c.dir, "README.md"), "utf8");
        assert.ok(
          readme.includes('npm install --ignore-scripts "$VANE_TARBALL"'),
        );
        assert.ok(readme.includes("node quickstart.mjs"));
        const result = await exec(process.execPath, ["quickstart.mjs"], {
          cwd: c.dir,
          env: c.env,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        });
        const proof = JSON.parse(result.stdout);
        assert.equal(proof.schema, "vane.reference-quickstart-result");
        assert.equal(proof.order.data[0].status, "complete");
        assert.equal(proof.payment[0].status, "created");
        return `Literal documented npm init/install original tarball and node quickstart.mjs reproduced official reference in fresh application directory; package ${proof.package.name}@${proof.package.version}, final Order/Payment Views verified`;
      }),
  },
  {
    id: "generated.docker-image",
    requirements: ["EE-SVC-031"],
    kind: "positive",
    requires: "postgresql",
    timeoutMs: 300000,
    run: async (context) => {
      if (process.env.VANE_CONFORMANCE_DOCKER !== "1")
        throw Object.assign(
          new Error(
            "Real Docker build/run requires VANE_CONFORMANCE_DOCKER=1 on a Linux Docker host; no image evidence claimed locally",
          ),
          { code: "CONFORMANCE_GAP" },
        );
      await exec("docker", ["info", "--format", "{{.ServerVersion}}"], {
        timeout: 10000,
      });
      return withReference(context, async (c) => {
        await c.gateway();
        await c.migrate();
        const generated = await writeGenerated(c);
        const tag = `vane-conformance:${randomUUID()}`;
        const name = `vane-conformance-${randomUUID()}`;
        try {
          await exec("docker", ["build", "-t", tag, generated.dir], {
            timeout: 180000,
            maxBuffer: 10 * 1024 * 1024,
          });
          const args = [
            "run",
            "--rm",
            "--name",
            name,
            "--network",
            "host",
            ...Object.keys(generated.env).flatMap((key) => ["--env", key]),
            tag,
          ];
          const running = await c.start("docker", args, generated.env);
          await exerciseReference(running.url);
          const labels = JSON.parse(
            (
              await exec(
                "docker",
                [
                  "image",
                  "inspect",
                  tag,
                  "--format",
                  "{{json .Config.Labels}}",
                ],
                { timeout: 10000 },
              )
            ).stdout,
          );
          assert.equal(labels["org.vane.input-hash"], c.plan.inputHash);
          assert.equal(
            labels["org.vane.generator-version"],
            c.metadata.version,
          );
          const inspect = await exec(
            "docker",
            ["image", "inspect", tag, "--format", "{{.Id}}"],
            { timeout: 10000 },
          );
          return `Generated Dockerfile built and actual container completed public Order/Payment/SSE flow on real PostgreSQL; image ${inspect.stdout.trim()}`;
        } finally {
          await exec("docker", ["rm", "-f", name], { timeout: 10000 }).catch(
            () => {},
          );
          await exec("docker", ["image", "rm", "-f", tag], {
            timeout: 10000,
          }).catch(() => {});
        }
      });
    },
  },
];
