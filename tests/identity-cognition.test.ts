import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  IdentityCognitionPin,
  ModelCallBinding,
  type IdentityDocument,
} from "../packages/contracts/src/index.js";
import type { FacultyPin } from "../packages/contracts/src/faculty.js";
import { canonicalDigest, canonicalStringify, identityCoreCanonicalV1, identityCoreDigest, identityCoreDigestV1 } from "../services/kernel/src/identity/canonical.js";
import {
  IDENTITY_BLOCK_BEGIN,
  IdentityCognitionRefusal,
  assertProjectionWithinCap,
  countIdentityBlocks,
  projectIdentity,
  projectionBytes,
  projectionDigest,
  renderIdentityBlock,
} from "../services/kernel/src/identity/projection.js";
import { identityFramingCeiling } from "../services/kernel/src/faculty/identity-ceiling.js";
import { assembleAnalystRequest, type AnalystCognition } from "../services/kernel/src/mission/analyst-assembly.js";
import { assemblyDigestOf, continuityDigestOf } from "../services/kernel/src/mission/cognition-digests.js";
import { projectFacultyRequest } from "../services/kernel/src/faculty/policy.js";
import { reviewerRequest } from "../services/kernel/src/mission/prompts.js";
import { modelDigest } from "../packages/models/src/digest.js";
import { parseIdentityCognitionEnabled } from "../services/kernel/src/identity/cognition-binding.js";
import { provenanceOf, verifyIdentityEvidence, type IdentityCompletionFacts } from "../services/kernel/src/identity/evidence-verify.js";
import { reduceCheck } from "../services/kernel/src/alerting/reducer.js";
import { resolvePolicy } from "../services/kernel/src/alerting/policy.js";
import { evaluateIdentity } from "../services/kernel/src/health/evaluate.js";
import type { IdentitySnapshot } from "../services/kernel/src/health/snapshot.js";
import type { CheckResult } from "../services/kernel/src/health/types.js";
import { GOLDEN_CASES, GOLDEN_IDS, goldenAnalystInput, goldenPins, loadTree, providerBodies } from "./support/p7b-off-golden.js";

/**
 * KJ-P7B-1 pure qualification (ADR-0022, D1 erratum): the TypeScript digest twin against the shared corpus, the narrow
 * projection, the single assembler (OFF byte-equality against release 4127361, ON determinism), D9 assembly and
 * continuity digests, the pure completion verifier, the identity alert policy and the identity health checks.
 */
const corpus = JSON.parse(readFileSync("tests/fixtures/identity-core-v1.vectors.json", "utf8")) as {
  vectors: Array<{ name: string; inputJson: string; canonical?: string; sha256?: string; classASha256?: string; refuse?: string }>;
};
const golden = JSON.parse(readFileSync("tests/fixtures/p7b-off-golden.json", "utf8")) as {
  capturedFrom: string;
  cases: Record<string, { analystRequest: string; reviewerRequest: string; analystBodies: { deepseek: string; openrouter: string } }>;
};
const vector = (name: string) => corpus.vectors.find((v) => v.name === name)!;
const KERNEL_V1 = JSON.parse(vector("kernel-v1-activated").inputJson) as IdentityDocument;
const VERSION_ROW_ID = "08be5e20-2606-4809-b81f-11552bb67502";

const tree = await loadTree(".");
const pins = goldenPins(tree) as unknown as { analyst: FacultyPin; reviewer: FacultyPin };
const INTELLIGENCE = identityFramingCeiling("intelligence", "faculty-routing/v1");

function kernelPin(doc: IdentityDocument = KERNEL_V1): IdentityCognitionPin {
  const projection = projectIdentity(doc, "ANALYST_INTELLIGENCE_V1", INTELLIGENCE);
  return IdentityCognitionPin.parse({
    tenantId: GOLDEN_IDS.tenant, taskId: GOLDEN_IDS.task, stepId: GOLDEN_IDS.analystStep,
    identityId: doc.id, identityVersionId: VERSION_ROW_ID, identityVersion: doc.version,
    identityCoreDigest: identityCoreDigestV1(doc), classADigest: identityCoreDigestV1(doc.sections.classA),
    digestContract: "kerneljson:identity-core/v1", projectionSchema: "kerneljson:identity-projection/v1",
    projectionProfile: "ANALYST_INTELLIGENCE_V1", projection, projectionBytes: projectionBytes(projection),
    projectionDigest: projectionDigest(projection), facultyId: "intelligence", facultyVersion: pins.analyst.faculty.version,
    facultyDigest: pins.analyst.facultyDigest, mode: "REQUIRED",
  });
}
const assemble = (cognition: AnalystCognition, caseName = "faculty-no-memory", facultyPin: FacultyPin | null = pins.analyst) => {
  const c = GOLDEN_CASES.find((x) => x.name === caseName)!;
  return assembleAnalystRequest({
    request: goldenAnalystInput(tree, c) as Parameters<typeof assembleAnalystRequest>[0]["request"],
    recipe: "repo-analysis-mission/v1", repo: "jonnyallum/kerneljson", facultyPin, cognition, memoryAssemblyDigest: null,
  });
};
const refusal = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error instanceof IdentityCognitionRefusal ? error.code : `OTHER:${String(error)}`; }
  return "NO_REFUSAL";
};

describe("G1 kerneljson:identity-core/v1 - the TypeScript twin against the shared corpus", () => {
  for (const v of corpus.vectors) {
    it(v.refuse ? `refuses ${v.name}` : `reproduces ${v.name}`, () => {
      const value = JSON.parse(v.inputJson);
      if (v.refuse) {
        expect(() => identityCoreCanonicalV1(value)).toThrow(v.refuse);
        return;
      }
      expect(identityCoreCanonicalV1(value)).toBe(v.canonical);
      expect(identityCoreDigestV1(value)).toBe(v.sha256);
      // The P7A function's meaning is frozen: for every storable value it equals v1.
      expect(identityCoreDigest(value)).toBe(v.sha256);
      if (v.classASha256) expect(identityCoreDigestV1(value.sections.classA)).toBe(v.classASha256);
    });
  }
  it("pins the three production Kernel v1 digests", () => {
    expect(vector("kernel-v1-draft").sha256).toBe("01998d0145dc5d69f4c8220603c3839b6cab227d177b8f54a7d4847ffe41d66a");
    expect(vector("kernel-v1-activated").sha256).toBe("4f6dc581f06701c207d5cdf8bc1ced59fa0741c15bab18c30537d0b17a7bf9ed");
    expect(vector("kernel-v1-class-a").sha256).toBe("c1e3d107616db8ebf4586121d62eb2c6dd966351e2e11de3949a253ce6158dc6");
    expect(vector("kernel-v1-class-c-only").classASha256).toBe(vector("kernel-v1-activated").classASha256);
    expect(vector("kernel-v1-class-d-only").classASha256).toBe(vector("kernel-v1-activated").classASha256);
    expect(vector("kernel-v1-class-a-one-byte").classASha256).not.toBe(vector("kernel-v1-activated").classASha256);
  });
  it("refuses what the database cannot hold: a NUL, a lone surrogate, a non-plain value", () => {
    expect(() => identityCoreCanonicalV1({ s: "a\u0000b" })).toThrow("IDENTITY_CANONICAL_STRING");
    expect(() => identityCoreCanonicalV1({ s: "\ud83d" })).toThrow("IDENTITY_CANONICAL_STRING");
    expect(() => identityCoreCanonicalV1({ d: new Date(0) })).toThrow("IDENTITY_CANONICAL_TYPE");
    expect(() => identityCoreCanonicalV1({ u: undefined })).toThrow("IDENTITY_CANONICAL_UNDEFINED");
  });
});

describe("B1 narrow-only projection (ANALYST_INTELLIGENCE_V1)", () => {
  it("projects Class A whole and exactly persona/communication/behaviour; never presentation or Class D", () => {
    const p = projectIdentity(KERNEL_V1, "ANALYST_INTELLIGENCE_V1", INTELLIGENCE);
    expect(Object.keys(p.sections.classA).sort()).toEqual(["constitution", "facultyFraming", "memoryPolicy", "name", "operatorRelationship", "values"]);
    expect(Object.keys(p.sections.classC).sort()).toEqual(["behaviour", "communication", "persona"]);
    expect(p.sections).not.toHaveProperty("classD");
    const bytes = canonicalStringify(p);
    expect(bytes).not.toContain(KERNEL_V1.sections.classC.presentation);
    expect(bytes).not.toContain(KERNEL_V1.sections.classD.vision);
    for (const o of KERNEL_V1.sections.classD.objectives) expect(bytes).not.toContain(o);
    expect(identityCoreDigestV1(p.sections.classA)).toBe(vector("kernel-v1-class-a").sha256);
    expect(p.identity).toEqual({ id: KERNEL_V1.id, version: 1, identityCoreDigest: vector("kernel-v1-activated").sha256, digestContract: "kerneljson:identity-core/v1" });
  });
  it("fails closed on a missing profile, the verifier ceiling, an unknown faculty or policy, or a split Class A", () => {
    expect(refusal(() => projectIdentity(KERNEL_V1, "REVIEWER_V1", INTELLIGENCE))).toBe("IDENTITY_PROFILE_MISSING");
    expect(identityFramingCeiling("verifier", "faculty-routing/v1")).toEqual([]);
    expect(refusal(() => projectIdentity(KERNEL_V1, "ANALYST_INTELLIGENCE_V1", identityFramingCeiling("verifier", "faculty-routing/v1")))).toBe("IDENTITY_SCOPE_EMPTY");
    expect(refusal(() => projectIdentity(KERNEL_V1, "ANALYST_INTELLIGENCE_V1", identityFramingCeiling("architect", "faculty-routing/v1")))).toBe("IDENTITY_SCOPE_EMPTY");
    expect(refusal(() => projectIdentity(KERNEL_V1, "ANALYST_INTELLIGENCE_V1", identityFramingCeiling("intelligence", "faculty-routing/v2")))).toBe("IDENTITY_SCOPE_EMPTY");
    expect(refusal(() => projectIdentity(KERNEL_V1, "ANALYST_INTELLIGENCE_V1", INTELLIGENCE.filter((p) => p !== "classA.memoryPolicy")))).toBe("IDENTITY_SCOPE_CLASS_A_INCOMPLETE");
    // A ceiling wider than the profile never widens the projection.
    const wide = projectIdentity(KERNEL_V1, "ANALYST_INTELLIGENCE_V1", [...INTELLIGENCE, "classC.presentation", "classD.vision"]);
    expect(canonicalStringify(wide)).toBe(canonicalStringify(projectIdentity(KERNEL_V1, "ANALYST_INTELLIGENCE_V1", INTELLIGENCE)));
  });
  it("never rewrites governed bytes: a document the contracts would trim is refused, not normalised", () => {
    const padded = structuredClone(KERNEL_V1);
    padded.sections.classC.persona = ` ${padded.sections.classC.persona}`;
    expect(refusal(() => projectIdentity(padded, "ANALYST_INTELLIGENCE_V1", INTELLIGENCE))).toBe("IDENTITY_DOCUMENT_NOT_CANONICAL");
  });
  it("measures the 16 KiB cap in UTF-8 bytes of the canonical projection, and refuses over it without truncating", () => {
    expect(projectionBytes(projectIdentity(KERNEL_V1, "ANALYST_INTELLIGENCE_V1", INTELLIGENCE))).toBeLessThan(16384);
    const big = structuredClone(KERNEL_V1);
    big.sections.classA.constitution = "é".repeat(4000); // 4000 chars, 8000 bytes
    big.sections.classA.operatorRelationship = "€".repeat(3000); // 3000 chars, 9000 bytes
    const p = projectIdentity(big, "ANALYST_INTELLIGENCE_V1", INTELLIGENCE);
    expect(canonicalStringify(p).length).toBeLessThan(16384); // a character count would wrongly pass it
    expect(projectionBytes(p)).toBeGreaterThan(16384);
    expect(refusal(() => assertProjectionWithinCap(p))).toBe("IDENTITY_PROJECTION_TOO_LARGE");
    expect(() => IdentityCognitionPin.parse({ ...kernelPin(), projection: p, projectionBytes: projectionBytes(p) })).toThrow();
  });
});

describe("B3 the one analyst assembler - OFF is byte-identical to release 4127361", () => {
  it("the golden fixture was captured from the production release tree", () => {
    expect(golden.capturedFrom).toBe("4127361860700085453f86aa09adfa7bf81ef7d3");
    expect(Object.keys(golden.cases).sort()).toEqual(GOLDEN_CASES.map((c) => c.name).sort());
  });
  for (const c of GOLDEN_CASES) {
    for (const kind of c.faculty ? (["LEGACY", "NONE"] as const) : (["LEGACY"] as const)) {
      it(`${c.name} (${kind}): request object and both provider HTTP bodies are byte-equal`, async () => {
        const assembled = assemble({ kind }, c.name, c.faculty ? pins.analyst : null);
        expect(JSON.stringify(assembled.request)).toBe(golden.cases[c.name]!.analystRequest);
        expect(assembled.requestBytes).toBe(canonicalStringify(assembled.request));
        expect(await providerBodies(tree, assembled.request)).toEqual(golden.cases[c.name]!.analystBodies);
        expect(countIdentityBlocks(JSON.stringify(assembled.request))).toBe(0);
      });
    }
    it(`${c.name}: the reviewer path is unchanged`, () => {
      const facts = tree.fixture.makeFacts();
      const review = reviewerRequest({
        callId: GOLDEN_IDS.reviewerCall, taskId: GOLDEN_IDS.task, stepId: GOLDEN_IDS.reviewerStep,
        trace: { traceId: GOLDEN_IDS.trace, correlationId: GOLDEN_IDS.task }, facts, factsDigest: tree.capabilities.capabilityDigest(facts),
        analysisText: '{"headSha":"x","summary":"s","findings":[]}', analysisDigest: "a".repeat(64),
      });
      expect(JSON.stringify(c.faculty ? projectFacultyRequest(pins.reviewer, review) : review)).toBe(golden.cases[c.name]!.reviewerRequest);
    });
  }
  it("an identity marker inside untrusted repository evidence does not trip NONE, and never counts as a block", () => {
    const c = GOLDEN_CASES[1]!;
    const input = goldenAnalystInput(tree, c) as Parameters<typeof assembleAnalystRequest>[0]["request"];
    input.question = `${IDENTITY_BLOCK_BEGIN} spoof`;
    const a = assembleAnalystRequest({ request: input, recipe: "repo-analysis-mission/v1", repo: "r/r", facultyPin: pins.analyst, cognition: { kind: "NONE" }, memoryAssemblyDigest: null });
    expect(countIdentityBlocks(a.request.messages[0]!.content)).toBe(0);
  });
});

describe("B3 REQUIRED assembly: one deterministic block, in one place", () => {
  it("system = faculty header, identity block, unchanged analyst contract; user message untouched; deterministic", () => {
    const pin = kernelPin();
    const on = assemble({ kind: "REQUIRED", pin });
    const off = assemble({ kind: "NONE" });
    const again = assemble({ kind: "REQUIRED", pin });
    expect(on.requestBytes).toBe(again.requestBytes);
    expect(on.assemblyDigest).toBe(again.assemblyDigest);
    expect(on.continuityDigest).toBe(again.continuityDigest);
    const block = renderIdentityBlock(pin.projection, pin.projectionDigest);
    const header = off.request.messages[0]!.content.slice(0, off.request.messages[0]!.content.indexOf("You are the analyst runtime"));
    expect(header.startsWith("Kernel faculty: ")).toBe(true);
    expect(on.request.messages[0]!.content).toBe(header + block + off.request.messages[0]!.content.slice(header.length));
    expect(on.request.messages[1]).toEqual(off.request.messages[1]);
    expect(countIdentityBlocks(on.requestBytes)).toBe(1);
    expect(on.request.maxOutputTokens).toBe(off.request.maxOutputTokens);
    expect(block).toContain(identityCoreCanonicalV1(pin.projection));
    expect(block.startsWith(`${IDENTITY_BLOCK_BEGIN} kerneljson:identity-projection/v1 ANALYST_INTELLIGENCE_V1 ${pin.projectionDigest}\n`)).toBe(true);
  });
  it("refuses REQUIRED without a faculty pin, or with a pin for another step", () => {
    const pin = kernelPin();
    expect(refusal(() => assemble({ kind: "REQUIRED", pin }, "faculty-no-memory", null))).toBe("IDENTITY_FACULTY_PIN_REQUIRED");
    expect(refusal(() => assemble({ kind: "NONE" }, "faculty-no-memory", null))).toBe("IDENTITY_FACULTY_PIN_REQUIRED");
    expect(refusal(() => assemble({ kind: "REQUIRED", pin: { ...pin, stepId: GOLDEN_IDS.reviewerStep } }))).toBe("IDENTITY_PIN_BINDING_REFUSED");
  });
});

describe("D9 assembly_digest and continuity_digest", () => {
  it("changes with one byte of any message or the output budget, and with nothing else", () => {
    const base = assemble({ kind: "REQUIRED", pin: kernelPin() }).request;
    const d = assemblyDigestOf(base);
    const sys = structuredClone(base); sys.messages[0]!.content += "x";
    const usr = structuredClone(base); usr.messages[1]!.content = usr.messages[1]!.content.replace("Question:", "Question;");
    expect(assemblyDigestOf(sys)).not.toBe(d);
    expect(assemblyDigestOf(usr)).not.toBe(d);
    expect(assemblyDigestOf({ ...base, maxOutputTokens: base.maxOutputTokens - 1 })).not.toBe(d);
    // The execution envelope is excluded: a fresh mission's ids do not change the D9 digest...
    const fresh = { ...base, callId: "88888888-8888-4888-8888-888888888888", taskId: "99999999-9999-4999-8999-999999999999", trace: { traceId: GOLDEN_IDS.task, correlationId: GOLDEN_IDS.trace } };
    expect(assemblyDigestOf(fresh)).toBe(d);
    // ...while request_digest still binds the full ModelRequest, provider and model per call.
    expect(modelDigest({ provider: "deepseek", model: "deepseek-v4-flash", request: base })).not.toBe(modelDigest({ provider: "deepseek", model: "deepseek-v4-flash", request: fresh }));
  });
  it("G5 in CI: two providers, same inputs - assembly and continuity equal, request_digest differs", () => {
    const openrouterPin = { ...pins.analyst, provider: "openrouter", model: "anthropic/claude-test" } as FacultyPin;
    const a = assemble({ kind: "REQUIRED", pin: kernelPin() });
    const b = assemble({ kind: "REQUIRED", pin: kernelPin() }, "faculty-no-memory", openrouterPin);
    expect(b.assemblyDigest).toBe(a.assemblyDigest);
    expect(b.continuityDigest).toBe(a.continuityDigest);
    expect(modelDigest({ provider: "openrouter", model: "anthropic/claude-test", request: b.request }))
      .not.toBe(modelDigest({ provider: "deepseek", model: "deepseek-v4-flash", request: a.request }));
  });
  it("continuity binds identity, faculty, memory and the D9 assembly digest", () => {
    const input = {
      mission: { recipe: "r", question: "q", contractDigest: "c".repeat(64), repo: "o/r", factsDigest: "f".repeat(64) },
      faculty: { id: "intelligence", version: 1, digest: "d".repeat(64) },
      identity: null, memory: null, assemblyDigest: "a".repeat(64),
    };
    const d = continuityDigestOf(input);
    expect(continuityDigestOf({ ...input, memory: { assemblyDigest: "b".repeat(64) } })).not.toBe(d);
    expect(continuityDigestOf({ ...input, assemblyDigest: "e".repeat(64) })).not.toBe(d);
    expect(continuityDigestOf({ ...input, faculty: { ...input.faculty, version: 2 } })).not.toBe(d);
    expect(continuityDigestOf({ ...input, identity: { mode: "REQUIRED", identityCoreDigest: "1".repeat(64), projectionProfile: "ANALYST_INTELLIGENCE_V1", projectionDigest: "2".repeat(64) } })).not.toBe(d);
  });
});

describe("completion: verifyIdentityEvidence (pure) - evidence == MODEL_CALLED binding == latch/pin", () => {
  // Build projections inside tests: a broken projection must fail a test, not abort test collection.
  const pin = kernelPin;
  const binding = (mode: "NONE" | "REQUIRED", over: Partial<ModelCallBinding> = {}) => ({ status: "RUNNING", binding: ModelCallBinding.parse({
    contract: "kerneljson:model-call-binding/v1", task_id: GOLDEN_IDS.task, step_id: GOLDEN_IDS.analystStep, call_id: GOLDEN_IDS.analystCall,
    provider: "deepseek", model: "deepseek-v4-flash", status: "SUCCEEDED", request_digest: "1".repeat(64), assembly_digest: "2".repeat(64),
    continuity_digest: "3".repeat(64), identity_cognition_mode: mode, ...over,
  }) });
  const record = (source: string, stepId: string, metadata: Record<string, unknown>) => ({
    id: crypto.randomUUID(), taskId: GOLDEN_IDS.task, stepId, type: "ARTIFACT", source, digest: "9".repeat(64), capturedAt: "2026-09-30T00:00:00.000Z", metadata,
  });
  const analystMeta = (mode: "NONE" | "REQUIRED", over: Record<string, unknown> = {}) => ({
    call_id: GOLDEN_IDS.analystCall, provider: "deepseek", model: "deepseek-v4-flash", request_digest: "1".repeat(64),
    assembly_digest: "2".repeat(64), continuity_digest: "3".repeat(64), identity_cognition_mode: mode,
    identity: mode === "REQUIRED" ? provenanceOf(pin()) : null, ...over,
  });
  const facts = (mode: "NONE" | "REQUIRED", over: Partial<IdentityCompletionFacts> = {}, meta: Record<string, unknown> = {}): IdentityCompletionFacts => ({
    contractStartEpoch: 13, bindingEpoch: 13, analystStepId: GOLDEN_IDS.analystStep,
    latches: [{ tenant_id: GOLDEN_IDS.tenant, task_id: GOLDEN_IDS.task, step_id: GOLDEN_IDS.analystStep, mode, release_epoch: "13" }],
    pins: mode === "REQUIRED" ? [pin()] : [],
    modelCalls: [binding(mode)],
    evidence: [record("kerneljson:runtime/analyst", GOLDEN_IDS.analystStep, analystMeta(mode, meta)),
      record("kerneljson:runtime/reviewer", GOLDEN_IDS.reviewerStep, { identity_cognition_mode: "NONE" })],
    ...over,
  });
  it("accepts NONE and REQUIRED contract tasks, and a legacy task with no cognition state", () => {
    expect(() => verifyIdentityEvidence(facts("NONE"))).not.toThrow();
    expect(() => verifyIdentityEvidence(facts("REQUIRED"))).not.toThrow();
    const legacy = { contractStartEpoch: 13, bindingEpoch: 12, analystStepId: GOLDEN_IDS.analystStep, latches: [], pins: [], modelCalls: [], evidence: [record("kerneljson:runtime/analyst", GOLDEN_IDS.analystStep, { call_id: GOLDEN_IDS.analystCall })] };
    expect(() => verifyIdentityEvidence(legacy)).not.toThrow();
    expect(() => verifyIdentityEvidence({ ...legacy, contractStartEpoch: null, bindingEpoch: 13 })).not.toThrow();
    expect(() => verifyIdentityEvidence({ ...legacy, bindingEpoch: null })).not.toThrow();
  });
  const rejects: Array<[string, () => IdentityCompletionFacts]> = [
    ["a contract task with no latch", () => facts("NONE", { latches: [] })],
    ["a contract task with no MODEL_CALLED binding", () => facts("NONE", { modelCalls: [] })],
    ["a call_id mismatch", () => facts("NONE", {}, { call_id: "88888888-8888-4888-8888-888888888888" })],
    ["a request_digest mismatch", () => facts("NONE", {}, { request_digest: "4".repeat(64) })],
    ["an assembly_digest mismatch", () => facts("REQUIRED", {}, { assembly_digest: "4".repeat(64) })],
    ["a continuity_digest mismatch", () => facts("REQUIRED", {}, { continuity_digest: "4".repeat(64) })],
    ["a provider mismatch", () => facts("NONE", {}, { provider: "openrouter" })],
    ["evidence mode differing from the latch", () => facts("NONE", {}, { identity_cognition_mode: "REQUIRED" })],
    ["REQUIRED evidence identity differing from the pin", () => facts("REQUIRED", {}, { identity: { ...provenanceOf(pin()), identity_version: 2 } })],
    ["REQUIRED with no identity evidence", () => facts("REQUIRED", {}, { identity: null })],
    ["REQUIRED with no pin", () => facts("REQUIRED", { pins: [] })],
    ["NONE with a pin", () => facts("NONE", { pins: [pin()] })],
    ["NONE carrying identity", () => facts("NONE", {}, { identity: provenanceOf(pin()) })],
    ["a latch bound to another release epoch", () => facts("NONE", { latches: [{ tenant_id: GOLDEN_IDS.tenant, task_id: GOLDEN_IDS.task, step_id: GOLDEN_IDS.analystStep, mode: "NONE", release_epoch: 14 }] })],
    ["a legacy task carrying a latch", () => facts("NONE", { bindingEpoch: 12, modelCalls: [], evidence: [] })],
    ["reviewer evidence carrying identity", () => facts("NONE", { evidence: [record("kerneljson:runtime/analyst", GOLDEN_IDS.analystStep, analystMeta("NONE")), record("kerneljson:runtime/reviewer", GOLDEN_IDS.reviewerStep, { identity_cognition_mode: "NONE", identity: null })] })],
    ["a binding whose mode differs", () => facts("NONE", { modelCalls: [binding("REQUIRED")] })],
  ];
  for (const [label, f] of rejects) it(`refuses ${label}`, () => expect(() => verifyIdentityEvidence(f())).toThrow(/Identity completion verification failed|Invalid/));
  it("the MODEL_CALLED payload is strict: no messages, prompt or memory text can ride in it", () => {
    expect(() => ModelCallBinding.parse({ ...binding("NONE").binding, messages: [{ role: "user", content: "x" }] })).toThrow();
    expect(Object.keys(binding("NONE").binding).sort()).toEqual(["assembly_digest", "call_id", "continuity_digest", "contract", "identity_cognition_mode", "model", "provider", "request_digest", "status", "step_id", "task_id"]);
  });
});

describe("G2 identity alert policy: explicit rows, silent NO_OBSERVATION, loud real incidents", () => {
  const IDS = ["identity.completedTasksHaveActivation", "identity.profilesHaveActivatedIdentity", "identity.currentDigestParity",
    "identity.singleCurrentPerTenant", "identity.headEqualsCurrent", "identity.analystRunsBound", "identity.verifierIsolated"];
  const check = (id: string, status: CheckResult["status"]): CheckResult => ({ id, status, evidence: "e", message: "m", checkedAt: "2026-09-30T00:00:00.000Z" });
  it("every identity check has its own explicit row - never the generic fallback", () => {
    for (const id of IDS) expect(resolvePolicy(id).checkId).toBe(id);
    expect(resolvePolicy("identity.analystRunsBound").severityFor("CRITICAL")).toBe("P0");
    expect(resolvePolicy("identity.singleCurrentPerTenant").severityFor("CRITICAL")).toBe("P0");
    expect(resolvePolicy("identity.verifierIsolated").severityFor("CRITICAL")).toBe("P1");
    expect(resolvePolicy("identity.completedTasksHaveActivation").severityFor("CRITICAL")).toBe("P1");
    expect(resolvePolicy("identity.profilesHaveActivatedIdentity").severityFor("DEGRADED")).toBe("P2");
    for (const id of IDS) expect(resolvePolicy(id).severityFor("UNKNOWN")).toBe("P3");
  });
  it("a NO_OBSERVATION episode is tracked at P3, never notified, and recovers silently", () => {
    const opened = reduceCheck(null, check("identity.analystRunsBound", "UNKNOWN"), "s", "2026-09-30T00:00:00.000Z");
    expect(opened.decision).toMatchObject({ kind: "NEW", severity: "P3", notify: false });
    const closed = reduceCheck(opened.nextRow, check("identity.analystRunsBound", "HEALTHY"), "s", "2026-09-30T00:05:00.000Z");
    expect(closed.decision).toMatchObject({ kind: "RECOVERED", notify: false });
  });
  it("a real P0 notifies, escalating out of a silent P3, and its recovery is announced", () => {
    const quiet = reduceCheck(null, check("identity.analystRunsBound", "UNKNOWN"), "s", "2026-09-30T00:00:00.000Z");
    const loud = reduceCheck(quiet.nextRow, check("identity.analystRunsBound", "CRITICAL"), "s", "2026-09-30T00:01:00.000Z");
    expect(loud.decision).toMatchObject({ kind: "ESCALATED", severity: "P0", notify: true });
    const back = reduceCheck(loud.nextRow, check("identity.analystRunsBound", "HEALTHY"), "s", "2026-09-30T00:02:00.000Z");
    expect(back.decision).toMatchObject({ kind: "RECOVERED", notify: true });
    expect(reduceCheck(null, check("identity.analystRunsBound", "CRITICAL"), "s", "2026-09-30T00:00:00.000Z").decision).toMatchObject({ kind: "NEW", severity: "P0", notify: true });
  });
  it("existing checks keep their exact behaviour", () => {
    const a = reduceCheck(null, check("authority.bindingReleaseConsistent", "UNKNOWN"), "s", "2026-09-30T00:00:00.000Z");
    expect(a.decision).toMatchObject({ severity: "P3", notify: true });
    expect(reduceCheck(a.nextRow, check("authority.bindingReleaseConsistent", "HEALTHY"), "s", "2026-09-30T00:01:00.000Z").decision).toMatchObject({ kind: "RECOVERED", notify: true });
    expect(reduceCheck(null, check("legacyAuthority.b1FreezeObservable", "CRITICAL"), "s", "2026-09-30T00:00:00.000Z").decision).toMatchObject({ severity: "P0", notify: false });
  });
});

describe("G2 identity health: Group A store invariants, Group B cognition binding", () => {
  const snapshot = (over: Partial<Exclude<IdentitySnapshot["cognition"], { unavailable: true }>> = {}): IdentitySnapshot => ({
    dbReachable: true, completedTasksMissingActivation: [], profilesWithoutCurrentIdentity: [],
    cognition: { digestParityFailures: [], tenantsWithMultipleCurrent: [], headCurrentMismatches: [], contractActive: false,
      requiredLatches: 0, unboundRequired: [], contractRuntimeRecords: 0, isolationViolations: [], ...over },
  });
  const statusOf = (s: IdentitySnapshot, id: string) => evaluateIdentity(s, {} as never, "2026-09-30T00:00:00.000Z").checks.find((c) => c.id === id)?.status;
  it("feature OFF (no REQUIRED latch, no contract) is NO_OBSERVATION for Group B and never CRITICAL", () => {
    const r = evaluateIdentity(snapshot(), {} as never, "2026-09-30T00:00:00.000Z");
    expect(r.checks.map((c) => c.id)).toHaveLength(7);
    expect(r.checks.filter((c) => c.status === "CRITICAL")).toEqual([]);
    expect(statusOf(snapshot(), "identity.analystRunsBound")).toBe("UNKNOWN");
    expect(statusOf(snapshot(), "identity.verifierIsolated")).toBe("UNKNOWN");
    expect(statusOf(snapshot(), "identity.currentDigestParity")).toBe("HEALTHY");
  });
  it("every invariant fails on its own broken input", () => {
    expect(statusOf(snapshot({ digestParityFailures: ["v"] }), "identity.currentDigestParity")).toBe("CRITICAL");
    expect(statusOf(snapshot({ tenantsWithMultipleCurrent: ["t"] }), "identity.singleCurrentPerTenant")).toBe("CRITICAL");
    expect(statusOf(snapshot({ headCurrentMismatches: ["i"] }), "identity.headEqualsCurrent")).toBe("CRITICAL");
    expect(statusOf(snapshot({ requiredLatches: 1, unboundRequired: [{ taskId: "t", stepId: "s", reason: "r" }] }), "identity.analystRunsBound")).toBe("CRITICAL");
    expect(statusOf(snapshot({ requiredLatches: 1 }), "identity.analystRunsBound")).toBe("HEALTHY");
    expect(statusOf(snapshot({ isolationViolations: [{ taskId: "t", reason: "r" }] }), "identity.verifierIsolated")).toBe("CRITICAL");
    expect(statusOf(snapshot({ contractActive: true, contractRuntimeRecords: 2 }), "identity.verifierIsolated")).toBe("HEALTHY");
  });
  it("database unreachable: all seven UNKNOWN, deferring to the database domain", () => {
    const r = evaluateIdentity({ ...snapshot(), dbReachable: false, cognition: { unavailable: true, reason: "database unreachable" } }, {} as never, "2026-09-30T00:00:00.000Z");
    expect(r.checks).toHaveLength(7);
    expect(r.checks.every((c) => c.status === "UNKNOWN")).toBe(true);
  });
});

describe("B2 the feature switch", () => {
  it("is exactly true/false; unset or empty is OFF; anything else refuses", () => {
    expect(parseIdentityCognitionEnabled(undefined)).toBe(false);
    expect(parseIdentityCognitionEnabled("")).toBe(false);
    expect(parseIdentityCognitionEnabled("false")).toBe(false);
    expect(parseIdentityCognitionEnabled("true")).toBe(true);
    for (const bad of ["TRUE", "1", "yes", " true"]) expect(() => parseIdentityCognitionEnabled(bad)).toThrow("refusing to guess");
  });
  it("the production compose default and env tooling keep it OFF unless explicitly true", () => {
    expect(readFileSync("infrastructure/docker/execution.compose.yaml", "utf8")).toContain("KJ_IDENTITY_COGNITION_ENABLED: ${KJ_IDENTITY_COGNITION_ENABLED:-}");
    expect(readFileSync("scripts/runtime_env_merge.py", "utf8")).toMatch(/"KJ_IDENTITY_COGNITION_ENABLED": re\.compile\(r"\^\(true\|false\)\$"\)/);
  });
  it("an identity digest of the whole canonical state is stable (journal/DB comparison primitive)", () => {
    expect(canonicalDigest({ b: 1, a: 2 })).toBe(canonicalDigest({ a: 2, b: 1 }));
  });
});
