import type { SecretValue } from "./service-configuration.js";

export interface VaultConfiguration {
  readonly provider: "vault-kv-v2";
  readonly address: SecretValue;
  readonly token: SecretValue;
  readonly mount: string;
  readonly timeoutMs: number;
}
export class SecretResolutionError extends Error {
  constructor() {
    super("The required secret could not be resolved.");
  }
}
export async function resolveEnvironmentSecret(
  value: SecretValue,
): Promise<string> {
  const result =
    value.kind === "literal"
      ? value.value
      : value.kind === "env"
        ? process.env[value.name]
        : undefined;
  if (!result) throw new SecretResolutionError();
  return result;
}
/** Names use path#field. No caching: a fresh runtime resolves rotated values. */
export async function createVaultSecretResolver(
  configuration: VaultConfiguration,
  transport: typeof fetch = fetch,
) {
  try {
    const address = new URL(
      await resolveEnvironmentSecret(configuration.address),
    );
    const token = await resolveEnvironmentSecret(configuration.token);
    if (
      address.protocol !== "https:" ||
      address.username ||
      address.password ||
      address.search ||
      address.hash ||
      !/^[a-zA-Z0-9_-]+$/.test(configuration.mount) ||
      !Number.isSafeInteger(configuration.timeoutMs) ||
      configuration.timeoutMs < 1 ||
      configuration.timeoutMs > 2147483647
    )
      throw new SecretResolutionError();
    return async (value: SecretValue): Promise<string> => {
      if (value.kind !== "secret") return resolveEnvironmentSecret(value);
      try {
        const parts = value.name.split("#");
        const path = parts[0];
        const field = parts[1];
        if (
          parts.length !== 2 ||
          !path ||
          !field ||
          path.split("/").some((s) => !/^[a-zA-Z0-9_-]+$/.test(s))
        )
          throw new SecretResolutionError();
        const response = await transport(
          new URL(`/v1/${configuration.mount}/data/${path}`, address),
          {
            headers: { "X-Vault-Token": token },
            signal: AbortSignal.timeout(configuration.timeoutMs),
            redirect: "error",
          },
        );
        if (!response.ok) throw new SecretResolutionError();
        const content = (await response.json()) as {
          data?: { data?: Record<string, unknown> };
        };
        const result = content.data?.data?.[field];
        if (typeof result !== "string" || !result)
          throw new SecretResolutionError();
        return result;
      } catch {
        throw new SecretResolutionError();
      }
    };
  } catch {
    throw new SecretResolutionError();
  }
}
