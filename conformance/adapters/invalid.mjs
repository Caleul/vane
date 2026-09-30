import { createAdapter as vane } from "./vane.mjs";

// Deliberately violate EE-ENT-002. All other public operations are unchanged.
export async function createAdapter(options) {
  const adapter = await vane(options);
  const original = adapter.api.compileSemanticIr;
  return {
    ...adapter,
    name: "deliberately-invalid-identity-adapter",
    api: {
      ...adapter.api,
      compileSemanticIr(declaration) {
        const mutated = structuredClone(declaration);
        for (const entity of mutated.entities ?? []) {
          if (!entity.columns.some((column) => column.identity)) {
            const id = entity.columns.find((column) => column.name === "id");
            if (id) id.identity = true;
          }
        }
        return original(mutated);
      },
    },
  };
}
