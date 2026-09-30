import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseReflectionDisposition, parseReflectionRequest, parseReflectionStringObject,
  RecipeId, ReflectionProposalV1, ReflectionSourceV1,
} from "../packages/contracts/src/index.js";
import { canonicalDigest, canonicalStringify, identityCoreDigestV1 } from "../services/kernel/src/identity/canonical.js";
import { buildReflectionProposal, verifyReflectionProposal, verifyReflectionSource } from "../services/kernel/src/reflection/verify.js";
import { reflectionAt, reflectionFixture, reflectionId, refreshReflectionContinuity } from "./support/reflection-fixture.js";

const request = (id: string) => ({ schema: "kerneljson:reflection-request/v1" as const, sourceTaskId: id, focus: "REVIEW_EXECUTION" as const });
const identity = (tenantId: string) => ({ id: reflectionId(30), reflectionTaskId: reflectionId(31), tenantId,
  requesterId: reflectionId(32), createdAt: reflectionAt });
const verify = (f: ReturnType<typeof reflectionFixture>) => verifyReflectionSource(f.task.tenant.id, f.task.id, f);
const build = (f = reflectionFixture()) => buildReflectionProposal(request(f.task.id), f, identity(f.task.tenant.id));

describe("reflection bounded public parsing", () => {
  it("accepts semantic reorder/escapes without changing the request digest", () => {
    const r = request(reflectionId(1));
    const a = parseReflectionRequest(JSON.stringify(r));
    const b = parseReflectionRequest(` { "focus":"REVIEW_EXECUTION", "sourceTaskId":"${r.sourceTaskId}", "sch\\u0065ma":"kerneljson:reflection-request/v1" } `);
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
    expect(canonicalDigest({ ...a, focus: "ASSESS_ANALYST_ROUTE" })).not.toBe(canonicalDigest(a));
  });
  it.each([
    '{"a":"b","a":"c"}', '{"a":"b","\\u0061":"c"}', '{"a":{"a":"b"}}', '{"a":[]}',
    '{"a":null}', '{"a":true}', '{"a":3}', '{"a":"b",}', '{"a":"b"}{}', '["a"]',
    '{"a":"\\x00"}', '{"a":"\\uD800"}', '{"a":"\\u0000"}', '{"a":"\n"}', '\u00a0{}',
  ])("refuses malformed/duplicate/non-flat JSON: %s", text => {
    expect(() => parseReflectionStringObject(text)).toThrow("REFLECTION_INPUT_INVALID");
  });
  it("enforces UTF-8 byte boundaries before parsing, with no truncation", () => {
    const exact = JSON.stringify({ a: "é".repeat(508) });
    expect(Buffer.byteLength(exact)).toBe(1024);
    expect(parseReflectionStringObject(exact)["a"]).toHaveLength(508);
    expect(() => parseReflectionStringObject(exact + " ")).toThrow("REFLECTION_INPUT_INVALID");
    expect(parseReflectionStringObject(String.raw`{"a":"\"\\/\b\f\n\r\t😀"}`)["a"]).toContain("😀");
  });
  it.each(["tenantId", "origin", "status", "provider", "content", "__proto__", "constructor", "verified"])("rejects public extra field %s", key => {
    const text = JSON.stringify(request(reflectionId(1))).slice(0, -1) + `,"${key}":"SECRET_MARKER"}`;
    expect(() => parseReflectionRequest(text)).toThrow(/^REFLECTION_INPUT_INVALID$/);
  });
  it("binds dispositions to fixed decision/reason pairs and duplicate-key refusal", () => {
    const d = { proposalId: reflectionId(1), proposalDigest: "a".repeat(64), idempotencyKey: reflectionId(2), decision: "ACKNOWLEDGED", reasonCode: "REVIEWED" };
    expect(parseReflectionDisposition(JSON.stringify(d))).toEqual(d);
    expect(() => parseReflectionDisposition(JSON.stringify({ ...d, decision: "APPROVED" }))).toThrow();
    expect(() => parseReflectionDisposition(JSON.stringify({ ...d, decision: "REJECTED" }))).toThrow();
    expect(() => parseReflectionDisposition(JSON.stringify(d).replace('"REVIEWED"', '"REVIEWED","reasonCode":"REVIEWED"'))).toThrow();
    expect(parseReflectionDisposition(JSON.stringify({ ...d, decision: "REJECTED", reasonCode: "NOT_USEFUL" })).decision).toBe("REJECTED");
  });
});

describe("reflection persisted source qualification", () => {
  it.each(["NONE", "REQUIRED"] as const)("verifies %s without copying source content", mode => {
    const f = reflectionFixture(mode), p = build(f), json = JSON.stringify(p);
    expect(p.source.cognition.mode).toBe(mode);
    expect(p.source.evidence).toHaveLength(4);
    expect(p.source.memoryAssemblyDigest).toBeNull();
    expect(p.source.analyst.model).toBe(f.facultyPins[0]!.model);
    expect(verifyReflectionProposal(p)).toEqual(p);
    expect(json).not.toContain(f.evidence[1]!.metadata["text"]);
    for (const key of ['"text":', '"messages":', '"projection":', '"sections":', '"metadata":']) expect(json).not.toContain(key);
    if (mode === "REQUIRED") expect(json).not.toContain(f.identityVersions[0]!.document.sections.classA.constitution);
  });
  const mutations: Array<[string, (f: ReturnType<typeof reflectionFixture>) => void]> = [
    ["unfinished source", f => { f.task.status = "RUNNING"; }],
    ["wrong outcome task", f => { f.outcome.taskId = reflectionId(99); }],
    ["extra plan", f => { f.plans.push(f.plans[0]!); }],
    ["non-mission recipe", f => { f.plans[0]!.recipe = "uppercase/v1"; }],
    ["missing step", f => { f.steps.pop(); }],
    ["step task substitution", f => { f.steps[0]!.taskId = reflectionId(99); }],
    ["step dependency substitution", f => { f.steps[1]!.dependencies = [reflectionId(99)]; }],
    ["duplicate evidence", f => { f.evidence[1]!.id = f.evidence[0]!.id; }],
    ["evidence task substitution", f => { f.evidence[1]!.taskId = reflectionId(99); }],
    ["evidence step substitution", f => { f.evidence[1]!.stepId = f.evidence[2]!.stepId!; }],
    ["text tampering", f => { f.evidence[1]!.metadata["text"] = "PRIVATE_BAD_TEXT"; }],
    ["freshness", f => { f.evidence[0]!.capturedAt = "2099-01-01T00:00:00Z"; }],
    ["incorrect outcome", f => { f.outcome.summary = "unverified"; }],
    ["precontract", f => { f.bindingEpoch = 12; }],
    ["activation mismatch", f => { f.activation.releaseId = "another-release"; }],
    ["binding tenant", f => { f.binding.tenantId = reflectionId(99); }],
    ["latch tenant", f => { f.latches[0]!.tenant_id = reflectionId(99); }],
    ["missing call binding", f => { f.modelCalls = []; }],
    ["assembly tampering", f => { f.modelCalls[0]!.binding.assembly_digest = "d".repeat(64); }],
    ["missing faculty", f => { f.facultyPins = []; }],
    ["faculty tenant", f => { f.facultyPins[0]!.tenantId = reflectionId(99); }],
    ["faculty receipt substitution", f => { f.evidence[1]!.metadata["faculty"] = {}; }],
    ["reviewer identity", f => { f.evidence[2]!.metadata["identity"] = null; }],
    ["reviewer memory", f => { f.evidence[2]!.metadata["memory_context"] = {}; }],
    ["missing identity pin", f => { f.identityPins = []; }],
    ["missing pinned version", f => { f.identityVersions = []; }],
    ["version tenant", f => { f.identityVersions[0]!.tenantId = reflectionId(99); }],
    ["version bytes", f => { f.identityVersions[0]!.document.sections.classA.constitution += " changed"; }],
    ["coherent forged projection", f => {
      const p = f.identityPins[0]!;
      p.projection.sections.classC.persona = "substituted";
      p.projectionDigest = identityCoreDigestV1(p.projection);
      p.projectionBytes = Buffer.byteLength(canonicalStringify(p.projection));
      (f.evidence[1]!.metadata["identity"] as Record<string, unknown>)["projection_digest"] = p.projectionDigest;
      refreshReflectionContinuity(f); // Keep downstream bindings coherent; only pinned-version parity must reject this.
    }],
    ["partial memory provenance", f => { f.evidence[1]!.metadata["memory_context"] = { status: "ASSEMBLED", assembly_id: reflectionId(40), context_digest: null, memories: [], external_count: 0, used_tokens: 0 }; }],
  ];
  it.each(mutations)("refuses %s without leaking diagnostics", (_name, mutate) => {
    const f = reflectionFixture("REQUIRED"); mutate(f);
    expect(() => verify(f)).toThrow(/^REFLECTION_SOURCE_REFUSED$/);
  });
  it("requires explicitly matching tenant and source IDs", () => {
    const f = reflectionFixture();
    expect(() => verifyReflectionSource(reflectionId(99), f.task.id, f)).toThrow();
    expect(() => verifyReflectionSource(f.task.tenant.id, reflectionId(99), f)).toThrow();
  });
  it("keeps memory assembly references but no memory content", () => {
    const f = reflectionFixture();
    f.evidence[1]!.metadata["memory_context"] = { status: "ASSEMBLED", assembly_id: reflectionId(40),
      context_digest: "e".repeat(64), memories: [{ memory_id: reflectionId(41), version: 1 }], external_count: 0, used_tokens: 12 };
    expect(() => verify(f)).toThrow(); // Memory metadata must agree with call-time continuity.
    refreshReflectionContinuity(f);
    expect(build(f).source.memoryAssemblyDigest).toBe("e".repeat(64));
    expect(JSON.stringify(build(f))).not.toContain(reflectionId(41));
  });
});

describe("reflection proposal integrity and isolation", () => {
  it("enforces the exact canonical proposal byte cap", () => {
    const f = reflectionFixture(), assigned = identity(f.task.tenant.id), p = build(f);
    const timestamp = (extra: number) => assigned.createdAt.replace(".000Z", `.${"0".repeat(3 + extra)}Z`);
    const room = 16384 - Buffer.byteLength(canonicalStringify(p));
    const exact = buildReflectionProposal(request(f.task.id), f, { ...assigned, createdAt: timestamp(room) });
    expect(Buffer.byteLength(canonicalStringify(exact))).toBe(16384);
    expect(() => buildReflectionProposal(request(f.task.id), f, { ...assigned, createdAt: timestamp(room + 1) })).toThrow();
  });
  it("binds semantic content and producing IDs/time, independent of row/object order", () => {
    const f = reflectionFixture(), p = build(f);
    f.evidence.reverse(); f.steps.reverse(); f.facultyPins.reverse();
    expect(build(f)).toEqual(p);
    const other = buildReflectionProposal({ ...request(f.task.id), focus: "ASSESS_ANALYST_ROUTE" }, f,
      { ...identity(f.task.tenant.id), id: reflectionId(80) });
    expect(other.evaluationRequest).toBe("BENCHMARK_ANALYST_ROUTE");
    expect(other.sourceManifestDigest).toBe(p.sourceManifestDigest);
    expect(other.proposalDigest).not.toBe(p.proposalDigest);
    expect(() => verifyReflectionProposal({ ...p, createdAt: "2026-10-01T00:00:00Z" })).toThrow();
    expect(verifyReflectionProposal(Object.fromEntries(Object.entries(p).reverse()))).toEqual(p);
  });
  it("refuses non-allowlisted content, partial identity, excess references, and unsupported observations", () => {
    const p = build();
    expect(() => verifyReflectionProposal({ ...p, text: "copied output" })).toThrow();
    expect(ReflectionProposalV1.safeParse({ ...p, observations: [...p.observations, "MODEL_IS_BETTER"] }).success).toBe(false);
    expect(ReflectionSourceV1.safeParse({ ...p.source, evidence: Array.from({ length: 9 }, (_, i) => ({ ...p.source.evidence[0], id: reflectionId(100 + i) })) }).success).toBe(false);
    expect(ReflectionSourceV1.safeParse({ ...p.source, cognition: { mode: "REQUIRED", identity: null } }).success).toBe(false);
    expect(() => verifyReflectionProposal({ ...p, sourceManifestDigest: "e".repeat(64) })).toThrow();
  });
  it("rejects credential-shaped allowed strings with a fixed error", () => {
    const f = reflectionFixture();
    f.binding.releaseId = `sk-${"0".repeat(32)}`; f.activation.releaseId = f.binding.releaseId;
    expect(() => verify(f)).toThrow(/^REFLECTION_SOURCE_REFUSED$/);
  });
  it("has no registered recipe or direct provider/database/prompt imports", () => {
    expect(RecipeId.safeParse("reflection-review/v1").success).toBe(false);
    const code = readFileSync("services/kernel/src/reflection/verify.ts", "utf8");
    for (const forbidden of ["from \"pg\"", "ModelPort", "analyst-assembly.js", "mission/prompts.js", "process.env", "fetch("])
      expect(code).not.toContain(forbidden);
  });
});
