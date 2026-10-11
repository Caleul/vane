import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { classification, verify } from "./api-snapshot.mjs";
import { canonicalStage, validateContents } from "./pack.mjs";
const metadata = {
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  bin: { "entity-event": "./dist/cli.js" },
};
const files = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "api-manifest.json",
  "docs/public-api.md",
  "docs/compatibility.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/cli.js",
];
test("signature, referenced type, runtime and classification drift each fail", () => {
  const baseline = {
    exports: [
      {
        name: "Event",
        signatures: ["(name: string): Event"],
        runtime: { kind: "function", arity: 1 },
        classification: "supported",
      },
    ],
    declarationHashes: { "dsl.d.ts": "original" },
  };
  verify(baseline, baseline);
  for (const mutate of [
    (copy) => {
      copy.exports[0].signatures[0] = "(name: number): Event";
    },
    (copy) => {
      copy.declarationHashes["dsl.d.ts"] = "changed";
    },
    (copy) => {
      copy.exports[0].runtime.arity = 2;
    },
    (copy) => {
      copy.exports[0].classification = "experimental";
    },
  ]) {
    const copy = structuredClone(baseline);
    mutate(copy);
    assert.throws(() => verify(copy, baseline), /drift/);
  }
});
test("privileged/experimental APIs are explicit and stay exported", () => {
  assert.equal(
    classification("postgresql/operations.d.ts").classification,
    "privileged",
  );
  assert.equal(
    classification("service-artifacts.d.ts").classification,
    "experimental",
  );
  assert.equal(classification("dsl.d.ts").classification, "supported");
  for (const file of [
    "postgresql/module-runtime.d.ts",
    "postgresql/view-runtime.d.ts",
    "postgresql/saga-store.d.ts",
    "service-runtime.d.ts",
    "secrets.d.ts",
  ])
    assert.equal(classification(file).classification, "privileged");
  assert.equal(
    classification("postgresql/storage-ir.d.ts").classification,
    "supported",
  );
  assert.equal(
    classification("http-runtime.d.ts", "TerminalResultStore").classification,
    "privileged",
  );
  assert.throws(
    () => classification("postgresql/new-raw-executor.d.ts"),
    /explicit API classification/,
  );
});
test("required artifact entries and public-only contents enforced", () => {
  validateContents(files, metadata);
  assert.throws(
    () =>
      validateContents(
        files.filter((name) => name !== "dist/cli.js"),
        metadata,
      ),
    /Required/,
  );
  for (const bad of [
    "src/private.ts",
    "node_modules/pg/index.js",
    "docs/evidence/previous.json",
    "secret.pem",
    "test/spec.mjs",
  ])
    assert.throws(
      () => validateContents([...files, bad], metadata),
      /Forbidden|Unexpected/,
    );
});
test("canonical staging preserves bytes and fixes modes under umask077", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "vane-modes-test-"));
  const source = resolve(directory, "source");
  const stage = resolve(directory, "stage");
  const previous = process.umask(0o077);
  try {
    for (const name of files) {
      await mkdir(resolve(source, name, ".."), { recursive: true });
      await writeFile(resolve(source, name), `bytes:${name}`);
    }
    await canonicalStage(source, stage, files, metadata.bin);
    for (const name of files) {
      assert.equal(
        await readFile(resolve(stage, name), "utf8"),
        `bytes:${name}`,
      );
      assert.equal(
        (await stat(resolve(stage, name))).mode & 0o777,
        name === "dist/cli.js" ? 0o755 : 0o644,
      );
    }
    assert.equal((await stat(resolve(stage, "dist"))).mode & 0o777, 0o755);
  } finally {
    process.umask(previous);
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual checker snapshot rejects same export name with changed parameter type", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "vane-api-fixture-"));
  try {
    await mkdir(resolve(directory, "dist"));
    await writeFile(resolve(directory, "package.json"), '{"type":"module"}');
    await writeFile(
      resolve(directory, "dist/index.js"),
      "export function echo(value) { return value; }",
    );
    await writeFile(
      resolve(directory, "dist/index.d.ts"),
      "export declare function echo(value: string): string;",
    );
    const { snapshot } = await import("./api-snapshot.mjs");
    const baseline = await snapshot(directory);
    assert.deepEqual(
      baseline.exports.map((entry) => entry.name),
      ["echo"],
    );
    assert.equal(baseline.exports[0].runtime.arity, 1);
    await writeFile(
      resolve(directory, "dist/index.d.ts"),
      "export declare function echo(value: number): number;",
    );
    const changed = await snapshot(directory);
    assert.deepEqual(
      changed.exports.map((entry) => entry.name),
      ["echo"],
    );
    assert.throws(() => verify(changed, baseline), /drift/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
