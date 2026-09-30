import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Load only the entry explicitly declared by the installed package's exports.
// No fallback to source, workspace self-reference, or private package paths.
export async function createAdapter({ packageRoot }) {
  const root = await realpath(packageRoot);
  const metadata = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  if (metadata.name !== "@lilka/vane")
    throw new Error("Expected an installed @lilka/vane package");
  const entry = metadata.exports?.["."]?.import;
  const bin = metadata.bin?.["entity-event"];
  for (const target of [entry, bin]) {
    if (typeof target !== "string" || !target.startsWith("./"))
      throw new Error(
        "Package must declare public import and entity-event CLI",
      );
    const resolved = await realpath(resolve(root, target));
    const path = relative(root, resolved);
    if (isAbsolute(path) || path.startsWith(".."))
      throw new Error("Public package entry escapes installed package");
  }
  const api = await import(pathToFileURL(resolve(root, entry)).href);
  return {
    name: "vane-packaged-public-api",
    api,
    packageRoot: root,
    package: {
      name: metadata.name,
      version: metadata.version,
      engines: metadata.engines,
    },
    cli: async (args, options = {}) => {
      const result = spawnSync(
        process.execPath,
        [resolve(root, bin), ...args],
        {
          encoding: "utf8",
          timeout: 30000,
          ...options,
        },
      );
      if (result.error) throw result.error;
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}
