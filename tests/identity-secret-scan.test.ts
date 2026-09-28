import { describe, expect, it } from "vitest";
import { findSecretShapedContent } from "../services/kernel/src/identity/secret-scan.js";

describe("KJ-P7A findSecretShapedContent - identity documents get the same secret-shape screen as memory", () => {
  it("finds a secret nested anywhere in the document tree", () => {
    expect(findSecretShapedContent({ sections: { classA: { name: "sk-abcdefghijklmnopqrstuvwxyz0123456789" } } })).toBe("api-key");
    expect(findSecretShapedContent({ values: ["fine", "AKIAABCDEFGHIJKLMNOP"] })).toBe("aws-access-key");
  });

  it("clears an ordinary document with no secret-shaped content", () => {
    expect(findSecretShapedContent({ sections: { classA: { name: "Jai", values: ["rigour", "honesty"] } } })).toBeNull();
  });

  it("ignores non-string leaves (numbers, booleans, null) without throwing", () => {
    expect(findSecretShapedContent({ n: 1, b: true, nul: null, arr: [1, 2, { x: null }] })).toBeNull();
  });
});
