import {
  RuntimeTelemetry,
  type ServiceProfile,
  createVaultSecretResolver,
  env,
  secret,
} from "../src/index.js";
const operational: ServiceProfile = {
  telemetry: { exporter: "json", redact: ["email"] },
  secrets: {
    provider: "vault-kv-v2",
    address: env("VAULT_ADDR"),
    token: env("VAULT_TOKEN"),
    mount: "secret",
    timeoutMs: 5000,
  },
};
new RuntimeTelemetry(operational.telemetry).record("event", { eventId: "id" });
void createVaultSecretResolver({
  provider: "vault-kv-v2",
  address: env("VAULT_ADDR"),
  token: env("VAULT_TOKEN"),
  mount: "secret",
  timeoutMs: 5000,
}).then((resolve) => resolve(secret("app/db#password")));
// @ts-expect-error unsupported exporter cannot silently activate telemetry
const bad: ServiceProfile = { telemetry: { exporter: "automatic" } };
const badVault: ServiceProfile = {
  secrets: {
    // @ts-expect-error provider is explicit and restricted to implemented Vault KV v2
    provider: "automatic",
    address: env("VAULT_ADDR"),
    token: env("VAULT_TOKEN"),
    mount: "secret",
    timeoutMs: 5000,
  },
};
void bad;
void badVault;
