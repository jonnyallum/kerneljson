import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { AdaptiveRouter } from "../services/kernel/src/routing.js";
import {
  Task,
  TaskStep,
  CapabilityInvocation,
  type RouteObservation,
} from "../packages/contracts/src/index.js";
import { verificationFixture } from "../evals/fixtures/verification.js";
import {
  CapabilityRegistry,
  createBuiltinRegistry,
  UPPERCASE,
  TextInput,
  TextOutput,
} from "../packages/capabilities/src/index.js";
import { uppercaseSuite } from "../evals/golden/uppercase.js";
import { evaluate, promotionAllowed } from "../services/evaluator/src/index.js";
const alternate = { ...UPPERCASE, version: "1.1.0" },
  at = "2026-09-05T12:00:00.000Z";
function setup(
  effect: "ALLOW" | "DENY" | "APPROVAL_REQUIRED" = "ALLOW",
  evaluated = true,
  cold = false,
) {
  const registry = new CapabilityRegistry(
    [UPPERCASE, alternate].map((ref) => ({
      metadata: {
        ...createBuiltinRegistry().describe(UPPERCASE).metadata,
        ...ref,
      },
      inputSchema: TextInput,
      outputSchema: TextOutput,
      execute: (input) => ({
        text: TextInput.parse(input).text.trim().toUpperCase(),
      }),
      verify: (input, output) =>
        TextOutput.parse(output).text ===
        TextInput.parse(input).text.trim().toUpperCase(),
    })),
  );
  const bundle = verificationFixture(),
    task = Task.parse({ ...Task.parse(bundle.task), status: "COMPILED" }),
    step = TaskStep.parse({
      ...TaskStep.parse(bundle.steps[0]),
      status: "READY",
    }),
    request = CapabilityInvocation.parse(
      bundle.policies[0]!.payload.invocation,
    );
  const router = new AdaptiveRouter(
    registry,
    {
      version: "routing/1",
      compatible: [UPPERCASE, alternate],
      defaultCapability: UPPERCASE,
      limits: {
        minSamples: 1,
        maxAgeMs: 60000,
        minSuccessRate: 0.9,
        maxLatencyMs: 100,
        maxCostUnits: 2,
        allowColdStart: cold,
      },
    },
    {
      version: "routing-policy/1",
      rules: [UPPERCASE, alternate].map((capability) => ({
        tenantId: task.tenant.id,
        principalId: task.principal.id,
        capability,
        effect,
        ...(effect === "APPROVAL_REQUIRED"
          ? { approver: task.principal, ttlMs: 1000 }
          : {}),
      })),
    },
    async (ref, digest) =>
      evaluated &&
      promotionAllowed(
        evaluate(
          uppercaseSuite,
          {
            digest,
            execute: (input) =>
              registry.execute({ ...request, capability: ref, input }).output,
          },
          at,
        ),
        uppercaseSuite,
        digest,
      ),
  );
  const measurement = (
    capability: {id:string;version:string} = UPPERCASE,
    latencyMs = 10,
  ): RouteObservation => ({
    taskId: randomUUID(),
    evidenceId: randomUUID(),
    capability,
    descriptorDigest: registry.describe(capability).digest,
    observedAt: at,
    success: true,
    latencyMs,
    costUnits: 1,
  });
  return { router, registry, task, step, request, measurement };
}
it("adapts deterministically to measured latency among evaluated compatible versions", async () => {
  const s = setup();
  let records = [s.measurement(UPPERCASE, 80), s.measurement(alternate, 10)];
  const choice = await s.router.select(s.task, s.step, s.request, records, at);
  expect(choice.invocation.capability).toEqual(alternate);
  expect(choice.reason).toBe("MEASURED");
  records = [s.measurement(UPPERCASE, 5), s.measurement(alternate, 10)];
  expect(
    (await s.router.select(s.task, s.step, s.request, records, at)).invocation
      .capability,
  ).toEqual(UPPERCASE);
});
it("never trades policy or evaluation failure for faster execution", async () => {
  for (const effect of ["DENY", "APPROVAL_REQUIRED"] as const) {
    const s = setup(effect);
    await expect(
      s.router.select(s.task, s.step, s.request, [s.measurement()], at),
    ).rejects.toThrow("No eligible");
  }
  const s = setup("ALLOW", false);
  await expect(
    s.router.select(s.task, s.step, s.request, [s.measurement()], at),
  ).rejects.toThrow("No eligible");
});
it("enforces reliability, latency, cost, freshness and descriptor binding", async () => {
  const s = setup();
  for (const overrides of [
    { success: false },
    { latencyMs: 101 },
    { costUnits: 3 },
    { observedAt: "2020-01-01T00:00:00Z" },
    { observedAt: "2099-01-01T00:00:00Z" },
    { descriptorDigest: "f".repeat(64) },
  ])
    await expect(
      s.router.select(
        s.task,
        s.step,
        s.request,
        [{ ...s.measurement(), ...overrides }],
        at,
      ),
    ).rejects.toThrow("No eligible");
});
it("requires explicit cold-start opt-in and uses only the evaluated default", async () => {
  const s = setup("ALLOW", true, true);
  const choice = await s.router.select(s.task, s.step, s.request, [], at);
  expect(choice.reason).toBe("COLD_START");
  expect(choice.samples).toBe(0);
  expect(choice.invocation.capability).toEqual(UPPERCASE);
  const closed = setup();
  await expect(
    closed.router.select(closed.task, closed.step, closed.request, [], at),
  ).rejects.toThrow();
});
it("breaks ties stably and rejects duplicate or injected measurement evidence", async () => {
  const s = setup(),
    records = [s.measurement(alternate), s.measurement(UPPERCASE)];
  expect(
    (await s.router.select(s.task, s.step, s.request, records, at)).invocation
      .capability,
  ).toEqual(
    (
      await s.router.select(
        s.task,
        s.step,
        s.request,
        [...records].reverse(),
        at,
      )
    ).invocation.capability,
  );
  await expect(
    s.router.select(s.task, s.step, s.request, [records[0]!, records[0]!], at),
  ).rejects.toThrow("Duplicate");
  await expect(
    s.router.select(
      s.task,
      s.step,
      s.request,
      [{ ...records[0], decision: "ALLOW" }] as unknown as RouteObservation[],
      at,
    ),
  ).rejects.toThrow();
});
it("rejects task/step/invocation scope mismatches before selection", async () => {
  const s = setup();
  await expect(
    s.router.select(
      s.task,
      s.step,
      { ...s.request, taskId: randomUUID() },
      [s.measurement()],
      at,
    ),
  ).rejects.toThrow("No eligible");
});
