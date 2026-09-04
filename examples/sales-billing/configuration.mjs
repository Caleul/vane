import { readFileSync } from "node:fs";
import {
  http,
  BUILTIN_PROVIDERS,
  compileProjectSources,
  env,
  httpAcl,
  monolith,
  node,
  postgres,
  postgresDeduplication,
  postgresFailureQueue,
  postgresMailbox,
  postgresOutbox,
  postgresSaga,
  serviceConfiguration,
  sse,
} from "../../dist/index.js";
const sources = ["billing.vane.ts", "sales.vane.ts"].map((fileName) => ({
  fileName,
  sourceText: readFileSync(new URL(fileName, import.meta.url), "utf8"),
}));
const compiled = compileProjectSources(sources);
if (!compiled.success) throw new Error(JSON.stringify(compiled.diagnostics));
export default serviceConfiguration({
  application: "sales-billing",
  project: compiled.ir,
  providers: BUILTIN_PROVIDERS,
  profiles: {
    development: {
      environment: "development",
      topology: monolith({
        name: "api",
        modules: ["Sales", "Billing"],
        runtime: node(),
        persistence: {
          provider: postgres(),
          namespace: "sales_billing",
          targetVersion: 16,
          connection: env("DATABASE_URL"),
        },
      }),
      communication: {
        mailbox: postgresMailbox(),
        outbox: postgresOutbox(),
        deduplication: postgresDeduplication(),
        saga: postgresSaga(),
        failureQueue: postgresFailureQueue(),
      },
      http: {
        provider: http(),
        sagaStream: sse(),
        security: {
          authentication: "none",
          authorization: "allow",
          cors: [],
          rateLimit: null,
        },
      },
      telemetry: { exporter: "json", redact: ["email"] },
      policies: {
        defaults: {
          timeoutMs: 1000,
          retry: {
            attempts: 3,
            backoff: "exponential",
            delayMs: 100,
            maxDelayMs: 1000,
          },
        },
      },
      acls: {
        "Billing.PaymentGateway.Authorize": {
          provider: httpAcl(),
          version: "1",
          endpoint: env("PAYMENT_GATEWAY_URL"),
          idempotencyHeader: "Idempotency-Key",
          responses: [
            {
              status: 200,
              result: "approved",
              fields: { reference: "reference" },
            },
            { status: 402, result: "declined", fields: {} },
          ],
        },
      },
      contracts: {
        Sales: {
          basePath: "/sales",
          events: [
            {
              event: "Order.Place",
              saga: "PlaceOrder",
              terminal: {
                view: "OrderDetails",
                input: { id: { kind: "eventInput", input: "id" } },
              },
            },
          ],
          views: [{ view: "OrderDetails" }],
        },
        Billing: { basePath: "/billing", views: [{ view: "PaymentReceipt" }] },
      },
    },
    test: {
      extends: "development",
      environment: "test",
      telemetry: { exporter: "none" },
    },
    production: {
      extends: "development",
      environment: "production",
      http: {
        provider: http(),
        sagaStream: sse(),
        security: {
          authentication: { bearer: env("API_TOKEN") },
          authorization: "allow",
          cors: [],
          rateLimit: { requests: 100, windowMs: 1000 },
        },
      },
    },
  },
});
