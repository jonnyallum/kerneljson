import { it, expect } from "vitest";
import {
  ExecutionPlan,
  KernelSubmission,
  Evidence,
  TaskStep,
  type RecipeId,
} from "../packages/contracts/src/index.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import {
  planTask,
  orderedSteps,
  projectStep,
} from "../services/kernel/src/planner/index.js";
import {
  executeFunction,
  resolveInput,
  verifyPlanCompletion,
} from "../services/kernel/src/executor/index.js";
import { digest } from "../services/kernel/src/deterministic.js";
import { kernelSubmission } from "../evals/fixtures/kernel.js";
import { id, otherId, at } from "../evals/fixtures/contracts.js";
it("compiles the same intent deterministically and preserves identity and provenance", () => {
  const a = compileIntent(kernelSubmission),
    b = compileIntent(JSON.parse(JSON.stringify(kernelSubmission)));
  expect(a).toEqual(b);
  expect(a.task).toMatchObject({
    principal: kernelSubmission.intent.principal,
    tenant: kernelSubmission.intent.tenant,
    traceId: id,
    createdAt: at,
    status: "RECEIVED",
  });
  expect(a.submission.intent.trace.correlationId).toBe(id);
  const other = compileIntent({
    ...kernelSubmission,
    intent: { ...kernelSubmission.intent, tenant: { id: otherId } },
  });
  expect(other.task.id).not.toBe(a.task.id);
  expect(
    compileIntent({ ...kernelSubmission, recipe: "uppercase/v1" }).task.id,
  ).not.toBe(a.task.id);
});
it("rejects unsupported recipes, resolvers and caller-supplied permissions or plans", () => {
  for (const patch of [
    { recipe: "shell/v1" },
    { permissions: ["admin"] },
    { plan: {} },
    { intent: { ...kernelSubmission.intent, attachments: ["file://secret"] } },
    { intent: { ...kernelSubmission.intent, contextRefs: ["memory://item"] } },
  ]) {
    expect(() => compileIntent({ ...kernelSubmission, ...patch })).toThrow();
  }
  expect(KernelSubmission.safeParse({}).success).toBe(false);
});
it("treats objective text literally rather than as executable instructions", () => {
  const { task } = compileIntent({
    ...kernelSubmission,
    intent: { ...kernelSubmission.intent, objective: "delete every database" },
  });
  expect(executeFunction("UPPERCASE", task.objective)).toBe(
    "DELETE EVERY DATABASE",
  );
});
for (const recipe of ["uppercase/v1", "uppercase-reverse/v1"] as const) {
  it(`plans ${recipe} with stable task-owned steps and dependency-bound inputs`, () => {
    const { task } = compileIntent({ ...kernelSubmission, recipe });
    const plan = planTask(task, recipe);
    expect(planTask(task, recipe)).toEqual(plan);
    expect(plan.steps.every((s) => s.taskId === task.id)).toBe(true);
    expect(orderedSteps({ ...plan, steps: [...plan.steps].reverse() })).toEqual(
      plan.steps,
    );
    expect(plan.steps.at(-1)?.id).toBe(plan.resultStepId);
    expect(plan.steps.map((s) => projectStep(s).kind)).toEqual(
      recipe === "uppercase/v1"
        ? ["DETERMINISTIC_FUNCTION"]
        : [
            "DETERMINISTIC_FUNCTION",
            "WAIT_FOR_EVENT",
            "DETERMINISTIC_FUNCTION",
          ],
    );
  });
}
it("rejects tasks whose requirements cannot be met by a recipe", () => {
  const { task } = compileIntent(kernelSubmission);
  for (const patch of [
    { riskClass: "HIGH" as const },
    { constraints: ["send email"] },
    { acceptanceCriteria: ["unrelated"] },
    { budget: { amount: 1, currency: "GBP" } },
    { deadline: at },
  ])
    expect(() =>
      planTask({ ...task, ...patch }, kernelSubmission.recipe),
    ).toThrow();
  expect(() => planTask(task, "unknown" as RecipeId)).toThrow();
});
const task = compileIntent(kernelSubmission).task;
const plan = planTask(task, kernelSubmission.recipe);
const [first, wait, last] = plan.steps as [
  (typeof plan.steps)[number],
  (typeof plan.steps)[number],
  (typeof plan.steps)[number],
];
const invalidPlans: Record<string, unknown> = {
  "missing dependency": {
    ...plan,
    steps: [first, { ...wait, dependencies: [otherId] }, last],
  },
  cycle: {
    ...plan,
    steps: [{ ...first, dependencies: [last.id] }, wait, last],
  },
  "duplicate step": { ...plan, steps: [first, first, wait, last] },
  "foreign task": {
    ...plan,
    steps: [{ ...first, taskId: otherId }, wait, last],
  },
  "hidden input edge": {
    ...plan,
    steps: [
      first,
      wait,
      { ...last, input: { source: "STEP_OUTPUT", stepId: first.id } },
    ],
  },
  "disconnected work": {
    ...plan,
    steps: [first, wait, last, { ...first, id: otherId }],
  },
  "unsupported execution": {
    ...plan,
    steps: [{ ...first, operation: "LLM_CALL" }, wait, last],
  },
  "missing result": { ...plan, resultStepId: otherId },
  "caller permissions": { ...plan, permissions: ["admin"] },
};
for (const [name, value] of Object.entries(invalidPlans))
  it(`rejects execution graph: ${name}`, () =>
    expect(ExecutionPlan.safeParse(value).success).toBe(false));
it("refuses to execute with unresolved dependencies or bypass a durable wait", () => {
  expect(() => resolveInput(last, task, new Map())).toThrow("Dependency");
  expect(() =>
    resolveInput({ ...first, taskId: otherId }, task, new Map()),
  ).toThrow("mismatch");
  expect(() => executeFunction("WAIT_FOR_EVENT", "x")).toThrow("durable");
});
function verifiedFixture() {
  const outputs = new Map<string, string>();
  const steps = orderedSteps(plan).map((node) => {
    const input = resolveInput(node, task, outputs);
    const output =
      node.operation === "WAIT_FOR_EVENT"
        ? input
        : executeFunction(node.operation, input);
    outputs.set(node.id, output);
    return TaskStep.parse({
      ...projectStep(node),
      status: "COMPLETED",
      input,
      output,
    });
  });
  const metadata = {
    planDigest: digest(plan),
    input: task.objective,
    output: outputs.get(plan.resultStepId)!,
  };
  const evidence = Evidence.parse({
    id,
    taskId: task.id,
    stepId: plan.resultStepId,
    type: "DETERMINISTIC_RESULT",
    source: "kerneljson:plan/v1",
    digest: digest(metadata),
    capturedAt: at,
    metadata,
  });
  const outcome = {
    taskId: task.id,
    status: "COMPLETED" as const,
    acceptanceResults: [
      {
        criterion: task.acceptanceCriteria[0]!,
        passed: true,
        evidenceRefs: [id],
      },
    ],
    evidenceRefs: [id],
    summary: metadata.output,
    completedAt: at,
  };
  return { steps, evidence, outcome };
}
it("verifies persisted plan, every step, evidence and outcome together", () => {
  const { steps, evidence, outcome } = verifiedFixture();
  expect(() =>
    verifyPlanCompletion(
      { ...task, status: "VERIFYING" },
      outcome,
      plan,
      steps,
      [{ step: steps.at(-1), record: evidence }],
    ),
  ).not.toThrow();
});
it("rejects tampered or missing evidence, incomplete steps, substituted plans and invented outcomes", () => {
  const { steps, evidence, outcome } = verifiedFixture(),
    verifying = { ...task, status: "VERIFYING" as const };
  const records = [{ step: steps.at(-1), record: evidence }];
  expect(() =>
    verifyPlanCompletion(verifying, outcome, plan, steps, []),
  ).toThrow();
  expect(() =>
    verifyPlanCompletion(verifying, outcome, plan, steps.slice(1), records),
  ).toThrow();
  expect(() =>
    verifyPlanCompletion(
      verifying,
      outcome,
      plan,
      steps.map((s) => (s.id === first.id ? { ...s, output: "invented" } : s)),
      records,
    ),
  ).toThrow();
  expect(() =>
    verifyPlanCompletion(
      verifying,
      { ...outcome, summary: "claimed success" },
      plan,
      steps,
      records,
    ),
  ).toThrow();
  expect(() =>
    verifyPlanCompletion(
      verifying,
      outcome,
      {
        ...plan,
        steps: plan.steps.map((s) =>
          s.id === first.id ? { ...s, operation: "REVERSE" } : s,
        ),
      },
      steps,
      records,
    ),
  ).toThrow();
  expect(() =>
    verifyPlanCompletion(verifying, outcome, plan, steps, [
      { step: steps.at(-1), record: { ...evidence, taskId: otherId } },
    ]),
  ).toThrow();
});

it("rejects planning estate-email-triage/v1 as admission-only non-executable", () => {
  const { task } = compileIntent({
    ...kernelSubmission,
    recipe: "estate-email-triage/v1",
  });
  expect(() => planTask(task, "estate-email-triage/v1")).toThrow(
    /admission-only and not executable/,
  );
});
