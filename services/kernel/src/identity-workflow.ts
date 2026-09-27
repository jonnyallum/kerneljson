import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import {
  ApprovalAnswer,
  ApprovalResolution,
  CapabilityInvocation,
  IDENTITY_CHANGE_RECIPE,
  IdentityDocument,
  IdentityDocumentDraft,
  IdentityGovernanceClass,
  PrincipalRef,
  Task,
  TaskEvent,
  TaskStep,
  parseIdentityChangeObjective,
  type TaskStatus,
} from "../../../packages/contracts/src/index.js";
import {
  IDENTITY_APPLY_A,
  IDENTITY_APPLY_ROLLBACK,
  capabilityDigest,
  createIdentityCapabilityRegistry,
} from "../../../packages/capabilities/src/index.js";
import { compileIntent } from "./compiler/index.js";
import { planTask } from "./planner/index.js";
import { PolicyRules, evaluatePolicy } from "./policy.js";
import { ApprovalError, ApprovalStore } from "./approval-store.js";
import { AuthenticatorUnavailableError } from "./control-signing.js";
import { IdentityRefusal, IdentityStore } from "./identity/store.js";
import { classADigest, identityCoreDigest } from "./identity/canonical.js";
import { completeIdentityTask } from "./identity/complete.js";
import { findSecretShapedContent } from "./identity/secret-scan.js";
import type { AuthenticatedRequest, Authenticator } from "./golden-workflow.js";
import type { Ledger } from "./ledger.js";

const SERVICE_NAME = "IdentityChangeWorkflowV1";

/**
 * KJ-P7A - IdentityChangeWorkflowV1 (ADR-0021).
 *
 * Modelled directly on golden-workflow.ts's createGoldenWorkflow: same authenticated-control
 * boundary, same ApprovalStore/evaluatePolicy machinery for the human-approval gate (D5 - reused
 * exactly, no second approval system), same TASK_CREATED -> PLAN_COMPILED -> ... -> TASK_COMPLETED
 * event shape. What is different, and why:
 *
 *  - Only Class A and ROLLBACK candidates are approval-gated (IDENTITY_APPLY_A / IDENTITY_APPLY_ROLLBACK,
 *    a capability namespace that exists purely as an ApprovalStore scope identifier and is never
 *    executed - see packages/capabilities/src/index.ts). Class C/D and BOOTSTRAP proceed straight to
 *    activation: their governance is entirely DB-trigger-enforced (rate cap, freeze, byte-identity),
 *    per ADR-0021 D6.
 *  - governance_class is never chosen here. It is read back from whatever the database's
 *    identity_candidate_classify() trigger actually derived from the document diff (D6); this
 *    workflow only supplies a placeholder request that the database is free to overwrite.
 *  - The task must reach COMPLETED strictly BEFORE the identity_versions/identity_activations rows
 *    are written (D8 - identity_version_guard() refuses a version whose owning task is not already
 *    COMPLETED), which is backwards from the golden workflow's own "verify last" shape. See
 *    identity/complete.ts for why this needs its own completion path rather than VerificationStore.
 */
export function createIdentityChangeWorkflow(
  ledger: Ledger,
  configuredRules: PolicyRules,
  authenticate: Authenticator,
) {
  ledger = ledger.forWorkflow(SERVICE_NAME);
  const rules = PolicyRules.parse(configuredRules);
  const approvals = new ApprovalStore(ledger.pool),
    identityStore = new IdentityStore(ledger.pool),
    capabilities = createIdentityCapabilityRegistry();

  async function identity(
    ctx: restate.Context | restate.WorkflowSharedContext,
    handler: "run" | "approve" | "cancel",
  ) {
    try {
      const request = ctx.request();
      return PrincipalRef.parse(
        await authenticate(request.headers, {
          service: SERVICE_NAME,
          handler,
          key: (ctx as { key: string }).key,
          body: request.body,
        } satisfies AuthenticatedRequest),
      );
    } catch (error) {
      if (error instanceof AuthenticatorUnavailableError) throw error;
      throw new restate.TerminalError("Unauthenticated", { errorCode: 401 });
    }
  }
  const notify = async (ctx: restate.WorkflowSharedContext, resolution: ApprovalResolution) => {
    const promise = ctx.promise<ApprovalResolution>("approval");
    if (!(await promise.peek())) {
      try {
        await promise.resolve(resolution);
      } catch (error) {
        if (!(await promise.peek())) throw error;
      }
    }
    return resolution;
  };

  return restate.workflow({
    name: SERVICE_NAME,
    handlers: {
      run: async (ctx: restate.WorkflowContext, raw: unknown) => {
        const actor = await ctx.run("authenticate-submission", () => identity(ctx, "run"));
        let compiled: ReturnType<typeof compileIntent>;
        try {
          compiled = compileIntent(raw);
          if (compiled.submission.recipe !== IDENTITY_CHANGE_RECIPE) throw new Error("Unsupported recipe");
        } catch {
          throw new restate.TerminalError("Invalid identity-change submission", { errorCode: 400 });
        }
        const task = compiled.task;
        if (task.id !== ctx.key || task.principal.id !== actor.id || task.principal.kind !== actor.kind)
          throw new restate.TerminalError("Invalid task identity", { errorCode: 403 });
        // ADR-0021 D1/D5: identity change is always a human act. A bootstrap task's submitter becomes
        // the identity's owner_principal_id, which the migration's identity_owner_guard() trigger
        // requires be HUMAN and an ACTIVE tenant member regardless - this rejects the SERVICE case
        // earlier, with a clearer message, before any DB write is attempted.
        if (actor.kind !== "HUMAN")
          throw new restate.TerminalError("Identity changes may only be requested by a HUMAN principal", { errorCode: 403 });

        const request = parseIdentityChangeObjective(task.objective);
        const plan = planTask(task, IDENTITY_CHANGE_RECIPE);

        let taskState = task;
        const emit = async (key: string, type: TaskEvent["type"], status: TaskStatus, step?: TaskStep) => {
          taskState = Task.parse({ ...taskState, status });
          const event = TaskEvent.parse({
            id: ctx.rand.uuidv4(),
            taskId: task.id,
            traceId: task.traceId,
            actor: task.principal,
            occurredAt: new Date(await ctx.date.now()).toISOString(),
            type,
            payload:
              type === "TASK_CREATED"
                ? { intent: compiled.submission.intent }
                : type === "PLAN_COMPILED"
                  ? { plan, planDigest: capabilityDigest(plan) }
                  : {},
          });
          await ctx.run(key, () => ledger.write({ key, task: taskState, event, ...(step ? { step } : {}) }));
        };
        await emit("create", "TASK_CREATED", "RECEIVED");

        // Resolve which identity this task addresses, and whether it bootstraps one. A profile row
        // must exist before a candidate can reference it (identity_candidates.identity_id FK).
        const profile = await ctx.run("read-profile", () => identityStore.readProfile(task.tenant.id));
        let identityId: string;
        let draftDocument: IdentityDocumentDraft;
        if (request.kind === "ROLLBACK") {
          if (!profile) throw new restate.TerminalError("Cannot roll back: no identity exists yet for this tenant", { errorCode: 409 });
          identityId = profile.id;
          const target = await ctx.run("read-rollback-target", () => identityStore.readVersion(identityId, request.toVersion));
          if (!target) throw new restate.TerminalError(`Cannot roll back: version ${request.toVersion} does not exist for this identity`, { errorCode: 404 });
          const { version: _drop, ...rest } = target.document;
          draftDocument = IdentityDocumentDraft.parse(rest);
        } else {
          if (request.document.tenantId !== task.tenant.id)
            throw new restate.TerminalError("Identity document tenantId does not match the requesting task's tenant", { errorCode: 400 });
          if (profile) {
            if (request.document.id !== profile.id)
              throw new restate.TerminalError("Identity document id does not match this tenant's existing identity", { errorCode: 400 });
            identityId = profile.id;
          } else {
            // Bootstrap: the caller's declared document id becomes the identity id. Derived from the
            // immutable request payload, not fresh randomness - stable across a Restate replay.
            identityId = request.document.id;
          }
          draftDocument = request.document;
        }
        // A memory is never a place for a credential, and neither is an identity document - it is
        // shown to models and to the operator exactly the same way. Fails closed before any DB write,
        // reusing KJ-P5's own secret-shape check (services/memory/src/canonical/policy.ts) rather than
        // a second pattern set.
        const secretShape = findSecretShapedContent(draftDocument.sections);
        if (secretShape) throw new restate.TerminalError(`Identity document content looks like a credential (${secretShape}); refused before any write`, { errorCode: 400 });
        if (!profile) {
          if (request.kind === "ROLLBACK") throw new restate.TerminalError("Unreachable: rollback requires an existing profile", { errorCode: 500 });
          await ctx.run("bootstrap-profile", async () => {
            try {
              await identityStore.createProfile({
                id: identityId,
                tenantId: task.tenant.id,
                ownerPrincipalId: actor.id,
                name: request.kind === "PROPOSE" ? request.document.sections.classA.name : "Primary",
              });
            } catch (error) {
              if (error instanceof IdentityRefusal) throw new restate.TerminalError(`Identity bootstrap refused: ${error.message}`, { errorCode: 403 });
              throw error;
            }
          });
        }

        const proposedDigest = identityCoreDigest(draftDocument);
        const candidateId = ctx.rand.uuidv4();
        const candidate = await ctx.run("propose-candidate", async () => {
          try {
            return await identityStore.propose({
              id: candidateId,
              identityId,
              tenantId: task.tenant.id,
              document: draftDocument,
              proposedDigest,
              origin: "OPERATOR_INSTRUCTION",
              // A placeholder only for the ordinary PROPOSE case: identity_candidate_classify()
              // overwrites this with the actual diff-derived class (D6). BOOTSTRAP and ROLLBACK are
              // the two classes the trigger independently verifies rather than overwrites.
              governanceClass: request.kind === "ROLLBACK" ? "ROLLBACK" : profile ? "A" : "BOOTSTRAP",
              proposedByTask: task.id,
            });
          } catch (error) {
            if (error instanceof IdentityRefusal) throw new restate.TerminalError(`Identity change refused: ${error.message}`, { errorCode: 403 });
            throw error;
          }
        });
        const governanceClass: IdentityGovernanceClass = candidate.governanceClass;
        const needsApproval = governanceClass === "A" || governanceClass === "ROLLBACK";
        const capabilityRef = governanceClass === "ROLLBACK" ? IDENTITY_APPLY_ROLLBACK : IDENTITY_APPLY_A;

        let step = TaskStep.parse({
          id: plan.resultStepId,
          taskId: task.id,
          kind: "DETERMINISTIC_FUNCTION",
          status: "READY",
          dependencies: [],
          requiredCapabilities: needsApproval ? [capabilityRef] : [],
          riskClass: "LOW",
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          input: { candidateId: candidate.id, identityCoreDigest: proposedDigest },
          idempotencyKey: `identity-apply-${candidate.id}`,
        });
        await emit("compile", "PLAN_COMPILED", "COMPILED", step);

        const approvalId = ctx.key; // one gate for this task, scoped to it - same shape as golden-workflow.
        if (needsApproval) {
          const invocation = CapabilityInvocation.parse({
            runId: ctx.rand.uuidv4(),
            taskId: task.id,
            stepId: step.id,
            trace: { traceId: task.traceId, correlationId: task.id },
            capability: capabilityRef,
            idempotencyKey: step.idempotencyKey!,
            input: step.input,
          });
          const decisionId = ctx.rand.uuidv4(),
            at = new Date(await ctx.date.now()).toISOString();
          const evaluation = await ctx.run("evaluate-policy", () =>
            evaluatePolicy(rules, taskState, step, invocation, capabilities.describe(capabilityRef), decisionId, at),
          );
          if (evaluation.decision.decision !== "APPROVAL_REQUIRED")
            throw new restate.TerminalError("Identity change policy did not require approval as expected - refusing to proceed unguarded", { errorCode: 403 });
          await ctx.run("record-policy", async () => {
            try {
              await approvals.record(evaluation, invocation, approvalId);
            } catch (error) {
              if (error instanceof ApprovalError || error instanceof z.ZodError)
                throw new restate.TerminalError("Identity approval persistence rejected", { errorCode: 403 });
              throw error;
            }
          });
          await emit("approval-required", "APPROVAL_REQUESTED", "APPROVAL_REQUIRED");
          const timeout = Math.max(1, Date.parse(evaluation.expiresAt!) - (await ctx.date.now()));
          try {
            await ctx.promise<ApprovalResolution>("approval").get().orTimeout(timeout);
          } catch (error) {
            if (!(error instanceof restate.TimeoutError)) throw error;
          }
          const evidenceId = ctx.rand.uuidv4(),
            eventId = ctx.rand.uuidv4();
          const resolution = await ctx.run("resolve-deadline", () => approvals.expire(approvalId, evidenceId, eventId));
          if (resolution.status !== "GRANTED") {
            // ctx.date.now() (itself a journaled Restate operation) must never be called from inside
            // a ctx.run() callback: on replay the callback body does not re-execute (the journaled
            // result is returned directly), so an inner context call made only on the first attempt
            // desyncs the replay and the SDK refuses with "await could not be replayed" - caught live
            // against a real Restate server 2026-09-25. Resolve it here, outside ctx.run, instead.
            const rejectedAt = new Date(await ctx.date.now()).toISOString();
            await ctx.run("reject-candidate", async () => {
              try {
                await identityStore.resolveCandidate(candidate.id, "REJECTED", rejectedAt);
              } catch (error) {
                // Replay safety: a prior attempt's DB write may have committed even though Restate's
                // own journal entry for this step did not, in which case a replay hits "already
                // resolved" here. Only swallow that exact, confirmed case - anything else rethrows so
                // Restate can retry a genuinely transient failure rather than silently losing it.
                const current = await identityStore.readCandidate(candidate.id);
                if (current?.state !== "REJECTED") throw error;
              }
            });
            await emit("approval-rejected", resolution.reason === "CANCELLED" ? "TASK_CANCELLED" : "TASK_FAILED", resolution.reason === "CANCELLED" ? "CANCELLED" : "FAILED");
            return { authorization: resolution.status };
          }
          const approvedAt = new Date(await ctx.date.now()).toISOString();
          await ctx.run("approve-candidate", async () => {
            try {
              await identityStore.resolveCandidate(candidate.id, "APPROVED", approvedAt);
            } catch (error) {
              const current = await identityStore.readCandidate(candidate.id);
              if (current?.state !== "APPROVED") throw error;
            }
          });
          await emit("approved", "TASK_READY", "READY");
        } else {
          await emit("ready", "TASK_READY", "READY");
        }

        step = TaskStep.parse({ ...step, status: "RUNNING" });
        await emit("start", "TASK_STARTED", "RUNNING", step);
        step = TaskStep.parse({ ...step, status: "COMPLETED", output: { candidateId: candidate.id, governanceClass } });
        await emit("step-complete", "STEP_COMPLETED", "RUNNING", step);
        await emit("verify", "TASK_VERIFYING", "VERIFYING");

        const completedAt = new Date(await ctx.date.now()).toISOString();
        const proofMetadata = { candidateId: candidate.id, governanceClass, proposedDigest };
        // ctx.rand.uuidv4()/ctx.date.now() must be resolved OUTSIDE any ctx.run() callback (see the
        // comment above reject-candidate/approve-candidate) - hoisted here, before entering ctx.run.
        const completionEvidenceId = ctx.rand.uuidv4(),
          completionEventId = ctx.rand.uuidv4();
        await ctx.run("complete-task", () =>
          completeIdentityTask(
            ledger.pool,
            task.id,
            `Identity ${governanceClass} change applied for ${identityId}`,
            { evidenceId: completionEvidenceId, digest: capabilityDigest(proofMetadata), metadata: proofMetadata },
            { eventId: completionEventId, at: completedAt },
          ),
        );

        // D8: only now, with the task durably COMPLETED, may the version/activation exist.
        const versionId = ctx.rand.uuidv4(),
          activationId = ctx.rand.uuidv4();
        return ctx.run("activate-identity", async () => {
          const head = await identityStore.readHead(identityId);
          const version = head ? head.version + 1 : 1;
          const fullDocument = IdentityDocument.parse({ ...draftDocument, version });
          try {
            const { activation } = await identityStore.activate({
              versionId,
              identityId,
              tenantId: task.tenant.id,
              version,
              document: fullDocument,
              identityCoreDigest: identityCoreDigest(fullDocument),
              classADigest: classADigest(fullDocument.sections.classA),
              candidateId: candidate.id,
              createdByTask: task.id,
              activationId,
              approvalId: needsApproval ? approvalId : null,
              requestTaskId: task.id,
            });
            return { identityId, version, governanceClass, activationId: activation.id };
          } catch (error) {
            // The task is already COMPLETED and cannot be un-completed (D8's other direction - the
            // task's own success is never contingent on this write, only ordered before it). A
            // genuinely stuck task-completed-but-not-activated state is what the orphan detector
            // (identity/orphan-check.ts) exists to catch and page on, not something to paper over
            // with a TerminalError that would make Restate treat this step as retryable garbage.
            throw new restate.TerminalError(`Identity activation did not complete after task completion: ${error instanceof Error ? error.message : String(error)}`, { errorCode: 500 });
          }
        });
      },
      approve: restate.handlers.workflow.shared(async (ctx: restate.WorkflowSharedContext, raw: unknown) => {
        const actor = await identity(ctx, "approve"),
          answer = ApprovalAnswer.safeParse(raw);
        if (!answer.success) throw new restate.TerminalError("Invalid approval answer", { errorCode: 400 });
        const evidenceId = ctx.rand.uuidv4(),
          eventId = ctx.rand.uuidv4();
        const resolution = await ctx.run("answer", async () => {
          try {
            return await approvals.resolve(ctx.key, answer.data, actor, evidenceId, eventId);
          } catch (error) {
            if (error instanceof ApprovalError || error instanceof z.ZodError) throw new restate.TerminalError("Approval rejected", { errorCode: 403 });
            throw error;
          }
        });
        return notify(ctx, resolution);
      }),
      cancel: restate.handlers.workflow.shared(async (ctx: restate.WorkflowSharedContext) => {
        const actor = await identity(ctx, "cancel"),
          evidenceId = ctx.rand.uuidv4(),
          eventId = ctx.rand.uuidv4();
        const resolution = await ctx.run("cancel", async () => {
          try {
            return await approvals.cancel(ctx.key, actor, evidenceId, eventId);
          } catch (error) {
            if (error instanceof ApprovalError) throw new restate.TerminalError("Cancellation rejected", { errorCode: 403 });
            throw error;
          }
        });
        return notify(ctx, resolution);
      }),
    },
  });
}
