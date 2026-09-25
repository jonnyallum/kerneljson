import { createHash } from "node:crypto";

/**
 * ADR-0021 D3 - the identity digest contract is this function, deliberately, not an accident of
 * JSON.stringify's insertion-order-dependent output or Postgres jsonb::text's unspecified key
 * ordering. Object keys are sorted recursively at every depth; arrays keep their given order
 * (order is semantic there - e.g. IdentityClassA.values); primitives use JSON's own encoding.
 * Two documents with identical meaning and different incidental key order MUST digest identically;
 * a one-byte content difference anywhere MUST digest differently. See canonical.test.ts.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

/** identity_core_digest: over the whole document (id, version if present, tenantId, sections). */
export function identityCoreDigest(document: unknown): string {
  return canonicalDigest(document);
}

/** class_a_digest: over Class A content alone - the exact bytes a Class C/D change must never touch. */
export function classADigest(classA: unknown): string {
  return canonicalDigest(classA);
}
