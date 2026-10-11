import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argument = (name) =>
  process.argv.includes(name)
    ? process.argv[process.argv.indexOf(name) + 1]
    : undefined;
const output = resolve(argument("--out") ?? resolve(root, "artifacts/release"));
const manifestPath = argument("--manifest");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw Error(
      `${command} ${args.join(" ")} failed: ${result.stderr}\n${result.stdout}`,
    );
  return result.stdout.trim();
}
export function validateContents(files, metadata) {
  const paths = files.map((file) =>
    typeof file === "string" ? file : file.path,
  );
  for (const name of [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "api-manifest.json",
    "docs/public-api.md",
    "docs/compatibility.md",
    metadata.exports["."].types,
    metadata.exports["."].import,
    ...Object.values(metadata.bin),
  ])
    if (!paths.includes(name.replace(/^\.\//, "")))
      throw Error(`Required packed file absent: ${name}`);
  if (
    paths.some(
      (name) =>
        name.startsWith("src/") ||
        name.startsWith("test/") ||
        name.includes("node_modules/") ||
        name.startsWith(".git/") ||
        name.startsWith("docs/evidence/") ||
        /\.(tgz|pem|key)$/.test(name),
    )
  )
    throw Error(
      "Forbidden source, test, archive, credentials or dependencies in package",
    );
  if (
    paths.some(
      (name) =>
        name !== "package.json" &&
        name !== "README.md" &&
        name !== "LICENSE" &&
        name !== "CHANGELOG.md" &&
        name !== "api-manifest.json" &&
        !name.startsWith("dist/") &&
        !/^docs\/[^/]+\.md$/.test(name) &&
        !/^examples\/sales-billing\/[^/]+\.(vane\.ts|mjs|md)$/.test(name),
    )
  )
    throw Error(
      "Unexpected packed file outside approved public package contents",
    );
}
export async function canonicalStage(source, stage, files, bin) {
  const executables = new Set(
    Object.values(bin).map((name) => name.replace(/^\.\//, "")),
  );
  for (const item of files) {
    const name = typeof item === "string" ? item : item.path;
    if (name.startsWith("/") || name.split("/").includes(".."))
      throw Error("Invalid packed path");
    const target = resolve(stage, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await copyFile(resolve(source, name), target);
    await chmod(target, executables.has(name) ? 0o755 : 0o644);
  }
  async function modes(directory) {
    await chmod(directory, 0o755);
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) await modes(resolve(directory, entry.name));
  }
  await modes(stage);
}
export async function pack() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 19)
    throw Error("Release packaging requires supported Node >=24.19.0 <25");
  if (run("git", ["status", "--porcelain"]))
    throw Error(
      "Release packaging requires clean checkout (including untracked files)",
    );
  const commit = run("git", ["rev-parse", "HEAD"]);
  const tree = run("git", ["rev-parse", "HEAD^{tree}"]);
  const metadata = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  if (metadata.private || metadata.version === "0.0.0")
    throw Error("Release package must have reviewed version and private=false");
  if (!process.argv.includes("--skip-build")) run("npm", ["run", "build"]);
  run("node", ["scripts/release/api-snapshot.mjs"]);
  const preview = JSON.parse(
    run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]),
  )[0];
  validateContents(preview.files, metadata);
  const stage = await mkdtemp(resolve(tmpdir(), "vane-canonical-pack-"));
  try {
    await canonicalStage(root, stage, preview.files, metadata.bin);
    await mkdir(output, { recursive: true });
    const packed = JSON.parse(
      run(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", output],
        stage,
      ),
    )[0];
    validateContents(packed.files, metadata);
    const path = resolve(output, packed.filename);
    const bytes = await readFile(path);
    const manifest = {
      schema: "vane.release-package",
      version: 1,
      name: metadata.name,
      packageVersion: metadata.version,
      filename: packed.filename,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      commit,
      tree,
      node: process.version,
      npm: run("npm", ["--version"]),
      apiManifestSha256: createHash("sha256")
        .update(await readFile(resolve(root, "api-manifest.json")))
        .digest("hex"),
      canonicalModes: { directory: "0755", file: "0644", bin: "0755" },
      files: packed.files
        .map((file) => ({ path: file.path, size: file.size, mode: file.mode }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
    if (manifestPath) {
      await mkdir(dirname(resolve(manifestPath)), { recursive: true });
      await writeFile(
        resolve(manifestPath),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }
    console.log(JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await pack();
