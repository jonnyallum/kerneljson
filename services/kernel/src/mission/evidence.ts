import {
  Evidence,
  type GithubFacts,
  type MissionReconciliation,
  type ModelCallReceipt,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { sha256Text } from "./reconcile.js";

/**
 * KJ-P3 - evidence shapes for the mission. The workflow builds evidence with these and
 * the ledger's verifier checks it against the same constants, so the two cannot drift.
 */
export const SOURCES = {
  github: "kerneljson:github-read/v1",
  analyst: "kerneljson:runtime/analyst",
  reviewer: "kerneljson:runtime/reviewer",
  reconcile: "kerneljson:mission-reconcile/v1",
} as const;

export type RuntimeRole = "analyst" | "reviewer";

export const stepOutputs = {
  github: (facts: GithubFacts, factsDigest: string) => ({
    facts_digest: factsDigest,
    head_sha: facts.headSha,
  }),
  runtime: (digest: string) => ({ output_digest: digest }),
  reconcile: (rec: MissionReconciliation) => ({ decision: rec.decision }),
};

interface Base {
  id: string;
  taskId: string;
  stepId: string;
  capturedAt: string;
}

export function githubEvidence(args: Base & { facts: GithubFacts; factsDigest: string }): Evidence {
  return Evidence.parse({
    id: args.id,
    taskId: args.taskId,
    stepId: args.stepId,
    type: "TOOL_RECEIPT",
    source: SOURCES.github,
    digest: args.factsDigest,
    capturedAt: args.capturedAt,
    metadata: {
      capability: "github.read",
      repo: args.facts.repo,
      head_sha: args.facts.headSha,
      content_sha256: args.factsDigest,
      facts: args.facts,
    },
  });
}

export function runtimeEvidence(
  args: Base & {
    role: RuntimeRole;
    text: string;
    receipt: Extract<ModelCallReceipt, { status: "SUCCEEDED" }>;
    /** What this output was produced from: the GitHub digest, or the analysis digest. */
    subjectDigest: string;
    /** KJ-P5: the memory context this call was given. Added only when memory was in play. */
    memoryContext?: Record<string, unknown>;
  },
): Evidence {
  const r = args.receipt;
  return Evidence.parse({
    id: args.id,
    taskId: args.taskId,
    stepId: args.stepId,
    type: "ARTIFACT",
    source: SOURCES[args.role],
    digest: sha256Text(args.text),
    capturedAt: args.capturedAt,
    metadata: {
      role: args.role,
      provider: r.provider,
      model: r.model,
      response_model: r.responseModel,
      provider_request_id: r.providerRequestId,
      call_id: r.callId,
      request_digest: r.requestDigest,
      output_digest: r.outputDigest,
      usage: { ...r.usage },
      subject_digest: args.subjectDigest,
      text: args.text,
      ...(args.memoryContext ? { memory_context: args.memoryContext } : {}),
    },
  });
}

/** A failed step still leaves evidence: what failed, never the provider's error body. */
export function failureEvidence(
  args: Base & { source: string; metadata: Record<string, string | number | boolean | null> },
): Evidence {
  return Evidence.parse({
    id: args.id,
    taskId: args.taskId,
    stepId: args.stepId,
    type: "ARTIFACT",
    source: args.source,
    digest: capabilityDigest(args.metadata),
    capturedAt: args.capturedAt,
    metadata: args.metadata,
  });
}

export function reconcileEvidence(args: Base & { rec: MissionReconciliation }): Evidence {
  return Evidence.parse({
    id: args.id,
    taskId: args.taskId,
    stepId: args.stepId,
    type: "DETERMINISTIC_RESULT",
    source: SOURCES.reconcile,
    digest: capabilityDigest(args.rec),
    capturedAt: args.capturedAt,
    metadata: args.rec,
  });
}
