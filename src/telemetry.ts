import { randomUUID } from "node:crypto";

export interface TelemetryConfiguration {
  readonly exporter: "none" | "json";
  /** Additional metadata keys to redact recursively. Payloads are never recorded. */
  readonly redact?: readonly string[];
}
export interface TelemetryRecord {
  readonly schema: "vane.telemetry";
  readonly timestamp: string;
  readonly operation: string;
  readonly spanId: string;
  readonly outcome: "success" | "fail";
  readonly durationMs: number;
  readonly attributes: Readonly<Record<string, unknown>>;
}
export type TelemetrySink = (record: TelemetryRecord) => void;

export class RuntimeTelemetry {
  readonly #metrics = new Map<string, { count: number; durationMs: number }>();
  exporterFailures = 0;
  constructor(
    readonly configuration: TelemetryConfiguration = { exporter: "none" },
    readonly sink: TelemetrySink = (r) =>
      process.stderr.write(`${JSON.stringify(r)}\n`),
  ) {}
  redact(value: unknown): unknown {
    const keys = new Set([
      "password",
      "token",
      "authorization",
      "secret",
      "credential",
      "payload",
      "input",
      "data",
      "result",
      ...(this.configuration.redact ?? []).map((s) => s.toLowerCase()),
    ]);
    const visit = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(visit);
      if (v && typeof v === "object")
        return Object.fromEntries(
          Object.entries(v).map(([k, val]) => [
            k,
            keys.has(k.toLowerCase()) ? "[REDACTED]" : visit(val),
          ]),
        );
      return v;
    };
    return visit(value);
  }
  record(
    operation: string,
    attributes: Readonly<Record<string, unknown>>,
    outcome: "success" | "fail" = "success",
    durationMs = 0,
  ): void {
    const key = `${operation}.${outcome}`;
    const metric = this.#metrics.get(key) ?? { count: 0, durationMs: 0 };
    metric.count++;
    metric.durationMs += durationMs;
    this.#metrics.set(key, metric);
    if (this.configuration.exporter === "none") return;
    try {
      this.sink({
        schema: "vane.telemetry",
        timestamp: new Date().toISOString(),
        operation,
        spanId: randomUUID(),
        outcome,
        durationMs,
        attributes: this.redact(attributes) as Record<string, unknown>,
      });
    } catch {
      this.exporterFailures++;
    }
  }
  async span<T>(
    operation: string,
    attributes: Readonly<Record<string, unknown>>,
    work: () => Promise<T>,
    failed: (value: T) => boolean = () => false,
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await work();
      this.record(
        operation,
        attributes,
        failed(result) ? "fail" : "success",
        performance.now() - start,
      );
      return result;
    } catch (error) {
      this.record(operation, attributes, "fail", performance.now() - start);
      throw error;
    }
  }
  metrics() {
    return Object.fromEntries(
      [...this.#metrics]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, { ...v }]),
    );
  }
}
