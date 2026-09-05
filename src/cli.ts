#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { operationalCommand } from "./operational-cli.js";
import { generateServiceDeployment } from "./service-artifacts.js";
import {
  compileServiceConfiguration,
  serializeServicePlan,
  validateServiceConfiguration,
} from "./service-compiler.js";
import type { ServiceConfiguration } from "./service-configuration.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const options = new Map<string, string>();
  let json = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key && !key.startsWith("--")) {
      positional.push(key);
      continue;
    }
    if (key === "--json") {
      json = true;
      continue;
    }
    if (
      ![
        "--config",
        "--profile",
        "--out",
        "--previous",
        "--migration",
        "--approval",
        "--port",
        "--before",
        "--limit",
        "--offset",
      ].includes(key ?? "") ||
      !args[i + 1] ||
      args[i + 1]?.startsWith("--")
    )
      throw new Error();
    options.set(key as string, args[++i] as string);
  }
  if (
    ![
      "validate",
      "plan",
      "generate",
      "migrate",
      "dev",
      "inspect",
      "failures",
    ].includes(command ?? "") ||
    !options.has("--config")
  ) {
    console.error(
      "Usage: entity-event validate|plan|generate|migrate|dev|inspect|failures --config <configuration.mjs> [--profile <name>] [--out <new-directory>] [--json]",
    );
    process.exitCode = 1;
    return;
  }
  const loaded = (await import(
    pathToFileURL(resolve(options.get("--config") as string)).href
  )) as { default: ServiceConfiguration };
  const configuration = loaded.default;
  const profile = options.get("--profile");
  if (command === "validate" && !profile) {
    const result = validateServiceConfiguration(configuration);
    const valid =
      Object.keys(result).length > 0 &&
      Object.values(result).every((r) => r.success);
    console.log(
      JSON.stringify(
        {
          success: valid,
          profiles: Object.fromEntries(
            Object.entries(result).map(([key, r]) => [
              key,
              r.success ? { success: true, warnings: r.warnings } : r,
            ]),
          ),
        },
        null,
        json ? 0 : 2,
      ),
    );
    if (!valid) process.exitCode = 1;
    return;
  }
  if (!profile) throw new Error();
  if (["migrate", "dev", "inspect", "failures"].includes(command as string)) {
    await operationalCommand(
      command as string,
      positional,
      options,
      configuration,
      profile,
      json,
    );
    return;
  }
  if (positional.length) throw new Error();
  const result = compileServiceConfiguration(configuration, profile);
  if (!result.success) {
    console.log(JSON.stringify(result, null, json ? 0 : 2));
    process.exitCode = 1;
    return;
  }
  if (command === "plan") {
    console.log(
      json
        ? serializeServicePlan(result.plan)
        : JSON.stringify(result.plan, null, 2),
    );
    return;
  }
  if (command === "validate") {
    console.log(JSON.stringify({ success: true, warnings: result.warnings }));
    return;
  }
  const target = options.get("--out");
  if (!target) throw new Error();
  const output = resolve(target);
  // Publish one completed directory. mkdir reserves the target so existing files are never overwritten.
  const staging = resolve(dirname(output), `.vane-${randomUUID()}`);
  await mkdir(output);
  await mkdir(staging);
  try {
    const files = generateServiceDeployment(result.plan, configuration.project);
    for (const [name, content] of Object.entries(files))
      await writeFile(resolve(staging, name), content, { flag: "wx" });
    await rename(staging, output);
    console.log(
      JSON.stringify({
        success: true,
        inputHash: result.plan.inputHash,
        files: Object.keys(files).sort(),
        warnings: result.warnings,
      }),
    );
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rmdir(output).catch(() => {});
    throw error;
  }
}
void main().catch(() => {
  console.error(
    "Configuration command failed. Check arguments, the trusted configuration module and a new output directory. No secret values are printed.",
  );
  process.exitCode = 1;
});
