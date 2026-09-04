import type { ExecutionPolicy } from "./service-configuration.js";

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  timeoutMs: 10000,
  retry: { attempts: 1, backoff: "fixed", delayMs: 0, maxDelayMs: 0 },
  idempotency: "required",
  deduplication: "durable",
};

export function retryDelay(policy: ExecutionPolicy, attempt: number): number {
  return Math.min(
    policy.retry.maxDelayMs,
    policy.retry.delayMs *
      (policy.retry.backoff === "exponential"
        ? 2 ** Math.min(52, Math.max(0, attempt - 1))
        : 1),
  );
}

export function retryableFailure(code: string): boolean {
  return [
    "VANE_ACL_TIMEOUT",
    "VANE_ACL_UNAVAILABLE",
    "VANE_EVENT_TIMEOUT",
    "VANE_EVENT_UNAVAILABLE",
  ].includes(code);
}

export function transientPostgreSqlFailure(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "57014") return "VANE_EVENT_TIMEOUT";
  if (
    typeof code === "string" &&
    (code.startsWith("08") ||
      [
        "40001",
        "40P01",
        "55P03",
        "57P01",
        "57P02",
        "57P03",
        "ECONNRESET",
        "ECONNREFUSED",
        "EPIPE",
        "ETIMEDOUT",
      ].includes(code))
  )
    return "VANE_EVENT_UNAVAILABLE";
  return null;
}
