import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  acceptedRun,
  validateCandidate,
  validateRegistry,
} from "./publish-policy.mjs";
const sha = "a".repeat(40);
test("publication accepts only successful exact-head trusted main push workflow", () => {
  const run = {
    head_sha: sha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/ci.yml",
    pull_requests: [],
  };
  assert.ok(acceptedRun(run, sha, "ci.yml"));
  for (const mutation of [
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { conclusion: "failure" },
    { status: "in_progress" },
    { path: ".github/workflows/forged.yml" },
    { pull_requests: [{ number: 1 }] },
  ])
    assert.equal(acceptedRun({ ...run, ...mutation }, sha, "ci.yml"), false);
});
function tarball(version) {
  const body = Buffer.from(JSON.stringify({ name: "@lilka/vane", version }));
  const header = Buffer.alloc(512);
  header.write("package/package.json");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  const checksum = header.reduce((a, b) => a + b, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(
    Buffer.concat([
      header,
      body,
      Buffer.alloc(512 - body.length),
      Buffer.alloc(1024),
    ]),
  );
}
function manifest(bytes, version = "0.1.0-rc.1") {
  return {
    schema: "vane.release-package",
    version: 1,
    commit: sha,
    name: "@lilka/vane",
    packageVersion: version,
    filename: `lilka-vane-${version}.tgz`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}
test("canonical artifact validates actual hashes, source and internal RC version; GA blocked", () => {
  const bytes = tarball("0.1.0-rc.1");
  const identity = manifest(bytes);
  assert.equal(validateCandidate(identity, bytes, sha).version, "0.1.0-rc.1");
  for (const mutation of [
    { commit: "b".repeat(40) },
    { sha256: "0".repeat(64) },
    { integrity: "sha512-invalid" },
    { filename: "../evil.tgz" },
    { packageVersion: "0.1.0-rc.2" },
  ])
    assert.throws(() =>
      validateCandidate({ ...identity, ...mutation }, bytes, sha),
    );
  const ga = tarball("0.1.0");
  assert.throws(
    () => validateCandidate(manifest(ga, "0.1.0"), ga, sha),
    /RC candidate/,
  );
});
test("registry verification rejects alternate package bytes and origins", () => {
  const candidate = { integrity: "sha512-verified" };
  validateRegistry(
    {
      integrity: candidate.integrity,
      tarball: "https://registry.npmjs.org/@lilka/vane/-/vane-0.1.0-rc.1.tgz",
    },
    candidate,
  );
  assert.throws(() =>
    validateRegistry(
      {
        integrity: "sha512-wrong",
        tarball: "https://registry.npmjs.org/@lilka/vane/-/vane.tgz",
      },
      candidate,
    ),
  );
  assert.throws(() =>
    validateRegistry(
      {
        integrity: candidate.integrity,
        tarball: "https://evil.example/pkg.tgz",
      },
      candidate,
    ),
  );
});
test("local execution fails closed before any publish without workflow authorization", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./publish.mjs", import.meta.url).pathname, "--verify-gates"],
    { env: { PATH: process.env.PATH }, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /restricted to the main-branch GitHub workflow/);
});
