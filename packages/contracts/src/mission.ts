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

/** `anthropic/claude-x` -> `claude-x`; a bare `deepseek-v4-pro` is its own slug. */
export function modelSlug(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1).toLowerCase();
}

/**
 * One model reached by two routes (`deepseek-v4-pro` direct, `deepseek/deepseek-v4-pro` through
 * OpenRouter) is still one model. Independence is judged on the slug, never on the route.
 */
export const sameModel = (a: string, b: string): boolean => modelSlug(a) === modelSlug(b);

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

/**
 * The output contract the kernel enforces on the analysis. It is derived from the task objective,
 * which is immutable once admitted, so the workflow and the ledger backstop both re-derive the
 * same contract and neither can relax it. It is enforced by the reconciler, never by prompt wording.
 */
export const MISSION_OUTPUT_SCHEMA = "repo-analysis-findings/v2" as const;
export const MISSION_DEFAULT_MAX_FINDINGS = 8;
export const MISSION_HARD_MAX_FINDINGS = 12;

export const MissionContract = z
  .strictObject({
    outputSchema: z.literal(MISSION_OUTPUT_SCHEMA),
    /** The exact count asked for (`findings=N`), or null when only a ceiling applies. */
    requestedFindings: z.number().int().min(1).max(MISSION_HARD_MAX_FINDINGS).nullable(),
    minFindings: z.number().int().min(1).max(MISSION_HARD_MAX_FINDINGS),
    maxFindings: z.number().int().min(1).max(MISSION_HARD_MAX_FINDINGS),
  })
  .superRefine((c, ctx) => {
    if (c.minFindings > c.maxFindings) ctx.addIssue({ code: "custom", message: "min exceeds max" });
    if (c.requestedFindings !== null && (c.minFindings !== c.requestedFindings || c.maxFindings !== c.requestedFindings))
      ctx.addIssue({ code: "custom", message: "An exact count fixes both bounds" });
  });
export type MissionContract = z.infer<typeof MissionContract>;

const DIRECTIVE = /^(findings|max-findings)=(.*)$/i;

/**
 * `owner/repo`, then optional structured directives, then an optional free-text question:
 *   `owner/repo findings=3 What should we fix first?`      exactly 3 findings
 *   `owner/repo max-findings=5 ...`                         between 1 and 5
 *   `owner/repo ...`                                        between 1 and 8 (the default)
 * A directive is only recognised straight after the slug, and a malformed one is rejected at
 * admission rather than silently becoming question text that nothing enforces. The English in the
 * question is never parsed for a number: only these tokens set the contract.
 */
export function parseMissionObjective(objective: string): {
  repo: string;
  question: string;
  contract: MissionContract;
} {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(objective.trim());
  if (!match) throw new Error("Mission objective must start with owner/repo");
  const repo = RepoSlug.parse(match[1]);
  let rest = (match[2] ?? "").trim();
  let exact: number | null = null;
  let atMost: number | null = null;
  for (;;) {
    const token = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    const directive = token ? DIRECTIVE.exec(token[1]!) : null;
    if (!token || !directive) break;
    const key = directive[1]!.toLowerCase();
    const n = /^\d{1,2}$/.test(directive[2]!) ? Number(directive[2]) : 0;
    if (n < 1 || n > MISSION_HARD_MAX_FINDINGS)
      throw new Error(`Mission ${key} must be a whole number from 1 to ${MISSION_HARD_MAX_FINDINGS}`);
    if ((key === "findings" ? exact : atMost) !== null) throw new Error(`Mission ${key} is set twice`);
    if (key === "findings") exact = n;
    else atMost = n;
    rest = (token[2] ?? "").trim();
  }
  if (exact !== null && atMost !== null) throw new Error("Mission findings= and max-findings= cannot both be set");
  const question = rest || DEFAULT_MISSION_QUESTION;
  if (question.length > 2000) throw new Error("Mission question is too long");
  const contract = MissionContract.parse({
    outputSchema: MISSION_OUTPUT_SCHEMA,
    requestedFindings: exact,
    minFindings: exact ?? 1,
    maxFindings: exact ?? atMost ?? MISSION_DEFAULT_MAX_FINDINGS,
  });
  return { repo, question, contract };
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
        /** The git object id at the captured commit: the file's content digest (or the directory's tree id). */
        sha: Sha40,
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

/**
 * One piece of evidence a finding stands on: a path in the captured tree plus the git object id
 * (or a prefix of at least 12 characters, which is what the prompt shows) that the tree holds for it
 * at the captured commit. The kernel resolves it against the persisted tree.
 */
export const FindingEvidence = z.strictObject({
  path: z.string().min(1).max(300),
  blobSha: z.string().regex(/^[0-9a-f]{12,40}$/),
});
export type FindingEvidence = z.infer<typeof FindingEvidence>;

/** What the analyst runtime must return (as a single JSON object). */
export const MissionAnalysis = z.strictObject({
  headSha: Sha40,
  summary: z.string().trim().min(20).max(4000),
  findings: z
    .array(
      z.strictObject({
        title: z.string().trim().min(3).max(160),
        detail: z.string().trim().min(10).max(1200),
        // May be empty here so that "uncited" is its own named reconcile check, not a schema failure.
        evidence: z.array(FindingEvidence).max(8),
      }),
    )
    .min(1)
    .max(MISSION_HARD_MAX_FINDINGS),
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
  "analysis_finding_count_within_contract",
  "analysis_findings_cited",
  "analysis_paths_exist_in_evidence",
  "analysis_evidence_binds_to_commit",
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
    /** What the kernel required of the analysis, re-derived from the task objective. */
    contract: MissionContract,
    findingCount: z.number().int().min(0).max(MISSION_HARD_MAX_FINDINGS),
    /**
     * One digest per finding over {headSha, path, full git object id} of what it cites. Present only
     * when every finding is cited and bound to the captured commit: it says "this claim is grounded
     * in this exact repository evidence", not that the claim is true.
     */
    findingEvidenceDigests: z.array(Sha256).max(MISSION_HARD_MAX_FINDINGS),
    githubDigest: Sha256,
    analysisDigest: Sha256,
    reviewDigest: Sha256,
    analystModel: z.string().max(256),
    reviewerModel: z.string().max(256),
    /**
     * Provider and family as recorded on each runtime's own receipt. Model identity is what the
     * provider REPORTS it ran: it is not cryptographically proven, least of all through a router.
     */
    independence: z.strictObject({
      analystProvider: z.string().min(1).max(64),
      reviewerProvider: z.string().min(1).max(64),
      analystFamily: z.string().max(64),
      reviewerFamily: z.string().max(64),
      crossProvider: z.boolean(),
      crossFamily: z.boolean(),
    }),
  })
  .superRefine((r, ctx) => {
    if (r.checks.some((c, i) => c.name !== RECONCILE_CHECKS[i]))
      ctx.addIssue({ code: "custom", message: "Checks out of order" });
    const all = r.checks.every((c) => c.passed);
    if ((r.decision === "ACCEPTED") !== all)
      ctx.addIssue({ code: "custom", message: "Decision does not follow the checks" });
  });
export type MissionReconciliation = z.infer<typeof MissionReconciliation>;
