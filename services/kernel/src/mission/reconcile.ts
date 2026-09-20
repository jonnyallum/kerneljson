import { createHash } from "node:crypto";
import {
  GithubFacts,
  MISSION_RUNTIME_FAMILIES,
  MissionAnalysis,
  MissionContract,
  MissionReconciliation,
  MissionReview,
  RECONCILE_CHECKS,
  modelFamily,
  sameModel,
  type FindingEvidence,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";

/**
 * KJ-P3 - the kernel's own judgement of a mission. Pure, deterministic, no I/O.
 *
 * Claude and Grok return text. This module decides whether that text is acceptable,
 * using only the persisted GitHub evidence and the runtimes' own receipts. It runs
 * twice: once by the workflow to decide, and again independently at the ledger's
 * completion boundary from persisted evidence, so the workflow cannot self-approve.
 *
 * KJ-P3.1: the output contract (how many findings) and the evidence binding (which file
 * version each finding stands on) are enforced here, deterministically, and re-derived by the
 * ledger backstop. Nothing in this module judges whether a finding is TRUE: it proves that
 * each claim is grounded in this exact repository evidence at this exact commit.
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
  /** Re-derived from the task objective by the caller, never taken from runtime output. */
  contract: MissionContract;
  analysisText: string;
  /** The model the provider reports it ran (receipt.responseModel), not the one requested. */
  analystModel: string;
  /** The port that served the analyst (receipt.provider), for example `deepseek` or `openrouter`. */
  analystProvider: string;
  reviewText: string;
  reviewerModel: string;
  reviewerProvider: string;
}

/** The git object id the captured tree holds for a cited path, if the citation binds to it. */
function bind(tree: ReadonlyMap<string, string>, item: FindingEvidence): string | null {
  const full = tree.get(item.path);
  return full !== undefined && full.startsWith(item.blobSha) ? full : null;
}

export function reconcileMission(input: ReconcileInput): MissionReconciliation {
  const facts = GithubFacts.parse(input.facts);
  const contract = MissionContract.parse(input.contract);
  const analysis = parseAnalysis(input.analysisText);
  const review = parseReview(input.reviewText);
  const tree = new Map(facts.tree.map((e) => [e.path, e.sha]));
  const analysisDigest = sha256Text(input.analysisText);
  const findings = analysis?.findings ?? [];
  const cited = findings.flatMap((f) => f.evidence);

  const headMatches = analysis !== null && analysis.headSha === facts.headSha;
  const allCited = analysis !== null && findings.every((f) => f.evidence.length > 0);
  const pathsExist = analysis !== null && cited.every((e) => tree.has(e.path));
  // A path that exists is not enough: the citation must carry the object id the captured tree
  // holds for it, so a finding cannot stand on a file version from another commit or on a guess.
  // (A path that is absent from the tree is the previous check's failure, not this one's.)
  const bound = headMatches && cited.every((e) => !tree.has(e.path) || bind(tree, e) !== null);

  // One digest per finding, computed by the kernel (a model cannot compute a hash) over the
  // captured head, each cited path and its full object id. Only issued for a fully grounded analysis.
  const grounded = allCited && pathsExist && bound;
  const findingEvidenceDigests = grounded
    ? findings.map((f) =>
        capabilityDigest({
          headSha: facts.headSha,
          evidence: [...new Map(f.evidence.map((e) => [e.path, bind(tree, e)!])).entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([path, sha]) => ({ path, sha })),
        }),
      )
    : [];

  const results: Record<(typeof RECONCILE_CHECKS)[number], boolean> = {
    analysis_schema_valid: analysis !== null,
    analysis_head_sha_matches_evidence: headMatches,
    analysis_finding_count_within_contract:
      analysis !== null && findings.length >= contract.minFindings && findings.length <= contract.maxFindings,
    analysis_findings_cited: allCited,
    analysis_paths_exist_in_evidence: pathsExist,
    analysis_evidence_binds_to_commit: bound,
    review_schema_valid: review !== null,
    review_binds_to_analysis: review !== null && review.reviewedAnalysisSha256 === analysisDigest,
    analyst_runtime_allowed: runtimeAllowed(input.analystModel),
    reviewer_runtime_allowed: runtimeAllowed(input.reviewerModel),
    // The reviewer must be a different model from the analyst, or it is marking its own work.
    // Judged on the model slug, so one model reached by two routes still counts as one model.
    reviewer_is_independent: !sameModel(input.analystModel, input.reviewerModel),
    review_verdict_acceptable: review !== null && review.verdict !== "reject",
    review_flags_no_unsupported_findings: review !== null && review.unsupportedFindings.length === 0,
  };
  const checks = RECONCILE_CHECKS.map((name) => ({ name, passed: results[name] }));
  const analystFamily = modelFamily(input.analystModel);
  const reviewerFamily = modelFamily(input.reviewerModel);
  return MissionReconciliation.parse({
    decision: checks.every((c) => c.passed) ? "ACCEPTED" : "REJECTED",
    checks,
    contract,
    findingCount: findings.length,
    findingEvidenceDigests,
    githubDigest: capabilityDigest(facts),
    analysisDigest,
    reviewDigest: sha256Text(input.reviewText),
    analystModel: input.analystModel,
    reviewerModel: input.reviewerModel,
    independence: {
      analystProvider: input.analystProvider,
      reviewerProvider: input.reviewerProvider,
      analystFamily,
      reviewerFamily,
      crossProvider: input.analystProvider !== input.reviewerProvider,
      crossFamily: analystFamily !== reviewerFamily,
    },
  });
}

/** Deterministic outcome summary, so the ledger can require the outcome to say exactly this. */
export function missionSummary(analysis: MissionAnalysis): string {
  return `Accepted: ${analysis.summary}`.slice(0, 500);
}

export function failedCheckNames(rec: MissionReconciliation): string[] {
  return rec.checks.filter((c) => !c.passed).map((c) => c.name);
}
