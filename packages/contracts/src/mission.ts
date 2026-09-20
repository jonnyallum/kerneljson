import { z } from "zod";
import { Timestamp } from "./common.js";

/**
 * KJ-P3 - the repository-analysis mission (`repo-analysis-mission/v1`).
 *
 * KernelJSON stays the sole task authority. Claude and Grok are execution
 * runtimes: they return text, and the kernel decides whether that text is
 * acceptable by re-deriving every check from persisted evidence. These schemas
 * are the wire contract between the kernel and those runtimes.
 */
export const MISSION_RECIPE = "repo-analysis-mission/v1" as const;

export const MISSION_CRITERION =
  "An independent reviewer accepts an analysis whose head SHA and cited paths match the GitHub evidence, re-derived from persisted evidence";

/**
 * Runtime families the mission accepts, for either role. The deployment chooses the models;
 * the verifier checks the family the provider REPORTS it ran, never the one requested.
 * Claude plus Grok gives independence across lineages. A single-family pairing (for example
 * two DeepSeek models) is accepted, but only when the reviewer is a different model from the
 * analyst; that is weaker independence and the evidence records exactly which models ran.
 */
export const MISSION_RUNTIME_FAMILIES = ["anthropic", "x-ai", "deepseek"] as const;

/** `anthropic/claude-x` -> `anthropic`; a bare `deepseek-v4-pro` -> `deepseek`. */
export function modelFamily(model: string): string {
  const slash = model.indexOf("/");
  return (slash > 0 ? model.slice(0, slash) : (model.split("-")[0] ?? "")).toLowerCase();
}

/** Read-only GitHub capability reference recorded on the evidence step. */
export const GITHUB_READ_CAPABILITY = {
  id: "60000000-0000-4000-8000-0000000000a1",
  version: "1.0.0",
} as const;

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const RepoSlug = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
  .refine((s) => !/(^|\/)\.{1,2}$/.test(s), "Invalid repository name");

export const DEFAULT_MISSION_QUESTION =
  "Summarise the architecture, the main components, the biggest risks and the most important gaps.";

/** `owner/repo` optionally followed by a free-text question. Anything else is rejected at admission. */
export function parseMissionObjective(objective: string): { repo: string; question: string } {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(objective.trim());
  if (!match) throw new Error("Mission objective must start with owner/repo");
  const repo = RepoSlug.parse(match[1]);
  const question = (match[2] ?? "").trim() || DEFAULT_MISSION_QUESTION;
  if (question.length > 2000) throw new Error("Mission question is too long");
  return { repo, question };
}

/** Bounded, read-only facts about one repository at one commit. This is the evidence. */
export const GithubFacts = z.strictObject({
  repo: RepoSlug,
  private: z.boolean(),
  defaultBranch: z.string().min(1).max(200),
  headSha: Sha40,
  headCommitDate: Timestamp,
  headCommitMessage: z.string().max(300),
  language: z.string().max(80).nullable(),
  sizeKb: z.number().int().nonnegative(),
  pushedAt: Timestamp.nullable(),
  openIssues: z.number().int().nonnegative(),
  tree: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(300),
        type: z.enum(["blob", "tree"]),
      }),
    )
    .max(1000),
  treeTruncated: z.boolean(),
  readme: z
    .strictObject({
      path: z.string().min(1).max(300),
      sha256: Sha256,
      excerpt: z.string().max(6000),
    })
    .nullable(),
});
export type GithubFacts = z.infer<typeof GithubFacts>;

/** What the analyst runtime must return (as a single JSON object). */
export const MissionAnalysis = z.strictObject({
  headSha: Sha40,
  summary: z.string().trim().min(20).max(4000),
  findings: z
    .array(
      z.strictObject({
        title: z.string().trim().min(3).max(160),
        detail: z.string().trim().min(10).max(1200),
        paths: z.array(z.string().min(1).max(300)).min(1).max(8),
      }),
    )
    .min(1)
    .max(12),
});
export type MissionAnalysis = z.infer<typeof MissionAnalysis>;

/** What the reviewer runtime must return (as a single JSON object). */
export const MissionReview = z.strictObject({
  reviewedAnalysisSha256: Sha256,
  verdict: z.enum(["approve", "approve_with_notes", "reject"]),
  unsupportedFindings: z.array(z.number().int().min(0).max(11)).max(12),
  notes: z.array(z.string().trim().min(1).max(400)).max(10),
});
export type MissionReview = z.infer<typeof MissionReview>;

export const RECONCILE_CHECKS = [
  "analysis_schema_valid",
  "analysis_head_sha_matches_evidence",
  "analysis_paths_exist_in_evidence",
  "review_schema_valid",
  "review_binds_to_analysis",
  "analyst_runtime_allowed",
  "reviewer_runtime_allowed",
  "reviewer_is_independent",
  "review_verdict_acceptable",
  "review_flags_no_unsupported_findings",
] as const;

export const MissionReconciliation = z
  .strictObject({
    decision: z.enum(["ACCEPTED", "REJECTED"]),
    checks: z
      .array(z.strictObject({ name: z.enum(RECONCILE_CHECKS), passed: z.boolean() }))
      .length(RECONCILE_CHECKS.length),
    githubDigest: Sha256,
    analysisDigest: Sha256,
    reviewDigest: Sha256,
    analystModel: z.string().max(256),
    reviewerModel: z.string().max(256),
  })
  .superRefine((r, ctx) => {
    if (r.checks.some((c, i) => c.name !== RECONCILE_CHECKS[i]))
      ctx.addIssue({ code: "custom", message: "Checks out of order" });
    const all = r.checks.every((c) => c.passed);
    if ((r.decision === "ACCEPTED") !== all)
      ctx.addIssue({ code: "custom", message: "Decision does not follow the checks" });
  });
export type MissionReconciliation = z.infer<typeof MissionReconciliation>;
