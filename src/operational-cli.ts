import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Pool } from "pg";
import {
  type PostgreSqlMigrationApproval,
  applyPostgreSqlMigrationPlan,
} from "./postgresql/migration-executor.js";
import {
  type PostgreSqlMigrationPlan,
  createPostgreSqlMigrationPlan,
} from "./postgresql/migrations.js";
import { PostgreSqlOperations } from "./postgresql/operations.js";
import type { PostgreSqlStorageIr } from "./postgresql/storage-ir.js";
import { createVaultSecretResolver } from "./secrets.js";
import {
  compileServiceConfiguration,
  resolveServiceProfile,
} from "./service-compiler.js";
import type { ServiceConfiguration } from "./service-configuration.js";
import {
  createServiceRuntime,
  resolveConfiguredSecret,
} from "./service-runtime.js";

export async function operationalCommand(
  command: string,
  positional: readonly string[],
  options: ReadonlyMap<string, string>,
  configuration: ServiceConfiguration,
  profileName: string,
  json: boolean,
): Promise<void> {
  const compiled = compileServiceConfiguration(configuration, profileName);
  if (!compiled.success) throw new Error("Invalid configuration.");
  const plan = compiled.plan;
  const profile = resolveServiceProfile(configuration, profileName);
  const output = (value: unknown) =>
    console.log(JSON.stringify(value, null, json ? 0 : 2));
  if (command === "inspect" && positional[0] === "event") {
    const identity = positional[1];
    const policy = plan.runtime.policies.find((p) => p.event === identity);
    if (!policy) throw new Error("Unknown Event.");
    output({
      policy,
      ownership: plan.runtime.ownership,
      policyExecution: plan.runtime.policyExecution,
    });
    return;
  }
  if (command === "migrate" && positional[0] === "diff") {
    const previous = options.has("--previous")
      ? (JSON.parse(
          await readFile(options.get("--previous") as string, "utf8"),
        ) as PostgreSqlStorageIr)
      : null;
    output(createPostgreSqlMigrationPlan({ previous, next: plan.storage }));
    return;
  }
  if (
    command === "dev" &&
    profile.environment !== "development" &&
    profile.environment !== "test"
  )
    throw new Error("dev requires a local profile.");
  const resolver = profile.secrets
    ? await createVaultSecretResolver(profile.secrets)
    : resolveConfiguredSecret;
  const connection = profile.topology?.service.persistence.connection;
  if (!connection) throw new Error("Missing database configuration.");
  const pool = new Pool({
    connectionString: await resolver(connection),
    connectionTimeoutMillis: 5000,
  });
  try {
    if (command === "migrate" && positional[0] === "apply") {
      const path = options.get("--migration");
      if (!path) throw new Error("Missing migration file.");
      const migration = JSON.parse(
        await readFile(path, "utf8"),
      ) as PostgreSqlMigrationPlan;
      const expected = createPostgreSqlMigrationPlan({
        previous: null,
        next: plan.storage,
      });
      if (migration.targetHash !== expected.targetHash)
        throw new Error("Migration targets another configuration.");
      const approval = options.has("--approval")
        ? (JSON.parse(
            await readFile(options.get("--approval") as string, "utf8"),
          ) as PostgreSqlMigrationApproval)
        : undefined;
      output(await applyPostgreSqlMigrationPlan(pool, migration, approval));
      return;
    }
    const operations = new PostgreSqlOperations(pool, plan.storage);
    if (command === "inspect") {
      if (positional[0] === "saga" && positional[1])
        output(await operations.inspectSaga(positional[1]));
      else if (positional[0] === "queues") output(await operations.queues());
      else throw new Error("Invalid inspection target.");
      return;
    }
    if (command === "failures") {
      if (positional[0] === "list") output(await operations.failures());
      else if (positional[0] === "retry-outbox" && positional[1])
        output({
          requeued: await operations.retryOutboxFailure(positional[1]),
        });
      else if (positional[0] === "resolve" && positional[1])
        output({ resolved: await operations.resolveFailure(positional[1]) });
      else if (positional[0] === "prune" && options.has("--before"))
        output({
          deleted: await operations.pruneResolvedFailures(
            options.get("--before") as string,
          ),
        });
      else throw new Error("Invalid failure operation.");
      return;
    }
    if (command !== "dev") throw new Error("Unknown operation.");
    const port = Number(options.get("--port") ?? 3000);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid port.");
    const runtime = await createServiceRuntime(configuration, profileName, {
      pool,
      resolveSecret: resolver,
    });
    await runtime.start();
    const server = createServer((req, res) => {
      void runtime.handler(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    let finish: () => void = () => {};
    const finished = new Promise<void>((r) => {
      finish = r;
    });
    let closing: Promise<void> | undefined;
    const stop = () => {
      closing ??= (async () => {
        server.close();
        server.closeAllConnections();
        await runtime.stop();
        finish();
      })();
      return closing;
    };
    const signal = () => {
      void stop();
    };
    process.once("SIGINT", signal);
    process.once("SIGTERM", signal);
    try {
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      output({
        state: "running",
        address: server.address(),
        inputHash: plan.inputHash,
      });
      void runtime.runWorkers().catch(() => {
        process.exitCode = 1;
        void stop();
      });
      await finished;
    } finally {
      process.removeListener("SIGINT", signal);
      process.removeListener("SIGTERM", signal);
      await stop();
    }
  } finally {
    await pool.end();
  }
}
