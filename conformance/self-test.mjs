import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allCases, humanReport, runSuite, validateCatalog } from "./runner.mjs";

const catalog = JSON.parse(
  await readFile(new URL("./catalog.json", import.meta.url), "utf8"),
);
const requirement = {
  id: "EE-TEST-001",
  category: "semantic",
  required: true,
  applicability: "applicable",
  statement: "Reject invalid identity",
  precondition: "Entity lacks identity",
  action: "Compile",
  expected: "Reject",
  sources: [{ url: "https://example.invalid/normative-baseline" }],
};
const fixture = {
  schema: "entity-event.conformance-catalog",
  version: 1,
  baseline: "test",
  requirements: [requirement],
};
const adapter = {
  name: "self-test",
  package: { name: "fixture", version: "1" },
};
const passing = {
  id: "test.reject",
  requirements: [requirement.id],
  kind: "negative",
  run: () => "Observed rejection",
};

test("catalog is versioned, sourced, unique and every case maps to a known requirement", () => {
  assert.equal(validateCatalog(catalog), true);
  assert.equal(
    catalog.requirements.filter((r) =>
      r.sources.some((s) => s.id?.startsWith("FR-")),
    ).length,
    130,
  );
});
test("source inventory has total, non-dangling coverage", async () => {
  const inventory = JSON.parse(
    await readFile(new URL("./source-inventory.json", import.meta.url), "utf8"),
  );
  const mapping = JSON.parse(
    await readFile(new URL("./source-map.json", import.meta.url), "utf8"),
  );
  const ids = new Set(catalog.requirements.map((r) => r.id));
  assert.equal(mapping.mappings.length, inventory.items.length);
  assert.equal(
    new Set(mapping.mappings.map((m) => m.source_anchor)).size,
    inventory.items.length,
  );
  for (const source of inventory.items) {
    const entry = mapping.mappings.find(
      (m) => m.source_anchor === source.proposed_id,
    );
    assert.ok(entry, source.proposed_id);
    assert.ok(entry.reason);
    for (const id of entry.requirement_ids) assert.ok(ids.has(id), id);
  }
});
test("required failed assertion is FAIL and nonzero", async () => {
  const report = await runSuite({
    catalog: fixture,
    adapter,
    cases: [
      { ...passing, run: () => assert.fail("accepted an invalid identity") },
    ],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.requirements[0].status, "FAIL");
  assert.equal(report.summary.releaseGate, "BLOCKED");
  assert.match(humanReport(report), /FAIL EE-TEST-001/);
});
test("missing required evidence is GAP and nonzero, never vacuous success", async () => {
  const report = await runSuite({ catalog: fixture, adapter, cases: [] });
  assert.equal(report.exitCode, 1);
  assert.equal(report.requirements[0].status, "GAP");
});
test("partial evidence remains GAP even if all mapped assertions pass", async () => {
  const report = await runSuite({
    catalog: {
      ...fixture,
      requirements: [
        { ...requirement, evidenceGap: "Real database execution absent" },
      ],
    },
    adapter,
    cases: [passing],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.requirements[0].status, "GAP");
  assert.equal(report.cases[0].status, "PASS");
});
test("complete evidence passes, records duration/evidence, serializes JSON", async () => {
  const report = await runSuite({
    catalog: fixture,
    adapter,
    cases: [passing],
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.summary.releaseGate, "PASS");
  assert.ok(report.cases[0].durationMs >= 0);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});
test("filtered passing run cannot claim release gate", async () => {
  const report = await runSuite({
    catalog: fixture,
    adapter,
    cases: [passing],
    ids: [requirement.id],
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.scope.complete, false);
  assert.equal(report.summary.releaseGate, "BLOCKED");
});
test("unknown and empty filters fail closed", async () => {
  await assert.rejects(
    () =>
      runSuite({
        catalog: fixture,
        adapter,
        cases: [],
        ids: ["EE-UNKNOWN-001"],
      }),
    /Unknown requirement/,
  );
  await assert.rejects(
    () => runSuite({ catalog: fixture, adapter, cases: [], category: "oops" }),
    /Unknown category/,
  );
  await assert.rejects(
    () =>
      runSuite({
        catalog: fixture,
        adapter,
        cases: [],
        category: "operations",
      }),
    /no requirements/,
  );
});
test("unjustified N/A and unknown case mappings cannot weaken required gate", () => {
  assert.throws(
    () =>
      validateCatalog(
        {
          ...fixture,
          requirements: [{ ...requirement, applicability: "not-applicable" }],
        },
        [],
      ),
    /Unjustified/,
  );
  assert.throws(
    () =>
      validateCatalog(fixture, [
        { ...passing, requirements: ["EE-UNKNOWN-001"] },
      ]),
    /Unknown case requirement/,
  );
  assert.throws(
    () =>
      validateCatalog(
        { ...fixture, requirements: [requirement, requirement] },
        [],
      ),
    /duplicate/,
  );
});
test("positive and negative fixtures exist and runnable code has no private imports", async () => {
  assert.ok(allCases.some((c) => c.kind === "positive"));
  assert.ok(allCases.some((c) => c.kind === "negative"));
  const paths = ["runner.mjs"];
  for (const folder of ["adapters", "cases"]) {
    for (const name of await readdir(
      new URL(`./${folder}/`, import.meta.url),
    )) {
      if (name.endsWith(".mjs")) paths.push(`${folder}/${name}`);
    }
  }
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /(?:from\s*|import\s*\()\s*["'][^"']*(?:\/src\/|\/test\/|dist-test)/,
      path,
    );
  }
});

test("environmental GAP is nonzero and failing error values are not serialized", async () => {
  const gap = await runSuite({
    catalog: fixture,
    adapter,
    cases: [
      {
        ...passing,
        run: () => {
          throw Object.assign(new Error("postgresql://sensitive"), {
            code: "CONFORMANCE_GAP",
          });
        },
      },
    ],
  });
  assert.equal(gap.exitCode, 1);
  assert.equal(gap.requirements[0].status, "GAP");
  assert.doesNotMatch(JSON.stringify(gap), /sensitive/);
  const failure = await runSuite({
    catalog: fixture,
    adapter,
    cases: [
      { ...passing, run: () => assert.equal("secret-value", "redacted") },
    ],
  });
  assert.doesNotMatch(JSON.stringify(failure), /secret-value/);
});
test("removing a mapped evidence case cannot silently pass a requirement", () => {
  assert.throws(
    () =>
      validateCatalog(
        { ...fixture, requirements: [{ ...requirement, tests: [passing.id] }] },
        [],
      ),
    /Missing mapped evidence/,
  );
});

test("case budgets are bounded and timeout yields structured failure", async () => {
  for (const timeoutMs of [0, -1, 300001, Number.POSITIVE_INFINITY, 1.5])
    assert.throws(
      () => validateCatalog(fixture, [{ ...passing, timeoutMs }]),
      /Invalid case time budget/,
    );
  const report = await runSuite({
    catalog: fixture,
    adapter,
    cases: [{ ...passing, timeoutMs: 5, run: () => new Promise(() => {}) }],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.cases[0].status, "FAIL");
  assert.equal(report.requirements[0].status, "FAIL");
});

test("source-scoped applicability remains visible in JSON and human evidence", async () => {
  const scopeNote = "Only the explicitly supported v0.1 monolith is exercised";
  const report = await runSuite({
    catalog: { ...fixture, requirements: [{ ...requirement, scopeNote }] },
    adapter,
    cases: [passing],
  });
  assert.equal(report.requirements[0].scopeNote, scopeNote);
  assert.ok(humanReport(report).includes(`Scope: ${scopeNote}`));
  assert.equal(report.requirements[0].status, "PASS");
});

test("supplied package is snapshotted before install and its exact hash reaches the runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vane-artifact-test-"));
  try {
    await mkdir(join(directory, "conformance"));
    await mkdir(join(directory, "bin"));
    await writeFile(
      join(directory, "conformance/pack-and-run.mjs"),
      await readFile(new URL("./pack-and-run.mjs", import.meta.url)),
    );
    await writeFile(
      join(directory, "conformance/package-sanity.mjs"),
      "export async function checkPackage() {}\n",
    );
    const original = join(directory, "original.tgz");
    await writeFile(original, "original-artifact-bytes");
    await writeFile(
      join(directory, "bin/npm"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'pack') {
  if (!process.env.ALLOW_PACK) process.exit(90);
  const path = require('node:path').join(args[args.indexOf('--pack-destination') + 1], 'normal.tgz');
  fs.writeFileSync(path, 'original-artifact-bytes');
  console.log(JSON.stringify([{filename: 'normal.tgz'}]));
  process.exit(0);
}
if (args[0] !== 'install') process.exit(90);
if (fs.readFileSync(args.at(-1), 'utf8') !== 'original-artifact-bytes') process.exit(91);
fs.writeFileSync(process.env.ORIGINAL_ARTIFACT, 'changed-during-install');
`,
    );
    await chmod(join(directory, "bin/npm"), 0o755);
    await writeFile(join(directory, "bin/git"), "#!/bin/sh\nprintf fixture\n");
    await chmod(join(directory, "bin/git"), 0o755);
    await writeFile(
      join(directory, "conformance/runner.mjs"),
      `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
const value=(name)=>args[args.indexOf(name)+1];
const bytes=readFileSync(value('--tarball-path'));
assert.equal(bytes.toString(), 'original-artifact-bytes');
assert.equal(value('--tarball-sha256'), createHash('sha256').update(bytes).digest('hex'));
`,
    );
    const run = (args, extraEnv = {}) =>
      spawnSync(
        process.execPath,
        [join(directory, "conformance/pack-and-run.mjs"), ...args],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            PATH: `${join(directory, "bin")}:${process.env.PATH}`,
            ORIGINAL_ARTIFACT: original,
            ...extraEnv,
          },
        },
      );
    const result = run(["--tarball", original]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(original, "utf8"), "changed-during-install");
    const normal = run([], { ALLOW_PACK: "1" });
    assert.equal(normal.status, 0, normal.stderr);
    for (const args of [
      ["--tarball"],
      ["--tarball", "--sanity"],
      ["--tarball", original, "--tarball", original],
    ]) {
      const invalid = run(args);
      assert.notEqual(invalid.status, 0);
      assert.match(
        invalid.stderr,
        /--tarball (requires a path|may be supplied only once)/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
