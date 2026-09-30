import { ANALYST_CONTINUITY_V1, type ModelRequest } from "../../../../packages/contracts/src/index.js";
import { canonicalDigest } from "../identity/canonical.js";

/**
 * KJ-P7B-1 (ADR-0022 section 9, D1 erratum) - the two provider-independent digests. Pure; imports only canonical.
 *
 * assembly_digest is ADR-0021 D9's: the provider-neutral, model-visible cognitive assembly, `messages` and
 * `maxOutputTokens` only. The execution envelope (callId, taskId, stepId, trace) and the route (provider, model) are
 * excluded, so the same deterministic inputs give the same digest on any provider. request_digest (models.ts) is
 * unchanged and still binds the full ModelRequest, provider and model per call.
 */
export function assemblyDigestOf(request: Pick<ModelRequest, "messages" | "maxOutputTokens">): string {
  return canonicalDigest({ messages: request.messages, maxOutputTokens: request.maxOutputTokens });
}

export interface ContinuityInput {
  mission: { recipe: string; question: string; contractDigest: string; repo: string; factsDigest: string };
  faculty: { id: string; version: number; digest: string } | null;
  identity: { mode: "REQUIRED"; identityCoreDigest: string; projectionProfile: string; projectionDigest: string } | null;
  /** The P5 task-id-free memory assembly digest, or null when no memory assembly was used. */
  memory: { assemblyDigest: string } | null;
  assemblyDigest: string;
}

/** `kerneljson:analyst-continuity/v1`. No provider, model, task, step, call or trace id, timestamp or attempt id. */
export function continuityDigestOf(input: ContinuityInput): string {
  return canonicalDigest({
    contract: ANALYST_CONTINUITY_V1,
    mission: input.mission,
    faculty: input.faculty,
    identity: input.identity,
    memory: input.memory,
    assemblyDigest: input.assemblyDigest,
  });
}
