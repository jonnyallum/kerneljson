import {
  CODE_CHANGE_CHECKS,
  CODE_CHANGE_LIMITS,
  CODE_CHANGE_TEST_WORKFLOW,
  CODE_CHANGE_WORKFLOW,
  ChangeFacts,
  CodeChangeReconciliation,
  CodeChangeReview,
  MISSION_RUNTIME_FAMILIES,
  codeChangeBranch,
  codeChangeRunTitle,
  modelFamily,
  refusedPathCategory,
  type CodeChangeCheck,
  type RefusedPathCategory,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { parseRuntimeJson, sha256Text } from "./reconcile.js";

/**
 * Mission #2 - the kernel's own judgement of a code change. Pure, deterministic, no I/O.
 *
 * The runner and the reviewer produce a branch and some text. This module decides whether the change is
 * acceptable using only the GitHub evidence the kernel captured itself and the reviewer's receipt. Like
 * `reconcileMission` it runs twice: by the workflow to decide whether to open the draft PR, and again at the
 * ledger's completion boundary from persisted evidence, so the workflow cannot approve its own work.
 *
 * It does not judge whether the code is GOOD: the test run and the reviewer speak to that. It proves the
 * change is the one the task asked for, on the task's branch, on top of the captured base, inside the size
 * and path bounds, tested at exactly the commit that would be proposed, and reviewed at exactly that diff.
 */

/** The digest the reviewer is shown and must echo back. Computed by the kernel; a model cannot compute it. */
export const changeDigest = (facts: unknown): string => capabilityDigest(facts);

export const parseCodeChangeReview = (text: string): CodeChangeReview | null => {
  try {
    return CodeChangeReview.parse(parseRuntimeJson(text));
  } catch {
    return null;
  }
};

export interface CodeChangeReconcileInput {
  taskId: string;
  /** The repository from the task objective, re-derived by the caller. */
  repo: string;
  /** Deployment configuration: the repositories this worker may change. */
  allowedRepos: readonly string[];
  /** From the kernel's GITHUB_EVIDENCE step, taken before the runner started. */
  baseSha: string;
  defaultBranch: string;
  /** Captured from GitHub after the runs finished. */
  facts: unknown;
  /** The coding model as configured for the runner (the family the reviewer must differ from). */
  coderModel: string;
  reviewText: string;
  /** The model the provider reports it ran (receipt.responseModel), not the one requested. */
  reviewerModel: string;
  reviewerProvider: string;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function reconcileCodeChange(input: CodeChangeReconcileInput): CodeChangeReconciliation {
  const parsed = ChangeFacts.safeParse(input.facts);
  const facts = parsed.success ? parsed.data : null;
  const digest = changeDigest(input.facts);
  const review = parseCodeChangeReview(input.reviewText);
  const files = facts?.files ?? [];
  const changedLines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  const refused = new Set<RefusedPathCategory>();
  for (const f of files)
    for (const p of [f.path, f.previousPath]) {
      const category = p === null ? null : refusedPathCategory(p);
      if (category) refused.add(category);
    }
  let branch: string | null;
  try {
    branch = codeChangeBranch(input.taskId);
  } catch {
    branch = null;
  }

  const codeRun = facts?.codeRun;
  const testRun = facts?.testRun;
  const results: Record<CodeChangeCheck, boolean> = {
    change_facts_valid: facts !== null,
    repository_allowlisted:
      facts !== null && same(facts.repo, input.repo) && input.allowedRepos.some((r) => same(r, input.repo)),
    branch_is_task_branch: facts !== null && branch !== null && facts.branch === branch,
    base_matches_evidence: facts !== null && facts.baseSha === input.baseSha && facts.defaultBranch === input.defaultBranch,
    // On top of the captured base and nothing else: GitHub compares base...head and must see head strictly ahead.
    branch_descends_from_base: facts !== null && facts.compareStatus === "ahead" && facts.behindBy === 0 && facts.aheadBy >= 1,
    change_not_empty: files.some((f) => f.status !== "unchanged"),
    // The reviewer must have seen every changed line: no file GitHub left out, and no changed file without its
    // patch text (GitHub omits it for binary or very large files).
    change_fully_listed:
      facts !== null && !facts.filesTruncated && files.every((f) => f.patchSha256 !== null || f.additions + f.deletions === 0),
    change_within_size:
      facts !== null &&
      files.length <= CODE_CHANGE_LIMITS.maxFiles &&
      changedLines <= CODE_CHANGE_LIMITS.maxChangedLines &&
      facts.patchBytes <= CODE_CHANGE_LIMITS.maxPatchBytes,
    change_avoids_refused_paths: facts !== null && refused.size === 0,
    change_deletes_no_files: facts !== null && files.every((f) => f.status !== "removed"),
    // The coding run was the kernel's: the fixed workflow, dispatched from the default branch, titled with this task.
    code_run_bound_to_task:
      codeRun !== undefined &&
      codeRun.workflowPath === `.github/workflows/${CODE_CHANGE_WORKFLOW}` &&
      codeRun.event === "workflow_dispatch" &&
      codeRun.headBranch === input.defaultBranch &&
      codeRun.displayTitle === codeChangeRunTitle(input.taskId, "code") &&
      codeRun.status === "completed" &&
      codeRun.conclusion === "success",
    // The test run is a separate workflow the kernel dispatched on the task branch. GitHub reports the commit it
    // ran on, so a pass counts only for exactly the head that would be proposed.
    test_run_bound_to_head:
      testRun !== undefined &&
      facts !== null &&
      testRun.workflowPath === `.github/workflows/${CODE_CHANGE_TEST_WORKFLOW}` &&
      testRun.event === "workflow_dispatch" &&
      testRun.headBranch === facts.branch &&
      testRun.headSha === facts.headSha &&
      testRun.displayTitle === codeChangeRunTitle(input.taskId, "test") &&
      testRun.status === "completed",
    tests_passed: testRun !== undefined && testRun.conclusion === "success",
    review_schema_valid: review !== null,
    review_binds_to_change: review !== null && review.reviewedChangeDigest === digest,
    reviewer_runtime_allowed: (MISSION_RUNTIME_FAMILIES as readonly string[]).includes(modelFamily(input.reviewerModel)),
    // Stronger than the analysis mission: a different model FAMILY from the coder, not just a different model.
    // The coder must be named with its vendor (`anthropic/claude-x`): a bare `claude-x` would read as family
    // `claude` and let an Anthropic reviewer pass as independent, so it fails closed instead.
    reviewer_is_independent:
      input.coderModel.includes("/") &&
      (MISSION_RUNTIME_FAMILIES as readonly string[]).includes(modelFamily(input.coderModel)) &&
      modelFamily(input.reviewerModel) !== modelFamily(input.coderModel),
    review_scope_matches: review !== null && review.scopeMatchesInstructions,
    review_verdict_acceptable: review !== null && review.verdict !== "reject" && review.concerns.length === 0,
  };
  const checks = CODE_CHANGE_CHECKS.map((name) => ({ name, passed: results[name] }));
  return CodeChangeReconciliation.parse({
    decision: checks.every((c) => c.passed) ? "ACCEPTED" : "REJECTED",
    checks,
    refusedCategories: [...refused].sort(),
    changeDigest: digest,
    reviewDigest: sha256Text(input.reviewText),
    headSha: facts?.headSha ?? null,
    fileCount: files.length,
    changedLines,
    coderModel: input.coderModel,
    reviewerModel: input.reviewerModel,
    reviewerProvider: input.reviewerProvider,
  });
}

export function failedCodeChangeChecks(rec: CodeChangeReconciliation): string[] {
  return rec.checks.filter((c) => !c.passed).map((c) => c.name);
}
