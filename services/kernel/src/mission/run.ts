import type { Context } from "@restatedev/restate-sdk";
import {
  Evidence,
  GithubFacts,
  Outcome,
  type ModelRequest,
  TaskStep,
  parseMissionObjective,
  type ExecutionPlan,
  type PlanStep,
  type Task,
  type TaskEvent,
  type TaskStatus,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import type { ModelPort } from "../../../../packages/models/src/index.js";
import type { Write } from "../ledger.js";
import { callModel } from "../models.js";
import { orderedSteps, projectStep } from "../planner/index.js";
import {
  SOURCES,
  failureEvidence,
  githubEvidence,
  reconcileEvidence,
  runtimeEvidence,
  stepOutputs,
  type RuntimeRole,
} from "./evidence.js";
import { analystRequest, reviewerRequest } from "./prompts.js";
import { failedCheckNames, missionSummary, parseAnalysis, reconcileMission, sha256Text } from "./reconcile.js";
import type { MissionNotice } from "./notify.js";

/**
 * KJ-P3 - the repository-analysis mission, as a sequence the kernel drives:
 *
 *   GITHUB_EVIDENCE -> RUNTIME_ANALYSE (Claude) -> RUNTIME_REVIEW (Grok) -> RECONCILE
 *
 * Runtimes return text; only this function, through the ledger, can move the task. Every
 * step writes evidence. COMPLETED is only requested when the kernel's own reconciliation
 * accepts, and the ledger then re-verifies it from persisted evidence before committing.
 * Anything else ends in FAILED with evidence. The notice is queued after the terminal
 * commit and can never change the outcome.
 */
export type Emit = (
  key: string,
  type: TaskEvent["type"],
  status: TaskStatus,
  extra?: Partial<Pick<Write, "step" | "steps" | "evidence" | "outcome">>,
  payload?: Record<string, unknown>,
) => Promise<Outcome | void>;

export interface MissionDeps {
  ctx: Pick<Context, "run">;
  task: Task;
  plan: ExecutionPlan;
  emit: Emit;
  now: () => Promise<string>;
  uuid: () => string;
  /** In production: `CapabilityServiceV1.githubRead` via the Restate client. */
  githubRead: (req: { repo: string }) => Promise<{ facts: unknown; factsDigest: string }>;
  analyst: ModelPort;
  reviewer: ModelPort;
  /** Queue the notice. Best effort: a failure here never changes the task outcome. */
  notify: (notice: MissionNotice) => Promise<void>;
}

export async function runRepoAnalysisMission(deps: MissionDeps): Promise<Outcome> {
  const { task, plan, emit } = deps;
  const { repo, question } = parseMissionObjective(task.objective);
  const [github, analyst, reviewer, reconcile] = orderedSteps(plan) as [PlanStep, PlanStep, PlanStep, PlanStep];
  const trace = { traceId: task.traceId, correlationId: task.id };
  const evidenceIds: string[] = [];

  const step = (node: PlanStep, patch: Partial<TaskStep>): TaskStep =>
    TaskStep.parse({ ...projectStep(node), ...patch });
  const begin = (node: PlanStep) =>
    emit(`step:${node.id}:start`, "STEP_STARTED", "RUNNING", {
      step: step(node, { status: "RUNNING", input: node.input }),
    });
  const complete = (node: PlanStep, output: Record<string, string>, evidence: Evidence) => {
    evidenceIds.push(evidence.id);
    return emit(
      `step:${node.id}:complete`,
      "STEP_COMPLETED",
      "RUNNING",
      { step: step(node, { status: "COMPLETED", input: node.input, output }), evidence },
      { output },
    );
  };

  const notify = async (status: MissionNotice["status"], at: string) => {
    await deps.ctx.run("mission-notify", async () => {
      try {
        await deps.notify({ taskId: task.id, status, at });
        return true;
      } catch {
        return false;
      }
    });
  };

  /** End the mission as FAILED. The failed step and the reason are both recorded as evidence. */
  const abort = async (
    node: PlanStep,
    source: string,
    metadata: Record<string, string | number | boolean | null>,
    reason: string,
  ): Promise<Outcome> => {
    const evidence = failureEvidence({
      id: deps.uuid(),
      taskId: task.id,
      stepId: node.id,
      source,
      metadata,
      capturedAt: await deps.now(),
    });
    evidenceIds.push(evidence.id);
    await emit(
      `step:${node.id}:failed`,
      "STEP_COMPLETED",
      "RUNNING",
      { step: step(node, { status: "FAILED", input: node.input, output: { failure: reason } }), evidence },
      { failure: reason },
    );
    const at = await deps.now();
    const outcome = Outcome.parse({
      taskId: task.id,
      status: "FAILED",
      acceptanceResults: task.acceptanceCriteria.map((criterion) => ({ criterion, passed: false, evidenceRefs: [] })),
      evidenceRefs: [...evidenceIds],
      summary: `mission FAILED: ${reason}`,
      completedAt: at,
    });
    await emit("fail", "TASK_FAILED", "FAILED", { outcome }, { failures: [reason] });
    await notify("FAILED", at);
    return outcome;
  };

  // 1. GitHub evidence.
  await begin(github);
  let facts: GithubFacts;
  let factsDigest: string;
  try {
    const result = await deps.githubRead({ repo });
    facts = GithubFacts.parse(result.facts);
    factsDigest = capabilityDigest(facts);
    if (factsDigest !== result.factsDigest) throw new Error("digest mismatch");
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : "READ_FAILED";
    return abort(github, SOURCES.github, { repo, error: code }, `GITHUB_${code}`);
  }
  await complete(
    github,
    stepOutputs.github(facts, factsDigest),
    githubEvidence({ id: deps.uuid(), taskId: task.id, stepId: github.id, facts, factsDigest, capturedAt: await deps.now() }),
  );

  // 2 and 3. The two runtimes. Each call is journaled once; a failed call is a failed mission.
  const runRuntime = async (node: PlanStep, role: RuntimeRole, port: ModelPort, build: () => ModelRequest) => {
    await begin(node);
    // A repository with very many long paths can exceed the port's prompt limit. That is a
    // deterministic failure of this mission, so it must end FAILED with evidence, never throw
    // out of the workflow where Restate would retry it forever.
    let request: ModelRequest;
    try {
      request = build();
    } catch {
      return {
        failed: await abort(
          node,
          SOURCES[role],
          { role, error: "PROMPT_TOO_LARGE" },
          `${role.toUpperCase()}_PROMPT_TOO_LARGE`,
        ),
      };
    }
    const result = await callModel(deps.ctx, port, request, async () => {});
    if (result.status === "FAILED") {
      const e = result.receipt.error;
      return {
        failed: await abort(
          node,
          SOURCES[role],
          {
            role,
            provider: result.receipt.provider,
            model: result.receipt.model,
            call_id: result.receipt.callId,
            request_digest: result.receipt.requestDigest,
            error: e.code,
            retryable: e.retryable,
            may_have_run: e.mayHaveRun,
            http_status: e.httpStatus ?? null,
          },
          `${role.toUpperCase()}_${e.code}`,
        ),
      };
    }
    return { text: result.text, receipt: result.receipt };
  };

  const analystId = deps.uuid();
  const a = await runRuntime(
    analyst,
    "analyst",
    deps.analyst,
    () => analystRequest({ callId: analystId, taskId: task.id, stepId: analyst.id, trace, facts, factsDigest, question }),
  );
  if ("failed" in a) return a.failed!;
  const analysisDigest = sha256Text(a.text);
  await complete(
    analyst,
    stepOutputs.runtime(analysisDigest),
    runtimeEvidence({
      id: deps.uuid(), taskId: task.id, stepId: analyst.id, role: "analyst",
      text: a.text, receipt: a.receipt, subjectDigest: factsDigest, capturedAt: await deps.now(),
    }),
  );

  const r = await runRuntime(
    reviewer,
    "reviewer",
    deps.reviewer,
    () =>
      reviewerRequest({
        callId: deps.uuid(), taskId: task.id, stepId: reviewer.id, trace, facts, factsDigest,
        analysisText: a.text, analysisDigest,
      }),
  );
  if ("failed" in r) return r.failed!;
  const reviewDigest = sha256Text(r.text);
  await complete(
    reviewer,
    stepOutputs.runtime(reviewDigest),
    runtimeEvidence({
      id: deps.uuid(), taskId: task.id, stepId: reviewer.id, role: "reviewer",
      text: r.text, receipt: r.receipt, subjectDigest: analysisDigest, capturedAt: await deps.now(),
    }),
  );

  // 4. The kernel's own judgement, from the evidence alone.
  await begin(reconcile);
  const rec = reconcileMission({
    facts,
    analysisText: a.text,
    analystModel: a.receipt.responseModel,
    reviewText: r.text,
    reviewerModel: r.receipt.responseModel,
  });
  await complete(
    reconcile,
    stepOutputs.reconcile(rec),
    reconcileEvidence({ id: deps.uuid(), taskId: task.id, stepId: reconcile.id, rec, capturedAt: await deps.now() }),
  );

  if (rec.decision !== "ACCEPTED") {
    const at = await deps.now();
    const outcome = Outcome.parse({
      taskId: task.id,
      status: "FAILED",
      acceptanceResults: task.acceptanceCriteria.map((criterion) => ({ criterion, passed: false, evidenceRefs: [] })),
      evidenceRefs: [...evidenceIds],
      summary: `mission REJECTED: ${failedCheckNames(rec).join(",")}`,
      completedAt: at,
    });
    await emit("fail", "TASK_FAILED", "FAILED", { outcome }, { failures: failedCheckNames(rec) });
    await notify("FAILED", at);
    return outcome;
  }

  await emit("verify", "TASK_VERIFYING", "VERIFYING");
  const analysis = parseAnalysis(a.text)!;
  const at = await deps.now();
  const candidate = Outcome.parse({
    taskId: task.id,
    status: "COMPLETED",
    acceptanceResults: task.acceptanceCriteria.map((criterion) => ({
      criterion,
      passed: true,
      evidenceRefs: [...evidenceIds],
    })),
    evidenceRefs: [...evidenceIds],
    summary: missionSummary(analysis),
    completedAt: at,
  });
  // The ledger re-verifies this from persisted evidence and converts a mismatch to FAILED.
  const finished = (await emit("complete", "TASK_COMPLETED", "COMPLETED", { outcome: candidate })) ?? candidate;
  await notify(finished.status === "COMPLETED" ? "COMPLETED" : "FAILED", finished.completedAt);
  return finished;
}
