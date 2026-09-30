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

/**
 * KJ-P7B-1 (ADR-0022 section 7) - the versioned contract `kerneljson:identity-core/v1`, twin of the SQL function
 * kernel_private.identity_core_canonical_v1. For every value the database can hold, its bytes are exactly
 * canonicalStringify's, so the P7A functions above keep their meaning. It additionally REFUSES what the SQL twin
 * refuses (a non-integer or unsafe number, a non-ASCII or NUL object key) and what the database cannot store (a NUL
 * or lone surrogate in a string), so the two twins can never silently disagree. Its semantics are frozen: a v2 is a
 * new function, never an edit to this one.
 */
export const IDENTITY_CORE_DIGEST_CONTRACT_V1 = "kerneljson:identity-core/v1";

export class IdentityCanonicalRefusal extends Error {}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function assertCanonicalV1(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value) || value.includes("\u0000")) throw new IdentityCanonicalRefusal(`IDENTITY_CANONICAL_STRING at ${path}`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new IdentityCanonicalRefusal(`IDENTITY_CANONICAL_NON_INTEGER at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertCanonicalV1(item, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if ([...key].some((ch) => ch.charCodeAt(0) === 0 || ch.charCodeAt(0) > 0x7f)) throw new IdentityCanonicalRefusal(`IDENTITY_CANONICAL_NON_ASCII_KEY at ${path}`);
      if (item === undefined) throw new IdentityCanonicalRefusal(`IDENTITY_CANONICAL_UNDEFINED at ${path}.${key}`);
      assertCanonicalV1(item, `${path}.${key}`);
    }
    return;
  }
  throw new IdentityCanonicalRefusal(`IDENTITY_CANONICAL_TYPE at ${path}`);
}

export function identityCoreCanonicalV1(value: unknown): string {
  assertCanonicalV1(value, "$");
  return canonicalStringify(value);
}

export function identityCoreDigestV1(value: unknown): string {
  return createHash("sha256").update(identityCoreCanonicalV1(value), "utf8").digest("hex");
}
