import type { Context } from "@restatedev/restate-sdk";
import {
  Evidence,
  GithubFacts,
  ModelCallBinding,
  Outcome,
  type IdentityCognitionState,
  type ModelCallReceipt,
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
import { reviewerRequest } from "./prompts.js";
import { assembleAnalystRequest, type AnalystCognition, type AssembledAnalystRequest } from "./analyst-assembly.js";
import type { MissionIdentityPort } from "../identity/cognition-binding.js";
import { IdentityCognitionRefusal } from "../identity/projection.js";
import { provenanceOf } from "../identity/evidence-verify.js";
import { failedCheckNames, missionSummary, parseAnalysis, reconcileMission, sha256Text } from "./reconcile.js";
import type { MissionNotice } from "./notify.js";
import { memoryEvidence, type MissionMemoryContext, type MissionMemoryPort } from "./memory-port.js";
import type { MissionFacultyPort } from "../faculty/registry.js";
import type { FacultyPin } from "../../../../packages/contracts/src/faculty.js";
import { projectFacultyRequest, facultyEvidence, FacultyRefusal } from "../faculty/policy.js";
import { modelDigest } from "../../../../packages/models/src/digest.js";

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
  /** KJ-P5: optional canonical memory. Read-only; absent means the mission runs exactly as before. */
  memory?: MissionMemoryPort;
  faculties?: MissionFacultyPort;
  /** KJ-P7B-1: the identity cognition port (latch + call-time authorisation). Absent means every task runs legacy. */
  identity?: MissionIdentityPort;
  /**
   * KJ-P7B-1 D1 erratum: durably record the immutable MODEL_CALLED digest binding. Called from inside callModel's
   * own receipt ctx.run, so it must write to the ledger DIRECTLY and never through `emit` (no nested journal entry).
   */
  recordModelCall?: (binding: ModelCallBinding, occurredAt: string) => Promise<void>;
  /** Queue the notice. Best effort: a failure here never changes the task outcome. */
  notify: (notice: MissionNotice) => Promise<void>;
}

export async function runRepoAnalysisMission(deps: MissionDeps): Promise<Outcome> {
  const { task, plan, emit } = deps;
  const { repo, question, contract } = parseMissionObjective(task.objective);
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
    metadata: Record<string, unknown>,
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
  interface RuntimeHooks {
    /** Extra call-time authorisation, after the faculty check, on the exact outgoing request. */
    authorize?: (request: ModelRequest) => Promise<void>;
    /** callModel's receipt hook. */
    record?: (receipt: ModelCallReceipt) => Promise<void>;
  }
  const runRuntime = async (node: PlanStep, role: RuntimeRole, port: ModelPort, build: () => ModelRequest, pin?: FacultyPin, hooks: RuntimeHooks = {}) => {
    await begin(node);
    // A repository with very many long paths can exceed the port's prompt limit. That is a
    // deterministic failure of this mission, so it must end FAILED with evidence, never throw
    // out of the workflow where Restate would retry it forever.
    let request: ModelRequest;
    try {
      // The build owns the whole composition, faculty projection included (the analyst's is assembleAnalystRequest).
      request = build();
    } catch (error) {
      const code = error instanceof FacultyRefusal || error instanceof IdentityCognitionRefusal ? error.code : "PROMPT_TOO_LARGE";
      return {
        failed: await abort(
          node,
          SOURCES[role],
          { role, error: code, ...(pin ? { faculty: facultyEvidence(pin) } : {}) },
          `${role.toUpperCase()}_${code}`,
        ),
      };
    }
    const guarded: ModelPort = pin && (deps.faculties || hooks.authorize) ? {
      generate: async (req) => {
        try {
          if (deps.faculties) await deps.faculties.authorize(pin, req);
          if (hooks.authorize) await hooks.authorize(req);
        }
        catch (error) {
          const refused = error instanceof FacultyRefusal || error instanceof IdentityCognitionRefusal;
          return { status: "FAILED", receipt: { status: "FAILED", callId: req.callId, taskId: req.taskId, stepId: req.stepId,
            trace: req.trace, provider: pin.provider, model: pin.model, requestDigest: modelDigest({ provider: pin.provider, model: pin.model, request: req }),
            finishedAt: new Date().toISOString(), durationMs: 0, error: { code: refused ? "REQUEST_REJECTED" : "PROVIDER_UNAVAILABLE", retryable: !refused, mayHaveRun: false } } };
        }
        const result = await port.generate(req);
        if (result.receipt.provider !== pin.provider || result.receipt.model !== pin.model) return {
          status: "FAILED", receipt: { status: "FAILED", callId: req.callId, taskId: req.taskId, stepId: req.stepId,
            trace: req.trace, provider: pin.provider, model: pin.model, requestDigest: modelDigest({ provider: pin.provider, model: pin.model, request: req }),
            finishedAt: new Date().toISOString(), durationMs: 0, error: { code: "UNSUPPORTED_RESPONSE", retryable: false, mayHaveRun: true } },
        };
        return result;
      },
    } : port;
    const result = await callModel(deps.ctx, guarded, request, hooks.record ?? (async () => {}));
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
            ...(pin ? { faculty: facultyEvidence(pin) } : {}),
          },
          `${role.toUpperCase()}_${e.code}`,
        ),
      };
    }
    return { text: result.text, receipt: result.receipt };
  };

  const pins: Partial<Record<RuntimeRole, FacultyPin>> = {};
  if (deps.faculties) {
    const faculties = deps.faculties;
    for (const [role, node] of [["analyst", analyst], ["reviewer", reviewer]] as const) {
      const selected = await deps.ctx.run(`faculty:${node.id}:pin`, async () => {
        try { return { pin: await faculties.pin({ tenantId: task.tenant.id, taskId: task.id, stepId: node.id }), error: null }; }
        catch (error) {
          if (!(error instanceof FacultyRefusal)) throw error;
          return { pin: null, error: error.code };
        }
      });
      if (!selected.pin) {
        await begin(node);
        return abort(node, SOURCES[role], { role, error: selected.error }, selected.error!);
      }
      pins[role] = selected.pin;
    }
  }
  // KJ-P7B-1: the durable cognition latch for the analyst step, after its faculty pin (ADR-0022 section 4.6). The
  // database row is canonical; this journaled value is replay material that authorize re-checks before the call.
  let cognition: IdentityCognitionState | null = null;
  if (deps.identity) {
    const identity = deps.identity;
    const latched = await deps.ctx.run(`identity:${analyst.id}:latch`, async () => {
      try {
        return { state: await identity.latch({ tenantId: task.tenant.id, taskId: task.id, stepId: analyst.id, facultyPin: pins.analyst ?? null }), error: null };
      } catch (error) {
        if (!(error instanceof IdentityCognitionRefusal)) throw error;
        return { state: null, error: error.code };
      }
    });
    if (!latched.state) {
      await begin(analyst);
      return abort(analyst, SOURCES.analyst, { role: "analyst", error: latched.error }, latched.error!);
    }
    cognition = latched.state;
  }
  const contractTask = cognition?.kind === "CONTRACT";
  const analystCognition: AnalystCognition =
    cognition?.kind !== "CONTRACT" ? { kind: "LEGACY" }
      : cognition.latch.mode === "NONE" ? { kind: "NONE" }
        : { kind: "REQUIRED", pin: cognition.pin! };
  const analystId = deps.uuid();
  // KJ-P5: assemble the bounded memory context once (journaled, so a replay sees the same context). Memory only
  // informs the analyst; if it is unavailable the mission still runs and the evidence says so.
  let memoryContext: MissionMemoryContext | null = null;
  if (deps.memory && (!pins.analyst || (pins.analyst.faculty.permittedMemoryClasses.length > 0 && pins.analyst.faculty.contextBudget.maxMemoryTokens > 0))) {
    const port = deps.memory;
    memoryContext = await deps.ctx.run("mission-memory-context", async (): Promise<MissionMemoryContext> => {
      try {
        return await port.assemble({
          tenantId: task.tenant.id,
          principal: task.principal,
          taskId: task.id,
          stepId: analyst.id,
          callId: analystId,
          purpose: question,
          project: repo,
          ...(pins.analyst ? { allowedClasses: pins.analyst.faculty.permittedMemoryClasses, maxTokens: pins.analyst.faculty.contextBudget.maxMemoryTokens } : {}),
        });
      } catch {
        return { status: "UNAVAILABLE", assemblyId: null, digest: null, text: "", memories: [], externalCount: 0, usedTokens: 0 };
      }
    });
  }
  let assembled: AssembledAnalystRequest | null = null;
  const identityPort = deps.identity;
  const latchedState = cognition;
  const a = await runRuntime(
    analyst,
    "analyst",
    deps.analyst,
    () => {
      assembled = assembleAnalystRequest({
        request: { callId: analystId, taskId: task.id, stepId: analyst.id, trace, facts, factsDigest, question, contract, memory: memoryContext?.text ?? "" },
        recipe: plan.recipe,
        repo,
        facultyPin: pins.analyst ?? null,
        cognition: analystCognition,
        memoryAssemblyDigest: memoryContext?.digest ?? null,
      });
      return assembled.request;
    },
    pins.analyst,
    {
      ...(identityPort && latchedState
        ? { authorize: (req: ModelRequest) => identityPort.authorize(latchedState, pins.analyst ?? null, req, assembled!.assemblyDigest) }
        : {}),
      ...(contractTask && deps.recordModelCall
        ? {
            // D1 erratum: every post-contract analyst call that reached the provider gets the immutable binding.
            record: async (receipt: ModelCallReceipt) => {
              if (receipt.status === "FAILED" && !receipt.error.mayHaveRun) return;
              await deps.recordModelCall!(ModelCallBinding.parse({
                contract: "kerneljson:model-call-binding/v1",
                task_id: receipt.taskId, step_id: receipt.stepId, call_id: receipt.callId,
                provider: receipt.provider, model: receipt.model, status: receipt.status,
                request_digest: receipt.requestDigest,
                assembly_digest: assembled!.assemblyDigest,
                continuity_digest: assembled!.continuityDigest,
                identity_cognition_mode: analystCognition.kind === "REQUIRED" ? "REQUIRED" : "NONE",
              }), receipt.finishedAt);
            },
          }
        : {}),
    },
  );
  if ("failed" in a) return a.failed!;
  const analysisDigest = sha256Text(a.text);
  await complete(
    analyst,
    stepOutputs.runtime(analysisDigest),
    runtimeEvidence({
      id: deps.uuid(), taskId: task.id, stepId: analyst.id, role: "analyst",
      text: a.text, receipt: a.receipt, subjectDigest: factsDigest, capturedAt: await deps.now(),
      ...(memoryContext ? { memoryContext: memoryEvidence(memoryContext) } : {}),
      ...(pins.analyst ? { faculty: facultyEvidence(pins.analyst) } : {}),
      ...(contractTask
        ? {
            cognition: {
              identity: analystCognition.kind === "REQUIRED" ? provenanceOf(analystCognition.pin) : null,
              identity_cognition_mode: analystCognition.kind === "REQUIRED" ? "REQUIRED" : "NONE",
              assembly_digest: assembled!.assemblyDigest,
              continuity_digest: assembled!.continuityDigest,
            },
          }
        : {}),
    }),
  );

  const r = await runRuntime(
    reviewer,
    "reviewer",
    deps.reviewer,
    () => {
      // The reviewer stays on its existing path: no identity, ever (ADR-0022 section 2, B4).
      const request = reviewerRequest({
        callId: deps.uuid(), taskId: task.id, stepId: reviewer.id, trace, facts, factsDigest,
        analysisText: a.text, analysisDigest,
      });
      return pins.reviewer ? projectFacultyRequest(pins.reviewer, request) : request;
    },
    pins.reviewer,
  );
  if ("failed" in r) return r.failed!;
  const reviewDigest = sha256Text(r.text);
  await complete(
    reviewer,
    stepOutputs.runtime(reviewDigest),
    runtimeEvidence({
      id: deps.uuid(), taskId: task.id, stepId: reviewer.id, role: "reviewer",
      text: r.text, receipt: r.receipt, subjectDigest: analysisDigest, capturedAt: await deps.now(),
      ...(pins.reviewer ? { faculty: facultyEvidence(pins.reviewer) } : {}),
      ...(contractTask ? { cognition: { identity_cognition_mode: "NONE" } } : {}),
    }),
  );

  // 4. The kernel's own judgement, from the evidence alone.
  await begin(reconcile);
  const rec = reconcileMission({
    facts,
    contract,
    analysisText: a.text,
    analystModel: a.receipt.responseModel,
    analystProvider: a.receipt.provider,
    reviewText: r.text,
    reviewerModel: r.receipt.responseModel,
    reviewerProvider: r.receipt.provider,
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
