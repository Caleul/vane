import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  allowedPackagePath,
  auditProblems,
  inspectTarball,
  secretMarkers,
} from "./audit-policy.mjs";
const result = (high, critical, total = high + critical) => ({
  exitCode: total ? 1 : 0,
  report: { metadata: { vulnerabilities: { high, critical, total } } },
});
test("high and critical findings block; absent reports cannot pass", () => {
  assert.deepEqual(auditProblems(result(1, 0)), ["dependency-advisory"]);
  assert.deepEqual(auditProblems(result(0, 1)), ["dependency-advisory"]);
  assert.deepEqual(auditProblems(result(0, 0)), []);
  assert.deepEqual(auditProblems({ exitCode: 0 }), ["audit-unavailable"]);
  assert.deepEqual(
    auditProblems({ exitCode: 0, report: { error: { code: "registry" } } }),
    ["audit-unavailable"],
  );
});
test("only intended package content accepted; secret markers contain no secret values", () => {
  for (const path of [
    "docs/sagas.md",
    "api-manifest.json",
    "examples/sales-billing/sales.vane.ts",
    "CHANGELOG.md",
    "dist/index.d.ts.map",
  ])
    assert.ok(allowedPackagePath(path));
  for (const path of [
    ".env",
    "docs/evidence/snapshot.json",
    "docs/phase8-consumers.tgz",
    "test/key.js",
    "docs/../key.md",
    "examples/unknown/main.mjs",
  ])
    assert.equal(allowedPackagePath(path), false);
  const token = `AKIA${"A".repeat(16)}`;
  const findings = secretMarkers(Buffer.from(token));
  assert.deepEqual(findings, ["aws-access-key"]);
  assert.ok(!JSON.stringify(findings).includes(token));
});
function archive(name, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write("00000000002\0", 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(
    Buffer.concat([
      header,
      Buffer.from("{}"),
      Buffer.alloc(510),
      Buffer.alloc(1024),
    ]),
  );
}
test("archive identity bytes inspected without extraction; links and traversal fail", () => {
  const files = inspectTarball(archive("package/package.json"));
  assert.equal(files[0].bytes.toString(), "{}");
  assert.throws(
    () => inspectTarball(archive("package/package.json", "2")),
    /regular files/,
  );
  assert.throws(
    () => inspectTarball(archive("package/../evil")),
    /Unsafe archive path/,
  );
  assert.throws(
    () => inspectTarball(archive("/tmp/evil")),
    /Unsafe archive path/,
  );
});
