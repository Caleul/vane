import { hashSemanticModule } from "./module-fingerprint.js";
import type { SemanticModule } from "./semantic-ir.js";

/** Explicit import closure only; no implicit access to neighboring Modules. */
export function moduleScope(
  module: SemanticModule,
  modules: readonly SemanticModule[],
): readonly SemanticModule[] {
  const found = new Map<string, SemanticModule>();
  const visit = (m: SemanticModule) => {
    if (found.has(m.name)) return;
    found.set(m.name, m);
    for (const name of m.imports) {
      const imported = modules.find((m) => m.name === name);
      if (!imported) throw new Error("Missing imported Module.");
      visit(imported);
    }
  };
  visit(module);
  const scope = [...found.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const owners = new Set<string>();
  for (const visible of scope) {
    for (const owner of [
      ...visible.entities,
      ...visible.antiCorruptionLayers,
    ]) {
      if (owners.has(owner.name))
        throw new Error("Ambiguous imported Event owner.");
      owners.add(owner.name);
    }
  }
  return scope;
}

export function importedModuleHashes(
  module: SemanticModule,
  modules: readonly SemanticModule[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    moduleScope(module, modules)
      .filter((m) => m.name !== module.name)
      .map((m) => [m.name, hashSemanticModule(m)]),
  );
}
