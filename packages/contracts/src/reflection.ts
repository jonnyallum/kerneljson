import { z } from "zod";
import { Id, Timestamp } from "./common.js";

// Contracts only: this recipe is deliberately absent from RecipeId until K3.
export const REFLECTION_INPUT_MAX_BYTES = 1024;
export const REFLECTION_PROPOSAL_MAX_BYTES = 16384;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/);
export const ReflectionFocus = z.enum(["REVIEW_EXECUTION", "ASSESS_ANALYST_ROUTE"]);
export const ReflectionRequestV1 = z.strictObject({
  schema: z.literal("kerneljson:reflection-request/v1"),
  sourceTaskId: Id,
  focus: ReflectionFocus,
});
export type ReflectionRequestV1 = z.infer<typeof ReflectionRequestV1>;

export const ReflectionDispositionV1 = z.discriminatedUnion("decision", [
  z.strictObject({ proposalId: Id, proposalDigest: Digest, idempotencyKey: Id,
    decision: z.literal("ACKNOWLEDGED"), reasonCode: z.literal("REVIEWED") }),
  z.strictObject({ proposalId: Id, proposalDigest: Digest, idempotencyKey: Id,
    decision: z.literal("REJECTED"),
    reasonCode: z.enum(["INSUFFICIENT_EVIDENCE", "NOT_USEFUL", "DUPLICATE", "OUT_OF_SCOPE"]) }),
]);
export type ReflectionDispositionV1 = z.infer<typeof ReflectionDispositionV1>;

const RuntimeReference = z.strictObject({
  stepId: Id, callId: Id, provider: Label, model: Label, responseModel: Label,
  requestDigest: Digest, outputDigest: Digest, facultyDigest: Digest,
});
const IdentityReference = z.strictObject({
  identityId: Id, versionId: Id, version: z.number().int().positive(),
  coreDigest: Digest, classADigest: Digest, projectionDigest: Digest,
});
export const ReflectionSourceV1 = z.strictObject({
  schema: z.literal("kerneljson:reflection-source/v1"),
  tenantId: Id, sourceTaskId: Id,
  taskDigest: Digest, planDigest: Digest, outcomeDigest: Digest, bindingDigest: Digest,
  releaseEpoch: z.number().int().positive(),
  releaseId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
  contractStartEpoch: z.number().int().positive(),
  evidence: z.array(z.strictObject({ id: Id, stepId: Id, digest: Digest })).min(1).max(8)
    .refine(rows => new Set(rows.map(r => r.id)).size === rows.length),
  analyst: RuntimeReference, reviewer: RuntimeReference,
  cognition: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("NONE"), identity: z.null() }),
    z.strictObject({ mode: z.literal("REQUIRED"), identity: IdentityReference }),
  ]),
  memoryAssemblyId: Id.nullable(), memoryAssemblyDigest: Digest.nullable(),
  assemblyDigest: Digest, continuityDigest: Digest,
}).refine(s => (s.memoryAssemblyId === null) === (s.memoryAssemblyDigest === null));
export type ReflectionSourceV1 = z.infer<typeof ReflectionSourceV1>;

export const ReflectionProposalV1 = z.strictObject({
  schema: z.literal("kerneljson:reflection-proposal/v1"),
  policyVersion: z.literal("reflection-review/v1"),
  id: Id, reflectionTaskId: Id, tenantId: Id, requesterId: Id,
  focus: ReflectionFocus, source: ReflectionSourceV1, sourceManifestDigest: Digest,
  observations: z.tuple([z.literal("CANONICAL_COMPLETION_VERIFIED"),
    z.literal("ANALYST_RECEIPT_BOUND"), z.literal("REVIEWER_ISOLATED")]),
  evaluationRequest: z.enum(["REVIEW_SINGLE_EXECUTION", "BENCHMARK_ANALYST_ROUTE"]),
  createdAt: Timestamp, proposalDigest: Digest,
}).superRefine((p, ctx) => {
  if (p.tenantId !== p.source.tenantId || p.reflectionTaskId === p.source.sourceTaskId
    || p.evaluationRequest !== (p.focus === "REVIEW_EXECUTION" ? "REVIEW_SINGLE_EXECUTION" : "BENCHMARK_ANALYST_ROUTE"))
    ctx.addIssue({ code: "custom", message: "Reflection binding mismatch" });
  // Sorting object keys changes order, never the encoded JSON byte count.
  if (new TextEncoder().encode(JSON.stringify(p)).byteLength > REFLECTION_PROPOSAL_MAX_BYTES)
    ctx.addIssue({ code: "custom", message: "Reflection proposal exceeds byte limit" });
});
export type ReflectionProposalV1 = z.infer<typeof ReflectionProposalV1>;

/** No nested JSON is supported by either public input. Decode each string token before
 * checking key uniqueness, so escaped duplicate keys cannot be overwritten by JSON.parse.
 * The byte bound precedes scanning; errors never echo input or Zod issue values. */
export function parseReflectionStringObject(text: string): Record<string, string> {
  const fail = (): never => { throw new Error("REFLECTION_INPUT_INVALID"); };
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > REFLECTION_INPUT_MAX_BYTES) fail();
  let cursor = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[cursor] ?? "")) cursor++; };
  const token = (): string => {
    whitespace();
    // JSON string grammar explicitly excludes the unescaped C0 control range.
    // eslint-disable-next-line no-control-regex
    const match = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/.exec(text.slice(cursor));
    if (!match) return fail();
    cursor += match[0].length;
    const value: string = JSON.parse(match[0]);
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) || value.includes("\0")) fail();
    return value;
  };
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  whitespace();
  if (text[cursor++] !== "{") fail();
  whitespace();
  if (text[cursor] !== "}") {
    for (;;) {
      const key = token();
      if (Object.hasOwn(result, key)) fail();
      whitespace();
      if (text[cursor++] !== ":") fail();
      result[key] = token();
      whitespace();
      if (text[cursor] !== ",") break;
      cursor++;
    }
  }
  if (text[cursor++] !== "}") fail();
  whitespace();
  if (cursor !== text.length) fail();
  return result;
}

export function parseReflectionRequest(text: string): ReflectionRequestV1 {
  const parsed = ReflectionRequestV1.safeParse(parseReflectionStringObject(text));
  if (!parsed.success) throw new Error("REFLECTION_INPUT_INVALID");
  return parsed.data;
}
export function parseReflectionDisposition(text: string): ReflectionDispositionV1 {
  const parsed = ReflectionDispositionV1.safeParse(parseReflectionStringObject(text));
  if (!parsed.success) throw new Error("REFLECTION_INPUT_INVALID");
  return parsed.data;
}
