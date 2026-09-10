import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ScheduleConfig,
  ScheduleSubmission,
} from "../packages/contracts/src/index.js";
import { kernelSubmission } from "../evals/fixtures/kernel.js";
import { compileSchedule } from "../services/kernel/src/schedule.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
const config = ScheduleConfig.parse({
  enabled: true,
  version: "test/1",
  maxIterations: 3,
  maxBudgetUnits: 3,
  minIntervalMs: 1000,
  maxIntervalMs: 30000,
});
const input = {
  intent: kernelSubmission.intent,
  iterations: 2,
  intervalMs: 1000,
  budgetUnits: 2,
};
it("compiles a bounded task plan with stable unique child task identities", () => {
  const a = compileSchedule(input, config, input.intent.principal),
    b = compileSchedule(input, config, input.intent.principal);
  expect(a).toEqual(b);
  expect(new Set(a.children.map((c) => compileIntent(c).task.id)).size).toBe(2);
  expect(a.task.acceptanceCriteria).toEqual([
    "All 2 scheduled tasks have verified outcomes",
  ]);
});
it("defaults disabled and requires an explicit authenticated human owner", () => {
  const { enabled: _, ...rest } = config;
  expect(() =>
    compileSchedule(input, ScheduleConfig.parse(rest), input.intent.principal),
  ).toThrow();
  expect(() =>
    compileSchedule(input, config, { id: randomUUID(), kind: "HUMAN" }),
  ).toThrow();
  expect(() =>
    compileSchedule(input, config, {
      ...input.intent.principal,
      kind: "SERVICE",
    }),
  ).toThrow();
});
it("enforces run counts, execution-unit budgets and interval limits", () => {
  for (const overrides of [
    { iterations: 4, budgetUnits: 4 },
    { iterations: 3, budgetUnits: 2 },
    { budgetUnits: 4 },
    { intervalMs: 999 },
    { intervalMs: 30001 },
  ])
    expect(() =>
      compileSchedule(
        { ...input, ...overrides },
        config,
        input.intent.principal,
      ),
    ).toThrow();
});
it("rejects attempts to enable, choose arbitrary workflows or inject plan fields", () => {
  for (const extra of [
    { enabled: true },
    { workflow: "Shell" },
    { plan: { commands: ["rm"] } },
  ])
    expect(ScheduleSubmission.safeParse({ ...input, ...extra }).success).toBe(
      false,
    );
});
