import { createHash } from "node:crypto";

/** Hashes normalized JSON values, never credentials. Receipt format v1. */
export function modelDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
