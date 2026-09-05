import { describe, it, expect } from "vitest";
import * as c from "../packages/contracts/src/index.js";
import {
  validFixtures,
  task,
  evidence,
  outcome,
  id,
  otherId,
  at,
  principal,
} from "../evals/fixtures/contracts.js";
import {
  SubmitTask,
  verifyEvidence,
  stepA,
  stepB,
  digest,
} from "../services/kernel/src/deterministic.js";
describe("contract fixtures", () => {
  for (const fixture of validFixtures) {
    it(`${fixture.name} accepts valid fixture`, () =>
      expect(fixture.schema.safeParse(fixture.value).success).toBe(true));
    it(`${fixture.name} rejects malformed, missing and unknown fields`, () => {
      for (const value of [
        null,
        [],
        {},
        { ...fixture.value, unexpectedPermission: "admin" },
      ])
        expect(fixture.schema.safeParse(value).success).toBe(false);
      for (const key of Object.keys(fixture.value)) {
        const malformed = {
          ...fixture.value,
          [key]: key === "input" || key === "payload" ? () => undefined : null,
        };
        expect(
          fixture.schema.safeParse(malformed).success,
          `${fixture.name}.${key}`,
        ).toBe(false);
      }
    });
  }
});
it("rejects invalid enums, IDs, timestamps and self-dependencies", () => {
  for (const patch of [
    { id: "bad" },
    { status: "DONE" },
    { riskClass: "SAFE" },
    { createdAt: "yesterday" },
    { parentTaskId: id },
    { objective: "" },
    { acceptanceCriteria: [] },
    { budget: { amount: -1, currency: "GBP" } },
  ])
    expect(c.Task.safeParse({ ...task, ...patch }).success).toBe(false);
  for (const d of ["ALLOW", "DENY", "APPROVAL_REQUIRED"])
    expect(c.Decision.parse(d)).toBe(d);
  for (const d of ["allow", "MODEL_GRANTED", "ADMIN", true])
    expect(c.Decision.safeParse(d).success).toBe(false);
  expect(c.Task.safeParse({ ...task, status: "COMPLETED" }).success).toBe(
    false,
  );
  expect(
    c.Approval.safeParse({
      id,
      taskId: id,
      requestedFrom: principal,
      requestedAt: at,
      status: "GRANTED",
    }).success,
  ).toBe(false);
});
it("freezes nested immutable event data", () => {
  const event = c.TaskEvent.parse({
    id,
    taskId: id,
    type: "TASK_CREATED",
    occurredAt: at,
    actor: principal,
    traceId: id,
    payload: { nested: { value: 1 } },
  });
  expect(Object.isFrozen(event)).toBe(true);
  expect(Object.isFrozen(event.payload)).toBe(true);
  expect(() => Reflect.set(event, "type", "TASK_COMPLETED")).not.toThrow();
  expect(event.type).toBe("TASK_CREATED");
});
it("enforces lifecycle transitions and terminal states", () => {
  const path = [
    "RECEIVED",
    "COMPILED",
    "READY",
    "RUNNING",
    "WAITING",
    "RUNNING",
    "VERIFYING",
    "COMPLETED",
  ] as const;
  for (let i = 1; i < path.length; i++)
    expect(() => c.assertTransition(path[i - 1]!, path[i]!)).not.toThrow();
  for (const from of ["COMPLETED", "FAILED", "CANCELLED"] as const)
    for (const to of c.TaskStatus.options)
      expect(() => c.assertTransition(from, to)).toThrow();
  expect(() => c.assertTransition("RECEIVED", "COMPLETED")).toThrow();
});
it("requires verified task-bound evidence and every criterion", () => {
  const verifying = { ...task, status: "VERIFYING" as const };
  expect(() =>
    c.assertCompletion(verifying, outcome, [evidence]),
  ).not.toThrow();
  expect(() => c.assertCompletion(verifying, outcome, [])).toThrow();
  expect(() =>
    c.assertCompletion(verifying, outcome, [{ ...evidence, taskId: otherId }]),
  ).toThrow();
  expect(() =>
    c.assertCompletion(
      { ...verifying, acceptanceCriteria: ["something else"] },
      outcome,
      [evidence],
    ),
  ).toThrow();
  for (const patch of [
    { evidenceRefs: [] },
    { acceptanceResults: [] },
    {
      acceptanceResults: [
        { criterion: "test", passed: false, evidenceRefs: [id] },
      ],
    },
  ])
    expect(c.Outcome.safeParse({ ...outcome, ...patch }).success).toBe(false);
  expect(c.Evidence.safeParse({ ...evidence, digest: undefined }).success).toBe(
    false,
  );
});
it("recomputes deterministic evidence and rejects tampering", () => {
  const metadata = {
    input: task.objective,
    output: stepB(stepA(task.objective)),
    recipe: "uppercase-reverse/v1",
  };
  const e = {
    ...evidence,
    source: "kerneljson:uppercase-reverse/v1",
    metadata,
    digest: digest(metadata),
  };
  expect(verifyEvidence(e, task, otherId)).toBe(true);
  expect(
    verifyEvidence(
      { ...e, metadata: { ...metadata, output: "invented" } },
      task,
      otherId,
    ),
  ).toBe(false);
  expect(verifyEvidence(e, { ...task, id: otherId }, otherId)).toBe(false);
  expect(
    SubmitTask.safeParse({ ...task, constraints: ["send an email"] }).success,
  ).toBe(false);
});
