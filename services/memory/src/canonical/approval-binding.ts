import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  CapabilityInvocation,
  Id,
  PolicyEvaluation,
  Task,
  TaskEvent,
  TaskStep,
  type ApprovalResolution,
  type PrincipalRef,
} from "../../../../packages/contracts/src/index.js";
import { CapabilityRegistry, capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { ApprovalStore } from "../../../kernel/src/approval-store.js";
import { stableId } from "../../../kernel/src/compiler/index.js";
import { Ledger } from "../../../kernel/src/ledger.js";
import { evaluatePolicy } from "../../../kernel/src/policy.js";

/**
 * KJ-P5 - protected promotion through the EXISTING approval machinery. There is no second approval system.
 *
 * A protected promotion is expressed exactly as the P4B approvals are: a task with one deterministic step that
 * invokes a capability, a policy evaluation that says APPROVAL_REQUIRED for a named human approver with a deadline,
 * and an approval row recorded by the ApprovalStore. The approval binds the exact invocation (which names the
 * candidate id and the sha256 of the candidate's canonical request), so an approval for one candidate can never
 * promote another, and it expires and can be denied or cancelled like any other.
 *
 * What is NOT built here (and is recorded as the remaining work in the runbook): the durable Restate workflow
 * that would wait for the answer and the Telegram card for it. The existing approval workflows are specific to the
 * `uppercase` capability, and generalising qualified workflow code was out of scope. So a protected promotion is
 * approval-CAPABLE at the store: the approval exists and is decided by the ApprovalStore for the named approver,
 * and `settle` then completes or rejects the candidate from that decision. The task stays COMPILED (never
 * APPROVAL_REQUIRED), so the Telegram card discovery, which shows only APPROVAL_REQUIRED tasks, does not show a
 * button that nothing could answer.
 */
export const MEMORY_PROMOTE = Object.freeze({ id: "60000000-0000-4000-8000-0000000000a1", version: "1.0.0" });

const PromoteInput = z.strictObject({ candidateId: Id, candidateDigest: z.string().regex(/^[a-f0-9]{64}$/) });

/** A no-op deterministic capability, described only so the policy can name and digest it. The service does the work. */
const registry = new CapabilityRegistry([
  {
    metadata: {
      ...MEMORY_PROMOTE,
      description: "Promote one memory candidate to canonical memory, after the named human approves this exact candidate",
      inputSchemaRef: "kerneljson:memory-promote-input/v1",
      outputSchemaRef: "kerneljson:memory-promote-output/v1",
      riskClass: "LOW",
      permissions: [],
      implementationType: "DETERMINISTIC",
      verificationRequirements: ["approved-promotion/v1"],
    },
    inputSchema: PromoteInput,
    outputSchema: z.strictObject({ promoted: z.boolean() }),
    execute: () => ({ promoted: true }),
    verify: () => true,
  },
]);

export interface PromotionApprovalTicket {
  approvalId: string;
  expiresAt: string;
}

export interface PromotionApprovalState {
  status: ApprovalResolution["status"];
  expiresAt: string;
  /** The candidate this approval was bound to, read from the persisted step input, never from the caller. */
  boundCandidateId: string | null;
  boundCandidateDigest: string | null;
  approver: string | null;
}

export interface PromotionApprovals {
  request(input: { tenantId: string; candidateId: string; candidateDigest: string; submitter: PrincipalRef }): Promise<PromotionApprovalTicket>;
  state(approvalId: string): Promise<PromotionApprovalState>;
  /** Mark an approval whose deadline has passed as EXPIRED. Does nothing before the deadline. */
  expireIfDue(approvalId: string): Promise<void>;
}

export interface PromotionApprovalConfig {
  approver: PrincipalRef;
  ttlMs: number;
}

export class PgPromotionApprovals implements PromotionApprovals {
  private readonly store: ApprovalStore;
  private readonly ledger: Ledger;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: PromotionApprovalConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.store = new ApprovalStore(pool);
    this.ledger = new Ledger(pool);
  }

  async request(i: { tenantId: string; candidateId: string; candidateDigest: string; submitter: PrincipalRef }): Promise<PromotionApprovalTicket> {
    const approvalId = stableId(["memory-approval/v1", i.tenantId, i.candidateId]);
    const taskId = stableId(["memory-promotion-task/v1", i.tenantId, i.candidateId]);
    const existing = await this.pool.query("select 1 from public.approvals where id = $1::uuid", [approvalId]);
    if (existing.rowCount === 0) {
      const at = this.now().toISOString();
      const traceId = stableId(["memory-promotion-trace/v1", i.tenantId, i.candidateId]);
      const stepId = stableId(["memory-promotion-step/v1", i.tenantId, i.candidateId]);
      const invocation = CapabilityInvocation.parse({
        runId: randomUUID(),
        taskId,
        stepId,
        trace: { traceId, correlationId: taskId },
        capability: MEMORY_PROMOTE,
        idempotencyKey: `memory-promote-${i.candidateId}`,
        input: { candidateId: i.candidateId, candidateDigest: i.candidateDigest },
      });
      const haveTask = await this.pool.query("select 1 from public.tasks where id = $1::uuid", [taskId]);
      let task = Task.parse({
        id: taskId,
        principal: i.submitter,
        tenant: { id: i.tenantId },
        objective: `Promote memory candidate ${i.candidateId}`,
        acceptanceCriteria: ["The candidate is promoted only after the named approver grants this exact promotion"],
        constraints: [],
        riskClass: "LOW",
        status: "RECEIVED",
        traceId,
        createdAt: at,
      });
      const step = TaskStep.parse({
        id: stepId,
        taskId,
        kind: "DETERMINISTIC_FUNCTION",
        status: "READY",
        dependencies: [],
        requiredCapabilities: [MEMORY_PROMOTE],
        riskClass: "LOW",
        retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        input: invocation.input,
        idempotencyKey: invocation.idempotencyKey,
      });
      if (haveTask.rowCount === 0) {
        const event = (type: TaskEvent["type"]) =>
          TaskEvent.parse({ id: randomUUID(), taskId, type, occurredAt: at, actor: i.submitter, traceId, payload: {} });
        await this.ledger.write({ key: "create", task, event: event("TASK_CREATED") });
        task = Task.parse({ ...task, status: "COMPILED" });
        await this.ledger.write({ key: "compile", task, event: event("PLAN_COMPILED"), step });
      }
      const evaluation: PolicyEvaluation = evaluatePolicy(
        {
          version: "kj-memory-approval-policy/1",
          rules: [
            {
              tenantId: i.tenantId,
              principalId: i.submitter.id,
              capability: MEMORY_PROMOTE,
              effect: "APPROVAL_REQUIRED",
              approver: this.config.approver,
              ttlMs: this.config.ttlMs,
            },
          ],
        },
        Task.parse({ ...task, status: "COMPILED" }),
        step,
        invocation,
        registry.describe(MEMORY_PROMOTE),
        randomUUID(),
        at,
      );
      await this.store.record(evaluation, invocation, approvalId);
    }
    const resolution = await this.store.read(approvalId);
    return { approvalId, expiresAt: resolution.expiresAt };
  }

  async state(approvalId: string): Promise<PromotionApprovalState> {
    const resolution = await this.store.read(approvalId);
    const bound = await this.pool.query<{ input: { candidateId?: unknown; candidateDigest?: unknown }; requested_from: string }>(
      `select s.contract->'input' as input, a.requested_from
         from public.approvals a join public.task_steps s on s.id = a.step_id and s.task_id = a.task_id
        where a.id = $1::uuid`,
      [approvalId],
    );
    const row = bound.rows[0];
    return {
      status: resolution.status,
      expiresAt: resolution.expiresAt,
      boundCandidateId: typeof row?.input?.candidateId === "string" ? row.input.candidateId : null,
      boundCandidateDigest: typeof row?.input?.candidateDigest === "string" ? row.input.candidateDigest : null,
      approver: row?.requested_from ?? null,
    };
  }

  async expireIfDue(approvalId: string): Promise<void> {
    const resolution = await this.store.read(approvalId);
    if (resolution.status !== "PENDING" || Date.parse(resolution.expiresAt) > this.now().getTime()) return;
    await this.store.expire(approvalId, randomUUID(), randomUUID());
  }
}

/** Exported only so tests can prove the approval binds the exact candidate. */
export const promotionInputDigest = (candidateId: string, candidateDigest: string): string => capabilityDigest({ candidateId, candidateDigest });
