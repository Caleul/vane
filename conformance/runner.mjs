#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cases as causality } from "./cases/causality.mjs";
import { cases as generatedReference } from "./cases/generated-reference.mjs";
import { cases as lifecycle } from "./cases/lifecycle.mjs";
import { cases as migrations } from "./cases/migrations.mjs";
import { cases as operations } from "./cases/operations.mjs";
import { cases as measuredPerformance } from "./cases/performance.mjs";
import { cases as persistence } from "./cases/persistence.mjs";
import { cases as postgres } from "./cases/postgres.mjs";
import { cases as remainingContracts } from "./cases/remaining-contracts.mjs";
import { cases as representation } from "./cases/representation.mjs";
import { cases as semantic } from "./cases/semantic.mjs";
import { cases as service } from "./cases/service.mjs";

export const allCases = [
  ...semantic,
  ...persistence,
  ...service,
  ...causality,
  ...postgres,
  ...operations,
  ...lifecycle,
  ...migrations,
  ...representation,
  ...remainingContracts,
  ...generatedReference,
  ...measuredPerformance,
];
export const categories = [
  "semantic",
  "persistence",
  "runtime",
  "contract",
  "saga",
  "operations",
];
const statuses = ["PASS", "FAIL", "GAP", "N/A"];

export function validateCatalog(catalog, cases = allCases) {
  if (
    catalog.schema !== "entity-event.conformance-catalog" ||
    catalog.version !== 1 ||
    !Array.isArray(catalog.requirements)
  )
    throw new Error("Unsupported catalog");
  const ids = new Set();
  for (const requirement of catalog.requirements) {
    if (!/^EE-[A-Z0-9]+-\d{3}$/.test(requirement.id) || ids.has(requirement.id))
      throw new Error(`Invalid or duplicate requirement ID: ${requirement.id}`);
    ids.add(requirement.id);
    if (
      !categories.includes(requirement.category) ||
      typeof requirement.required !== "boolean"
    )
      throw new Error(`Invalid requirement classification: ${requirement.id}`);
    for (const key of ["statement", "precondition", "action", "expected"])
      if (typeof requirement[key] !== "string" || !requirement[key].trim())
        throw new Error(`Missing ${key}: ${requirement.id}`);
    if (!Array.isArray(requirement.sources) || !requirement.sources.length)
      throw new Error(`Missing source: ${requirement.id}`);
    if (
      requirement.applicability === "not-applicable" &&
      (!requirement.reason || requirement.required)
    )
      throw new Error(`Unjustified N/A: ${requirement.id}`);
    if (!["applicable", "not-applicable"].includes(requirement.applicability))
      throw new Error(`Unknown applicability: ${requirement.id}`);
  }
  const caseIds = new Set();
  for (const test of cases) {
    if (caseIds.has(test.id)) throw new Error(`Duplicate case: ${test.id}`);
    caseIds.add(test.id);
    if (
      !["positive", "negative"].includes(test.kind) ||
      !test.requirements.length
    )
      throw new Error(`Invalid case: ${test.id}`);
    if (
      test.timeoutMs !== undefined &&
      (!Number.isSafeInteger(test.timeoutMs) ||
        test.timeoutMs < 1 ||
        test.timeoutMs > 300000)
    )
      throw new Error(`Invalid case time budget: ${test.id}`);
    for (const id of test.requirements)
      if (!ids.has(id)) throw new Error(`Unknown case requirement: ${id}`);
  }
  for (const requirement of catalog.requirements) {
    for (const id of requirement.tests ?? []) {
      if (
        !cases.some(
          (test) =>
            test.id === id && test.requirements.includes(requirement.id),
        )
      )
        throw new Error(
          `Missing mapped evidence case ${id} for ${requirement.id}`,
        );
    }
  }
  return true;
}

export async function runSuite({
  catalog,
  adapter,
  cases = allCases,
  ids = [],
  category,
  metadata = {},
}) {
  validateCatalog(catalog, cases);
  if (category && !categories.includes(category))
    throw new Error(`Unknown category: ${category}`);
  for (const id of ids)
    if (!catalog.requirements.some((r) => r.id === id))
      throw new Error(`Unknown requirement: ${id}`);
  const selected = catalog.requirements.filter(
    (r) =>
      (!category || r.category === category) &&
      (!ids.length || ids.includes(r.id)),
  );
  if (!selected.length) throw new Error("Filter selects no requirements");
  const selectedIds = new Set(selected.map((r) => r.id));
  const results = [];
  for (const test of cases.filter((t) =>
    t.requirements.some((id) => selectedIds.has(id)),
  )) {
    const start = performance.now();
    try {
      if (test.requires === "postgresql" && !adapter.databaseUrl)
        throw Object.assign(
          new Error(
            "VANE_CONFORMANCE_DATABASE_URL is required for independent PostgreSQL evidence",
          ),
          { code: "CONFORMANCE_GAP" },
        );
      const timeoutMs = test.timeoutMs ?? 60000;
      let timer;
      const evidence = await Promise.race([
        test.run(adapter),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Case exceeded its execution time budget")),
            timeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (typeof evidence !== "string" || !evidence.trim())
        throw new Error("Case returned no observable evidence");
      results.push({
        id: test.id,
        kind: test.kind,
        requirements: test.requirements,
        status: "PASS",
        durationMs: performance.now() - start,
        evidence,
      });
    } catch (error) {
      results.push({
        id: test.id,
        kind: test.kind,
        requirements: test.requirements,
        status: error?.code === "CONFORMANCE_GAP" ? "GAP" : "FAIL",
        durationMs: performance.now() - start,
        evidence:
          error?.code === "CONFORMANCE_GAP"
            ? "Required external evidence prerequisite is unavailable"
            : safeFailure(error),
        classification: error?.code === "CONFORMANCE_GAP" ? "MISSING" : "BUG",
      });
    }
  }
  const requirements = selected.map((requirement) => {
    const evidence = results.filter((t) =>
      t.requirements.includes(requirement.id),
    );
    let status;
    let reason;
    let classification;
    if (requirement.applicability === "not-applicable") {
      status = "N/A";
      reason = requirement.reason;
    } else if (evidence.some((t) => t.status === "FAIL")) {
      status = "FAIL";
      classification = "BUG";
      reason = "A normative assertion failed";
    } else if (
      !evidence.length ||
      evidence.some((t) => t.status === "GAP") ||
      requirement.evidenceGap
    ) {
      status = "GAP";
      classification = "MISSING";
      reason =
        requirement.evidenceGap ??
        (evidence.some((t) => t.status === "GAP")
          ? "A required evidence prerequisite is unavailable"
          : "No independent executable evidence is implemented for this requirement");
    } else {
      status = "PASS";
    }
    return {
      id: requirement.id,
      category: requirement.category,
      required: requirement.required,
      statement: requirement.statement,
      ...(requirement.scopeNote ? { scopeNote: requirement.scopeNote } : {}),
      status,
      durationMs: evidence.reduce((sum, t) => sum + t.durationMs, 0),
      evidence: evidence.map((t) => t.id),
      ...(reason ? { reason } : {}),
      ...(classification ? { classification } : {}),
      ...(status === "GAP"
        ? {
            findingType: "EVIDENCE_GAP",
            reproduction: {
              precondition: requirement.precondition,
              action: requirement.action,
              expected: requirement.expected,
            },
          }
        : {}),
      sources: requirement.sources,
    };
  });
  const summary = Object.fromEntries(
    statuses.map((status) => [
      status,
      requirements.filter((r) => r.status === status).length,
    ]),
  );
  const requiredBlockers = requirements.filter(
    (r) => r.required && ["FAIL", "GAP"].includes(r.status),
  ).length;
  return {
    schema: "entity-event.conformance-report",
    version: 1,
    catalogVersion: catalog.baseline,
    generatedAt: new Date().toISOString(),
    adapter: adapter.name,
    environment: {
      node: process.version,
      postgresql: adapter.postgresqlVersion ?? null,
      ...metadata,
      package: adapter.package,
    },
    scope: {
      complete: !category && !ids.length,
      category: category ?? null,
      ids,
    },
    summary: {
      ...summary,
      requiredBlockers,
      releaseGate:
        !category && !ids.length && requiredBlockers === 0 ? "PASS" : "BLOCKED",
    },
    requirements,
    cases: results,
    exitCode: requiredBlockers ? 1 : 0,
  };
}

function safeFailure(error) {
  // Assertion diffs may contain credentials from the broken implementation under test.
  // Keep the assertion operator/code and a non-sensitive location, never raw actual/expected.
  if (error?.code === "ERR_ASSERTION")
    return `Assertion failed (${error.operator ?? "assert"}); inspect the named public case`;
  return `Case raised ${error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,70}Error$/.test(error.name) ? error.name : "an error"}; inspect the named public case`;
}

export function humanReport(report) {
  return [
    `Entity Event ${report.catalogVersion} conformance (${report.adapter})`,
    `Package ${report.environment.package.name}@${report.environment.package.version}; Node ${report.environment.node}; PostgreSQL ${report.environment.postgresql ?? "not exercised"}`,
    `Commit ${report.environment.commit ?? "unidentified"}; scope ${report.scope.complete ? "complete catalog" : "FILTERED (not a release gate)"}`,
    ...report.requirements.map(
      (r) =>
        `${r.status.padEnd(4)} ${r.id} (${r.durationMs.toFixed(2)}ms) ${r.statement}${r.scopeNote ? `\n     Scope: ${r.scopeNote}` : ""}\n     ${r.evidence.join(", ") || "no executed evidence"}${r.reason ? `; ${r.reason}` : ""}${report.cases
          .filter((c) => r.evidence.includes(c.id))
          .map((c) => `\n     ${c.id}: ${c.status} ${c.evidence}`)
          .join("")}`,
    ),
    `PASS ${report.summary.PASS}; FAIL ${report.summary.FAIL}; GAP ${report.summary.GAP}; N/A ${report.summary["N/A"]}; required blockers ${report.summary.requiredBlockers}`,
    `Release gate: ${report.summary.releaseGate}`,
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  const ids = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      console.log(
        "Usage: node runner.mjs --package-root <installed-package> [--adapter <module>] [--id EE-*] [--category semantic|persistence|runtime|contract|saga|operations] [--json] [--out report.json] [--commit sha] [--tarball-sha256 hash] [--tarball-path file]",
      );
      return;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (
      ![
        "--package-root",
        "--adapter",
        "--id",
        "--category",
        "--out",
        "--commit",
        "--tarball-sha256",
        "--tarball-path",
      ].includes(arg) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error(`Unknown or missing argument: ${arg}`);
    const value = args[++i];
    if (arg === "--id") ids.push(value);
    else options[arg.slice(2)] = value;
  }
  if (!options["package-root"])
    throw new Error("--package-root must identify an installed package");
  const catalogBytes = await readFile(
    new URL("./catalog.json", import.meta.url),
  );
  const catalog = JSON.parse(catalogBytes);
  const module = await import(
    options.adapter
      ? pathToFileURL(resolve(options.adapter)).href
      : new URL("./adapters/vane.mjs", import.meta.url).href
  );
  const adapter = await module.createAdapter({
    packageRoot: options["package-root"],
  });
  adapter.databaseUrl = process.env.VANE_CONFORMANCE_DATABASE_URL;
  if (options["tarball-path"]) {
    const path = resolve(options["tarball-path"]);
    const hash = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (!options["tarball-sha256"] || hash !== options["tarball-sha256"])
      throw new Error("Tarball path must match declared integrity hash");
    adapter.tarballPath = path;
  }
  const report = await runSuite({
    catalog,
    adapter,
    ids,
    category: options.category,
    metadata: {
      commit: options.commit ?? null,
      tarballSha256: options["tarball-sha256"] ?? null,
      catalogSha256: createHash("sha256").update(catalogBytes).digest("hex"),
    },
  });
  const json = JSON.stringify(report, null, 2);
  if (options.out) await writeFile(resolve(options.out), `${json}\n`);
  console.log(options.json ? json : humanReport(report));
  process.exitCode = report.exitCode;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(`Conformance runner error: ${error.message}`);
    process.exitCode = 2;
  });
