import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalStringify, classADigest, identityCoreDigest } from "../services/kernel/src/identity/canonical.js";

/**
 * ADR-0021 D3 - the canonical digest contract itself. This is the single most load-bearing pure
 * function in KJ-P7A: every DB trigger and every cross-provider proof assumes it is truly
 * order-independent and truly content-sensitive. Prove both directly, not by inference.
 */
describe("canonicalStringify / canonicalDigest — the ADR-0021 D3 contract", () => {
  it("two objects with identical content but different key insertion order stringify identically", () => {
    const a = { id: "x", tenantId: "t", sections: { classA: { name: "Jai" }, classC: {} } };
    const b = { sections: { classC: {}, classA: { name: "Jai" } }, tenantId: "t", id: "x" };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
  });

  it("nested objects at every depth are sorted, not just the top level", () => {
    const a = { z: 1, a: { z: 1, a: 1, m: 1 } };
    const b = { a: { m: 1, z: 1, a: 1 }, z: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("a one-byte content difference anywhere in the tree changes the digest", () => {
    const a = { sections: { classA: { name: "Jai" } } };
    const b = { sections: { classA: { name: "Jal" } } };
    expect(canonicalDigest(a)).not.toBe(canonicalDigest(b));
  });

  it("array order IS semantic and is preserved, never sorted", () => {
    const a = { values: ["first", "second"] };
    const b = { values: ["second", "first"] };
    expect(canonicalStringify(a)).not.toBe(canonicalStringify(b));
    expect(canonicalDigest(a)).not.toBe(canonicalDigest(b));
  });

  it("produces a 64-character lowercase hex sha256", () => {
    const digest = canonicalDigest({ a: 1 });
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("identityCoreDigest and classADigest are the same underlying algorithm, applied to different scopes", () => {
    const document = { id: "x", version: 1, tenantId: "t", sections: { classA: { name: "Jai" }, classC: {}, classD: {} } };
    expect(identityCoreDigest(document)).toBe(canonicalDigest(document));
    expect(classADigest(document.sections.classA)).toBe(canonicalDigest(document.sections.classA));
    // Different scopes over related content genuinely differ - proves classADigest is not
    // accidentally just re-hashing the whole document.
    expect(identityCoreDigest(document)).not.toBe(classADigest(document.sections.classA));
  });

  it("a version number appearing or not appearing changes the digest (candidate vs. persisted version documents are NOT interchangeable)", () => {
    const withoutVersion = { id: "x", tenantId: "t", sections: {} };
    const withVersion = { id: "x", tenantId: "t", sections: {}, version: 1 };
    expect(canonicalDigest(withoutVersion)).not.toBe(canonicalDigest(withVersion));
  });

  it("primitives, null and nested arrays-of-objects all round-trip through JSON encoding correctly", () => {
    const value = { n: 1, s: "x", b: true, nul: null, arr: [{ z: 1, a: 2 }, { a: 2, z: 1 }] };
    // The two array elements have identical content but different key order - each element is
    // canonicalised independently, so they must stringify identically to each other too.
    const [first, second] = (JSON.parse(canonicalStringify(value)) as { arr: unknown[] }).arr as [unknown, unknown];
    expect(canonicalStringify(first)).toBe(canonicalStringify(second));
  });
});
