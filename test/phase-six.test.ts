import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_EXECUTION_POLICY,
  RuntimeTelemetry,
  compileServiceConfiguration,
  createVaultSecretResolver,
  env,
  localSecret,
  retryDelay,
} from "../src/index.js";
import { phaseFiveConfiguration } from "./phase-five-fixture.js";

describe("phase six policies and secrets", () => {
  it("caps exponential backoff", () => {
    const p = {
      ...DEFAULT_EXECUTION_POLICY,
      retry: {
        attempts: 5,
        backoff: "exponential" as const,
        delayMs: 10,
        maxDelayMs: 25,
      },
    };
    assert.deepEqual(
      [1, 2, 3, 1000].map((a) => retryDelay(p, a)),
      [10, 20, 25, 25],
    );
  });
  it("redacts metadata recursively and contains exporter failures", async () => {
    const t = new RuntimeTelemetry(
      { exporter: "json", redact: ["email"] },
      () => {
        throw new Error("secret");
      },
    );
    assert.deepEqual(
      t.redact({ nested: [{ email: "private", token: "private", count: 1 }] }),
      { nested: [{ email: "[REDACTED]", token: "[REDACTED]", count: 1 }] },
    );
    assert.equal(await t.span("event", {}, async () => 42), 42);
    assert.equal(t.exporterFailures, 1);
    assert.equal(t.metrics()["event.success"]?.count, 1);
  });
  it("reads Vault KV v2 without forwarding tokens on redirects or error messages", async () => {
    const seen: string[] = [];
    const resolver = await createVaultSecretResolver(
      {
        provider: "vault-kv-v2",
        address: localSecret("https://vault.example"),
        token: localSecret("private-token"),
        mount: "secret",
        timeoutMs: 100,
      },
      (async (url, options) => {
        seen.push(String(url));
        assert.equal(options?.redirect, "error");
        assert.equal(
          new Headers(options?.headers).get("X-Vault-Token"),
          "private-token",
        );
        return new Response(
          JSON.stringify({ data: { data: { password: "resolved-value" } } }),
        );
      }) as typeof fetch,
    );
    assert.equal(
      await resolver({ kind: "secret", name: "app/database#password" }),
      "resolved-value",
    );
    assert.deepEqual(seen, [
      "https://vault.example/v1/secret/data/app/database",
    ]);
    await assert.rejects(
      resolver({ kind: "secret", name: "../escape#password" }),
      /required secret/,
    );
    await assert.rejects(
      createVaultSecretResolver({
        provider: "vault-kv-v2",
        address: localSecret("http://vault.example"),
        token: localSecret("private-token"),
        mount: "secret",
        timeoutMs: 100,
      }),
      /required secret/,
    );
  });
  it("validates telemetry and Vault before infrastructure access", () => {
    const valid = compileServiceConfiguration(
      phaseFiveConfiguration({
        telemetry: { exporter: "json", redact: ["email"] },
        secrets: {
          provider: "vault-kv-v2",
          address: env("VAULT_ADDR"),
          token: env("VAULT_TOKEN"),
          mount: "secret",
          timeoutMs: 100,
        },
      }),
      "production",
    );
    assert.ok(valid.success, JSON.stringify(valid));
    assert.ok(
      valid.plan.runtime.bindings.some((b) => b.slot === "secrets.token"),
    );
    assert.equal(
      compileServiceConfiguration(
        phaseFiveConfiguration({
          secrets: {
            provider: "vault-kv-v2",
            address: env("VAULT_ADDR"),
            token: localSecret("do-not-print"),
            mount: "secret",
            timeoutMs: 100,
          },
        }),
        "production",
      ).success,
      false,
    );
  });
});

it("CLI inspects Event and computes deterministic migration diff without secrets or database", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "vane-phase6-cli-"));
  try {
    const config = join(dir, "config.mjs");
    await writeFile(
      config,
      `export default ${JSON.stringify(phaseFiveConfiguration())}`,
    );
    const invoke = (...args: string[]) =>
      execFileSync(
        process.execPath,
        [
          resolve("dist-test/src/cli.js"),
          ...args,
          "--config",
          config,
          "--profile",
          "test",
          "--json",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    assert.equal(
      JSON.parse(invoke("inspect", "event", "Sales.Order.Place")).policy.event,
      "Sales.Order.Place",
    );
    const diff = invoke("migrate", "diff");
    assert.equal(diff, invoke("migrate", "diff"));
    assert.ok(JSON.parse(diff).hash);
    assert.throws(() => invoke("inspect", "event", "Missing.Event"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
