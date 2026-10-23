import type { Context } from "@restatedev/restate-sdk";
import {
  ChangeFacts,
  CodeChangePr,
  Outcome,
  RunFacts,
  TaskStep,
  codeChangeBranch,
  parseCodeChangeObjective,
  type ExecutionPlan,
  type ModelCallReceipt,
  type ModelRequest,
  type PlanStep,
  type Task,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import type { ModelPort } from "../../../../packages/models/src/index.js";
import { callModel } from "../models.js";
import { orderedSteps, projectStep } from "../planner/index.js";
import { failureEvidence, runtimeEvidence } from "./evidence.js";
import type { CodeChangeNotice } from "./notify.js";
import { sha256Text } from "./reconcile.js";
import type { Emit } from "./run.js";
import { failedCodeChangeChecks, parseCodeChangeReview, reconcileCodeChange } from "./code-change-reconcile.js";
import {
  CODE_CHANGE_SOURCES,
  baseEvidence,
  captureEvidence,
  codeChangePrBody,
  codeChangeReconcileEvidence,
  codeChangeReviewerRequest,
  codeChangeStepOutputs,
  codeChangeSummary,
  codeChangeText,
  codeRunEvidence,
  prEvidence,
} from "./code-change-mission.js";

/**
 * code-change/v1, driven by the kernel like the other missions:
 *
 *   GITHUB_EVIDENCE (base) -> CODE_RUN (Actions) -> CODE_TEST (Actions, on the produced commit)
 *     -> RUNTIME_REVIEW (a different model family) -> RECONCILE -> OPEN_DRAFT_PR
 *
 * The runner and the reviewer produce a branch and some text; only this function, through the ledger, moves
 * the task. The draft PR is opened only after the kernel's reconciliation accepts, and COMPLETED is then
 * re-verified by the ledger from persisted evidence (verify-code-change.ts). Nothing here can merge: the GitHub
 * port has no such call and the token cannot write contents. Jonny is told when it starts, fails or opens the PR.
 */
export interface CodeChangeGithub {
  base(req: { repo: string }): Promise<{ defaultBranch: string; baseSha: string }>;
  dispatch(req: { repo: string; taskId: string; baseSha: string; instructions: string }): Promise<unknown>;
  dispatchTest(req: { repo: string; taskId: string }): Promise<unknown>;
  run(req: { repo: string; taskId: string; kind: "code" | "test" }): Promise<unknown>;
  branchHead(req: { repo: string; taskId: string }): Promise<string | null>;
  capture(req: {
    repo: string; taskId: string; baseSha: string; defaultBranch: string; codeRunId: number; testRunId: number;
  }): Promise<{ facts: unknown; factsDigest: string; patch: string }>;
  openPr(req: {
    repo: string; taskId: string; defaultBranch: string; expectedHeadSha: string; title: string; body: string;
  }): Promise<unknown>;
}

/** How long to wait for each run: a poll every `intervalMs`, at most `maxPolls`, and how long a run may take to appear. */
export interface PollPlan {
  intervalMs: number;
  maxPolls: number;
  appearWithin: number;
}
export const CODE_POLL: PollPlan = { intervalMs: 30_000, maxPolls: 90, appearWithin: 10 };
export const TEST_POLL: PollPlan = { intervalMs: 30_000, maxPolls: 50, appearWithin: 10 };

export interface CodeChangeDeps {
  ctx: Pick<Context, "run">;
  /** Restate's durable timer in production; immediate in tests. */
  sleep: (ms: number) => Promise<void>;
  task: Task;
  plan: ExecutionPlan;
  emit: Emit;
  now: () => Promise<string>;
  uuid: () => string;
  github: CodeChangeGithub;
  reviewer: ModelPort;
  /** The model the runner's Claude Code uses, vendor-qualified (`anthropic/...`). */
  coderModel: string;
  allowedRepos: readonly string[];
  notify: (notice: CodeChangeNotice) => Promise<void>;
  polls?: { code: PollPlan; test: PollPlan };
  /** True once the operator has cancelled the task. Checked before each step that asks GitHub for more. */
  cancelled?: () => Promise<boolean>;
}

/** A terminal error from the capability service carries a code as its message; anything else is generic. */
const codeOf = (error: unknown, fallback: string): string =>
  error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : fallback;

export async function runCodeChangeMission(deps: CodeChangeDeps): Promise<Outcome> {
  const { task, plan, emit } = deps;
  const [baseNode, codeNode, testNode, reviewNode, reconcileNode, prNode] = orderedSteps(plan) as [
    PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep,
  ];
  const polls = deps.polls ?? { code: CODE_POLL, test: TEST_POLL };
  const trace = { traceId: task.traceId, correlationId: task.id };
  const evidenceIds: string[] = [];
  const { repo, instructions } = parseCodeChangeObjective(task.objective);

  const step = (node: PlanStep, patch: Partial<TaskStep>): TaskStep => TaskStep.parse({ ...projectStep(node), ...patch });
  const begin = (node: PlanStep) =>
    emit(`step:${node.id}:start`, "STEP_STARTED", "RUNNING", { step: step(node, { status: "RUNNING", input: node.input }) });
  const complete = (node: PlanStep, output: Record<string, string | number | null>, evidence: ReturnType<typeof baseEvidence>) => {
    evidenceIds.push(evidence.id);
    return emit(
      `step:${node.id}:complete`,
      "STEP_COMPLETED",
      "RUNNING",
      { step: step(node, { status: "COMPLETED", input: node.input, output }), evidence },
      { output },
    );
  };
  // A notice never blocks or fails the mission; the outbox delivers it after this point.
  const notify = async (name: string, notice: CodeChangeNotice) => {
    await deps.ctx.run(`code-change-notify:${name}`, async () => {
      try {
        await deps.notify(notice);
        return true;
      } catch {
        return false;
      }
    });
  };
  // A cancel is honoured at each boundary before GitHub is asked to do more: a cancelled task dispatches nothing
  // further, opens no PR and never reports COMPLETED. A coding run already under way finishes on its own branch.
  const cancelledBefore = async (node: PlanStep): Promise<Outcome | null> => {
    if (!deps.cancelled || !(await deps.cancelled())) return null;
    const outcome = Outcome.parse({
      taskId: task.id,
      status: "CANCELLED",
      acceptanceResults: [],
      evidenceRefs: [],
      summary: `Cancelled at a step boundary, before ${node.id}`,
      completedAt: await deps.now(),
    });
    await emit("cancel", "TASK_CANCELLED", "CANCELLED", { outcome, step: step(node, { status: "CANCELLED", input: node.input }) });
    return outcome;
  };
  const failWith = async (reason: string, failures: string[]): Promise<Outcome> => {
    const at = await deps.now();
    const outcome = Outcome.parse({
      taskId: task.id,
      status: "FAILED",
      acceptanceResults: task.acceptanceCriteria.map((criterion) => ({ criterion, passed: false, evidenceRefs: [] })),
      evidenceRefs: [...evidenceIds],
      summary: `code change FAILED: ${reason}`,
      completedAt: at,
    });
    await emit("fail", "TASK_FAILED", "FAILED", { outcome }, { failures });
    await notify("failed", { taskId: task.id, status: "FAILED", at, text: codeChangeText.failed(task.id, repo, reason) });
    return outcome;
  };
  const abort = async (node: PlanStep, source: string, metadata: Record<string, unknown>, reason: string): Promise<Outcome> => {
    const evidence = failureEvidence({ id: deps.uuid(), taskId: task.id, stepId: node.id, source, metadata, capturedAt: await deps.now() });
    evidenceIds.push(evidence.id);
    await emit(
      `step:${node.id}:failed`,
      "STEP_COMPLETED",
      "RUNNING",
      { step: step(node, { status: "FAILED", input: node.input, output: { failure: reason } }), evidence },
      { failure: reason },
    );
    return failWith(reason, [reason]);
  };
  /** Poll a run until it completes. Every wait is a durable timer; every read a journaled service call. */
  const awaitRun = async (kind: "code" | "test", plan: PollPlan): Promise<RunFacts | string> => {
    for (let i = 0; i < plan.maxPolls; i++) {
      await deps.sleep(plan.intervalMs);
      let raw: unknown;
      try {
        raw = await deps.github.run({ repo, taskId: task.id, kind });
      } catch (error) {
        return codeOf(error, "RUN_READ_FAILED");
      }
      if (raw === null) {
        if (i + 1 >= plan.appearWithin) return "RUN_NOT_FOUND";
        continue;
      }
      const run = RunFacts.parse(raw);
      if (run.status === "completed") return run;
    }
    return "RUN_TIMED_OUT";
  };

  // 1. The base: the allowlist, then the default branch head the change must be made on.
  await begin(baseNode);
  if (!deps.allowedRepos.some((r) => r.toLowerCase() === repo.toLowerCase()))
    return abort(baseNode, CODE_CHANGE_SOURCES.base, { repo, error: "NOT_ALLOWED" }, "REPOSITORY_NOT_ALLOWLISTED");
  let base: { defaultBranch: string; baseSha: string };
  try {
    base = await deps.github.base({ repo });
  } catch (error) {
    return abort(baseNode, CODE_CHANGE_SOURCES.base, { repo, error: codeOf(error, "READ_FAILED") }, `BASE_${codeOf(error, "READ_FAILED")}`);
  }
  await complete(
    baseNode,
    codeChangeStepOutputs.base(repo, base.baseSha),
    baseEvidence({
      id: deps.uuid(), taskId: task.id, stepId: baseNode.id, capturedAt: await deps.now(),
      repo, defaultBranch: base.defaultBranch, baseSha: base.baseSha, instructions, coderModel: deps.coderModel,
    }),
  );
  await notify("started", { taskId: task.id, status: "STARTED", at: await deps.now(), text: codeChangeText.started(task.id, repo) });

  // 2. The coding run, dispatched from the default branch's own workflow file.
  const cancelledAtCode = await cancelledBefore(codeNode);
  if (cancelledAtCode) return cancelledAtCode;
  await begin(codeNode);
  try {
    await deps.github.dispatch({ repo, taskId: task.id, baseSha: base.baseSha, instructions });
  } catch (error) {
    return abort(codeNode, CODE_CHANGE_SOURCES.code, { error: codeOf(error, "DISPATCH_FAILED") }, `CODE_${codeOf(error, "DISPATCH_FAILED")}`);
  }
  const codeRun = await awaitRun("code", polls.code);
  if (typeof codeRun === "string") return abort(codeNode, CODE_CHANGE_SOURCES.code, { error: codeRun }, `CODE_${codeRun}`);
  if (codeRun.conclusion !== "success")
    return abort(codeNode, CODE_CHANGE_SOURCES.code, { run: codeRun }, `CODE_RUN_${(codeRun.conclusion ?? "unknown").toUpperCase()}`);
  await complete(codeNode, codeChangeStepOutputs.code(codeRun), codeRunEvidence({
    id: deps.uuid(), taskId: task.id, stepId: codeNode.id, capturedAt: await deps.now(), run: codeRun,
  }));

  // 3. The test run on the task branch, then the change captured at exactly the commit it tested.
  const cancelledAtTest = await cancelledBefore(testNode);
  if (cancelledAtTest) return cancelledAtTest;
  await begin(testNode);
  let facts: ChangeFacts;
  let factsDigest: string;
  let patch: string;
  try {
    if ((await deps.github.branchHead({ repo, taskId: task.id })) === null) throw new Error("BRANCH_NOT_FOUND");
    await deps.github.dispatchTest({ repo, taskId: task.id });
    const testRun = await awaitRun("test", polls.test);
    if (typeof testRun === "string") throw new Error(testRun);
    if (testRun.conclusion !== "success") throw new Error(`TESTS_${(testRun.conclusion ?? "unknown").toUpperCase()}`);
    const captured = await deps.github.capture({
      repo, taskId: task.id, baseSha: base.baseSha, defaultBranch: base.defaultBranch, codeRunId: codeRun.id, testRunId: testRun.id,
    });
    facts = ChangeFacts.parse(captured.facts);
    factsDigest = capabilityDigest(facts);
    if (factsDigest !== captured.factsDigest) throw new Error("DIGEST_MISMATCH");
    patch = captured.patch;
  } catch (error) {
    const code = codeOf(error, "TEST_FAILED");
    return abort(testNode, CODE_CHANGE_SOURCES.capture, { error: code }, code);
  }
  await complete(testNode, codeChangeStepOutputs.capture(facts, factsDigest), captureEvidence({
    id: deps.uuid(), taskId: task.id, stepId: testNode.id, capturedAt: await deps.now(), facts, factsDigest, patch,
  }));

  // 4. The independent review, of exactly that diff.
  await begin(reviewNode);
  let request: ModelRequest;
  try {
    request = codeChangeReviewerRequest({
      callId: deps.uuid(), taskId: task.id, stepId: reviewNode.id, trace, repo, instructions, facts, factsDigest, patch,
    });
  } catch {
    return abort(reviewNode, CODE_CHANGE_SOURCES.reviewer, { role: "reviewer", error: "PROMPT_TOO_LARGE" }, "REVIEWER_PROMPT_TOO_LARGE");
  }
  const result = await callModel(deps.ctx, deps.reviewer, request, async () => {});
  if (result.status === "FAILED") {
    const e = result.receipt.error;
    return abort(
      reviewNode,
      CODE_CHANGE_SOURCES.reviewer,
      {
        role: "reviewer", provider: result.receipt.provider, model: result.receipt.model, call_id: result.receipt.callId,
        request_digest: result.receipt.requestDigest, error: e.code, retryable: e.retryable, may_have_run: e.mayHaveRun,
        http_status: e.httpStatus ?? null,
      },
      `REVIEWER_${e.code}`,
    );
  }
  const review = result.receipt as Extract<ModelCallReceipt, { status: "SUCCEEDED" }>;
  const reviewDigest = sha256Text(result.text);
  await complete(reviewNode, codeChangeStepOutputs.runtime(reviewDigest), runtimeEvidence({
    id: deps.uuid(), taskId: task.id, stepId: reviewNode.id, role: "reviewer", text: result.text, receipt: review,
    subjectDigest: factsDigest, capturedAt: await deps.now(),
  }));

  // 5. The kernel's own judgement, from the evidence alone.
  await begin(reconcileNode);
  const rec = reconcileCodeChange({
    taskId: task.id, repo, allowedRepos: deps.allowedRepos, baseSha: base.baseSha, defaultBranch: base.defaultBranch, facts,
    coderModel: deps.coderModel, reviewText: result.text, reviewerModel: review.responseModel, reviewerProvider: review.provider,
  });
  await complete(reconcileNode, codeChangeStepOutputs.reconcile(rec), codeChangeReconcileEvidence({
    id: deps.uuid(), taskId: task.id, stepId: reconcileNode.id, capturedAt: await deps.now(), rec,
  }));
  if (rec.decision !== "ACCEPTED") {
    const failed = failedCodeChangeChecks(rec);
    const refused = rec.refusedCategories.length ? ` (refused: ${rec.refusedCategories.join(",")})` : "";
    return failWith(`REJECTED ${failed.join(",")}${refused}`, failed);
  }

  // 6. Only now, the draft PR, for exactly the reconciled head.
  const cancelledAtPr = await cancelledBefore(prNode);
  if (cancelledAtPr) return cancelledAtPr;
  await begin(prNode);
  let pr: CodeChangePr;
  try {
    const firstLine = instructions.split("\n")[0]!.trim();
    pr = CodeChangePr.parse(
      await deps.github.openPr({
        repo, taskId: task.id, defaultBranch: base.defaultBranch, expectedHeadSha: rec.headSha!,
        title: `kj: ${firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine}`,
        body: codeChangePrBody({
          taskId: task.id, instructions, rec, notes: parseCodeChangeReview(result.text)?.notes ?? [], testRunId: facts.testRun.id,
        }),
      }),
    );
    if (pr.headSha !== rec.headSha || !pr.url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/pull/`))
      throw new Error("PR_MISMATCH");
  } catch (error) {
    const code = codeOf(error, "PR_FAILED");
    return abort(prNode, CODE_CHANGE_SOURCES.pr, { error: code }, `PR_${code}`);
  }
  await complete(prNode, codeChangeStepOutputs.pr(pr), prEvidence({
    id: deps.uuid(), taskId: task.id, stepId: prNode.id, capturedAt: await deps.now(), pr,
    branch: codeChangeBranch(task.id), baseBranch: base.defaultBranch,
  }));

  await emit("verify", "TASK_VERIFYING", "VERIFYING");
  const at = await deps.now();
  const candidate = Outcome.parse({
    taskId: task.id,
    status: "COMPLETED",
    acceptanceResults: task.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidenceRefs: [...evidenceIds] })),
    evidenceRefs: [...evidenceIds],
    summary: codeChangeSummary(pr),
    completedAt: at,
  });
  // The ledger re-verifies this from persisted evidence and converts a mismatch to FAILED.
  const finished = (await emit("complete", "TASK_COMPLETED", "COMPLETED", { outcome: candidate })) ?? candidate;
  if (finished.status === "COMPLETED")
    await notify("opened", { taskId: task.id, status: "PR_OPENED", at: finished.completedAt, text: codeChangeText.opened(task.id, repo, pr, rec) });
  else
    await notify("failed", {
      taskId: task.id, status: "FAILED", at: finished.completedAt,
      text: codeChangeText.failed(task.id, repo, `completion verification failed after the draft PR (${pr.url}) was opened`),
    });
  return finished;
}
