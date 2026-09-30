import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpenApi } from "./openapi.js";
import { createPostgreSqlMigrationPlan } from "./postgresql/migrations.js";
import { renderPostgreSqlSchema } from "./postgresql/renderer.js";
import {
  type ServicePlan,
  compileServiceConfiguration,
  serializeServicePlan,
  technicalHash,
  technicalJson,
} from "./service-compiler.js";
import type {
  ServiceConfiguration,
  ServiceProfile,
} from "./service-configuration.js";

/** Produces files only. Does not build images, apply migrations or contact a cloud. */
export function generateServiceArtifacts(
  plan: ServicePlan,
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    "plan.json": serializeServicePlan(plan),
    "runtime-ir.json": technicalJson(plan.runtime),
    "storage-ir.json": technicalJson(plan.storage),
    "contract-ir.json": technicalJson(plan.contracts),
    "infrastructure-ir.json": technicalJson(plan.infrastructure),
    "schema.sql": renderPostgreSqlSchema(plan.storage),
    "initial-migration.json": technicalJson(
      createPostgreSqlMigrationPlan({ previous: null, next: plan.storage }),
    ),
    "deploy-plan.json": technicalJson({
      schema: "vane.deploy-plan",
      version: 1,
      profile: plan.profile,
      inputHash: plan.inputHash,
      apply: "manual",
      steps: plan.infrastructure.steps,
      migration:
        "For an existing database, diff against its actual storage snapshot; initial-migration.json is for an empty database only.",
      image: plan.infrastructure.services[0]?.image,
      secrets: plan.runtime.bindings.map((binding, index) => ({
        ...binding,
        containerEnvironment: `VANE_BINDING_${index}`,
      })),
    }),
    Dockerfile:
      'FROM node:24-alpine\nWORKDIR /app\nCOPY package.json vane.tgz ./\nRUN npm install --omit=dev --ignore-scripts\nCOPY bootstrap.mjs configuration.mjs deploy-plan.json artifacts.json *.provenance.json ./\nUSER node\nEXPOSE 3000\nCMD ["node", "bootstrap.mjs"]\n',
    "package.json": JSON.stringify(
      {
        name: `${plan.application}-deployment`,
        private: true,
        type: "module",
        dependencies: { "@lilka/vane": "file:./vane.tgz", pg: "8.23.0" },
      },
      null,
      2,
    ),
    "bootstrap.mjs": `import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createServiceRuntime } from '@lilka/vane';
import configuration from './configuration.mjs';
import deployment from './deploy-plan.json' with { type: 'json' };
const resolveBinding = (_reference, slot) => {
  const binding = deployment.secrets.find(binding => binding.slot === slot);
  const value = binding ? process.env[binding.containerEnvironment] : undefined;
  if (!value) throw new Error('A required deployment binding is unavailable.');
  return value;
};
let pool;
const database = { connect: async () => {
  pool ??= new Pool({ connectionString: resolveBinding(undefined, 'persistence.connection') });
  return pool.connect();
} };
let runtime;
try {
  runtime = await createServiceRuntime(configuration, deployment.profile, { pool: database, expectedInputHash: deployment.inputHash, resolveSecret: resolveBinding });
  await runtime.start();
} catch { await pool?.end(); console.error('Service startup failed; check schema and secret bindings.'); process.exit(1); }
const server = createServer((request, response) => { void runtime.handler(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); }); });
let closing;
const stop = () => closing ??= (async () => {
  server.close();
  server.closeAllConnections();
  await runtime.stop();
  await pool?.end();
})();
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
void runtime.runWorkers().catch(() => { console.error('Service worker stopped.'); process.exitCode = 1; void stop(); });
server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => console.log(JSON.stringify({state:'running',address:server.address(),inputHash:deployment.inputHash})));
`,
    "README.md": `# ${plan.application} deployment artifacts\n\nInput hash: ${plan.inputHash}\n\nNo infrastructure has been applied. Build the Vane library and pack it with npm pack; copy the tarball here as vane.tgz. Then build the Dockerfile with the image tag in deploy-plan.json. Supply each VANE_BINDING_n from the binding inventory at deployment time (never bake values into the image). Review and apply migrations explicitly before starting. For an existing database use the previous storage snapshot instead of the initial migration.\n\nDurable retry/backoff, Entity database timeouts, failure operations and internal telemetry are implemented. See the operations guide for recovery, retention and explicit secret resolution.\n`,
  };
  for (const contract of plan.contracts)
    files[`openapi-${encodeURIComponent(contract.module)}.json`] =
      technicalJson(generateOpenApi(contract));
  return attachArtifactProvenance(plan, files);
}

/** Attaches the provider-free semantic input to the generated executable configuration. */
export function generateServiceDeployment(
  plan: ServicePlan,
  project: import("./semantic-ir.js").SemanticProjectIr,
): Readonly<Record<string, string>> {
  const normalizedProject = {
    ...project,
    modules: [...project.modules].sort((a, b) => a.name.localeCompare(b.name)),
  };
  if (technicalHash(normalizedProject) !== plan.runtime.semanticProjectHash)
    throw new Error("Semantic project differs from the compiled plan.");
  const effective = JSON.parse(technicalJson(plan.effective)) as Record<
    string,
    unknown
  >;
  const replace = (slot: string, replacement: unknown) => {
    if (slot === "persistence.connection") {
      const t = effective.topology as {
        service: { persistence: { connection: unknown } };
      };
      t.service.persistence.connection = replacement;
      return;
    }
    if (slot === "http.authentication.bearer") {
      const h = effective.http as {
        security: { authentication: { bearer: unknown } };
      };
      h.security.authentication.bearer = replacement;
      return;
    }
    const acls = effective.acls as Record<string, Record<string, unknown>>;
    const key = Object.keys(acls).find(
      (k) =>
        slot === `acls.${k}.endpoint` || slot.startsWith(`acls.${k}.headers.`),
    );
    if (!key) throw new Error("Unknown binding slot.");
    const acl = acls[key] as Record<string, unknown>;
    if (slot === `acls.${key}.endpoint`) acl.endpoint = replacement;
    else
      (acl.headers as Record<string, unknown>)[
        slot.slice(`acls.${key}.headers.`.length)
      ] = replacement;
  };
  // Secret values are external. Keep their source kind/name in the hashed input.
  // A syntactically valid sentinel lets local URL slots validate without their value.
  for (const binding of plan.runtime.bindings) {
    if (binding.source === "literal" && binding.slot.endsWith(".endpoint"))
      replace(binding.slot, {
        kind: "literal",
        value: "https://redacted.invalid",
      });
  }
  const configuration: ServiceConfiguration = {
    schema: "vane.service-configuration",
    version: 1,
    application: plan.application,
    project: normalizedProject,
    providers: plan.runtime.providers,
    profiles: { [plan.profile]: effective as unknown as ServiceProfile },
  };
  const validation = compileServiceConfiguration(configuration, plan.profile);
  if (!validation.success || validation.plan.inputHash !== plan.inputHash)
    throw new Error("Generated configuration differs from the compiled plan.");
  const files = {
    ...generateServiceArtifacts(plan),
    "configuration.mjs": `export default ${technicalJson(configuration)};\n`,
  };
  return attachArtifactProvenance(plan, files);
}

/** Metadata accompanies standalone formats without changing their public schemas. */
function attachArtifactProvenance(
  plan: ServicePlan,
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("Generator package metadata is unavailable.");
    directory = parent;
  }
  const packageMetadata = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  ) as { name: string; version: string };
  if (packageMetadata.name !== "@lilka/vane")
    throw new Error("Generator package metadata is invalid.");
  const provenance = {
    schema: "vane.artifact-provenance",
    version: 1,
    inputHash: plan.inputHash,
    generator: {
      package: packageMetadata.name,
      version: packageMetadata.version,
    },
    versions: {
      servicePlan: plan.version,
      runtimeIr: plan.runtime.version,
      storageIr: plan.storage.version,
      contractIr: [
        ...new Set(plan.contracts.map((contract) => contract.version)),
      ],
      infrastructureIr: plan.infrastructure.version,
    },
  };
  const files: Record<string, string> = {};
  const companions: Record<string, string> = {};
  for (const [name, original] of Object.entries(input).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (name === "artifacts.json" || name.endsWith(".provenance.json"))
      continue;
    const sidecar = `${name}.provenance.json`;
    // Executable source/SQL comments remain harmless; JSON payloads stay untouched.
    const prefix =
      name === "bootstrap.mjs"
        ? "//"
        : name.endsWith(".sql")
          ? "--"
          : name === "Dockerfile"
            ? "#"
            : null;
    const header = prefix
      ? `${prefix} vane-provenance: ${JSON.stringify({ version: 1, inputHash: plan.inputHash, sidecar })}\n`
      : "";
    let content =
      header && !original.startsWith(`${prefix} vane-provenance:`)
        ? header + original
        : original;
    if (name === "Dockerfile" && !content.includes("org.vane.input-hash="))
      content += `LABEL org.vane.input-hash=${JSON.stringify(plan.inputHash)} org.vane.generator-version=${JSON.stringify(packageMetadata.version)}\n`;
    files[name] = content;
    companions[name] = sidecar;
    files[sidecar] = technicalJson({
      ...provenance,
      artifact: name,
      contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
      hashAlgorithm: "sha256-utf8",
    });
  }
  files["artifacts.json"] = technicalJson({
    ...provenance,
    schema: "vane.artifact-manifest",
    version: 2,
    hashAlgorithm: "sha256-utf8",
    companions,
    files: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        createHash("sha256").update(content, "utf8").digest("hex"),
      ]),
    ),
    selfHash:
      "excluded: manifest records its own provenance but cannot hash itself",
  });
  return files;
}
