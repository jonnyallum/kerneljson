import { z } from "zod";
import { CapabilityRef, Id, Timestamp } from "./common.js";
import { PrincipalRef, TraceRef } from "./identity.js";
import { PolicyDecision } from "./policy.js";
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PolicyScope = z.strictObject({
  taskId: Id,
  stepId: Id,
  tenantId: Id,
  principal: PrincipalRef,
  trace: TraceRef,
  capability: CapabilityRef,
  invocationDigest: Digest,
  descriptorDigest: Digest,
  policyVersion: z.string().min(1),
});
export const PolicyEvaluation = z
  .strictObject({
    decision: PolicyDecision,
    scope: PolicyScope,
    scopeDigest: Digest,
    approver: PrincipalRef.optional(),
    expiresAt: Timestamp.optional(),
  })
  .superRefine((e, ctx) => {
    if (
      e.decision.taskId !== e.scope.taskId ||
      e.decision.stepId !== e.scope.stepId ||
      e.decision.policyVersion !== e.scope.policyVersion ||
      e.decision.capability.id !== e.scope.capability.id ||
      e.decision.capability.version !== e.scope.capability.version
    )
      ctx.addIssue({ code: "custom", message: "Decision/scope mismatch" });
    if (e.decision.decision === "APPROVAL_REQUIRED") {
      if (
        e.approver?.kind !== "HUMAN" ||
        !e.expiresAt ||
        Date.parse(e.expiresAt) <= Date.parse(e.decision.evaluatedAt)
      )
        ctx.addIssue({
          code: "custom",
          message: "Approval requires a human and a future deadline",
        });
    } else if (e.approver || e.expiresAt)
      ctx.addIssue({ code: "custom", message: "Unexpected approval fields" });
  });
export type PolicyEvaluation = z.infer<typeof PolicyEvaluation>;
export const ApprovalAnswer = z.strictObject({
  scopeDigest: Digest,
  decision: z.enum(["GRANTED", "DENIED"]),
});
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;
export const ApprovalResolution = z.strictObject({
  approvalId: Id,
  scopeDigest: Digest,
  status: z.enum(["PENDING", "GRANTED", "DENIED", "EXPIRED"]),
  expiresAt: Timestamp,
  evidenceId: Id.optional(),
  reason: z.enum(["HUMAN", "EXPIRED", "CANCELLED"]).optional(),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolution>;
