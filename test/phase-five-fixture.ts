import {
  http,
  BUILTIN_PROVIDERS,
  type ServiceProfile,
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
} from "../src/index.js";
import { phaseFourModule } from "./phase-four-fixture.js";

export function phaseFiveConfiguration(overrides: ServiceProfile = {}) {
  return serviceConfiguration({
    application: "orders",
    project: {
      schema: "vane.semantic-project-ir",
      version: 2,
      modules: [phaseFourModule()],
    },
    providers: BUILTIN_PROVIDERS,
    profiles: {
      development: {
        environment: "development",
        topology: monolith({
          name: "api",
          modules: ["Sales"],
          runtime: node(),
          persistence: {
            provider: postgres(),
            namespace: "vane_five",
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
        contracts: {
          Sales: {
            basePath: "/sales",
            events: [
              {
                event: "Order.Place",
                saga: "PlaceOrder",
                terminal: {
                  view: "Receipt",
                  input: { id: { kind: "eventInput", input: "id" } },
                },
              },
            ],
            views: [{ view: "Receipt" }],
          },
        },
        acls: {
          "Sales.Gateway.Authorize": {
            provider: httpAcl(),
            version: "1",
            endpoint: env("GATEWAY_URL"),
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
        ...overrides,
      },
      test: { extends: "development", environment: "test" },
      production: { extends: "development", environment: "production" },
    },
  });
}
