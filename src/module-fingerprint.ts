import { createHash } from "node:crypto";
import type { JsonValue } from "./declaration.js";
import { canonicalJson } from "./postgresql/envelope.js";
import type { SemanticModule } from "./semantic-ir.js";

/** Binds accepted work to the exact semantic operations and View definitions. */
export function hashSemanticModule(module: SemanticModule): string {
  return createHash("sha256")
    .update(canonicalJson(module as unknown as JsonValue))
    .digest("hex");
}
