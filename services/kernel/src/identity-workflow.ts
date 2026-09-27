import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import {
  ApprovalAnswer,
  ApprovalResolution,
  CapabilityInvocation,
  IDENTITY_CHANGE_RECIPE,
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
  IDENTITY_APPLY_C,
  IDENTITY_APPLY_D,
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
import { identityCoreDigest } from "./identity/canonical.js";
import { IdentityD8InvariantError, completeAndActivateIdentity } from "./identity/complete.js";
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
 *  - Every class except BOOTSTRAP goes through policy (ADR-0021 D6) under its own gate capability
 *    (IDENTITY_APPLY_A / _ROLLBACK / _C / _D - a namespace that exists purely as a policy/ApprovalStore
 *    scope identifier and is never executed, see packages/capabilities/src/index.ts). Class A and
 *    ROLLBACK must be APPROVAL_REQUIRED and human-approved; Class C/D may be ALLOWed or approval-gated;
 *    DENY (including no matching rule) ends the task FAILED. The persisted decision is re-checked by
 *    identity_activation_guard(), and C/D is additionally frozen by default (D7) and rate-capped there.
 *  - governance_class is never chosen here. It is read back from whatever the database's
 *    identity_candidate_classify() trigger actually derived from the document diff (D6); this
 *    workflow only supplies a placeholder request that the database is free to overwrite.
 *  - D8: task completion, the identity version and its activation are ONE database transaction
 *    (identity/complete.ts completeAndActivateIdentity). identity_version_guard() sees the task
 *    COMPLETED inside that transaction; a refused activation rolls the completion back too.
 *  - No zombie tasks: everything decidable without a task (owner, tenant/id match, rollback target,
 *    secret screen) is refused BEFORE TASK_CREATED. After it, a deterministic refusal ends the task
 *    FAILED through the normal lifecycle; only transient failures throw, so Restate retries them.
 *  - Bootstrap is chosen by the absence of an identity HEAD, not of a profile, so an interrupted
 *    bootstrap (profile without head) is resumed by the owner's next bootstrap request.
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

        let request: ReturnType<typeof parseIdentityChangeObjective>;
        try {
          request = parseIdentityChangeObjective(task.objective);
        } catch {
          throw new restate.TerminalError("Invalid identity-change objective", { errorCode: 400 });
        }
        const plan = planTask(task, IDENTITY_CHANGE_RECIPE);

        // ---- Everything that can be decided without a task is decided BEFORE TASK_CREATED. ----
        // A refusal here is a Restate invocation failure with no canonical task at all, never a task
        // left permanently RECEIVED. Reads are journaled (ctx.run) so a replay decides identically.
        const profile = await ctx.run("read-profile", () => identityStore.readProfile(task.tenant.id));
        // Bootstrap is decided by the absence of a HEAD, not of a profile: a profile with no head is an
        // interrupted bootstrap (profile committed, the rest refused or crashed), and the database's own
        // identity_candidate_classify() requires BOOTSTRAP for exactly that state.
        const head = profile ? await ctx.run("read-head", () => identityStore.readHead(profile.id)) : null;
        // ADR-0021 D1/D5 owner rule: an existing identity may only be changed or rolled back by its own
        // owner. HUMAN membership of the tenant is not enough. (identity_candidate_classify() enforces
        // the same rule in the database; this refuses before any task or candidate exists.)
        if (profile && profile.ownerPrincipalId !== actor.id)
          throw new restate.TerminalError("Only this identity's owner may change or roll it back", { errorCode: 403 });
        let identityId: string;
        let draftDocument: IdentityDocumentDraft;
        if (request.kind === "ROLLBACK") {
          if (!profile || !head) throw new restate.TerminalError("Cannot roll back: this tenant has no activated identity yet", { errorCode: 409 });
          identityId = profile.id;
          const target = await ctx.run("read-rollback-target", () => identityStore.readVersion(profile.id, request.toVersion));
          if (!target) throw new restate.TerminalError(`Cannot roll back: version ${request.toVersion} does not exist for this identity`, { errorCode: 404 });
          const { version: _drop, ...rest } = target.document;
          draftDocument = IdentityDocumentDraft.parse(rest);
        } else {
          if (request.document.tenantId !== task.tenant.id)
            throw new restate.TerminalError("Identity document tenantId does not match the requesting task's tenant", { errorCode: 400 });
          if (profile && request.document.id !== profile.id)
            throw new restate.TerminalError("Identity document id does not match this tenant's existing identity", { errorCode: 400 });
          // Bootstrap: the caller's declared document id becomes the identity id. Derived from the
          // immutable request payload, not fresh randomness - stable across a Restate replay.
          identityId = profile ? profile.id : request.document.id;
          draftDocument = request.document;
        }
        // A memory is never a place for a credential, and neither is an identity document - it is
        // shown to models and to the operator exactly the same way. Reuses KJ-P5's own secret-shape
        // check (services/memory/src/canonical/policy.ts) rather than a second pattern set.
        const secretShape = findSecretShapedContent(draftDocument.sections);
        if (secretShape) throw new restate.TerminalError(`Identity document content looks like a credential (${secretShape}); refused before any write`, { errorCode: 400 });
        const bootstrapping = !head;

        let taskState = task;
        const emit = async (key: string, type: TaskEvent["type"], status: TaskStatus, step?: TaskStep, payload?: Record<string, string>) => {
          taskState = Task.parse({ ...taskState, status });
          const event = TaskEvent.parse({
            id: ctx.rand.uuidv4(),
            taskId: task.id,
            traceId: task.traceId,
            actor: task.principal,
            occurredAt: new Date(await ctx.date.now()).toISOString(),
            type,
            payload:
              payload ??
              (type === "TASK_CREATED"
                ? { intent: compiled.submission.intent }
                : type === "PLAN_COMPILED"
                  ? { plan, planDigest: capabilityDigest(plan) }
                  : {}),
          });
          await ctx.run(key, () => ledger.write({ key, task: taskState, event, ...(step ? { step } : {}) }));
        };
        await emit("create", "TASK_CREATED", "RECEIVED");

        // ---- From here on a canonical task exists: every deterministic refusal ends it FAILED. ----
        // Never a TerminalError that leaves the task RECEIVED/COMPILED/VERIFYING forever. Transient
        // failures still throw ordinary errors, so Restate retries the step instead.
        const refuse = async (reason: string) => {
          await emit("refused", "TASK_FAILED", "FAILED", undefined, { reason });
          return { status: "FAILED" as const, reason };
        };
        /** Resolves a still-HELD candidate REJECTED so a refused task never leaves a live proposal behind.
         *  An APPROVED candidate cannot leave that state, but identity_version_guard() only lets a version
         *  be created by the candidate's own proposing task - which is now FAILED - so it is inert. */
        const rejectIfHeld = async (candidateId: string, key: string) => {
          const rejectedAt = new Date(await ctx.date.now()).toISOString();
          await ctx.run(key, async () => {
            const current = await identityStore.readCandidate(candidateId);
            if (current?.state !== "HELD") return;
            try {
              await identityStore.resolveCandidate(candidateId, "REJECTED", rejectedAt);
            } catch (error) {
              // Replay safety: a prior attempt's write may have committed without its journal entry.
              if ((await identityStore.readCandidate(candidateId))?.state !== "REJECTED") throw error;
            }
          });
        };

        if (bootstrapping && request.kind === "PROPOSE") {
          const ensured = await ctx.run("bootstrap-profile", async () => {
            try {
              await identityStore.ensureProfile({
                id: identityId,
                tenantId: task.tenant.id,
                ownerPrincipalId: actor.id,
                name: request.document.sections.classA.name,
              });
              return null;
            } catch (error) {
              if (error instanceof IdentityRefusal) return error.message;
              throw error;
            }
          });
          if (ensured) return refuse(`Identity bootstrap refused: ${ensured}`);
        }

        const proposedDigest = identityCoreDigest(draftDocument);
        const candidateId = ctx.rand.uuidv4();
        const proposed = await ctx.run("propose-candidate", async () => {
          try {
            const row = await identityStore.propose({
              id: candidateId,
              identityId,
              tenantId: task.tenant.id,
              document: draftDocument,
              proposedDigest,
              origin: "OPERATOR_INSTRUCTION",
              // A placeholder only for the ordinary PROPOSE case: identity_candidate_classify()
              // overwrites this with the actual diff-derived class (D6). BOOTSTRAP and ROLLBACK are
              // the two classes the trigger independently verifies rather than overwrites.
              governanceClass: request.kind === "ROLLBACK" ? "ROLLBACK" : head ? "A" : "BOOTSTRAP",
              proposedByTask: task.id,
            });
            return { ok: true as const, candidate: row };
          } catch (error) {
            if (error instanceof IdentityRefusal) return { ok: false as const, reason: error.message };
            throw error;
          }
        });
        if (!proposed.ok) return refuse(`Identity change refused: ${proposed.reason}`);
        const candidate = proposed.candidate;
        const governanceClass: IdentityGovernanceClass = candidate.governanceClass;
        // ADR-0021 D6: every class except BOOTSTRAP goes through policy, each under its own gate
        // capability, so a rule for one class can never authorise another.
        const gate =
          governanceClass === "A" ? IDENTITY_APPLY_A
          : governanceClass === "ROLLBACK" ? IDENTITY_APPLY_ROLLBACK
          : governanceClass === "C" ? IDENTITY_APPLY_C
          : governanceClass === "D" ? IDENTITY_APPLY_D
          : null;

        let step = TaskStep.parse({
          id: plan.resultStepId,
          taskId: task.id,
          kind: "DETERMINISTIC_FUNCTION",
          status: "READY",
          dependencies: [],
          requiredCapabilities: gate ? [gate] : [],
          riskClass: "LOW",
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          input: { candidateId: candidate.id, identityCoreDigest: proposedDigest },
          idempotencyKey: `identity-apply-${candidate.id}`,
        });
        await emit("compile", "PLAN_COMPILED", "COMPILED", step);

        const approvalId = ctx.key; // one gate for this task, scoped to it - same shape as golden-workflow.
        let evaluation: Awaited<ReturnType<typeof evaluatePolicy>> | null = null;
        if (gate) {
          const invocation = CapabilityInvocation.parse({
            runId: ctx.rand.uuidv4(),
            taskId: task.id,
            stepId: step.id,
            trace: { traceId: task.traceId, correlationId: task.id },
            capability: gate,
            idempotencyKey: step.idempotencyKey!,
            input: step.input,
          });
          const decisionId = ctx.rand.uuidv4(),
            at = new Date(await ctx.date.now()).toISOString();
          const evaluated = await ctx.run("evaluate-policy", () =>
            evaluatePolicy(rules, taskState, step, invocation, capabilities.describe(gate), decisionId, at),
          );
          // Persisted whatever the decision - a DENY is audit evidence too. identity_activation_guard()
          // later requires this exact event (candidate, proposed digest, gate, decision).
          const recorded = await ctx.run("record-policy", async () => {
            try {
              await approvals.record(evaluated, invocation, approvalId);
              return true;
            } catch (error) {
              if (error instanceof ApprovalError || error instanceof z.ZodError) return false;
              throw error;
            }
          });
          if (!recorded) {
            await rejectIfHeld(candidate.id, "reject-candidate");
            return refuse("Identity policy decision persistence rejected");
          }
          // Class A and ROLLBACK must always be human-approved: ALLOW is not enough for them. Class C/D
          // may be ALLOWed or approval-gated by policy. DENY - including "no matching rule" - refuses.
          const decision = evaluated.decision.decision;
          const acceptable = decision === "APPROVAL_REQUIRED" || (decision === "ALLOW" && (governanceClass === "C" || governanceClass === "D"));
          if (!acceptable) {
            await rejectIfHeld(candidate.id, "reject-candidate");
            return refuse(`Identity change refused by policy: ${decision} (${evaluated.decision.reasonCode}) for Class ${governanceClass}`);
          }
          evaluation = evaluated;
        }
        const needsApproval = evaluation?.decision.decision === "APPROVAL_REQUIRED";
        if (needsApproval && evaluation) {
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
            // against a real Restate server 2026-09-25. rejectIfHeld resolves it outside ctx.run.
            await rejectIfHeld(candidate.id, "reject-candidate");
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

        // ADR-0021 D8: completion + version + activation commit together in ONE transaction, or not at
        // all (identity/complete.ts). ctx.rand.uuidv4()/ctx.date.now() are resolved OUTSIDE ctx.run()
        // (see the comment on the approval path) so every retry reuses the same ids.
        const completedAt = new Date(await ctx.date.now()).toISOString();
        const proofMetadata = { candidateId: candidate.id, governanceClass, proposedDigest };
        const completionEvidenceId = ctx.rand.uuidv4(),
          completionEventId = ctx.rand.uuidv4(),
          versionId = ctx.rand.uuidv4(),
          activationId = ctx.rand.uuidv4();
        const applied = await ctx.run("apply-identity", async () => {
          try {
            const { version, activation } = await completeAndActivateIdentity(ledger.pool, {
              taskId: task.id,
              summary: `Identity ${governanceClass} change applied for ${identityId}`,
              proof: { evidenceId: completionEvidenceId, digest: capabilityDigest(proofMetadata), metadata: proofMetadata },
              audit: { eventId: completionEventId, at: completedAt },
              identityId,
              tenantId: task.tenant.id,
              draftDocument,
              candidateId: candidate.id,
              versionId,
              activationId,
              approvalId: needsApproval ? approvalId : null,
            });
            return { ok: true as const, identityId, version: version.version, governanceClass, activationId: activation.id };
          } catch (error) {
            // A deterministic governance refusal (freeze, rate cap, any identity trigger) rolled the
            // WHOLE transaction back, completion included - journal it as data and end the task FAILED
            // below. A D8 invariant breach means a COMPLETED task already exists without activation
            // (written by something other than this path); nothing here can repair it - fail loudly.
            if (error instanceof IdentityD8InvariantError) throw new restate.TerminalError(error.message, { errorCode: 500 });
            if (error instanceof IdentityRefusal) return { ok: false as const, reason: error.message };
            throw error; // transient: Restate retries, and the retry converges (see completeAndActivateIdentity)
          }
        });
        if (!applied.ok) {
          await rejectIfHeld(candidate.id, "reject-refused-candidate");
          return refuse(`Identity activation refused: ${applied.reason}`);
        }
        return { identityId: applied.identityId, version: applied.version, governanceClass: applied.governanceClass, activationId: applied.activationId };
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
