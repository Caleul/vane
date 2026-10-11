import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  allowedPackagePath,
  auditProblems,
  inspectTarball,
  secretMarkers,
} from "./audit-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
let output = resolve(root, "release-evidence/supply-chain.json");
let tarball;
const consumers = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output" && args[i + 1]) output = resolve(args[++i]);
  else if (args[i] === "--tarball" && args[i + 1]) tarball = resolve(args[++i]);
  else if (args[i] === "--consumer" && args[i + 1])
    consumers.push(resolve(args[++i]));
  else throw new Error(`Unknown or incomplete audit argument: ${args[i]}`);
}
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
function command(executable, params, cwd = root) {
  const result = spawnSync(executable, params, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    command: [executable, ...params],
    exitCode: result.status,
    stdout: result.stdout ?? "",
    error: result.error?.message,
  };
}
const startedAt = new Date().toISOString();
const findings = [];
function fail(kind, detail) {
  findings.push({ kind, severity: "blocking", detail });
}
async function dependencies(directory, scope) {
  const lockBytes = await readFile(resolve(directory, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  const inventory = Object.entries(lock.packages).map(([path, entry]) => ({
    path: path || ".",
    version: entry.version,
    license: entry.license,
    dev: !!entry.dev,
    optional: !!entry.optional,
    integrity: entry.integrity,
    resolved: entry.resolved,
  }));
  for (const item of inventory.filter((item) => item.path !== ".")) {
    if (!item.integrity)
      fail("dependency-integrity", `${scope}: ${item.path} has no integrity`);
    if (
      !item.license ||
      ![
        "MIT",
        "ISC",
        "Apache-2.0",
        "MIT OR Apache-2.0",
        "(MIT OR Apache-2.0)",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "0BSD",
      ].includes(item.license)
    )
      fail(
        "license-review",
        `${scope}: ${item.path}: ${item.license ?? "missing"}`,
      );
  }
  const audits = [];
  for (const mode of ["runtime", "full"]) {
    const result = command(
      "npm",
      ["audit", ...(mode === "runtime" ? ["--omit=dev"] : []), "--json"],
      directory,
    );
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      fail("audit-unavailable", `${scope}/${mode}: no valid JSON report`);
    }
    for (const problem of auditProblems({ ...result, report }))
      fail(problem, `${scope}/${mode}: advisory verification failed`);
    audits.push({
      mode,
      command: result.command,
      exitCode: result.exitCode,
      report,
    });
  }
  return { scope, directory, lockSha256: sha256(lockBytes), inventory, audits };
}
const audits = [await dependencies(root, "framework")];
for (const [i, consumer] of consumers.entries())
  audits.push(await dependencies(consumer, `consumer-${i + 1}`));
let archive;
let archiveMetadata;
let tarballSha256;
let members;
if (tarball) {
  try {
    const bytes = await readFile(tarball);
    tarballSha256 = sha256(bytes);
    members = inspectTarball(bytes);
    const metadata = JSON.parse(
      members
        .find((file) => file.path === "package.json")
        ?.bytes.toString("utf8"),
    );
    archiveMetadata = metadata;
    archive = {
      name: metadata.name,
      version: metadata.version,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      entryCount: members.length,
    };
  } catch {
    fail("package-manifest", "Release archive missing, invalid or unsafe");
  }
} else {
  const pack = command("npm", ["pack", "--dry-run", "--json"]);
  try {
    archive = JSON.parse(pack.stdout)[0];
  } catch {
    fail("package-manifest", "npm pack returned invalid JSON");
  }
  if (pack.exitCode !== 0 || !archive?.files?.length)
    fail("package-manifest", "npm pack failed or empty archive");
  members = [];
  for (const file of archive?.files ?? []) {
    if (!allowedPackagePath(file.path)) {
      fail("unexpected-package-file", file.path);
      continue;
    }
    members.push({
      path: file.path,
      bytes: await readFile(resolve(root, file.path)),
    });
  }
}
const files = [];
for (const file of members ?? []) {
  if (!allowedPackagePath(file.path)) {
    fail("unexpected-package-file", file.path);
    continue;
  }
  for (const marker of secretMarkers(file.bytes))
    fail("package-secret-marker", `${file.path}: ${marker}`);
  files.push({
    path: file.path,
    size: file.bytes.length,
    sha256: sha256(file.bytes),
  });
}
const git = command("git", ["rev-parse", "HEAD"]);
const status = command("git", ["status", "--porcelain"]);
const npm = command("npm", ["--version"]);
if (tarball) {
  if (git.exitCode !== 0 || status.exitCode !== 0 || status.stdout.trim())
    fail(
      "source-provenance",
      "Release archive audit requires a clean identified source checkout",
    );
  const expectedMetadata = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  if (archiveMetadata) {
    const actualMetadata = archiveMetadata;
    if (
      actualMetadata.name !== expectedMetadata.name ||
      actualMetadata.version !== expectedMetadata.version ||
      JSON.stringify(actualMetadata.dependencies) !==
        JSON.stringify(expectedMetadata.dependencies)
    )
      fail(
        "package-identity",
        "Archive package name/version/dependencies differ from identified source",
      );
  }
}

const evidence = {
  schema: "vane.release.supply-chain",
  version: 2,
  startedAt,
  finishedAt: new Date().toISOString(),
  sourceCommit: git.stdout.trim(),
  sourceDirty: !!status.stdout.trim(),
  verificationMode: tarball ? "release-archive" : "preliminary-dry-run",
  node: process.version,
  npm: npm.stdout.trim(),
  status: findings.length ? "BLOCKED" : "PASS",
  exitCode: findings.length ? 1 : 0,
  findings,
  audits,
  package: {
    tarball: tarball ?? null,
    sha256: tarballSha256 ?? null,
    name: archive?.name,
    version: archive?.version,
    integrity: archive?.integrity,
    entryCount: archive?.entryCount,
    files,
  },
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(
  JSON.stringify({
    status: evidence.status,
    findings,
    output,
    packages: files.length,
    scopes: audits.map((item) => ({
      scope: item.scope,
      advisories: item.audits.map((audit) => ({
        mode: audit.mode,
        vulnerabilities: audit.report?.metadata?.vulnerabilities,
      })),
    })),
  }),
);
process.exitCode = evidence.exitCode;
