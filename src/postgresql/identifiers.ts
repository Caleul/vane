import { createHash } from "node:crypto";

export const POSTGRESQL_IDENTIFIER_MAX_BYTES = 63;

export function quotePostgreSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function quotePostgreSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function toPostgreSqlIdentifier(
  parts: readonly string[],
  prefix?: string,
): string {
  const normalized = parts
    .map(toSnakeCase)
    .filter((part) => part.length > 0)
    .join("__");
  const candidate = prefix ? `${prefix}_${normalized}` : normalized;
  return fitPostgreSqlIdentifier(candidate || "vane_object");
}

export function fitPostgreSqlIdentifier(identifier: string): string {
  if (Buffer.byteLength(identifier, "utf8") <= POSTGRESQL_IDENTIFIER_MAX_BYTES)
    return identifier;

  const suffix = `_${stableHash(identifier).slice(0, 10)}`;
  const maximumPrefixBytes =
    POSTGRESQL_IDENTIFIER_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  let prefix = "";
  for (const character of identifier) {
    if (Buffer.byteLength(`${prefix}${character}`, "utf8") > maximumPrefixBytes)
      break;
    prefix += character;
  }
  return `${prefix}${suffix}`;
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toSnakeCase(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
