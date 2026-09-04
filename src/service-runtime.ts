import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AclEventRuntime, httpAclAdapter } from "./acl-runtime.js";
import { PublicHttpRuntime, createNodeHttpHandler } from "./http-runtime.js";
import { PostgreSqlModuleRuntime } from "./postgresql/module-runtime.js";
import { PostgreSqlPublicSagaAdmission } from "./postgresql/public-saga-admission.js";
import type { PostgreSqlPoolLike } from "./postgresql/runtime.js";
import {
  PostgreSqlSagaRuntime,
  PostgreSqlSagaStore,
} from "./postgresql/saga-runtime.js";
import { PostgreSqlViewRuntime } from "./postgresql/view-runtime.js";
import {
  compileServiceConfiguration,
  resolveServiceProfile,
} from "./service-compiler.js";
import type {
  SecretValue,
  ServiceConfiguration,
} from "./service-configuration.js";

export interface ServiceRuntimeBindings {
  /** Caller owns and closes this pool. Schema migrations are never implicit. */
  readonly pool: PostgreSqlPoolLike;
  /** Deployment identity to verify before resolving secrets or accessing the database. */
  readonly expectedInputHash?: string;
  readonly resolveSecret?: (
    value: SecretValue,
    slot: string,
  ) => string | Promise<string>;
  readonly fetch?: typeof fetch;
}
export class ServiceRuntimeError extends Error {
  readonly code = "VANE_SERVICE_RUNTIME";
}
export async function resolveConfiguredSecret(
  value: SecretValue,
): Promise<string> {
  if (value.kind === "literal") return value.value;
  if (value.kind === "env") {
    const result = process.env[value.name];
    if (result) return result;
  }
  throw new ServiceRuntimeError(
    "Secret binding is unavailable. Supply a resolver for symbolic secret references.",
  );
}
/** Compiles again at the runtime boundary; cannot start an unvalidated or stale plan. */
export async function createServiceRuntime<P extends string>(
  configuration: ServiceConfiguration<P>,
  profileName: NoInfer<P>,
  bindings: ServiceRuntimeBindings,
) {
  const snapshot = structuredClone(configuration);
  const compiled = compileServiceConfiguration(snapshot, profileName);
  if (!compiled.success)
    throw new ServiceRuntimeError(
      compiled.diagnostics.map((d) => d.code).join(", "),
    );
  const plan = compiled.plan;
  if (
    bindings.expectedInputHash !== undefined &&
    bindings.expectedInputHash !== plan.inputHash
  )
    throw new ServiceRuntimeError(
      "Configuration differs from the expected deployment plan.",
    );
  const profile = resolveServiceProfile(snapshot, profileName);
  // Phase 5 resolves these policies, but cannot silently claim durable retry execution.
  if (
    plan.runtime.policies.some(
      (p) =>
        p.effective.retry.attempts !== 1 ||
        (p.effective.timeoutMs !== 10000 &&
          !Object.hasOwn(profile.acls ?? {}, p.event)),
    )
  )
    throw new ServiceRuntimeError(
      "The selected plan requires phase-six durable retry or Entity timeout execution.",
    );
  const resolve = bindings.resolveSecret ?? resolveConfiguredSecret;
  async function value(reference: SecretValue, slot: string): Promise<string> {
    try {
      const result = await resolve(reference, slot);
      if (typeof result !== "string" || !result) throw new Error();
      return result;
    } catch {
      throw new ServiceRuntimeError(
        "A required secret binding could not be resolved.",
      );
    }
  }
  const security = profile.http?.security;
  if (!security) throw new ServiceRuntimeError("HTTP security is unavailable.");
  const bearer =
    security.authentication === "none"
      ? null
      : await value(
          security.authentication.bearer,
          "http.authentication.bearer",
        );
  const modules = await Promise.all(
    [...snapshot.project.modules]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (module) => {
        const events = new PostgreSqlModuleRuntime({
          module,
          pool: bindings.pool,
          storage: plan.storage,
        });
        const views = new PostgreSqlViewRuntime(
          module,
          bindings.pool,
          plan.storage,
        );
        const aclRuntimes = new Map<string, AclEventRuntime>();
        for (const event of module.antiCorruptionLayers.flatMap(
          (a) => a.events,
        )) {
          const qualified = `${module.name}.${event.identity}`;
          const mapping = profile.acls?.[qualified];
          if (!mapping)
            throw new ServiceRuntimeError("ACL mapping is unavailable.");
          const endpoint = await value(
            mapping.endpoint,
            `acls.${qualified}.endpoint`,
          );
          const headers = Object.fromEntries(
            await Promise.all(
              Object.entries(mapping.headers ?? {}).map(async ([name, ref]) => [
                name,
                await value(ref, `acls.${qualified}.headers.${name}`),
              ]),
            ),
          );
          let adapter: ReturnType<typeof httpAclAdapter>;
          try {
            adapter = httpAclAdapter({
              ...mapping,
              eventIdentity: event.identity,
              url: endpoint,
              headers: () => headers,
              ...(bindings.fetch ? { fetch: bindings.fetch } : {}),
            });
          } catch {
            throw new ServiceRuntimeError(
              "Resolved ACL endpoint or mapping is invalid.",
            );
          }
          aclRuntimes.set(
            event.identity,
            new AclEventRuntime(
              [event],
              [adapter],
              plan.runtime.policies.find((p) => p.event === qualified)
                ?.effective.timeoutMs,
            ),
          );
        }
        const acls = {
          bindings: [...aclRuntimes.values()].flatMap((a) => a.bindings),
          dispatch: (envelope: Parameters<AclEventRuntime["dispatch"]>[0]) => {
            const runtime = aclRuntimes.get(envelope.eventIdentity);
            if (!runtime) throw new ServiceRuntimeError("Unknown ACL Event.");
            return runtime.dispatch(envelope);
          },
        };
        const store = new PostgreSqlSagaStore(bindings.pool, plan.storage);
        const plans = plan.runtime.sagas.filter(
          (p) => p.module === module.name,
        );
        const sagas = new PostgreSqlSagaRuntime({
          plans,
          store,
          events,
          views,
          acls,
        });
        const contract = plan.contracts.find((c) => c.module === module.name);
        if (!contract)
          throw new ServiceRuntimeError("Contract is unavailable.");
        const publicPlans = Object.fromEntries(
          contract.operations.flatMap((op) =>
            op.kind === "event" && op.saga
              ? [
                  [
                    op.identity,
                    plans.find(
                      (p) => p.saga === op.saga,
                    ) as (typeof plans)[number],
                  ],
                ]
              : [],
          ),
        );
        const http = new PublicHttpRuntime({
          contract,
          events,
          views,
          terminals: store,
          admission: new PostgreSqlPublicSagaAdmission(sagas, publicPlans),
        });
        return {
          name: module.name,
          events,
          views,
          acls,
          store,
          sagas,
          http,
          contract,
          handler: createNodeHttpHandler(http),
        };
      }),
  );
  let state: "stopped" | "starting" | "running" | "stopping" = "stopped";
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let workerPromise: Promise<void> | undefined;
  async function start(): Promise<void> {
    if (state === "running") return;
    if (state === "starting") return startPromise;
    if (state === "stopping")
      throw new ServiceRuntimeError("Service is stopping.");
    state = "starting";
    startPromise = (async () => {
      try {
        for (const module of modules) await module.events.start();
        if (state === "starting") state = "running";
      } catch {
        await Promise.allSettled(modules.map((m) => m.events.stop()));
        state = "stopped";
        throw new ServiceRuntimeError(
          "Service startup failed schema or database validation.",
        );
      }
    })();
    return startPromise;
  }
  function runWorkers(): Promise<void> {
    if (state !== "running")
      return Promise.reject(
        new ServiceRuntimeError("Start the service before its workers."),
      );
    if (!workerPromise)
      workerPromise = Promise.all(modules.map((m) => m.sagas.start()))
        .then(() => undefined)
        .finally(() => {
          workerPromise = undefined;
        });
    return workerPromise;
  }
  async function stop(): Promise<void> {
    if (state === "stopping") return stopPromise;
    if (state === "stopped") return;
    state = "stopping";
    stopPromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      await Promise.allSettled(modules.map((m) => m.sagas.stop()));
      await Promise.allSettled(modules.map((m) => m.events.stop()));
      state = "stopped";
    })();
    return stopPromise;
  }
  // One fixed-window budget for the explicit monolithic service; no implicit IP trust.
  let windowStart = Date.now();
  let requests = 0;
  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const reject = (status: number) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          code: `VANE_HTTP_${status}`,
          message: "Request rejected.",
          correlationId: randomUUID(),
        }),
      );
    };
    if (state !== "running") return reject(503);
    const origin = request.headers.origin;
    if (origin) {
      if (!security.cors.includes("*") && !security.cors.includes(origin))
        return reject(403);
      response.setHeader(
        "access-control-allow-origin",
        security.cors.includes("*") ? "*" : origin,
      );
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS" && origin) {
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        "Authorization, Content-Type",
      );
      response.writeHead(204);
      response.end();
      return;
    }
    if (security.authorization === "deny") return reject(403);
    if (bearer !== null) {
      const actual = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${bearer}`);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return reject(401);
    }
    if (security.rateLimit) {
      const now = Date.now();
      if (now - windowStart >= security.rateLimit.windowMs) {
        windowStart = now;
        requests = 0;
      }
      if (++requests > security.rateLimit.requests) return reject(429);
    }
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      return reject(400);
    }
    const target = modules.find((m) =>
      m.contract.operations.some(
        (op) =>
          op.path === path ||
          (op.kind === "event" && matchesStream(op.terminal.streamPath, path)),
      ),
    );
    if (!target) return reject(404);
    await target.handler(request, response);
  };
  return {
    plan,
    modules,
    start,
    stop,
    runWorkers,
    handler,
    get state() {
      return state;
    },
  };
}
function matchesStream(template: string, path: string): boolean {
  const parts = template.split("{sagaId}");
  return (
    parts.length === 2 &&
    path.startsWith(parts[0] as string) &&
    path.endsWith(parts[1] as string) &&
    !path
      .slice(
        (parts[0] as string).length,
        path.length - (parts[1] as string).length || undefined,
      )
      .includes("/")
  );
}
