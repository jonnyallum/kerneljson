import { expect, it } from "vitest";
import {
  Task,
  TaskStep,
  CapabilityResult,
  Evidence,
  PolicyEvaluation,
} from "../packages/contracts/src/index.js";
import { verifyTaskEvidence } from "../services/kernel/src/verification.js";
import { verificationFixture } from "../evals/fixtures/verification.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";
it("passes only independently verified, policy-authorized capability evidence", () => {
  const result = verifyTaskEvidence(verificationFixture());
  expect(result.status).toBe("PASSED");
  expect(result.evidenceRefs).toHaveLength(1);
});
it.each(["steps", "runs", "evidence", "policies"] as const)(
  "fails without %s",
  (key) => {
    const bundle = verificationFixture();
    bundle[key] = [];
    expect(verifyTaskEvidence(bundle).status).toBe("FAILED");
  },
);
it("rejects arbitrary acceptance criteria and unverified task state", () => {
  const bundle = verificationFixture();
  for (const change of [
    { acceptanceCriteria: ["send money"] },
    { status: "RUNNING" },
  ]) {
    expect(
      verifyTaskEvidence({
        ...bundle,
        task: { ...Task.parse(bundle.task), ...change },
      }).status,
    ).toBe("FAILED");
  }
});
it("rejects incomplete steps and forged output despite a recomputed digest", () => {
  const bundle = verificationFixture(),
    step = TaskStep.parse(bundle.steps[0]);
  expect(
    verifyTaskEvidence({ ...bundle, steps: [{ ...step, status: "RUNNING" }] })
      .status,
  ).toBe("FAILED");
  const run = bundle.runs[0]!,
    result = CapabilityResult.parse(run.result),
    output = { text: "forged" };
  expect(
    verifyTaskEvidence({
      ...bundle,
      runs: [
        {
          ...run,
          result: { ...result, output, outputDigest: capabilityDigest(output) },
        },
      ],
    }).status,
  ).toBe("FAILED");
});
it("rejects foreign evidence, descriptor drift and denied policy", () => {
  const bundle = verificationFixture(),
    evidence = Evidence.parse(bundle.evidence[0]);
  expect(
    verifyTaskEvidence({
      ...bundle,
      evidence: [{ ...evidence, taskId: evidence.stepId }],
    }).status,
  ).toBe("FAILED");
  expect(
    verifyTaskEvidence({
      ...bundle,
      runs: [{ ...bundle.runs[0]!, descriptor: {} }],
    }).status,
  ).toBe("FAILED");
  const policy = bundle.policies[0]!,
    evaluation = PolicyEvaluation.parse(policy.payload.evaluation);
  expect(
    verifyTaskEvidence({
      ...bundle,
      policies: [
        {
          ...policy,
          payload: {
            ...policy.payload,
            evaluation: {
              ...evaluation,
              decision: { ...evaluation.decision, decision: "DENY" },
            },
          },
        },
      ],
    }).status,
  ).toBe("FAILED");
});

it("requires bound human evidence for approval-required execution", () => {
  const bundle = verificationFixture(),
    task = Task.parse(bundle.task),
    policy = bundle.policies[0]!;
  const original = PolicyEvaluation.parse(policy.payload.evaluation);
  const evaluation = PolicyEvaluation.parse({
    ...original,
    decision: { ...original.decision, decision: "APPROVAL_REQUIRED" },
    approver: task.principal,
    expiresAt: "2026-09-05T12:01:00.000Z",
  });
  bundle.policies = [{ ...policy, payload: { ...policy.payload, evaluation } }];
  expect(verifyTaskEvidence(bundle).status).toBe("FAILED");
  const metadata = {
    approvalId: task.id,
    scopeDigest: evaluation.scopeDigest,
    status: "GRANTED",
    reason: "HUMAN",
    actor: task.principal,
  };
  const evidence = Evidence.parse({
    id: "80000000-0000-4000-8000-000000000003",
    taskId: task.id,
    stepId: evaluation.scope.stepId,
    type: "HUMAN_DECISION",
    source: "kerneljson:approval/v1",
    digest: capabilityDigest(metadata),
    capturedAt: "2026-09-05T12:00:30.000Z",
    metadata,
  });
  bundle.approvals = [
    { id: task.id, status: "GRANTED", evidenceId: evidence.id },
  ];
  bundle.evidence.push(evidence);
  expect(verifyTaskEvidence(bundle).status).toBe("PASSED");
  bundle.evidence[1] = { ...evidence, capturedAt: "2026-09-05T12:02:00.000Z" };
  expect(verifyTaskEvidence(bundle).status).toBe("FAILED");
  const forged = {
    ...metadata,
    actor: { ...task.principal, id: evaluation.scope.stepId },
  };
  bundle.evidence[1] = {
    ...evidence,
    metadata: forged,
    digest: capabilityDigest(forged),
  };
  expect(verifyTaskEvidence(bundle).status).toBe("FAILED");
});
