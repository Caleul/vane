import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(
  process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : "artifacts/release/reproducibility",
);
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw Error(
      `${command} ${args.join(" ")}: ${result.stderr}\n${result.stdout}`,
    );
  return result.stdout.trim();
}
if (run("git", ["status", "--porcelain"]))
  throw Error("Reproducibility requires clean source checkout");
const commit = run("git", ["rev-parse", "HEAD"]);
const temporary = await mkdtemp(resolve(tmpdir(), "vane-release-repeat-"));
await mkdir(output, { recursive: true });
try {
  const packages = [];
  for (const mask of ["022", "077"]) {
    const checkout = resolve(temporary, mask);
    run("git", ["clone", "--quiet", "--no-hardlinks", root, checkout]);
    run("git", ["checkout", "--quiet", "--detach", commit], checkout);
    run("sh", ["-c", `umask ${mask}; npm ci --ignore-scripts`], checkout);
    const target = resolve(output, mask);
    await mkdir(target, { recursive: true });
    run(
      "sh",
      [
        "-c",
        `umask ${mask}; exec node scripts/release/pack.mjs --out "$1" --manifest "$2"`,
        "pack",
        target,
        resolve(target, "manifest.json"),
      ],
      checkout,
    );
    const manifest = JSON.parse(
      await readFile(resolve(target, "manifest.json"), "utf8"),
    );
    packages.push({ umask: mask, ...manifest });
  }
  if (
    packages[0].sha256 !== packages[1].sha256 ||
    packages.some((pkg) => pkg.commit !== commit)
  )
    throw Error(
      "Identical commit produced different package bytes across umask/checkout",
    );
  const manifest = {
    schema: "vane.release-reproducibility",
    status: "PASS",
    commit,
    tree: packages[0].tree,
    sha256: packages[0].sha256,
    packages,
  };
  await writeFile(
    resolve(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
