import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import {
  acceptedRun,
  trustedWorkflows,
  validateCandidate,
  validateRegistry,
} from "./publish-policy.mjs";
const repository = "Caleul/vane";
const registry = "https://registry.npmjs.org";
const args = process.argv.slice(2);
let directory;
let output;
let gateOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--artifact-dir" && args[i + 1])
    directory = resolve(args[++i]);
  else if (args[i] === "--output" && args[i + 1]) output = resolve(args[++i]);
  else if (args[i] === "--verify-gates") gateOnly = true;
  else throw new Error("Unknown publication argument");
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} operation failed (exit ${result.status}); credentials/output withheld`,
    );
  return result.stdout.trim();
}
const sha = process.env.GITHUB_SHA;
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REPOSITORY !== repository ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  !/^[a-f0-9]{40}$/.test(sha ?? "")
)
  throw new Error(
    "Publication is restricted to the main-branch GitHub workflow",
  );
async function api(path) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${path}`,
    {
      headers: {
        authorization: `Bearer ${process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN}`,
        "x-github-api-version": "2022-11-28",
        accept: "application/vnd.github+json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new Error(`GitHub gate request failed: ${response.status}`);
  return response.json();
}
if ((await api("commits/main")).sha !== sha)
  throw new Error("Candidate no longer matches main HEAD");
const gates = [];
for (const workflow of trustedWorkflows) {
  const result = await api(
    `actions/workflows/${workflow}/runs?branch=main&event=push&head_sha=${sha}&per_page=100`,
  );
  const latest = result.workflow_runs
    ?.filter((r) => r.head_sha === sha)
    .sort((a, b) => b.id - a.id)[0];
  if (!acceptedRun(latest ?? {}, sha, workflow))
    throw new Error(
      `Required workflow is not green for candidate: ${workflow}`,
    );
  gates.push({
    workflow,
    id: latest.id,
    url: latest.html_url,
    attempt: latest.run_attempt,
  });
}
const readiness = gates.find((g) => g.workflow === "release-readiness.yml");
if (gateOnly) {
  if (!process.env.GITHUB_OUTPUT)
    throw new Error("Missing workflow output path");
  await writeFile(
    process.env.GITHUB_OUTPUT,
    `readiness_run=${readiness.id}\n`,
    { flag: "a" },
  );
  console.log(JSON.stringify({ sha, gates }));
  process.exit(0);
}
if (!directory || !output)
  throw new Error("Canonical artifact directory and receipt output required");
const manifest = JSON.parse(
  await readFile(resolve(directory, "package.json"), "utf8"),
);
if (basename(manifest.filename ?? "") !== manifest.filename)
  throw new Error("Unsafe artifact filename");
const tarball = resolve(directory, manifest.filename);
const bytes = await readFile(tarball);
const candidate = validateCandidate(manifest, bytes, sha);
const artifactList = await api(
  `actions/runs/${readiness.id}/artifacts?per_page=100`,
);
const matches = artifactList.artifacts.filter(
  (a) => a.name === `release-candidate-${sha}` && !a.expired,
);
if (matches.length !== 1)
  throw new Error("Exactly one retained readiness artifact required");
const artifact = matches[0];
if (artifact.workflow_run?.head_sha && artifact.workflow_run.head_sha !== sha)
  throw new Error("Readiness artifact head mismatch");
// Download action fetched this exact run artifact. Hash verification above binds its payload to canonical pack identity.
let actor = null;
let authentication;
if (process.env.NODE_AUTH_TOKEN) {
  actor = run("npm", ["whoami", "--registry", registry]);
  authentication = "npm-token";
} else {
  if (
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    throw new Error(
      "Neither authenticated npm token nor trusted-publisher OIDC available",
    );
  authentication = "github-oidc-trusted-publisher";
}
const npmVersion = run("npm", ["--version"]);
if (
  Number(npmVersion.split(".")[0]) < 11 ||
  (Number(npmVersion.split(".")[0]) === 11 &&
    Number(npmVersion.split(".")[1]) < 9)
)
  throw new Error("npm >=11.9 required for trusted publication");
run("npm", [
  "publish",
  tarball,
  "--tag",
  "next",
  "--access",
  "public",
  "--provenance",
  "--registry",
  registry,
]);
let dist;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    dist = JSON.parse(
      run("npm", [
        "view",
        `${manifest.name}@${candidate.version}`,
        "dist",
        "--json",
        "--registry",
        registry,
      ]),
    );
    validateRegistry(dist, candidate);
    break;
  } catch {
    if (attempt === 19)
      throw new Error(
        "Published registry artifact could not be verified; tag/release withheld",
      );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
const install = await mkdtemp(resolve(tmpdir(), "vane-registry-verification-"));
try {
  await writeFile(
    resolve(install, "package.json"),
    JSON.stringify({
      name: "vane-registry-verification",
      private: true,
      version: "1.0.0",
    }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--save-exact",
      `${manifest.name}@${candidate.version}`,
      "--registry",
      registry,
    ],
    install,
  );
  const lock = JSON.parse(
    await readFile(resolve(install, "package-lock.json"), "utf8"),
  );
  if (
    lock.packages["node_modules/@lilka/vane"]?.integrity !== candidate.integrity
  )
    throw new Error("Registry install integrity mismatch");
  for (const file of candidate.files) {
    const installed = await readFile(
      resolve(install, "node_modules/@lilka/vane", file.path),
    );
    if (
      createHash("sha256").update(installed).digest("hex") !==
      createHash("sha256").update(file.bytes).digest("hex")
    )
      throw new Error(`Registry installed file mismatch: ${file.path}`);
  }
} finally {
  await rm(install, { recursive: true, force: true });
}
const receipt = {
  schema: "vane.rc-publication-receipt",
  version: 1,
  status: "VERIFIED",
  repository,
  sha,
  package: manifest.name,
  packageVersion: candidate.version,
  sha256: candidate.sha256,
  integrity: candidate.integrity,
  registry,
  registryDist: dist,
  registryInstallVerified: true,
  authentication,
  actor,
  npm: npmVersion,
  gates,
  artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest },
  verifiedAt: new Date().toISOString(),
};
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT)
  await writeFile(process.env.GITHUB_OUTPUT, `version=${candidate.version}\n`, {
    flag: "a",
  });
console.log(
  JSON.stringify({
    status: "VERIFIED",
    version: candidate.version,
    sha256: candidate.sha256,
    receipt: output,
  }),
);
