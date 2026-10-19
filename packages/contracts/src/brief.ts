import { z } from "zod";
import { Id, Timestamp } from "./common.js";
import { RepoSlug } from "./mission.js";

/**
 * The daily morning brief (`morning-brief/v1`).
 *
 * The same shape as the repository-analysis mission, with no new kind of step:
 *
 *   GITHUB_EVIDENCE (activity across every repository the read token can see, plus the kernel's own
 *   task state) -> RUNTIME_ANALYSE -> RUNTIME_REVIEW (a different model) -> RECONCILE
 *
 * Every item in the brief must cite references that exist in the persisted evidence. The kernel
 * checks the citations, the reviewer checks that the claims follow from what is cited, and the ledger
 * re-derives both at the completion boundary. Nothing here judges whether the brief is useful.
 */
export const BRIEF_RECIPE = "morning-brief/v1" as const;

export const BRIEF_CRITERION =
  "An independent reviewer accepts a brief whose every item cites references present in the captured activity evidence, re-derived from persisted evidence";

/** `morning brief`, then an optional label (the scheduler passes its fire window). Nothing in it is parsed for meaning. */
export function parseBriefObjective(objective: string): { label: string } {
  const match = /^morning brief(?:\s+([\s\S]{1,200}))?$/i.exec(objective.trim());
  if (!match) throw new Error('A morning brief objective must start with "morning brief"');
  return { label: (match[1] ?? "").trim() };
}

/** How far back the brief looks. */
export const BRIEF_WINDOW_HOURS = 24;
export const BRIEF_MAX_ACTIVE_REPOS = 25;
export const BRIEF_MAX_COMMITS = 20;
export const BRIEF_MAX_PULLS = 10;
export const BRIEF_MAX_ITEMS = 12;

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const BriefCommit = z.strictObject({
  sha: Sha40,
  date: Timestamp,
  author: z.string().max(100),
  message: z.string().max(200),
});

export const BriefPull = z.strictObject({
  number: z.number().int().positive(),
  title: z.string().max(200),
  author: z.string().max(100),
  draft: z.boolean(),
  updatedAt: Timestamp,
});

export const BriefCiRun = z.strictObject({
  runId: z.number().int().positive(),
  name: z.string().max(200),
  status: z.string().max(40),
  conclusion: z.string().max(40).nullable(),
  headSha: Sha40,
  updatedAt: Timestamp,
});

export const BriefActiveRepo = z.strictObject({
  repo: RepoSlug,
  private: z.boolean(),
  defaultBranch: z.string().min(1).max(200),
  pushedAt: Timestamp,
  commits: z.array(BriefCommit).max(BRIEF_MAX_COMMITS),
  commitsTruncated: z.boolean(),
  /** null when the token cannot read pull requests for this repository. */
  openPulls: z.array(BriefPull).max(BRIEF_MAX_PULLS).nullable(),
  pullsTruncated: z.boolean(),
  /** The latest workflow run on the default branch; null when there is none or it cannot be read. */
  ci: BriefCiRun.nullable(),
});
export type BriefActiveRepo = z.infer<typeof BriefActiveRepo>;

/** Read-only GitHub activity for one window. This is the capability's receipt. */
export const GithubActivity = z.strictObject({
  windowStart: Timestamp,
  windowEnd: Timestamp,
  /** Repositories the token can see (first page, newest push first). */
  reposVisible: z.number().int().nonnegative(),
  reposVisibleTruncated: z.boolean(),
  active: z.array(BriefActiveRepo).max(BRIEF_MAX_ACTIVE_REPOS),
  activeTruncated: z.boolean(),
});
export type GithubActivity = z.infer<typeof GithubActivity>;

/** The kernel's own recent state, read from its ledger by the worker. */
export const KernelState = z.strictObject({
  tasks: z
    .array(z.strictObject({ recipe: z.string().max(80), status: z.string().max(20), count: z.number().int().positive() }))
    .max(64),
  lastCanary: z.strictObject({ taskId: Id, status: z.string().max(20), createdAt: Timestamp }).nullable(),
});
export type KernelState = z.infer<typeof KernelState>;

export const BriefFacts = z.strictObject({
  github: GithubActivity,
  /** The capability's own digest of `github`, re-checked by the workflow and the ledger. */
  githubDigest: Sha256,
  kernel: KernelState,
});
export type BriefFacts = z.infer<typeof BriefFacts>;

/** What the analyst runtime must return (as a single JSON object). */
export const BriefAnalysis = z.strictObject({
  windowEnd: Timestamp,
  headline: z.string().trim().min(10).max(300),
  items: z
    .array(
      z.strictObject({
        title: z.string().trim().min(3).max(120),
        detail: z.string().trim().min(10).max(600),
        // May be empty here so that "uncited" is its own named reconcile check, not a schema failure.
        refs: z.array(z.string().min(1).max(200)).max(8),
      }),
    )
    .min(1)
    .max(BRIEF_MAX_ITEMS),
});
export type BriefAnalysis = z.infer<typeof BriefAnalysis>;

export const BRIEF_RECONCILE_CHECKS = [
  "brief_schema_valid",
  "brief_window_matches_evidence",
  "brief_items_cited",
  "brief_refs_exist_in_evidence",
  "review_schema_valid",
  "review_binds_to_analysis",
  "analyst_runtime_allowed",
  "reviewer_runtime_allowed",
  "reviewer_is_independent",
  "review_verdict_acceptable",
  // Items the reviewer flags as unsupported are withheld, not delivered. The brief still completes
  // when at least one item survives and every flagged index names a real item.
  "review_leaves_supported_items",
] as const;

export const BriefReconciliation = z
  .strictObject({
    decision: z.enum(["ACCEPTED", "REJECTED"]),
    checks: z
      .array(z.strictObject({ name: z.enum(BRIEF_RECONCILE_CHECKS), passed: z.boolean() }))
      .length(BRIEF_RECONCILE_CHECKS.length),
    itemCount: z.number().int().min(0).max(BRIEF_MAX_ITEMS),
    /** 0-based indexes of the items the reviewer flagged; these are never delivered. */
    withheldItems: z.array(z.number().int().min(0).max(BRIEF_MAX_ITEMS - 1)).max(BRIEF_MAX_ITEMS),
    factsDigest: Sha256,
    analysisDigest: Sha256,
    reviewDigest: Sha256,
    analystModel: z.string().max(256),
    reviewerModel: z.string().max(256),
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
    if (r.checks.some((c, i) => c.name !== BRIEF_RECONCILE_CHECKS[i]))
      ctx.addIssue({ code: "custom", message: "Checks out of order" });
    if ((r.decision === "ACCEPTED") !== r.checks.every((c) => c.passed))
      ctx.addIssue({ code: "custom", message: "Decision does not follow the checks" });
  });
export type BriefReconciliation = z.infer<typeof BriefReconciliation>;
