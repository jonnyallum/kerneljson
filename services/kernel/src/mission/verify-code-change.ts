import {
  CODE_CHANGE_RECIPE,
  ChangeFacts,
  CodeChangePr,
  CodeChangeReconciliation,
  Evidence,
  RunFacts,
  TaskStep,
  assertCompletion,
  codeChangeBranch,
  parseCodeChangeObjective,
  type ExecutionPlan,
  type Outcome,
  type Task,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { orderedSteps, projectStep } from "../planner/index.js";
import { sha256Text } from "./reconcile.js";
import { reconcileCodeChange } from "./code-change-reconcile.js";
import { CODE_CHANGE_SOURCES, codeChangeStepOutputs, codeChangeSummary } from "./code-change-mission.js";

/**
 * The ledger's completion backstop for code-change/v1. It trusts nothing the workflow computed: it re-reads the
 * persisted base, runs, change facts, diff text, review and PR; re-runs the reconciliation against the
 * allowlist the WORKER is configured with (not one recorded by the run); and requires the persisted result, the
 * steps, the draft PR and the outcome to agree. Any mismatch throws and the ledger records FAILED.
 */
export interface CodeChangeVerifyConfig {
  allowedRepos: readonly string[];
}

interface Stored {
  step: unknown;
  record: unknown;
}

const fail = (why: string): never => {
  throw new Error(`Code-change completion rejected: ${why}`);
};

export function verifyCodeChangeCompletion(
  task: Task,
  outcome: Outcome,
  plan: ExecutionPlan,
  steps: readonly TaskStep[],
  records: readonly Stored[],
  config: CodeChangeVerifyConfig | undefined,
): void {
  if (plan.recipe !== CODE_CHANGE_RECIPE) fail("wrong recipe");
  if (!config || config.allowedRepos.length === 0) fail("no repository allowlist is configured");
  const nodes = orderedSteps(plan);
  if (nodes.length !== 6) fail("unexpected plan shape");
  const [baseNode, codeNode, testNode, reviewNode, reconcileNode, prNode] = nodes as [
    (typeof nodes)[0], (typeof nodes)[0], (typeof nodes)[0], (typeof nodes)[0], (typeof nodes)[0], (typeof nodes)[0],
  ];
  const { repo, instructions } = parseCodeChangeObjective(task.objective);

  const evidence = records.map((r) => Evidence.parse(r.record));
  const one = (stepId: string, type: Evidence["type"], source: string): Evidence => {
    const found = evidence.filter((e) => e.stepId === stepId && e.type === type && e.source === source);
    if (found.length !== 1) return fail(`expected exactly one ${source} evidence`);
    return found[0]!;
  };
  const eBase = one(baseNode.id, "TOOL_RECEIPT", CODE_CHANGE_SOURCES.base);
  const eCode = one(codeNode.id, "TOOL_RECEIPT", CODE_CHANGE_SOURCES.code);
  const eCapture = one(testNode.id, "TOOL_RECEIPT", CODE_CHANGE_SOURCES.capture);
  const eReview = one(reviewNode.id, "ARTIFACT", CODE_CHANGE_SOURCES.reviewer);
  const eRec = one(reconcileNode.id, "DETERMINISTIC_RESULT", CODE_CHANGE_SOURCES.reconcile);
  const ePr = one(prNode.id, "TOOL_RECEIPT", CODE_CHANGE_SOURCES.pr);

  const str = (e: Evidence, key: string): string => {
    const v = e.metadata[key];
    return typeof v === "string" && v.length > 0 ? v : fail(`missing ${key}`);
  };

  // The base: this task's repository and instructions, fixed before the runner started.
  if (eBase.digest !== capabilityDigest(eBase.metadata)) fail("base evidence digest mismatch");
  if (str(eBase, "repo") !== repo) fail("base evidence is for another repository");
  if (str(eBase, "instructions_sha256") !== sha256Text(instructions)) fail("base evidence is for other instructions");
  const baseSha = str(eBase, "base_sha");
  const defaultBranch = str(eBase, "default_branch");
  const coderModel = str(eBase, "coder_model");

  // The change and the diff the reviewer was shown.
  const facts = ChangeFacts.parse(eCapture.metadata["facts"]);
  const factsDigest = capabilityDigest(facts);
  if (eCapture.digest !== factsDigest || eCapture.metadata["content_sha256"] !== factsDigest) fail("change facts digest mismatch");
  const patch = eCapture.metadata["patch"];
  if (typeof patch !== "string" || eCapture.metadata["patch_sha256"] !== sha256Text(patch)) fail("diff text does not match its digest");
  if (Buffer.byteLength(patch as string, "utf8") !== facts.patchBytes) fail("diff size does not match the facts");
  const codeRun = RunFacts.parse(eCode.metadata["run"]);
  if (eCode.digest !== capabilityDigest(codeRun) || capabilityDigest(codeRun) !== capabilityDigest(facts.codeRun))
    fail("coding run evidence does not match the change facts");

  // The review, bound to that change.
  const reviewText = eReview.metadata["text"];
  if (typeof reviewText !== "string" || sha256Text(reviewText) !== eReview.digest) fail("review text does not match its digest");
  if (eReview.metadata["role"] !== "reviewer" || eReview.metadata["subject_digest"] !== factsDigest)
    fail("review evidence is not bound to the change");

  const recomputed = reconcileCodeChange({
    taskId: task.id,
    repo,
    allowedRepos: config!.allowedRepos,
    baseSha,
    defaultBranch,
    facts,
    coderModel,
    reviewText: reviewText as string,
    reviewerModel: str(eReview, "response_model"),
    reviewerProvider: str(eReview, "provider"),
  });
  const persisted = CodeChangeReconciliation.parse(eRec.metadata);
  if (capabilityDigest(persisted) !== capabilityDigest(recomputed) || eRec.digest !== capabilityDigest(recomputed))
    fail("persisted reconciliation does not match the recomputed one");
  if (recomputed.decision !== "ACCEPTED") fail("reconciliation did not accept the change");

  // The draft PR: for exactly the reconciled head, from the task branch into the default branch.
  const pr = CodeChangePr.parse(ePr.metadata["pr"]);
  if (ePr.digest !== capabilityDigest(pr)) fail("PR evidence digest mismatch");
  if (pr.headSha !== recomputed.headSha) fail("the PR is not for the reconciled head");
  if (ePr.metadata["branch"] !== codeChangeBranch(task.id) || ePr.metadata["base"] !== defaultBranch || ePr.metadata["draft"] !== true)
    fail("the PR is not a draft from the task branch into the default branch");
  if (!pr.url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/pull/`)) fail("the PR is in another repository");

  const expected = [
    [baseNode, codeChangeStepOutputs.base(repo, baseSha)],
    [codeNode, codeChangeStepOutputs.code(codeRun)],
    [testNode, codeChangeStepOutputs.capture(facts, factsDigest)],
    [reviewNode, codeChangeStepOutputs.runtime(eReview.digest as string)],
    [reconcileNode, codeChangeStepOutputs.reconcile(recomputed)],
    [prNode, codeChangeStepOutputs.pr(pr)],
  ] as const;
  for (const [node, output] of expected) {
    const stored = steps.find((s) => s.id === node.id);
    if (!stored || stored.status !== "COMPLETED" || stored.kind !== projectStep(node).kind)
      fail("a planned step is missing or not completed");
    if (capabilityDigest(stored!.output ?? null) !== capabilityDigest(output)) fail("step output does not match evidence");
  }

  if (outcome.summary !== codeChangeSummary(pr)) fail("outcome summary is not the verified one");
  const all = [eBase, eCode, eCapture, eReview, eRec, ePr];
  if (JSON.stringify([...outcome.evidenceRefs].sort()) !== JSON.stringify(all.map((e) => e.id).sort())) fail("outcome evidence set mismatch");
  assertCompletion(task, outcome, all);
}
