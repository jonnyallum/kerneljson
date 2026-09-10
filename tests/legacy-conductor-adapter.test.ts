import { expect, it, vi } from "vitest";
import {
  createBuiltinRegistry,
  createLegacyConductorRegistry,
  createRuntimeRegistry,
  CONDUCTOR_BRAIN_QUERY,
  REPOSITORY_READ,
  capabilityDigest,
} from "../packages/capabilities/src/index.js";
import {
  LegacyConductorAdapter,
  LegacyConductorError,
  LEGACY_CONDUCTOR_DENIED,
} from "../packages/runtimes/src/index.js";
import {
  SAMPLE_RESULT_DIGEST,
  conductorBrainQueryInvocation,
  mockBridgeOk,
} from "../evals/fixtures/conductor-brain-query.js";

const FIXED_NOW = "2026-09-10T01:30:00.000+00:00";
const BRIDGE = "C:/Users/jonny/Desktop/new-system/adapters/legacy_conductor/brain_query_bridge.py";

function adapterWith(
  runBridge: (req: Record<string, unknown>) => Promise<unknown>,
) {
  const registry = createLegacyConductorRegistry();
  return new LegacyConductorAdapter(registry, {
    bridgePath: BRIDGE,
    runBridge,
    now: () => FIXED_NOW,
  });
}

it("legacy conductor registry accepts conductor.brain_query without altering Track A runtime registry", () => {
  const trackA = createRuntimeRegistry();
  expect(trackA.list()).toHaveLength(3);
  expect(() => trackA.describe(CONDUCTOR_BRAIN_QUERY)).toThrow("NOT_FOUND");
  expect(trackA.describe(REPOSITORY_READ).metadata.id).toBe(REPOSITORY_READ.id);

  const legacy = createLegacyConductorRegistry();
  expect(legacy.mode).toBe("runtime");
  expect(legacy.describe(CONDUCTOR_BRAIN_QUERY).metadata.permissions).toEqual([
    "read-brain-projects",
  ]);
  expect(() => legacy.describe(REPOSITORY_READ)).toThrow("NOT_FOUND");

  const builtins = createBuiltinRegistry();
  expect(() => builtins.describe(CONDUCTOR_BRAIN_QUERY)).toThrow("NOT_FOUND");
});

it("happy path: bridge ok -> CapabilityResult + Evidence + Outcome verified", async () => {
  const runBridge = vi.fn(async () => mockBridgeOk());
  const adapter = adapterWith(runBridge);
  const packed = await adapter.invoke(conductorBrainQueryInvocation);
  expect(runBridge).toHaveBeenCalledTimes(1);
  const req = runBridge.mock.calls[0]![0] as Record<string, unknown>;
  expect(req.capability).toBe("conductor.brain_query");
  expect(req.tool).toBe("brain_query_projects");
  expect(req.args).toEqual({
    query: "KernelJSON migration project knowledge",
    scope: "projects",
    limit: 8,
  });
  expect(packed.digests.resultDigest).toBe(SAMPLE_RESULT_DIGEST);
  expect(packed.evidence.digest).toBe(SAMPLE_RESULT_DIGEST);
  expect(packed.outcome.status).toBe("COMPLETED");
  expect(packed.result.verification).toBe("PASSED");
  expect(packed.discoveredWork).toHaveLength(1);
  expect(packed.bridgeMeta.transport).toBe("private-stdio-import");
  expect((packed.result.output as { mutations: number }).mutations).toBe(0);
});

it("idempotent replay does not re-call bridge", async () => {
  const runBridge = vi.fn(async () => mockBridgeOk());
  const adapter = adapterWith(runBridge);
  const a = await adapter.invoke(conductorBrainQueryInvocation);
  const b = await adapter.invoke(conductorBrainQueryInvocation);
  expect(runBridge).toHaveBeenCalledTimes(1);
  expect(a.result).toEqual(b.result);
  expect(a.evidence.id).toBe(b.evidence.id);
});

it("fail-closed schema: unknown input keys / bad scope / limit>8", async () => {
  const adapter = adapterWith(async () => mockBridgeOk());
  await expect(
    adapter.invoke({
      ...conductorBrainQueryInvocation,
      input: { query: "x", scope: "projects", limit: 8, offset: 1 },
    }),
  ).rejects.toMatchObject({ code: "INVALID_SCHEMA" });
  await expect(
    adapter.invoke({
      ...conductorBrainQueryInvocation,
      input: { query: "x", scope: "agents", limit: 4 },
    }),
  ).rejects.toMatchObject({ code: "INVALID_SCHEMA" });
  await expect(
    adapter.invoke({
      ...conductorBrainQueryInvocation,
      input: { query: "x", scope: "projects", limit: 9 },
    }),
  ).rejects.toMatchObject({ code: "INVALID_SCHEMA" });
});

it("collar denial tests for unauthorised tools BEFORE Conductor", async () => {
  const runBridge = vi.fn(async () => mockBridgeOk());
  const adapter = adapterWith(runBridge);
  for (const name of LEGACY_CONDUCTOR_DENIED) {
    expect(() => adapter.assertAllowed(name)).toThrow(LegacyConductorError);
  }
  expect(() => adapter.assertAllowed("conductor.brain_query")).not.toThrow();
  expect(runBridge).not.toHaveBeenCalled();
});

it("unsupported capability (repository.read) rejected", async () => {
  const runBridge = vi.fn(async () => mockBridgeOk());
  const adapter = adapterWith(runBridge);
  await expect(
    adapter.invoke({
      ...conductorBrainQueryInvocation,
      capability: REPOSITORY_READ,
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  expect(runBridge).not.toHaveBeenCalled();
});

it("maps bridge failure modes: unavailable/timeout/brain/crash/denied/schema", async () => {
  const cases = [
    ["UNAVAILABLE", "UNAVAILABLE"],
    ["TIMEOUT", "TIMEOUT"],
    ["BRAIN_ERROR", "BRAIN_ERROR"],
    ["CRASH", "CRASH"],
    ["DENIED", "DENIED"],
    ["INVALID_SCHEMA", "INVALID_SCHEMA"],
  ] as const;
  for (const [bridgeCode, expected] of cases) {
    const adapter = adapterWith(async () => ({
      ok: false,
      code: bridgeCode,
      error: bridgeCode,
      mutations: 0,
    }));
    await expect(adapter.invoke({
      ...conductorBrainQueryInvocation,
      idempotencyKey: `fail-${bridgeCode}`,
    })).rejects.toMatchObject({ code: expected });
  }
});

it("tool unavailable and mutations detected fail closed", async () => {
  const a = adapterWith(async () => ({
    ok: false,
    code: "UNAVAILABLE",
    error: "tool missing",
    mutations: 0,
  }));
  await expect(
    a.invoke({ ...conductorBrainQueryInvocation, idempotencyKey: "tool-miss" }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });

  const b = adapterWith(async () => mockBridgeOk({ mutations: 1 }));
  await expect(
    b.invoke({ ...conductorBrainQueryInvocation, idempotencyKey: "mut" }),
  ).rejects.toBeInstanceOf(LegacyConductorError);
});

it("discovered work is returned but never auto-scheduled by adapter", async () => {
  const packed = await adapterWith(async () => mockBridgeOk()).invoke(
    conductorBrainQueryInvocation,
  );
  expect(Array.isArray(packed.discoveredWork)).toBe(true);
  expect(packed.evidence.metadata.discovered_work_count).toBe(1);
  expect(packed.evidence.metadata.conductor_done_is_not_kj_completion).toBe(true);
  // Adapter does not mint tasks — discoveredWork is data only
  expect(packed.result.taskId).toBe(conductorBrainQueryInvocation.taskId);
});

it("registry verify accepts adapter CapabilityResult", async () => {
  const registry = createLegacyConductorRegistry();
  const adapter = new LegacyConductorAdapter(registry, {
    bridgePath: BRIDGE,
    runBridge: async () => mockBridgeOk(),
    now: () => FIXED_NOW,
  });
  const packed = await adapter.invoke(conductorBrainQueryInvocation);
  expect(registry.verify(conductorBrainQueryInvocation, packed.result)).toEqual(
    packed.result,
  );
  expect(capabilityDigest(packed.result.output)).toBe(packed.result.outputDigest);
});
