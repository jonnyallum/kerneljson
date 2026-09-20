import { createHash } from "node:crypto";
import {
  GithubFacts,
  MISSION_RUNTIME_FAMILIES,
  MissionAnalysis,
  MissionReconciliation,
  MissionReview,
  RECONCILE_CHECKS,
  modelFamily,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";

/**
 * KJ-P3 - the kernel's own judgement of a mission. Pure, deterministic, no I/O.
 *
 * Claude and Grok return text. This module decides whether that text is acceptable,
 * using only the persisted GitHub evidence and the runtimes' own receipts. It runs
 * twice: once by the workflow to decide, and again independently at the ledger's
 * completion boundary from persisted evidence, so the workflow cannot self-approve.
 */
export const sha256Text = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Models often wrap JSON in one fenced block. Accept exactly that and nothing looser. */
export function parseRuntimeJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed) as unknown;
}

function tryParse<T>(parse: (v: unknown) => T, text: string): T | null {
  try {
    return parse(parseRuntimeJson(text));
  } catch {
    return null;
  }
}

export const parseAnalysis = (text: string): MissionAnalysis | null =>
  tryParse((v) => MissionAnalysis.parse(v), text);
export const parseReview = (text: string): MissionReview | null =>
  tryParse((v) => MissionReview.parse(v), text);

const runtimeAllowed = (model: string): boolean =>
  (MISSION_RUNTIME_FAMILIES as readonly string[]).includes(modelFamily(model));

export interface ReconcileInput {
  facts: GithubFacts;
  analysisText: string;
  /** The model the provider reports it ran (receipt.responseModel), not the one requested. */
  analystModel: string;
  reviewText: string;
  reviewerModel: string;
}

export function reconcileMission(input: ReconcileInput): MissionReconciliation {
  const facts = GithubFacts.parse(input.facts);
  const analysis = parseAnalysis(input.analysisText);
  const review = parseReview(input.reviewText);
  const treePaths = new Set(facts.tree.map((e) => e.path));
  const analysisDigest = sha256Text(input.analysisText);

  const results: Record<(typeof RECONCILE_CHECKS)[number], boolean> = {
    analysis_schema_valid: analysis !== null,
    analysis_head_sha_matches_evidence: analysis !== null && analysis.headSha === facts.headSha,
    analysis_paths_exist_in_evidence:
      analysis !== null && analysis.findings.every((f) => f.paths.every((p) => treePaths.has(p))),
    review_schema_valid: review !== null,
    review_binds_to_analysis: review !== null && review.reviewedAnalysisSha256 === analysisDigest,
    analyst_runtime_allowed: runtimeAllowed(input.analystModel),
    reviewer_runtime_allowed: runtimeAllowed(input.reviewerModel),
    // The reviewer must be a different model from the analyst, or it is marking its own work.
    reviewer_is_independent: input.analystModel !== input.reviewerModel,
    review_verdict_acceptable: review !== null && review.verdict !== "reject",
    review_flags_no_unsupported_findings: review !== null && review.unsupportedFindings.length === 0,
  };
  const checks = RECONCILE_CHECKS.map((name) => ({ name, passed: results[name] }));
  return MissionReconciliation.parse({
    decision: checks.every((c) => c.passed) ? "ACCEPTED" : "REJECTED",
    checks,
    githubDigest: capabilityDigest(facts),
    analysisDigest,
    reviewDigest: sha256Text(input.reviewText),
    analystModel: input.analystModel,
    reviewerModel: input.reviewerModel,
  });
}

/** Deterministic outcome summary, so the ledger can require the outcome to say exactly this. */
export function missionSummary(analysis: MissionAnalysis): string {
  return `Accepted: ${analysis.summary}`.slice(0, 500);
}

export function failedCheckNames(rec: MissionReconciliation): string[] {
  return rec.checks.filter((c) => !c.passed).map((c) => c.name);
}
