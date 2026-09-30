// Executable version of this example's documented installed-package quickstart.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const directory = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(
  dirname(fileURLToPath(import.meta.resolve("@lilka/vane"))),
);
const metadata = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);
const cli = join(packageRoot, metadata.bin["entity-event"]);
const configuration = join(directory, "configuration.mjs");
const common = ["--config", configuration, "--profile", "test", "--json"];
const children = [];
const migration = join(directory, `.migration-${randomUUID()}.json`);
async function invoke(args) {
  return JSON.parse(
    (
      await promisify(execFile)(process.execPath, [cli, ...args, ...common], {
        env: process.env,
        timeout: 10000,
      })
    ).stdout,
  );
}
async function start(args, env) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  });
  let errorText = "";
  child.stderr.on("data", (data) => {
    errorText += String(data);
  });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Quickstart service readiness timed out")),
      10000,
    );
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", () =>
      fail(new Error(`Quickstart child stopped: ${errorText}`)),
    );
    let text = "";
    child.stdout.on("data", (data) => {
      text += String(data);
      if (text.includes("\n")) {
        try {
          const ready = JSON.parse(text.split("\n")[0]);
          clearTimeout(timer);
          resolve({ child, url: `http://127.0.0.1:${ready.address.port}` });
        } catch (error) {
          fail(error);
        }
      }
    });
  });
}
try {
  assert.ok(process.env.DATABASE_URL, "Set DATABASE_URL to PostgreSQL16+");
  await invoke(["validate"]);
  const gateway = await start([join(directory, "gateway.mjs")], {
    ...process.env,
    PAYMENT_GATEWAY_PORT: "0",
  });
  process.env.PAYMENT_GATEWAY_URL = gateway.url;
  await writeFile(migration, JSON.stringify(await invoke(["migrate", "diff"])));
  await invoke(["migrate", "apply", "--migration", migration]);
  const application = await start(
    [cli, "dev", "--port", "0", ...common],
    process.env,
  );
  const id = randomUUID();
  const response = await fetch(`${application.url}/sales/events/Order.Place`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, amount: 500, minimum: 100 }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 202);
  const { sagaId } = await response.json();
  const stream = await fetch(`${application.url}/sales/sagas/${sagaId}`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(stream.status, 200);
  const frame = await stream.text();
  assert.ok(frame.startsWith("event: view\n"));
  const order = JSON.parse(frame.split("\ndata: ")[1].trim());
  assert.equal(order.data[0].status, "complete");
  const receipt = await fetch(
    `${application.url}/billing/views/PaymentReceipt`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(10000),
    },
  );
  assert.equal(receipt.status, 200);
  const payment = await receipt.json();
  console.log(
    JSON.stringify({
      schema: "vane.reference-quickstart-result",
      version: 1,
      package: { name: metadata.name, version: metadata.version },
      sagaId,
      order,
      payment,
    }),
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await child.exited;
    clearTimeout(timer);
  }
  await unlink(migration).catch(() => {});
}
