import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ApprovalAnswer,
  Task,
  TaskStep,
  PolicyEvaluation,
} from "../packages/contracts/src/index.js";
import {
  createBuiltinRegistry,
  UPPERCASE,
  capabilityDigest,
} from "../packages/capabilities/src/index.js";
import { PolicyRules, evaluatePolicy } from "../services/kernel/src/policy.js";
import { task as fixture } from "../evals/fixtures/contracts.js";
import { capabilityInvocation as invocation } from "../evals/fixtures/capabilities.js";
const task = Task.parse({
  ...fixture,
  id: invocation.taskId,
  traceId: invocation.trace.traceId,
  status: "COMPILED",
});
const step = TaskStep.parse({
  id: invocation.stepId,
  taskId: task.id,
  kind: "DETERMINISTIC_FUNCTION",
  status: "READY",
  dependencies: [],
  requiredCapabilities: [UPPERCASE],
  riskClass: "LOW",
  retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  input: invocation.input,
  idempotencyKey: invocation.idempotencyKey,
});
const descriptor = createBuiltinRegistry().describe(UPPERCASE);
const rule = {
  tenantId: task.tenant.id,
  principalId: task.principal.id,
  capability: UPPERCASE,
  effect: "ALLOW" as const,
};
const at = "2026-09-05T12:00:00.000Z";
it.each(["ALLOW", "DENY", "APPROVAL_REQUIRED"] as const)(
  "evaluates an explicit %s rule with a stable scope",
  (effect) => {
    const rules = PolicyRules.parse({
      version: "v1",
      rules: [
        {
          ...rule,
          effect,
          ...(effect === "APPROVAL_REQUIRED"
            ? { approver: fixture.principal, ttlMs: 1000 }
            : {}),
        },
      ],
    });
    const result = evaluatePolicy(
      rules,
      task,
      step,
      invocation,
      descriptor,
      randomUUID(),
      at,
    );
    expect(result.decision.decision).toBe(effect);
    expect(result.scopeDigest).toBe(capabilityDigest(result.scope));
    expect(PolicyEvaluation.safeParse(result).success).toBe(true);
  },
);
it.each([
  { ...rule, principalId: randomUUID() },
  { ...rule, tenantId: randomUUID() },
  { ...rule, capability: { ...UPPERCASE, version: "2.0.0" } },
])("denies unmatched identity/tenant/version (%#)", (candidate) => {
  expect(
    evaluatePolicy(
      { version: "v1", rules: [candidate] },
      task,
      step,
      invocation,
      descriptor,
      randomUUID(),
      at,
    ).decision.decision,
  ).toBe("DENY");
});
it("denies by default and refuses scope mismatch before considering ALLOW", () => {
  expect(
    evaluatePolicy(
      { version: "v1", rules: [] },
      task,
      step,
      invocation,
      descriptor,
      randomUUID(),
      at,
    ).decision.decision,
  ).toBe("DENY");
  const result = evaluatePolicy(
    { version: "v1", rules: [rule] },
    task,
    step,
    { ...invocation, input: { text: "changed" } },
    descriptor,
    randomUUID(),
    at,
  );
  expect(result.decision.reasonCode).toBe("SCOPE_MISMATCH");
});
it.each([
  { permissions: ["network"] },
  { riskClass: "HIGH" as const },
  { implementationType: "API" as const },
])("cannot authorize an unsupported capability (%#)", (change) => {
  const result = evaluatePolicy(
    { version: "v1", rules: [rule] },
    task,
    step,
    invocation,
    { ...descriptor, metadata: { ...descriptor.metadata, ...change } },
    randomUUID(),
    at,
  );
  expect(result.decision.reasonCode).toBe("UNSUPPORTED_CAPABILITY");
});
it("rejects ambiguous, service-approver and unbounded approval rules", () => {
  expect(
    PolicyRules.safeParse({ version: "v1", rules: [rule, rule] }).success,
  ).toBe(false);
  for (const ttlMs of [0, 86_400_001])
    expect(
      PolicyRules.safeParse({
        version: "v1",
        rules: [
          {
            ...rule,
            effect: "APPROVAL_REQUIRED",
            approver: fixture.principal,
            ttlMs,
          },
        ],
      }).success,
    ).toBe(false);
  expect(
    PolicyRules.safeParse({
      version: "v1",
      rules: [
        {
          ...rule,
          effect: "APPROVAL_REQUIRED",
          approver: { ...fixture.principal, kind: "SERVICE" },
          ttlMs: 1000,
        },
      ],
    }).success,
  ).toBe(false);
});
it("rejects actor/permissions injection into an approval answer", () => {
  const answer = { scopeDigest: "a".repeat(64), decision: "GRANTED" };
  expect(ApprovalAnswer.safeParse(answer).success).toBe(true);
  for (const change of [
    { actor: fixture.principal },
    { permissions: ["all"] },
    { decision: "ALLOW" },
    { scopeDigest: "bad" },
  ])
    expect(ApprovalAnswer.safeParse({ ...answer, ...change }).success).toBe(
      false,
    );
});

it("fails closed on task requirements the initial executor cannot enforce", () => {
  for (const change of [
    { constraints: ["Do not transform text"] },
    { deadline: at },
    { budget: { amount: 0, currency: "USD" } },
  ]) {
    const result = evaluatePolicy(
      { version: "v1", rules: [rule] },
      Task.parse({ ...task, ...change }),
      step,
      invocation,
      descriptor,
      randomUUID(),
      at,
    );
    expect(result.decision.reasonCode).toBe("UNSUPPORTED_TASK_REQUIREMENTS");
    expect(result.decision.decision).toBe("DENY");
  }
});
