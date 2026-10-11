import { gunzipSync } from "node:zlib";

export function auditProblems(result) {
  const findings = [];
  const counts = result.report?.metadata?.vulnerabilities;
  if (
    result.report?.error ||
    result.error ||
    result.exitCode === null ||
    !counts ||
    !["high", "critical", "total"].every(
      (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
    )
  )
    findings.push("audit-unavailable");
  else {
    if (counts.high + counts.critical > 0) findings.push("dependency-advisory");
    if (result.exitCode !== 0 && counts.total === 0)
      findings.push("audit-unavailable");
  }
  return findings;
}
export function allowedPackagePath(path) {
  return (
    [
      "package.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "api-manifest.json",
    ].includes(path) ||
    /^dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:js|d\.ts)(?:\.map)?$/.test(
      path,
    ) ||
    /^docs\/[A-Za-z0-9_-]+\.md$/.test(path) ||
    /^examples\/sales-billing\/(?:[A-Za-z0-9_-]+\.(?:mjs|vane\.ts)|README\.md)$/.test(
      path,
    )
  );
}
const markers = [
  [
    "private-key",
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  ],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  [
    "github-token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  ],
  [
    "literal-bearer-token",
    /authorization\s*:\s*['"`]Bearer\s+[A-Za-z0-9._~-]{20,}/i,
  ],
];
export function secretMarkers(bytes) {
  return markers
    .filter(([, regex]) => regex.test(bytes.toString("utf8")))
    .map(([name]) => name);
}
// Inspect in memory only: never extract archive paths to the filesystem.
export function inspectTarball(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
  const files = [];
  const seen = new Set();
  const str = (header, start, length) =>
    header
      .subarray(start, start + length)
      .toString("utf8")
      .split("\0")[0];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expected = Number.parseInt(str(header, 148, 8).trim(), 8);
    let actual = 0;
    for (let i = 0; i < 512; i++)
      actual += i >= 148 && i < 156 ? 32 : header[i];
    if (actual !== expected) throw new Error("Invalid tar header checksum");
    const prefix = str(header, 345, 155);
    const name = str(header, 0, 100);
    const full = prefix ? `${prefix}/${name}` : name;
    if (
      !full.startsWith("package/") ||
      full
        .split("/")
        .some((part) => part === ".." || part === "." || part === "") ||
      full.includes("\\")
    )
      throw new Error("Unsafe archive path");
    const path = full.slice(8);
    if (seen.has(path)) throw new Error("Duplicate archive member");
    seen.add(path);
    const type = str(header, 156, 1);
    if (type !== "0" && type !== "")
      throw new Error(
        "Archive members must be regular files; links and extensions are rejected",
      );
    const size = Number.parseInt(str(header, 124, 12).trim(), 8);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length
    )
      throw new Error("Invalid tar member size");
    files.push({
      path,
      bytes: tar.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (
    !files.length ||
    offset + 1024 > tar.length ||
    !tar.subarray(offset).every((byte) => byte === 0)
  )
    throw new Error("Incomplete tar archive");
  return files;
}
