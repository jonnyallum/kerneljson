import { z } from "zod";
import {
  CapabilityInvocation,
  CapabilityRef,
  Id,
  PolicyEvaluation,
  PrincipalRef,
  Task,
  TaskStep,
  Timestamp,
} from "../../../packages/contracts/src/index.js";
import {
  capabilityDigest,
  type CapabilityDescriptor,
} from "../../../packages/capabilities/src/index.js";

export const PolicyRules = z
  .strictObject({
    version: z.string().min(1),
    rules: z.array(
      z
        .strictObject({
          tenantId: Id,
          principalId: Id,
          capability: CapabilityRef,
          effect: z.enum(["ALLOW", "DENY", "APPROVAL_REQUIRED"]),
          approver: PrincipalRef.optional(),
          ttlMs: z.number().int().min(100).max(86_400_000).optional(),
        })
        .superRefine((r, ctx) => {
          if (
            r.effect === "APPROVAL_REQUIRED"
              ? r.approver?.kind !== "HUMAN" || !r.ttlMs
              : r.approver !== undefined || r.ttlMs !== undefined
          )
            ctx.addIssue({ code: "custom", message: "Invalid approval rule" });
        }),
    ),
  })
  .refine(
    (p) =>
      new Set(
        p.rules.map(
          (r) =>
            `${r.tenantId}:${r.principalId}:${r.capability.id}@${r.capability.version}`,
        ),
      ).size === p.rules.length,
    "Ambiguous policy rules",
  );
export type PolicyRules = z.infer<typeof PolicyRules>;
export function evaluatePolicy(
  rawRules: PolicyRules,
  rawTask: Task,
  rawStep: TaskStep,
  rawInvocation: CapabilityInvocation,
  descriptor: CapabilityDescriptor,
  id: string,
  at: string,
): PolicyEvaluation {
  const rules = PolicyRules.parse(rawRules),
    task = Task.parse(rawTask),
    step = TaskStep.parse(rawStep),
    invocation = CapabilityInvocation.parse(rawInvocation);
  Id.parse(id);
  Timestamp.parse(at);
  const scope = {
    taskId: task.id,
    stepId: step.id,
    tenantId: task.tenant.id,
    principal: task.principal,
    trace: invocation.trace,
    capability: invocation.capability,
    invocationDigest: capabilityDigest(invocation),
    descriptorDigest: descriptor.digest,
    policyVersion: rules.version,
  };
  let effect: "ALLOW" | "DENY" | "APPROVAL_REQUIRED" = "DENY",
    reason = "NO_MATCHING_RULE";
  const bound =
    task.status === "COMPILED" &&
    step.status === "READY" &&
    step.taskId === task.id &&
    invocation.taskId === task.id &&
    invocation.stepId === step.id &&
    invocation.trace.traceId === task.traceId &&
    capabilityDigest(step.requiredCapabilities) ===
      capabilityDigest([invocation.capability]) &&
    capabilityDigest(step.input) === capabilityDigest(invocation.input) &&
    step.idempotencyKey === invocation.idempotencyKey &&
    descriptor.metadata.id === invocation.capability.id &&
    descriptor.metadata.version === invocation.capability.version;
  const supported =
    task.riskClass === "LOW" &&
    step.riskClass === "LOW" &&
    step.kind === "DETERMINISTIC_FUNCTION" &&
    descriptor.metadata.riskClass === "LOW" &&
    descriptor.metadata.permissions.length === 0 &&
    descriptor.metadata.implementationType === "DETERMINISTIC";
  const rule = rules.rules.find(
    (r) =>
      r.tenantId === task.tenant.id &&
      r.principalId === task.principal.id &&
      r.capability.id === invocation.capability.id &&
      r.capability.version === invocation.capability.version,
  );
  if (!bound) reason = "SCOPE_MISMATCH";
  else if (task.constraints.length || task.budget || task.deadline)
    reason = "UNSUPPORTED_TASK_REQUIREMENTS";
  else if (!supported) reason = "UNSUPPORTED_CAPABILITY";
  else if (rule) {
    effect = rule.effect;
    reason = "EXPLICIT_RULE";
  }
  return PolicyEvaluation.parse({
    scope,
    scopeDigest: capabilityDigest(scope),
    decision: {
      id,
      taskId: task.id,
      stepId: step.id,
      capability: invocation.capability,
      decision: effect,
      reasonCode: reason,
      evaluatedAt: at,
      policyVersion: rules.version,
    },
    ...(effect === "APPROVAL_REQUIRED" && rule
      ? {
          approver: rule.approver,
          expiresAt: new Date(Date.parse(at) + rule.ttlMs!).toISOString(),
        }
      : {}),
  });
}
