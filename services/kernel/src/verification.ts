import {
  Task,
  TaskStep,
  CapabilityInvocation,
  CapabilityResult,
  Evidence,
  PolicyEvaluation,
  VerificationReport,
} from "../../../packages/contracts/src/index.js";
import {
  createBuiltinRegistry,
  UPPERCASE,
  capabilityDigest,
} from "../../../packages/capabilities/src/index.js";
import { criteria } from "./compiler/index.js";

export interface VerificationBundle {
  task: unknown;
  steps: unknown[];
  runs: {
    id: string;
    taskId: string;
    stepId: string;
    result: unknown;
    evidenceId: string;
    descriptor: unknown;
  }[];
  evidence: unknown[];
  policies: {
    id: string;
    taskId: string;
    actorId: string;
    traceId: string;
    payload: { evaluation: unknown; invocation: unknown; approvalId: string };
  }[];
  approvals: { id: string; status: string; evidenceId: string | null }[];
}
export function verifyTaskEvidence(
  bundle: VerificationBundle,
  verifiedAt?: string,
): VerificationReport {
  const task = Task.parse(bundle.task);
  const failures: string[] = [],
    evidenceRefs: string[] = [];
  const check = (valid: boolean, reason: string) => {
    if (!valid) failures.push(reason);
  };
  const same = (a: unknown, b: unknown) =>
    capabilityDigest(a) === capabilityDigest(b);
  try {
    check(task.status === "VERIFYING", "TASK_NOT_VERIFYING");
    check(
      task.riskClass === "LOW" &&
        task.constraints.length === 0 &&
        !task.budget &&
        !task.deadline,
      "UNSUPPORTED_TASK_REQUIREMENTS",
    );
    check(
      same(task.acceptanceCriteria, [criteria["uppercase/v1"]]),
      "UNSUPPORTED_ACCEPTANCE_CRITERIA",
    );
    if (
      bundle.steps.length !== 1 ||
      bundle.runs.length !== 1 ||
      bundle.policies.length !== 1
    )
      throw new Error("Incomplete bundle");
    const step = TaskStep.parse(bundle.steps[0]),
      run = bundle.runs[0]!,
      result = CapabilityResult.parse(run.result);
    const policy = bundle.policies[0]!,
      evaluation = PolicyEvaluation.parse(policy.payload.evaluation),
      request = CapabilityInvocation.parse(policy.payload.invocation);
    const registry = createBuiltinRegistry();
    registry.verify(request, result);
    check(
      same(request.capability, UPPERCASE) &&
        same(run.descriptor, registry.describe(UPPERCASE)),
      "CAPABILITY_DESCRIPTOR_MISMATCH",
    );
    check(
      run.id === request.runId &&
        run.taskId === task.id &&
        run.stepId === step.id &&
        request.taskId === task.id &&
        request.stepId === step.id,
      "RUN_SCOPE_MISMATCH",
    );
    check(
      step.taskId === task.id &&
        step.status === "COMPLETED" &&
        step.kind === "DETERMINISTIC_FUNCTION" &&
        step.riskClass === "LOW" &&
        step.dependencies.length === 0 &&
        same(step.requiredCapabilities, [UPPERCASE]) &&
        step.idempotencyKey === request.idempotencyKey,
      "STEP_SCOPE_MISMATCH",
    );
    check(
      same(request.input, { text: task.objective }) &&
        same(step.input, request.input) &&
        same(step.output, result.output) &&
        same(result.output, { text: task.objective.trim().toUpperCase() }),
      "RESULT_MISMATCH",
    );
    check(
      policy.id === evaluation.decision.id &&
        policy.taskId === task.id &&
        policy.actorId === task.principal.id &&
        policy.traceId === task.traceId,
      "POLICY_EVENT_MISMATCH",
    );
    check(
      evaluation.scopeDigest === capabilityDigest(evaluation.scope) &&
        evaluation.scope.invocationDigest === capabilityDigest(request) &&
        evaluation.scope.descriptorDigest === result.descriptorDigest &&
        evaluation.scope.taskId === task.id &&
        evaluation.scope.stepId === step.id &&
        evaluation.scope.tenantId === task.tenant.id &&
        same(evaluation.scope.principal, task.principal) &&
        same(evaluation.scope.trace, request.trace) &&
        request.trace.traceId === task.traceId &&
        same(evaluation.scope.capability, request.capability),
      "POLICY_SCOPE_MISMATCH",
    );
    check(evaluation.decision.decision !== "DENY", "POLICY_DENIED");
    const records = bundle.evidence.map((e) => Evidence.parse(e));
    check(records.every(e => Date.parse(e.capturedAt) >= Date.parse(task.createdAt) && (!verifiedAt || Date.parse(e.capturedAt) <= Date.parse(verifiedAt))), "STALE_OR_FUTURE_EVIDENCE");
    const evidence = records.find((e) => e.id === run.evidenceId);
    check(
      !!evidence &&
        evidence.taskId === task.id &&
        evidence.stepId === step.id &&
        evidence.type === "DETERMINISTIC_RESULT" &&
        evidence.source === "kerneljson:capability/v1" &&
        evidence.digest === capabilityDigest(result) &&
        same(evidence.metadata, {
          capability: request.capability,
          runId: request.runId,
          requestDigest: result.requestDigest,
          outputDigest: result.outputDigest,
          descriptorDigest: result.descriptorDigest,
        }),
      "RESULT_EVIDENCE_MISMATCH",
    );
    if (evidence) evidenceRefs.push(evidence.id);
    if (evaluation.decision.decision === "APPROVAL_REQUIRED") {
      const approval = bundle.approvals.find(
        (a) => a.id === policy.payload.approvalId,
      );
      const decision = records.find((e) => e.id === approval?.evidenceId);
      const expected = {
        approvalId: approval?.id,
        scopeDigest: evaluation.scopeDigest,
        status: "GRANTED",
        reason: "HUMAN",
        actor: evaluation.approver,
      };
      check(
        approval?.status === "GRANTED" &&
          !!decision &&
          decision.taskId === task.id &&
          decision.stepId === step.id &&
          decision.type === "HUMAN_DECISION" &&
          decision.source === "kerneljson:approval/v1" &&
          decision.digest === capabilityDigest(decision.metadata) &&
          same(decision.metadata, expected) &&
          Date.parse(decision.capturedAt) >=
            Date.parse(evaluation.decision.evaluatedAt) &&
          Date.parse(decision.capturedAt) < Date.parse(evaluation.expiresAt!),
        "APPROVAL_EVIDENCE_MISMATCH",
      );
      if (decision) evidenceRefs.push(decision.id);
    }
  } catch {
    failures.push("INVALID_OR_INCOMPLETE_EVIDENCE");
  }
  return VerificationReport.parse({
    taskId: task.id,
    verifierVersion: "capability-uppercase/1",
    status: failures.length ? "FAILED" : "PASSED",
    failures,
    evidenceRefs: failures.length ? [] : evidenceRefs,
  });
}
