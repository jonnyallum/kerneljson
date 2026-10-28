import { z } from "zod";
import { RepoSlug } from "./mission.js";

/**
 * Mission #2 - the code-change mission (`code-change/v1`).
 *
 * Jonny asks for a bounded change to one allowlisted repository. An isolated GitHub Actions runner makes it
 * on a branch, a separate test run checks that exact commit, an independent model reviews the diff, and the
 * kernel opens a DRAFT pull request only when its own reconciliation of the GitHub evidence accepts. Nothing
 * here can merge or deploy: the merge is Jonny's, in GitHub, behind a protected default branch.
 *
 * These schemas are the wire contract between the kernel, the runner client and the reviewer. As with
 * `repo-analysis-mission/v1`, every acceptance check is re-derived from persisted evidence, never taken from
 * runner or model output.
 */
export const CODE_CHANGE_RECIPE = "code-change/v1" as const;

export const CODE_CHANGE_CRITERION =
  "An independent reviewer accepts a change whose branch head, diff and passing test run match the GitHub evidence, re-derived from persisted evidence";

/** The two workflows installed in the pilot repository (templates under infrastructure/github/). */
export const CODE_CHANGE_WORKFLOW = "kj-code-change.yml" as const;
export const CODE_CHANGE_TEST_WORKFLOW = "kj-test.yml" as const;

/** Every run the kernel starts carries this exact title, so a run is found by task, never by timing. */
export const codeChangeRunTitle = (taskId: string, kind: "code" | "test"): string => `kj:${taskId} ${kind}`;

const TaskUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** The only branch a task may produce. The repository ruleset limits Actions to this namespace. */
export const codeChangeBranch = (taskId: string): string => `kj/${TaskUuid.parse(taskId)}`;

export const CODE_CHANGE_LIMITS = {
  minInstructionChars: 10,
  maxInstructionChars: 2000,
  maxFiles: 20,
  /** Additions plus deletions across the whole change. */
  maxChangedLines: 800,
  /** The diff text the reviewer is shown, in bytes. Kept under the 128k-character model message bound. */
  maxPatchBytes: 100_000,
} as const;

/**
 * `owner/repo` then the instructions in plain words. Whether the repository is allowed is NOT decided here:
 * that is deployment configuration, checked at admission and again by the reconciler.
 */
export function parseCodeChangeObjective(objective: string): { repo: string; instructions: string } {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(objective.trim());
  if (!match) throw new Error("Code-change objective must be owner/repo followed by the instructions");
  const repo = RepoSlug.parse(match[1]);
  const instructions = match[2]!.trim();
  if (instructions.length < CODE_CHANGE_LIMITS.minInstructionChars) throw new Error("Code-change instructions are too short");
  if (instructions.length > CODE_CHANGE_LIMITS.maxInstructionChars) throw new Error("Code-change instructions are too long");
  return { repo, instructions };
}

/**
 * Paths a pilot change may not touch. These need Jonny's separate approval, so the mission refuses them
 * outright instead of asking: CI and automation, infrastructure and deployment, secrets and credentials,
 * billing and payments, and dependency manifests (a new dependency is a supply-chain decision).
 * Matched case-insensitively against every path a change touches, including a rename's old path.
 */
export const REFUSED_PATH_CATEGORIES = ["ci_and_automation", "infrastructure", "secrets", "billing", "dependencies"] as const;
export type RefusedPathCategory = (typeof REFUSED_PATH_CATEGORIES)[number];

const REFUSED: ReadonlyArray<readonly [RefusedPathCategory, RegExp]> = [
  ["ci_and_automation", /^\.github\/|^\.gitlab-ci\.yml$|^\.circleci\/|(^|\/)\.husky\/|(^|\/)\.pre-commit-config\.yaml$|(^|\/)\.gitattributes$|(^|\/)CODEOWNERS$/i],
  ["infrastructure", /(^|\/)(infra|infrastructure|deploy|deployment|terraform|k8s|kubernetes|helm|ansible|supabase\/migrations)\/|(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Caddyfile|vercel\.json|netlify\.toml|fly\.toml|Procfile|app\.yaml|cloudbuild\.ya?ml)$|\.tf$|\.tfvars$/i],
  ["secrets", /(^|\/)\.env($|\.)|(^|\/)(secrets?|credentials?)(\/|\.|$)|\.(pem|key|p12|pfx|jks|keystore)$|(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$|(^|\/)\.npmrc$|(^|\/)\.netrc$/i],
  ["billing", /(^|\/)[^/]*(billing|payment|invoice|stripe|subscription|checkout)[^/]*(\/|$)/i],
  ["dependencies", /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.yarnrc(\.yml)?|bun\.lockb?|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock))$/i],
];

/** The first refused category a path falls in, or null when the pilot may change it. */
export function refusedPathCategory(path: string): RefusedPathCategory | null {
  for (const [category, pattern] of REFUSED) if (pattern.test(path)) return category;
  return null;
}

/** A repository-relative path as GitHub reports it: no leading slash, no `.` or `..` segment. */
const RepoPath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith("/") && !p.split("/").some((s) => s === "" || s === "." || s === ".."), "Invalid path");

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** One workflow run as the Actions API reports it. The kernel checks every field; it trusts none of them by default. */
export const RunFacts = z.strictObject({
  id: z.number().int().positive(),
  /** `.github/workflows/<file>` from the run's `path`. */
  workflowPath: z.string().min(1).max(200),
  event: z.string().min(1).max(50),
  /** The ref the workflow ran from. */
  headBranch: z.string().min(1).max(250),
  /** The commit the workflow ran on. */
  headSha: Sha40,
  displayTitle: z.string().max(300),
  status: z.string().min(1).max(30),
  conclusion: z.string().max(30).nullable(),
});
export type RunFacts = z.infer<typeof RunFacts>;

export const ChangedFile = z.strictObject({
  path: RepoPath,
  status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]),
  /** The old path of a rename or copy, which is checked against the refused paths too. */
  previousPath: RepoPath.nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Git object id of the file at the branch head (null when removed). */
  blobSha: Sha40.nullable(),
  /** sha256 of the patch text GitHub returned, or null when it returned none (binary or too large). */
  patchSha256: Sha256.nullable(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

/** Everything the kernel captures from GitHub about one produced change. This is the evidence. */
export const ChangeFacts = z.strictObject({
  repo: RepoSlug,
  defaultBranch: z.string().min(1).max(200),
  baseSha: Sha40,
  branch: z.string().min(1).max(250),
  headSha: Sha40,
  /** From the compare API between baseSha and headSha. */
  compareStatus: z.enum(["ahead", "behind", "diverged", "identical"]),
  aheadBy: z.number().int().nonnegative(),
  behindBy: z.number().int().nonnegative(),
  files: z.array(ChangedFile).max(300),
  /** True when GitHub reported more files than it listed (it caps the compare response). */
  filesTruncated: z.boolean(),
  /** Size in bytes of the diff text the reviewer is shown (every file's patch, as GitHub returned it). */
  patchBytes: z.number().int().nonnegative(),
  codeRun: RunFacts,
  testRun: RunFacts,
});
export type ChangeFacts = z.infer<typeof ChangeFacts>;

/** What the reviewer runtime must return (as a single JSON object). */
export const CodeChangeReview = z.strictObject({
  /** The change digest the prompt showed, echoed back: binds the verdict to this exact evidence. */
  reviewedChangeDigest: Sha256,
  verdict: z.enum(["approve", "approve_with_notes", "reject"]),
  /** Does the diff do what the instructions asked, and nothing else? */
  scopeMatchesInstructions: z.boolean(),
  /** Blocking problems. Any concern refuses the change, whatever the verdict says. */
  concerns: z.array(z.string().trim().min(1).max(400)).max(10),
  /** Non-blocking remarks, carried into the draft PR description. */
  notes: z.array(z.string().trim().min(1).max(400)).max(10),
});
export type CodeChangeReview = z.infer<typeof CodeChangeReview>;

export const CODE_CHANGE_CHECKS = [
  "change_facts_valid",
  "repository_allowlisted",
  "branch_is_task_branch",
  "base_matches_evidence",
  "branch_descends_from_base",
  "change_not_empty",
  "change_fully_listed",
  "change_within_size",
  "change_avoids_refused_paths",
  "change_deletes_no_files",
  "code_run_bound_to_task",
  "test_run_bound_to_head",
  "tests_passed",
  "review_schema_valid",
  "review_binds_to_change",
  "reviewer_runtime_allowed",
  "reviewer_is_independent",
  "review_scope_matches",
  "review_verdict_acceptable",
] as const;
export type CodeChangeCheck = (typeof CODE_CHANGE_CHECKS)[number];

export const CodeChangeReconciliation = z
  .strictObject({
    decision: z.enum(["ACCEPTED", "REJECTED"]),
    checks: z
      .array(z.strictObject({ name: z.enum(CODE_CHANGE_CHECKS), passed: z.boolean() }))
      .length(CODE_CHANGE_CHECKS.length),
    /** Refused categories the change touched, for the failure notice. Empty when none. */
    refusedCategories: z.array(z.enum(REFUSED_PATH_CATEGORIES)).max(REFUSED_PATH_CATEGORIES.length),
    changeDigest: Sha256,
    reviewDigest: Sha256,
    headSha: Sha40.nullable(),
    fileCount: z.number().int().nonnegative(),
    changedLines: z.number().int().nonnegative(),
    coderModel: z.string().max(256),
    reviewerModel: z.string().max(256),
    reviewerProvider: z.string().max(64),
  })
  .superRefine((r, ctx) => {
    if (r.checks.some((c, i) => c.name !== CODE_CHANGE_CHECKS[i]))
      ctx.addIssue({ code: "custom", message: "Checks out of order" });
    const all = r.checks.every((c) => c.passed);
    if ((r.decision === "ACCEPTED") !== all)
      ctx.addIssue({ code: "custom", message: "Decision does not follow the checks" });
  });
export type CodeChangeReconciliation = z.infer<typeof CodeChangeReconciliation>;

/** The draft pull request as GitHub returned it, re-checked by the kernel before it is evidence. */
export const CodeChangePr = z.strictObject({
  number: z.number().int().positive(),
  url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/),
  headSha: Sha40,
});
export type CodeChangePr = z.infer<typeof CodeChangePr>;
