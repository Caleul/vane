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
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
