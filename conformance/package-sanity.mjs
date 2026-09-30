import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAdapter as invalid } from "./adapters/invalid.mjs";
import { createAdapter as valid } from "./adapters/vane.mjs";
import { runSuite } from "./runner.mjs";

export async function checkPackage(packageRoot) {
  const catalog = JSON.parse(
    await readFile(new URL("./catalog.json", import.meta.url), "utf8"),
  );
  const normal = await runSuite({
    catalog,
    adapter: await valid({ packageRoot }),
    ids: ["EE-ENT-002"],
  });
  assert.equal(
    normal.requirements[0].status,
    "PASS",
    "Valid packaged implementation must reject both missing and composite identities",
  );
  assert.equal(normal.exitCode, 0);
  const mutant = await runSuite({
    catalog,
    adapter: await invalid({ packageRoot }),
    ids: ["EE-ENT-002"],
  });
  assert.equal(
    mutant.requirements[0].status,
    "FAIL",
    "Invalid adapter must fail EE-ENT-002 specifically, not merely have other GAPs",
  );
  assert.equal(
    mutant.cases.find((c) => c.id === "semantic.identity-missing").status,
    "FAIL",
  );
  assert.equal(mutant.exitCode, 1);
  console.log(
    "Packaged sanity PASS: valid adapter PASS EE-ENT-002; deliberately invalid adapter FAIL EE-ENT-002 with exit1",
  );
}
