import type { Context } from "@restatedev/restate-sdk";
import {
  BriefFacts,
  GithubActivity,
  KernelState,
  Outcome,
  TaskStep,
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
import { failureEvidence, runtimeEvidence, type RuntimeRole } from "./evidence.js";
import { memoryEvidence, type MissionMemoryContext, type MissionMemoryPort } from "./memory-port.js";
import type { BriefNotice } from "./notify.js";
import { sha256Text } from "./reconcile.js";
import type { Emit } from "./run.js";
import {
  BRIEF_SOURCES,
  briefAnalystRequest,
  briefFactsEvidence,
  briefFailedChecks,
  briefMessage,
  briefReconcileEvidence,
  briefReviewerRequest,
  briefStepOutputs,
  briefSummary,
  parseBrief,
  reconcileBrief,
} from "./brief.js";

/**
 * The morning brief, driven by the kernel exactly like the repository-analysis mission:
 *
 *   GITHUB_EVIDENCE (activity + kernel state) -> RUNTIME_ANALYSE -> RUNTIME_REVIEW -> RECONCILE
 *
 * Runtimes return text; only this function, through the ledger, moves the task. COMPLETED is only
 * requested when the kernel's reconciliation accepts, and the ledger re-verifies it from persisted
 * evidence (verify-brief.ts). The brief is delivered only after that commit, through the outbox.
 * No faculties and no identity cognition: both are scoped to the repository-analysis recipe.
 */
export interface BriefDeps {
  ctx: Pick<Context, "run">;
  task: Task;
  plan: ExecutionPlan;
  emit: Emit;
  now: () => Promise<string>;
  uuid: () => string;
  /** In production: `CapabilityServiceV1.githubActivity` via the Restate client. */
  githubActivity: (req: { windowEnd: string }) => Promise<{ activity: unknown; activityDigest: string }>;
  /** The kernel's own recent task state, read from the ledger. */
  kernelState: (req: { since: string; excludeTaskId: string }) => Promise<KernelState>;
  analyst: ModelPort;
  reviewer: ModelPort;
  memory?: MissionMemoryPort;
  notify: (notice: BriefNotice) => Promise<void>;
}

export async function runMorningBriefMission(deps: BriefDeps): Promise<Outcome> {
  const { task, plan, emit } = deps;
  const [gather, analyst, reviewer, reconcile] = orderedSteps(plan) as [PlanStep, PlanStep, PlanStep, PlanStep];
  const trace = { traceId: task.traceId, correlationId: task.id };
  const evidenceIds: string[] = [];

  const step = (node: PlanStep, patch: Partial<TaskStep>): TaskStep => TaskStep.parse({ ...projectStep(node), ...patch });
  const begin = (node: PlanStep) =>
    emit(`step:${node.id}:start`, "STEP_STARTED", "RUNNING", { step: step(node, { status: "RUNNING", input: node.input }) });
  const complete = (node: PlanStep, output: Record<string, string>, evidence: ReturnType<typeof briefFactsEvidence>) => {
    evidenceIds.push(evidence.id);
    return emit(
      `step:${node.id}:complete`,
      "STEP_COMPLETED",
      "RUNNING",
      { step: step(node, { status: "COMPLETED", input: node.input, output }), evidence },
      { output },
    );
  };
  const notify = async (notice: BriefNotice) => {
    await deps.ctx.run("brief-notify", async () => {
      try {
        await deps.notify(notice);
        return true;
      } catch {
        return false;
      }
    });
  };
  const failWith = async (summary: string, failures: string[]): Promise<Outcome> => {
    const at = await deps.now();
    const outcome = Outcome.parse({
      taskId: task.id,
      status: "FAILED",
      acceptanceResults: task.acceptanceCriteria.map((criterion) => ({ criterion, passed: false, evidenceRefs: [] })),
      evidenceRefs: [...evidenceIds],
      summary,
      completedAt: at,
    });
    await emit("fail", "TASK_FAILED", "FAILED", { outcome }, { failures });
    await notify({ taskId: task.id, status: "FAILED", at });
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
    return failWith(`brief FAILED: ${reason}`, [reason]);
  };

  // 1. Evidence: GitHub activity across every visible repository, plus the kernel's own state.
  await begin(gather);
  let facts: BriefFacts;
  try {
    const windowEnd = await deps.now();
    const read = await deps.githubActivity({ windowEnd });
    const github = GithubActivity.parse(read.activity);
    if (capabilityDigest(github) !== read.activityDigest) throw new Error("DIGEST_MISMATCH");
    const kernel = KernelState.parse(
      await deps.ctx.run("brief-kernel-state", () => deps.kernelState({ since: github.windowStart, excludeTaskId: task.id })),
    );
    facts = BriefFacts.parse({ github, githubDigest: read.activityDigest, kernel });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : "READ_FAILED";
    return abort(gather, BRIEF_SOURCES.facts, { error: code }, `GITHUB_${code}`);
  }
  const factsDigest = capabilityDigest(facts);
  await complete(
    gather,
    briefStepOutputs.facts(factsDigest),
    briefFactsEvidence({ id: deps.uuid(), taskId: task.id, stepId: gather.id, facts, factsDigest, capturedAt: await deps.now() }),
  );

  const runRuntime = async (node: PlanStep, role: RuntimeRole, port: ModelPort, build: () => ModelRequest) => {
    await begin(node);
    let request: ModelRequest;
    try {
      request = build();
    } catch {
      return { failed: await abort(node, BRIEF_SOURCES[role], { role, error: "PROMPT_TOO_LARGE" }, `${role.toUpperCase()}_PROMPT_TOO_LARGE`) };
    }
    const result = await callModel(deps.ctx, port, request, async () => {});
    if (result.status === "FAILED") {
      const e = result.receipt.error;
      return {
        failed: await abort(
          node,
          BRIEF_SOURCES[role],
          {
            role, provider: result.receipt.provider, model: result.receipt.model, call_id: result.receipt.callId,
            request_digest: result.receipt.requestDigest, error: e.code, retryable: e.retryable,
            may_have_run: e.mayHaveRun, http_status: e.httpStatus ?? null,
          },
          `${role.toUpperCase()}_${e.code}`,
        ),
      };
    }
    return { text: result.text, receipt: result.receipt as Extract<ModelCallReceipt, { status: "SUCCEEDED" }> };
  };

  // 2. The analyst, with the operator's memory when it is available. Memory never blocks the brief.
  const analystCallId = deps.uuid();
  let memoryContext: MissionMemoryContext | null = null;
  if (deps.memory) {
    const port = deps.memory;
    memoryContext = await deps.ctx.run("brief-memory-context", async (): Promise<MissionMemoryContext> => {
      try {
        return await port.assemble({
          tenantId: task.tenant.id, principal: task.principal, taskId: task.id, stepId: analyst.id, callId: analystCallId,
          purpose: "morning brief: priorities, commitments, projects and repositories to watch",
          project: "morning-brief",
        });
      } catch {
        return { status: "UNAVAILABLE", assemblyId: null, digest: null, text: "", memories: [], externalCount: 0, usedTokens: 0 };
      }
    });
  }
  const memoryText = memoryContext?.text ?? "";
  const a = await runRuntime(analyst, "analyst", deps.analyst, () =>
    briefAnalystRequest({ callId: analystCallId, taskId: task.id, stepId: analyst.id, trace, facts, factsDigest, memory: memoryText }),
  );
  if ("failed" in a) return a.failed!;
  const analysisDigest = sha256Text(a.text);
  await complete(
    analyst,
    briefStepOutputs.runtime(analysisDigest),
    runtimeEvidence({
      id: deps.uuid(), taskId: task.id, stepId: analyst.id, role: "analyst", text: a.text, receipt: a.receipt,
      subjectDigest: factsDigest, capturedAt: await deps.now(),
      ...(memoryContext ? { memoryContext: memoryEvidence(memoryContext) } : {}),
    }),
  );

  // 3. The independent reviewer, given the same evidence and memory the analyst had.
  const r = await runRuntime(reviewer, "reviewer", deps.reviewer, () =>
    briefReviewerRequest({
      callId: deps.uuid(), taskId: task.id, stepId: reviewer.id, trace, facts, factsDigest,
      analysisText: a.text, analysisDigest, memory: memoryText,
    }),
  );
  if ("failed" in r) return r.failed!;
  const reviewDigest = sha256Text(r.text);
  await complete(
    reviewer,
    briefStepOutputs.runtime(reviewDigest),
    runtimeEvidence({
      id: deps.uuid(), taskId: task.id, stepId: reviewer.id, role: "reviewer", text: r.text, receipt: r.receipt,
      subjectDigest: analysisDigest, capturedAt: await deps.now(),
    }),
  );

  // 4. The kernel's own judgement, from the evidence alone.
  await begin(reconcile);
  const rec = reconcileBrief({
    facts,
    memoryIds: memoryContext?.memories.map((m) => m.memoryId) ?? [],
    analysisText: a.text,
    analystModel: a.receipt.responseModel,
    analystProvider: a.receipt.provider,
    reviewText: r.text,
    reviewerModel: r.receipt.responseModel,
    reviewerProvider: r.receipt.provider,
  });
  await complete(
    reconcile,
    briefStepOutputs.reconcile(rec),
    briefReconcileEvidence({ id: deps.uuid(), taskId: task.id, stepId: reconcile.id, rec, capturedAt: await deps.now() }),
  );
  if (rec.decision !== "ACCEPTED") return failWith(`brief REJECTED: ${briefFailedChecks(rec).join(",")}`, briefFailedChecks(rec));

  await emit("verify", "TASK_VERIFYING", "VERIFYING");
  const brief = parseBrief(a.text)!;
  const at = await deps.now();
  const candidate = Outcome.parse({
    taskId: task.id,
    status: "COMPLETED",
    acceptanceResults: task.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidenceRefs: [...evidenceIds] })),
    evidenceRefs: [...evidenceIds],
    summary: briefSummary(brief, rec.withheldItems),
    completedAt: at,
  });
  // The ledger re-verifies this from persisted evidence and converts a mismatch to FAILED.
  const finished = (await emit("complete", "TASK_COMPLETED", "COMPLETED", { outcome: candidate })) ?? candidate;
  if (finished.status === "COMPLETED")
    await notify({
      taskId: task.id,
      status: "COMPLETED",
      at: finished.completedAt,
      text: briefMessage(brief, {
        taskId: task.id,
        activeRepos: facts.github.active.length,
        reviewerModel: r.receipt.responseModel,
        withheldItems: rec.withheldItems,
      }),
    });
  else await notify({ taskId: task.id, status: "FAILED", at: finished.completedAt });
  return finished;
}
