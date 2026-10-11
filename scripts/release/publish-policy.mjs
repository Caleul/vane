import { createHash } from "node:crypto";
import { inspectTarball } from "./audit-policy.mjs";
export const trustedWorkflows = [
  "ci.yml",
  "phase-8.yml",
  "release-readiness.yml",
];
export function acceptedRun(run, sha, workflow) {
  return (
    /^[a-f0-9]{40}$/.test(sha) &&
    run.head_sha === sha &&
    run.head_branch === "main" &&
    run.event === "push" &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    run.path === `.github/workflows/${workflow}` &&
    !run.pull_requests?.length
  );
}
export function validateCandidate(manifest, bytes, sha) {
  if (
    manifest.schema !== "vane.release-package" ||
    manifest.version !== 1 ||
    manifest.commit !== sha ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    manifest.name !== "@lilka/vane" ||
    !/^\d+\.\d+\.\d+-rc\.\d+$/.test(manifest.packageVersion) ||
    !/^lilka-vane-[0-9A-Za-z.-]+\.tgz$/.test(manifest.filename)
  )
    throw new Error("Only a reviewed exact-head RC candidate is eligible");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (manifest.sha256 !== sha256 || manifest.integrity !== integrity)
    throw new Error("Canonical artifact hash mismatch");
  const files = inspectTarball(bytes);
  const pkg = JSON.parse(
    files.find((file) => file.path === "package.json")?.bytes.toString("utf8"),
  );
  if (pkg.name !== manifest.name || pkg.version !== manifest.packageVersion)
    throw new Error("Archive version differs from release manifest");
  return { sha256, integrity, files, version: pkg.version };
}
export function validateRegistry(dist, candidate) {
  if (
    dist.integrity !== candidate.integrity ||
    typeof dist.tarball !== "string" ||
    !dist.tarball.startsWith("https://registry.npmjs.org/@lilka/vane/-/")
  )
    throw new Error("Registry package integrity or origin mismatch");
}
