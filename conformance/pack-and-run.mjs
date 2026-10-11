#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackage } from "./package-sanity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}
const temporary = await mkdtemp(join(tmpdir(), "vane-conformance-"));
try {
  const cache =
    process.env.VANE_CONFORMANCE_NPM_CACHE ?? join(tmpdir(), "vane-npm-cache");
  const args = process.argv.slice(2);
  const artifactIndex = args.indexOf("--tarball");
  let suppliedTarball;
  if (artifactIndex !== -1) {
    if (!args[artifactIndex + 1] || args[artifactIndex + 1].startsWith("--"))
      throw new Error("--tarball requires a path");
    suppliedTarball = resolve(args[artifactIndex + 1]);
    args.splice(artifactIndex, 2);
    if (args.includes("--tarball"))
      throw new Error("--tarball may be supplied only once");
  }
  if (args.includes("--sanity") && args.length !== 1)
    throw new Error("--sanity cannot be combined with report filters");
  const packed = suppliedTarball
    ? null
    : JSON.parse(
        execute("npm", [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          temporary,
          "--cache",
          cache,
        ]),
      );
  // Snapshot supplied bytes once: installation and Docker evidence use the same artifact.
  const tarball = suppliedTarball
    ? join(temporary, "candidate.tgz")
    : join(temporary, packed[0].filename);
  if (suppliedTarball)
    await writeFile(tarball, await readFile(suppliedTarball));
  const hash = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({
      name: "entity-event-conformance-consumer",
      private: true,
      type: "module",
    }),
  );
  execute(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      cache,
      tarball,
    ],
    { cwd: temporary },
  );
  const packageRoot = join(temporary, "node_modules/@lilka/vane");
  const commit = execute("git", ["rev-parse", "HEAD"]).trim();
  const dirty = execute("git", ["status", "--porcelain"]).trim();
  if (args.includes("--sanity")) {
    await checkPackage(packageRoot);
  } else {
    const runner = join(root, "conformance/runner.mjs");
    const result = spawnSync(
      process.execPath,
      [
        runner,
        "--package-root",
        packageRoot,
        "--commit",
        `${commit}${dirty ? "-dirty" : ""}`,
        "--tarball-sha256",
        hash,
        "--tarball-path",
        tarball,
        ...args,
      ],
      { cwd: root, stdio: "inherit", timeout: 600000 },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 2;
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
