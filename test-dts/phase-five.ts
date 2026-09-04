import {
  type ProviderSelection,
  type ServiceProfile,
  compileServiceConfiguration,
  env,
  node,
  postgres,
  service,
  serviceConfiguration,
} from "../src/index.js";
const configuration = serviceConfiguration({
  application: "typed",
  project: { schema: "vane.semantic-project-ir", version: 2, modules: [] },
  providers: [],
  profiles: { test: { environment: "test" } },
});
compileServiceConfiguration(configuration, "test");
// @ts-expect-error Profile must be a declared root key.
compileServiceConfiguration(configuration, "missing");
const runtime: ProviderSelection<"runtime"> = node();
void runtime;
// @ts-expect-error A storage provider cannot select the runtime.
const wrong: ProviderSelection<"runtime"> = postgres();
void wrong;
service({
  name: "api",
  modules: ["Sales"],
  runtime: node(),
  persistence: {
    provider: postgres(),
    namespace: "sales",
    targetVersion: 16,
    connection: env("DATABASE_URL"),
  },
});
const profile: ServiceProfile = {
  policies: {
    defaults: {
      // @ts-expect-error Durable idempotency cannot be disabled.
      idempotency: "none",
    },
  },
};
void profile;
