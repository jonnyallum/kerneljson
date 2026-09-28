import { looksLikeSecret } from "../../../memory/src/canonical/policy.js";

/**
 * KJ-P7A - identity documents are shown to models and to the operator in Telegram approval flows,
 * exactly the same exposure memory has (see ADR-0021's DB-authority list: "secrets rejected"). Reuses
 * looksLikeSecret from KJ-P5's memory policy directly rather than a second pattern set to maintain.
 */
export function findSecretShapedContent(document: unknown): string | null {
  if (typeof document === "string") return looksLikeSecret(document);
  if (Array.isArray(document)) {
    for (const item of document) {
      const found = findSecretShapedContent(item);
      if (found) return found;
    }
    return null;
  }
  if (document !== null && typeof document === "object") {
    for (const value of Object.values(document)) {
      const found = findSecretShapedContent(value);
      if (found) return found;
    }
  }
  return null;
}
