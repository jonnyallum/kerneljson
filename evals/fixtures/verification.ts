import {
  Task,
  TaskStep,
  Evidence,
} from "../../packages/contracts/src/index.js";
import {
  createBuiltinRegistry,
  UPPERCASE,
  capabilityDigest,
} from "../../packages/capabilities/src/index.js";
import { task as original } from "./contracts.js";
import { capabilityInvocation } from "./capabilities.js";
import { evaluatePolicy } from "../../services/kernel/src/policy.js";
import { criteria } from "../../services/kernel/src/compiler/index.js";
import type { VerificationBundle } from "../../services/kernel/src/verification.js";
export function verificationFixture(): VerificationBundle {
  const task = Task.parse({
    ...original,
    id: capabilityInvocation.taskId,
    traceId: capabilityInvocation.trace.traceId,
    status: "COMPILED",
    acceptanceCriteria: [criteria["uppercase/v1"]],
  });
  const request = { ...capabilityInvocation, input: { text: task.objective } };
  const registry = createBuiltinRegistry(),
    descriptor = registry.describe(UPPERCASE),
    result = registry.execute(request);
  const step = TaskStep.parse({
    id: request.stepId,
    taskId: task.id,
    kind: "DETERMINISTIC_FUNCTION",
    status: "READY",
    dependencies: [],
    requiredCapabilities: [UPPERCASE],
    riskClass: "LOW",
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    input: request.input,
    idempotencyKey: request.idempotencyKey,
  });
  const evaluation = evaluatePolicy(
    {
      version: "verify-policy/1",
      rules: [
        {
          tenantId: task.tenant.id,
          principalId: task.principal.id,
          capability: UPPERCASE,
          effect: "ALLOW",
        },
      ],
    },
    task,
    step,
    request,
    descriptor,
    "80000000-0000-4000-8000-000000000001",
    task.createdAt,
  );
  const evidence = Evidence.parse({
    id: "80000000-0000-4000-8000-000000000002",
    taskId: task.id,
    stepId: step.id,
    type: "DETERMINISTIC_RESULT",
    source: "kerneljson:capability/v1",
    digest: capabilityDigest(result),
    capturedAt: task.createdAt,
    metadata: {
      capability: request.capability,
      runId: request.runId,
      requestDigest: result.requestDigest,
      outputDigest: result.outputDigest,
      descriptorDigest: result.descriptorDigest,
    },
  });
  return {
    task: { ...task, status: "VERIFYING" },
    steps: [{ ...step, status: "COMPLETED", output: result.output }],
    runs: [
      {
        id: result.runId,
        taskId: task.id,
        stepId: step.id,
        result,
        evidenceId: evidence.id,
        descriptor,
      },
    ],
    evidence: [evidence],
    policies: [
      {
        id: evaluation.decision.id,
        taskId: task.id,
        actorId: task.principal.id,
        traceId: task.traceId,
        payload: { evaluation, invocation: request, approvalId: task.id },
      },
    ],
    approvals: [],
  };
}
