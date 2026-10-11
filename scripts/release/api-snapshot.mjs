import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const supportedModules = new Set([
  "dsl.d.ts",
  "declaration.d.ts",
  "diagnostic.d.ts",
  "compiler.d.ts",
  "source-parser.d.ts",
  "semantic-ir.d.ts",
  "contract-ir.d.ts",
  "openapi.d.ts",
  "service-configuration.d.ts",
  "service-compiler.d.ts",
  "http-runtime.d.ts",
  "postgresql/materializer.d.ts",
  "postgresql/renderer.d.ts",
  "postgresql/storage-ir.d.ts",
  "postgresql/migrations.d.ts",
]);
const privilegedModules = new Set([
  "postgresql/operations.d.ts",
  "postgresql/migration-executor.d.ts",
  "postgresql/delivery.d.ts",
  "postgresql/runtime.d.ts",
  "postgresql/envelope.d.ts",
  "postgresql/public-saga-admission.d.ts",
  "postgresql/saga-runtime.d.ts",
  "postgresql/module-runtime.d.ts",
  "postgresql/view-runtime.d.ts",
  "postgresql/saga-store.d.ts",
  "service-runtime.d.ts",
  "secrets.d.ts",
]);
const experimentalModules = new Set([
  "service-artifacts.d.ts",
  "execution-policy.d.ts",
  "telemetry.d.ts",
  "acl-runtime.d.ts",
  "saga-plan.d.ts",
  "index.d.ts",
]);
const privilegedHttpNames = new Set([
  "DurablePublicEventAdmission",
  "InMemoryTerminalResultStore",
  "InMemoryTerminalResultStoreOptions",
  "TerminalResultStore",
]);
export function classification(file, name) {
  if (
    privilegedModules.has(file) ||
    (file === "http-runtime.d.ts" && privilegedHttpNames.has(name))
  )
    return {
      classification: "privileged",
      reason:
        "Direct database/event/view execution, stored-result inspection, maintenance, admission, service bootstrap bindings or credential resolution requires trusted application authority.",
    };
  if (experimentalModules.has(file))
    return {
      classification: "experimental",
      reason:
        "Advanced adapter or generated-artifact contract is versioned but may change in a minor 0.x release.",
    };
  if (supportedModules.has(file))
    return {
      classification: "supported",
      reason:
        "Documented declarative, pure compiler/configuration or public HTTP application contract.",
    };
  throw new Error(
    `New export origin requires explicit API classification: ${file} (${name ?? "unknown"})`,
  );
}

export async function snapshot(directory = root) {
  const index = resolve(directory, "dist/index.d.ts");
  const program = ts.createProgram([index], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(index);
  if (!source) throw Error("Build dist before API snapshot");
  const runtime = await import(
    `${pathToFileURL(resolve(directory, "dist/index.js")).href}?snapshot=${Date.now()}`
  );
  const flags =
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.WriteArrowStyleSignature |
    ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  const printer = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  });
  const exports = checker
    .getExportsOfModule(checker.getSymbolAtLocation(source))
    .map((entry) => {
      const symbol =
        entry.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(entry)
          : entry;
      const declarations = symbol.declarations ?? [];
      const files = [
        ...new Set(
          declarations.map((node) =>
            relative(
              resolve(directory, "dist"),
              node.getSourceFile().fileName,
            ).replaceAll("\\", "/"),
          ),
        ),
      ];
      const type = checker.getTypeOfSymbolAtLocation(
        symbol,
        declarations[0] ?? source,
      );
      const declaredType =
        symbol.flags & ts.SymbolFlags.Type
          ? checker.getDeclaredTypeOfSymbol(symbol)
          : null;
      const value = runtime[entry.name];
      const methods = [];
      if (typeof value === "function" && value.prototype) {
        for (const name of Object.getOwnPropertyNames(value.prototype).sort()) {
          if (name === "constructor") continue;
          const descriptor = Object.getOwnPropertyDescriptor(
            value.prototype,
            name,
          );
          methods.push({
            name,
            kind: descriptor.get ? "getter" : typeof descriptor.value,
            arity:
              typeof descriptor.value === "function"
                ? descriptor.value.length
                : null,
          });
        }
      }
      return {
        name: entry.name,
        ...classification(files[0] ?? "", entry.name),
        files,
        kind: ts.SymbolFlags[symbol.flags] ?? symbol.flags,
        type: checker.typeToString(type, undefined, flags),
        declaredType: declaredType
          ? checker.typeToString(declaredType, undefined, flags)
          : null,
        signatures: type
          .getCallSignatures()
          .map((sig) => checker.signatureToString(sig, undefined, flags)),
        declarations: declarations.map((node) =>
          printer
            .printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
            .trim(),
        ),
        runtime: Object.hasOwn(runtime, entry.name)
          ? {
              kind: typeof value,
              arity: typeof value === "function" ? value.length : null,
              methods,
              constant:
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean"
                  ? value
                  : undefined,
            }
          : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const declarations = {};
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith(".d.ts"))
        declarations[
          relative(resolve(directory, "dist"), file).replaceAll("\\", "/")
        ] = createHash("sha256")
          .update(
            printer.printFile(
              ts.createSourceFile(
                file,
                await readFile(file, "utf8"),
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.TS,
              ),
            ),
          )
          .digest("hex");
    }
  }
  await visit(resolve(directory, "dist"));
  return {
    schema: "vane.public-api",
    version: 1,
    typescript: ts.version,
    entrypoint: ".",
    policy: "docs/public-api.md",
    exports,
    declarationHashes: Object.fromEntries(
      Object.entries(declarations).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}
export function verify(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(
      "Public API drift detected. Review declaration/signature/runtime/classification changes, document compatibility, then explicitly update api-manifest.json.",
    );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const actual = await snapshot();
  if (process.argv.includes("--update")) {
    await writeFile(
      resolve(root, "api-manifest.json"),
      `${JSON.stringify(actual, null, 2)}\n`,
    );
    console.log(`API snapshot updated: ${actual.exports.length} exports`);
  } else {
    verify(
      actual,
      JSON.parse(await readFile(resolve(root, "api-manifest.json"), "utf8")),
    );
    console.log(`API snapshot verified: ${actual.exports.length} exports`);
  }
}
