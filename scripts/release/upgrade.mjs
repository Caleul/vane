import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runFile = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Runs in the installed consumer. Only public exports and the normal pg dependency.
const inspector = `import pg from 'pg';
import {writeFile} from 'node:fs/promises';
import {result,namespace} from './configuration.mjs';
const pool=new pg.Pool({connectionString:process.env.VANE_DOGFOOD_DATABASE_URL});
try {
 const schema=result.plan.storage;
 const name=id=>schema.tables.find(t=>t.semanticId===id).name;
 const table=id=> '"'+namespace+'"."'+name(id)+'"';
 const snapshot={
  storage:schema,
  postgresVersion:(await pool.query('SHOW server_version')).rows[0].server_version,
  postgresVersionNum:Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num),
  columns:(await pool.query('SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity,is_generated FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position',[namespace])).rows,
  constraints:(await pool.query('SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE connamespace=$1::regnamespace ORDER BY conname',[namespace])).rows,
  indexes:(await pool.query('SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname',[namespace])).rows,
  history:(await pool.query('SELECT * FROM "'+namespace+'"."__vane_migrations" ORDER BY applied_at')).rows,
  projects:(await pool.query('SELECT * FROM '+table('Tasks.Project')+' ORDER BY id')).rows,
  todos:(await pool.query('SELECT * FROM '+table('Tasks.Todo')+' ORDER BY id')).rows,
 };
 await writeFile(process.argv[2],JSON.stringify(snapshot,null,2));
 console.log(JSON.stringify({postgresVersion:snapshot.postgresVersion,rows:{projects:snapshot.projects.length,todos:snapshot.todos.length},history:snapshot.history.length}));
}finally{await pool.end();}`;

export async function runUpgrade({
  tarball,
  baselineArchive = join(repository, "docs/evidence/phase-8/consumers.tar.gz"),
  expectedVersion = "0.1.0-rc.1",
  databaseUrl = process.env.VANE_RELEASE_DATABASE_URL ??
    process.env.VANE_DOGFOOD_DATABASE_URL ??
    process.env.VANE_TEST_DATABASE_URL,
  out = join(repository, "docs/evidence/phase9/upgrade.json"),
}) {
  const startedAt = new Date().toISOString();
  const commands = [];
  const http = [];
  const processes = [];
  const evidence = {
    schema: "vane.release.upgrade-evidence",
    version: 1,
    requirement: "R9-D3",
    status: "FAIL",
    startedAt,
    node: process.version,
    expectedVersion,
    commands,
    http,
    processes,
    sourceOrigin:
      "Immutable Phase 8 Todo/Project consumer archive; upgrade validation, not a new independent adopter",
    consultations: [
      "docs/operations.md public CLI migration protocol",
      "docs/postgresql.md public Storage IR and migration API",
      "test-integration/postgresql-migration.integration.test.ts no-op status assertion",
      "src/cli.ts and src/operational-cli.ts to inspect existing public CLI JSON response shapes",
    ],
    scriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  };
  let directory;
  let app;
  let active;
  let environment;
  let baseline;
  async function command(
    program,
    args,
    { expectedExit = 0, timeout = 60000, cwd = app } = {},
  ) {
    const entry = {
      program,
      args,
      cwd,
      expectedExit,
      startedAt: new Date().toISOString(),
    };
    commands.push(entry);
    let result;
    try {
      result = await runFile(program, args, {
        cwd,
        env: environment ?? process.env,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      });
      entry.exitCode = 0;
    } catch (error) {
      entry.exitCode = typeof error.code === "number" ? error.code : -1;
      result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
      entry.signal = error.signal;
    }
    entry.stdout = result.stdout;
    entry.stderr = result.stderr;
    entry.finishedAt = new Date().toISOString();
    assert.equal(
      entry.exitCode,
      expectedExit,
      `${program} ${args.join(" ")} failed: ${entry.stderr || entry.stdout}`,
    );
    return result;
  }
  async function installed() {
    const packageJson = JSON.parse(
      await readFile(
        join(app, "node_modules/@lilka/vane/package.json"),
        "utf8",
      ),
    );
    const path = await realpath(join(app, "node_modules/@lilka/vane"));
    assert.ok(
      path.startsWith(`${app}/node_modules/`),
      "Package must resolve inside external node_modules",
    );
    return {
      name: packageJson.name,
      version: packageJson.version,
      path,
      cli: join(path, packageJson.bin["entity-event"]),
      lock: JSON.parse(await readFile(join(app, "package-lock.json"), "utf8"))
        .packages["node_modules/@lilka/vane"],
    };
  }
  async function snapshot(label) {
    const file = join(directory, `${label}.json`);
    await command(process.execPath, ["upgrade-inspect.mjs", file]);
    return JSON.parse(await readFile(file, "utf8"));
  }
  function schemaEqual(before, after) {
    for (const key of [
      "storage",
      "columns",
      "constraints",
      "indexes",
      "history",
    ])
      assert.deepEqual(after[key], before[key], `Upgrade must preserve ${key}`);
  }
  async function start() {
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: app,
      env: { ...environment, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
    };
    processes.push(log);
    const exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => {
        Object.assign(log, {
          code,
          signal,
          finishedAt: new Date().toISOString(),
        });
        resolve({ code, signal });
      }),
    );
    active = { child, exited };
    return new Promise((resolveReady, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Upgrade HTTP process readiness timeout")),
        30000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Upgrade server stopped: ${log.stderr}`));
      });
      child.stderr.on("data", (chunk) => {
        log.stderr += chunk;
      });
      child.stdout.on("data", (chunk) => {
        log.stdout += chunk;
        for (const line of log.stdout.split("\n")) {
          try {
            const ready = JSON.parse(line);
            if (ready.ready) {
              clearTimeout(timer);
              active.url = `http://127.0.0.1:${ready.address.port}`;
              resolveReady(active);
            }
          } catch {}
        }
      });
    });
  }
  async function stop() {
    if (!active) return;
    const current = active;
    active = null;
    if (current.child.exitCode !== null || current.child.signalCode !== null)
      return;
    current.child.kill("SIGTERM");
    const timer = setTimeout(() => current.child.kill("SIGKILL"), 10000);
    const result = await current.exited;
    clearTimeout(timer);
    assert.deepEqual(
      result,
      { code: 0, signal: null },
      "Upgrade process must drain gracefully",
    );
  }
  async function request(path, body) {
    const method = body === undefined ? "GET" : "POST";
    const response = await fetch(active.url + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    http.push({
      timestamp: new Date().toISOString(),
      method,
      path,
      input: body,
      status: response.status,
      text,
    });
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, text, data };
  }
  async function view(name, input) {
    const result = await request(`/tasks/views/${name}`, input);
    assert.equal(result.status, 200, result.text);
    assert.ok(Array.isArray(result.data));
    return result.data;
  }
  async function terminal(sagaId, kind = "view") {
    const stream = await request(`/tasks/sagas/${sagaId}`);
    assert.equal(stream.status, 200);
    assert.ok(stream.text.startsWith(`event: ${kind}\n`), stream.text);
    assert.equal((stream.text.match(/^event:/gm) ?? []).length, 1);
    return JSON.parse(stream.text.split("\ndata: ")[1].trim());
  }
  async function event(identity, input, kind = "view") {
    const admission = await request(`/tasks/events/${identity}`, input);
    assert.equal(admission.status, 202, admission.text);
    assert.deepEqual(Object.keys(admission.data), ["sagaId"]);
    return {
      sagaId: admission.data.sagaId,
      terminal: await terminal(admission.data.sagaId, kind),
    };
  }
  try {
    assert.ok(
      databaseUrl,
      "Set VANE_RELEASE_DATABASE_URL, VANE_DOGFOOD_DATABASE_URL or VANE_TEST_DATABASE_URL to PostgreSQL16",
    );
    assert.ok(tarball, "--tarball is required");
    tarball = resolve(tarball);
    baselineArchive = resolve(baselineArchive);
    out = resolve(out);
    evidence.candidateTarball = {
      path: tarball,
      sha256: sha256(await readFile(tarball)),
    };
    evidence.baselineArchive = {
      path: baselineArchive,
      sha256: sha256(await readFile(baselineArchive)),
    };
    directory = await mkdtemp(join(tmpdir(), "vane-release-upgrade-"));
    evidence.cleanWorkspace = directory;
    await command("tar", ["-xzf", baselineArchive, "-C", directory], {
      cwd: directory,
    });
    const extracted = join(directory, "vane-dogfood");
    app = join(extracted, "apps/todo");
    baseline = join(extracted, "artifacts/vane.tgz");
    const provenance = JSON.parse(
      await readFile(join(extracted, "artifacts/candidate.json"), "utf8"),
    );
    const baselineBytes = await readFile(baseline);
    assert.equal(
      sha256(baselineBytes),
      provenance.sha256,
      "Archived baseline tarball identity must match phase8 candidate",
    );
    assert.notEqual(
      evidence.candidateTarball.sha256,
      provenance.sha256,
      "Upgrade must use a distinct candidate tarball",
    );
    evidence.baselineTarball = {
      sha256: provenance.sha256,
      version: provenance.version,
      commit: provenance.commit,
      tree: provenance.tree,
    };
    const namespace = `dogfood_todo_upgrade_${randomUUID().replaceAll("-", "")}`;
    evidence.namespace = namespace;
    environment = {
      ...process.env,
      VANE_DOGFOOD_DATABASE_URL: databaseUrl,
      VANE_TODO_NAMESPACE: namespace,
    };
    evidence.consumerSources = {};
    for (const name of [
      "model.vane.ts",
      "configuration.mjs",
      "server.mjs",
      "types.ts",
      "tsconfig.json",
    ])
      evidence.consumerSources[name] = sha256(await readFile(join(app, name)));
    await writeFile(join(app, "upgrade-inspect.mjs"), inspector);
    evidence.npmVersion = (await command("npm", ["--version"])).stdout.trim();
    await command("npm", ["ci", "--ignore-scripts"]);
    const old = await installed();
    assert.equal(old.version, "0.0.0");
    evidence.baselineInstalled = old;
    await command("npm", ["run", "typecheck"]);
    await command("npm", ["run", "build"]);
    await command("npm", ["run", "migrate"]);
    const initial = await snapshot("baseline-empty");
    assert.ok(
      initial.postgresVersionNum >= 160000 &&
        initial.postgresVersionNum < 170000,
      "Upgrade gate requires PostgreSQL16",
    );
    await start();
    const projectId = randomUUID();
    const todoId = randomUUID();
    evidence.identities = { projectId, todoId };
    await event("Project.Create", {
      id: projectId,
      name: "Persisted before RC",
    });
    const todo = {
      id: todoId,
      projectId,
      title: "Persisted Todo",
      totalUnits: 8,
      completedUnits: 0,
    };
    await event("Todo.Create", todo);
    const completed = await event("Todo.Complete", { id: todoId, units: 2 });
    assert.equal(completed.terminal.data[0].completedUnits, 2);
    const priorRows = await view("TodoCard", { id: todoId });
    await stop();
    const before = await snapshot("baseline-persisted");
    assert.equal(before.projects.length, 1);
    assert.equal(before.todos.length, 1);
    schemaEqual(initial, before);
    evidence.beforeUpgrade = before;
    const previous = join(directory, "previous-storage.json");
    await writeFile(previous, JSON.stringify(before.storage, null, 2));
    const rcCopy = join(directory, "rc-vane.tgz");
    await copyFile(tarball, rcCopy);
    await command("npm", ["install", rcCopy, "--ignore-scripts"]);
    const candidate = await installed();
    assert.equal(candidate.name, "@lilka/vane");
    assert.equal(candidate.version, expectedVersion);
    assert.equal(
      candidate.lock.integrity,
      `sha512-${createHash("sha512")
        .update(await readFile(rcCopy))
        .digest("base64")}`,
    );
    evidence.candidateInstalled = candidate;
    await command("npm", ["run", "typecheck"]);
    await command("npm", ["run", "build"]);
    const invalidTypes = join(app, "upgrade-invalid-types.ts");
    await writeFile(
      invalidTypes,
      'import type { CreateTodoInput } from "./model.vane.js"; const bad: CreateTodoInput={id:"id",projectId:"id",title:"bad",totalUnits:"wrong",completedUnits:0}; void bad;\n',
    );
    const negativeTypes = await command(
      process.execPath,
      [
        join(app, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--experimentalDecorators",
        "--skipLibCheck",
        invalidTypes,
      ],
      { expectedExit: 2 },
    );
    assert.match(negativeTypes.stdout, /TS2322/);
    await rm(invalidTypes);
    const cliBase = [
      "--config",
      join(app, "configuration.mjs"),
      "--profile",
      "test",
      "--json",
    ];
    await command(process.execPath, [candidate.cli, "validate", ...cliBase]);
    await command(process.execPath, [candidate.cli, "plan", ...cliBase]);
    const negativeConfig = join(app, "upgrade-invalid-configuration.mjs");
    await writeFile(
      negativeConfig,
      'import config from "./configuration.mjs"; const invalid=structuredClone(config); delete invalid.profiles.test.topology.service.persistence.connection; export default invalid;\n',
    );
    const cliNegative = await command(
      process.execPath,
      [
        candidate.cli,
        "validate",
        "--config",
        negativeConfig,
        "--profile",
        "test",
        "--json",
      ],
      { expectedExit: 1 },
    );
    const rejected = JSON.parse(cliNegative.stdout);
    assert.equal(rejected.success, false);
    assert.ok(rejected.diagnostics.length);
    assert.ok(!("plan" in rejected));
    const diff = JSON.parse(
      (
        await command(process.execPath, [
          candidate.cli,
          "migrate",
          "diff",
          "--previous",
          previous,
          ...cliBase,
        ])
      ).stdout,
    );
    const migration = diff.plan ?? diff;
    assert.equal(migration.noOp, true);
    assert.equal(migration.steps.length, 0);
    evidence.migration = migration;
    const migrationPath = join(directory, "rc-migration.json");
    await writeFile(migrationPath, JSON.stringify(migration, null, 2));
    for (let attempt = 0; attempt < 2; attempt++) {
      const applied = JSON.parse(
        (
          await command(process.execPath, [
            candidate.cli,
            "migrate",
            "apply",
            "--migration",
            migrationPath,
            ...cliBase,
          ])
        ).stdout,
      );
      assert.equal(applied.status, "no-op");
    }
    const afterMigration = await snapshot("candidate-after-migration");
    schemaEqual(before, afterMigration);
    assert.deepEqual(afterMigration.projects, before.projects);
    assert.deepEqual(afterMigration.todos, before.todos);
    evidence.afterMigration = afterMigration;
    await start();
    assert.deepEqual(await view("TodoCard", { id: todoId }), priorRows);
    assert.deepEqual(await terminal(completed.sagaId), completed.terminal);
    const advanced = await event("Todo.Complete", { id: todoId, units: 3 });
    assert.equal(advanced.terminal.data[0].completedUnits, 5);
    const unchanged = await view("TodoCard", { id: todoId });
    const failed = await event(
      "Todo.Complete",
      { id: todoId, units: 9 },
      "fail",
    );
    assert.ok(
      failed.terminal.code &&
        failed.terminal.message &&
        failed.terminal.correlationId,
    );
    assert.deepEqual(await view("TodoCard", { id: todoId }), unchanged);
    const addedId = randomUUID();
    const newTodo = {
      id: addedId,
      projectId,
      title: "Created after RC",
      totalUnits: 3,
      completedUnits: 0,
    };
    await event("Todo.Create", newTodo);
    assert.deepEqual(await view("TodoCard", { id: addedId }), [newTodo]);
    await stop();
    const after = await snapshot("candidate-persisted");
    schemaEqual(before, after);
    assert.equal(after.projects.length, 1);
    assert.equal(after.todos.length, 2);
    assert.equal(
      Number(after.todos.find((row) => row.id === todoId).completed_units),
      5,
    );
    evidence.afterUpgrade = after;
    await start();
    assert.equal((await view("TodoCard", { id: todoId }))[0].completedUnits, 5);
    assert.deepEqual(await view("TodoCard", { id: addedId }), [newTodo]);
    await stop();
    const restarted = await snapshot("candidate-restarted");
    schemaEqual(after, restarted);
    assert.deepEqual(restarted.todos, after.todos);
    assert.deepEqual(restarted.projects, after.projects);
    evidence.checks = {
      normalTarballDependency: true,
      baselineVersion: old.version,
      candidateVersion: candidate.version,
      publicTypePositiveAndNegative: true,
      publicCliPositiveAndNegative: true,
      previousStorageDiffNoOp: true,
      migrationApplyTwiceNoDrift: true,
      persistedProjectTodoAcrossUpgrade: true,
      terminalAcrossUpgrade: true,
      candidateHttpEventView: true,
      negativeRuleNoPartialMutation: true,
      restartStable: true,
    };
    evidence.status = "PASS";
  } catch (error) {
    evidence.error = error.stack;
  } finally {
    try {
      await stop();
    } catch (error) {
      evidence.status = "FAIL";
      evidence.shutdownError = error.stack;
    }
    if (app && environment) {
      try {
        await command(process.execPath, ["cleanup.mjs"]);
        evidence.cleanup = "PASS";
      } catch (error) {
        evidence.status = "FAIL";
        evidence.cleanupError = error.stack;
      }
    }
    evidence.finishedAt = new Date().toISOString();
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(resolve(out), `${JSON.stringify(evidence, null, 2)}\n`);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return evidence;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      tarball: { type: "string" },
      "baseline-archive": { type: "string" },
      "expected-version": { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  const result = await runUpgrade({
    tarball: values.tarball,
    baselineArchive: values["baseline-archive"],
    expectedVersion: values["expected-version"],
    out: values.out,
  });
  console.log(
    JSON.stringify({
      status: result.status,
      requirement: result.requirement,
      baseline: result.baselineTarball?.sha256,
      candidate: result.candidateTarball?.sha256,
      error: result.error,
    }),
  );
  if (result.status !== "PASS") process.exitCode = 1;
}
