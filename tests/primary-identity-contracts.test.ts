import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  IDENTITY_CHANGE_RECIPE,
  IdentityChangeRequest,
  IdentityClassA,
  IdentityDocument,
  IdentityDocumentDraft,
  parseIdentityChangeObjective,
} from "../packages/contracts/src/primary-identity.js";

/**
 * KJ-P7A contract tests for packages/contracts/src/primary-identity.ts. Pure schema behaviour only -
 * no DB, no workflow. See tests/identity-canonical.test.ts for the digest contract and
 * tests/identity-migration.integration.test.ts for the DB-enforced invariants these contracts feed.
 */

const classA = (over: Partial<ReturnType<typeof baseClassA>> = {}) => ({ ...baseClassA(), ...over });
function baseClassA() {
  return {
    name: "Jai",
    constitution: "Serve the operator honestly.",
    values: ["honesty", "rigour"],
    operatorRelationship: "Reports to Jonny.",
    facultyFraming: "Frames whichever faculty the kernel already selected.",
    memoryPolicy: "May narrow canonical memory, never widen it.",
  };
}
function baseDocument(overrides: { id?: string; tenantId?: string } = {}) {
  return {
    id: overrides.id ?? randomUUID(),
    tenantId: overrides.tenantId ?? randomUUID(),
    sections: {
      classA: classA(),
      classC: { persona: "warm, direct", communication: "plain", behaviour: "cautious", presentation: "concise" },
      classD: { objectives: ["ship KJ-P7"], vision: "A trustworthy operator partner." },
    },
  };
}

describe("IdentityDocumentDraft / IdentityDocument", () => {
  it("accepts a well-formed draft with no version", () => {
    expect(IdentityDocumentDraft.safeParse(baseDocument()).success).toBe(true);
  });

  it("rejects a draft that includes a version (candidates never know one)", () => {
    const withVersion = { ...baseDocument(), version: 1 };
    expect(IdentityDocumentDraft.safeParse(withVersion).success).toBe(false);
  });

  it("IdentityDocument requires a positive integer version", () => {
    const doc = { ...baseDocument(), version: 1 };
    expect(IdentityDocument.safeParse(doc).success).toBe(true);
    expect(IdentityDocument.safeParse({ ...baseDocument(), version: 0 }).success).toBe(false);
    expect(IdentityDocument.safeParse({ ...baseDocument(), version: -1 }).success).toBe(false);
    expect(IdentityDocument.safeParse({ ...baseDocument(), version: 1.5 }).success).toBe(false);
  });

  it("is strict: an unknown top-level key is rejected, not silently dropped", () => {
    expect(IdentityDocumentDraft.safeParse({ ...baseDocument(), extra: "x" }).success).toBe(false);
  });

  it("is strict inside sections too: an unknown key in classA is rejected", () => {
    const doc = baseDocument();
    (doc.sections.classA as Record<string, unknown>)["rogueField"] = "x";
    expect(IdentityDocumentDraft.safeParse(doc).success).toBe(false);
  });
});

describe("IdentityClassA values / IdentityClassD objectives are bounded list items, not paragraphs", () => {
  it("rejects a values array item over 300 characters (bounds worst-case document size)", () => {
    const over = classA({ values: ["x".repeat(301)] });
    expect(IdentityClassA.safeParse(over).success).toBe(false);
  });

  it("accepts a values array item at exactly 300 characters", () => {
    const at = classA({ values: ["x".repeat(300)] });
    expect(IdentityClassA.safeParse(at).success).toBe(true);
  });

  it("rejects more than 20 values", () => {
    const many = classA({ values: Array.from({ length: 21 }, (_, i) => `v${i}`) });
    expect(IdentityClassA.safeParse(many).success).toBe(false);
  });

  it("rejects an empty values array (min 1)", () => {
    expect(IdentityClassA.safeParse(classA({ values: [] })).success).toBe(false);
  });
});

describe("IdentityChangeRequest — discriminated PROPOSE / ROLLBACK", () => {
  it("parses a PROPOSE request", () => {
    const req = { kind: "PROPOSE", document: baseDocument(), reason: "bootstrap" };
    expect(IdentityChangeRequest.safeParse(req).success).toBe(true);
  });

  it("parses a ROLLBACK request", () => {
    const req = { kind: "ROLLBACK", toVersion: 2, reason: "revert a bad change" };
    expect(IdentityChangeRequest.safeParse(req).success).toBe(true);
  });

  it("rejects a PROPOSE request carrying toVersion, and a ROLLBACK request carrying document (strict per branch)", () => {
    expect(IdentityChangeRequest.safeParse({ kind: "PROPOSE", document: baseDocument(), reason: "x", toVersion: 2 }).success).toBe(false);
    expect(IdentityChangeRequest.safeParse({ kind: "ROLLBACK", toVersion: 1, reason: "x", document: baseDocument() }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(IdentityChangeRequest.safeParse({ kind: "DELETE", reason: "x" }).success).toBe(false);
  });

  it("rejects a non-positive or non-integer toVersion", () => {
    for (const bad of [0, -1, 1.5])
      expect(IdentityChangeRequest.safeParse({ kind: "ROLLBACK", toVersion: bad, reason: "x" }).success, String(bad)).toBe(false);
  });

  it("requires a non-empty reason, capped at 500 characters", () => {
    expect(IdentityChangeRequest.safeParse({ kind: "ROLLBACK", toVersion: 1, reason: "" }).success).toBe(false);
    expect(IdentityChangeRequest.safeParse({ kind: "ROLLBACK", toVersion: 1, reason: "x".repeat(501) }).success).toBe(false);
    expect(IdentityChangeRequest.safeParse({ kind: "ROLLBACK", toVersion: 1, reason: "x".repeat(500) }).success).toBe(true);
  });
});

describe("parseIdentityChangeObjective", () => {
  it("round-trips a valid PROPOSE request through JSON encoding", () => {
    const req = { kind: "PROPOSE" as const, document: baseDocument(), reason: "bootstrap" };
    const parsed = parseIdentityChangeObjective(JSON.stringify(req));
    expect(parsed).toEqual(req);
  });

  it("throws a clear error on malformed JSON, never silently coercing", () => {
    expect(() => parseIdentityChangeObjective("{not json")).toThrow(/JSON-encoded/);
  });

  it("throws (a zod error) on well-formed JSON that does not satisfy the schema", () => {
    expect(() => parseIdentityChangeObjective(JSON.stringify({ kind: "PROPOSE" }))).toThrow();
  });

  it("IDENTITY_CHANGE_RECIPE is the exact literal the gateway/compiler/planner all key off", () => {
    expect(IDENTITY_CHANGE_RECIPE).toBe("identity-change/v1");
  });
});

describe("worst-case document size stays within the gateway's MAX_BODY_BYTES (65536)", () => {
  it("a maximally-sized PROPOSE request's JSON encoding fits comfortably under the cap", () => {
    const maxClassA = {
      name: "x".repeat(100),
      constitution: "x".repeat(4000),
      values: Array.from({ length: 20 }, () => "x".repeat(300)),
      operatorRelationship: "x".repeat(4000),
      facultyFraming: "x".repeat(4000),
      memoryPolicy: "x".repeat(4000),
    };
    const maxClassC = { persona: "x".repeat(4000), communication: "x".repeat(4000), behaviour: "x".repeat(4000), presentation: "x".repeat(4000) };
    const maxClassD = { objectives: Array.from({ length: 20 }, () => "x".repeat(300)), vision: "x".repeat(4000) };
    const doc = { id: randomUUID(), tenantId: randomUUID(), sections: { classA: maxClassA, classC: maxClassC, classD: maxClassD } };
    expect(IdentityDocumentDraft.safeParse(doc).success).toBe(true);
    const encoded = JSON.stringify({ kind: "PROPOSE", document: doc, reason: "x".repeat(500) });
    expect(encoded.length).toBeLessThan(65536);
  });
});
