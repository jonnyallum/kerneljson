import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  CapabilityRegistry,
  createBuiltinRegistry,
  createRuntimeRegistry,
  REPOSITORY_READ,
  UPPERCASE,
  TextInput,
  TextOutput,
  capabilityDigest,
} from "../packages/capabilities/src/index.js";
import {
  NewSystemRuntimeAdapter,
  NewSystemRuntimeError,
  planRepositoryRead,
  verifyRepositoryRead,
} from "../packages/runtimes/src/index.js";
import {
  CONTENT_SHA256,
  mockSpawnerCompletedResponse,
  mockSpawnerStructuredOutput,
  repositoryReadInvocation,
} from "../evals/fixtures/repository-read.js";

const FIXED_NOW = "2026-09-09T18:20:00.000+00:00";

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return handler(url, init);
  }) as unknown as typeof fetch;
}

it("createBuiltinRegistry still refuses permissioned caps; runtime registry accepts repository.read", () => {
  const builtins = createBuiltinRegistry();
  expect(builtins.list()).toHaveLength(2);
  expect(builtins.mode).toBe("builtin");
  expect(() => builtins.describe(REPOSITORY_READ)).toThrow("NOT_FOUND");

  const runtime = createRuntimeRegistry();
  expect(runtime.mode).toBe("runtime");
  expect(runtime.list()).toHaveLength(3);
  const desc = runtime.describe(REPOSITORY_READ);
  expect(desc.metadata.permissions).toEqual(["read-only-filesystem"]);
  expect(desc.metadata.implementationType).toBe("SANDBOX");
  expect(desc.metadata.id).toBe(REPOSITORY_READ.id);

  const upper = builtins.describe(UPPERCASE);
  expect(
    () =>
      new CapabilityRegistry([
        {
          metadata: { ...upper.metadata, permissions: ["write"] },
          inputSchema: TextInput,
          outputSchema: TextOutput,
          execute: () => ({ text: "X" }),
          verify: () => true,
        },
      ]),
  ).toThrow("UNSUPPORTED_CAPABILITY");
});

it("runtime registry verify accepts Spawner-shaped repository.read output with full SHA-256", () => {
  const runtime = createRuntimeRegistry();
  const output = mockSpawnerCompletedResponse();
  const structured = JSON.parse(String(output.output)) as Record<string, unknown>;
  const invocation = repositoryReadInvocation;
  // Build a CapabilityResult and verify via registry (execute path fails closed for external)
  expect(() => runtime.execute(invocation)).toThrow("IMPLEMENTATION_FAILED");
  const descriptor = runtime.describe(REPOSITORY_READ);
  const result = {
    runId: invocation.runId,
    taskId: invocation.taskId,
    stepId: invocation.stepId,
    trace: invocation.trace,
    capability: invocation.capability,
    idempotencyKey: invocation.idempotencyKey,
    requestDigest: capabilityDigest(invocation),
    descriptorDigest: descriptor.digest,
    output: structured,
    outputDigest: capabilityDigest(structured),
    verification: "PASSED" as const,
  };
  expect(runtime.verify(invocation, result)).toEqual(result);
  expect(String(structured.content_sha256)).toMatch(/^[a-f0-9]{64}$/);
});

it("NewSystemRuntimeAdapter POSTs SpawnRequest with input_data and maps Evidence digest to content_sha256", async () => {
  const runtime = createRuntimeRegistry();
  let capturedBody: unknown;
  const fetchImpl = mockFetch(async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(mockSpawnerCompletedResponse()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const adapter = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    caller: "kerneljson",
    tenantId: "estate",
    fetch: fetchImpl,
    now: () => FIXED_NOW,
  });
  const packed = await adapter.invoke(repositoryReadInvocation);
  expect(capturedBody).toEqual({
    task_id: repositoryReadInvocation.taskId,
    caller: "kerneljson",
    tenant_id: "estate",
    mission: "repository.read",
    brief: "KJ-000000 repository.read of NOTES.md",
    skills: ["repository.read"],
    timeout_seconds: 45,
    input_data: {
      repo_path: "C:/Users/jonny/Desktop/kerneljson",
      target_file: "NOTES.md",
      timeout_seconds: 45,
    },
    dry_run: false,
  });
  expect(packed.digests.contentSha256).toBe(CONTENT_SHA256);
  expect(packed.evidence.digest).toBe(CONTENT_SHA256);
  expect(packed.executionKey).toBe(repositoryReadInvocation.taskId);
  expect(packed.outcome.status).toBe("COMPLETED");
  expect(packed.result.verification).toBe("PASSED");
});

it("idempotent replay returns the same CapabilityResult for the same idempotencyKey", async () => {
  const runtime = createRuntimeRegistry();
  const fetchImpl = mockFetch(
    async () =>
      new Response(JSON.stringify(mockSpawnerCompletedResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const adapter = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    fetch: fetchImpl,
    now: () => FIXED_NOW,
  });
  const a = await adapter.invoke(repositoryReadInvocation);
  const b = await adapter.invoke(repositoryReadInvocation);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(a.result).toEqual(b.result);
  expect(a.evidence.id).toBe(b.evidence.id);
});

it("fails closed on Spawner failure, non-64 digests, and mutations_detected != 0", async () => {
  const runtime = createRuntimeRegistry();
  const failing = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    fetch: mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            status: "failed",
            exit_code: 1,
            evidence: "Target README not found",
            output: "",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
    now: () => FIXED_NOW,
  });
  await expect(failing.invoke(repositoryReadInvocation)).rejects.toBeInstanceOf(
    NewSystemRuntimeError,
  );

  const badDigest = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    fetch: mockFetch(
      async () =>
        new Response(
          JSON.stringify(
            mockSpawnerCompletedResponse({
              structured: { content_sha256: "abc", output_hash: "abc" },
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
    now: () => FIXED_NOW,
  });
  await expect(badDigest.invoke(repositoryReadInvocation)).rejects.toMatchObject({
    code: "INVALID_SPAWNER_OUTPUT",
  });

  const mutated = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    fetch: mockFetch(
      async () =>
        new Response(
          JSON.stringify(
            mockSpawnerCompletedResponse({
              structured: { mutations_detected: 2 },
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
    now: () => FIXED_NOW,
  });
  await expect(mutated.invoke(repositoryReadInvocation)).rejects.toMatchObject({
    code: "INVALID_SPAWNER_OUTPUT",
  });
});

it("KJ-000000 minimum plan + verifier PASS on adapter result", async () => {
  const runtime = createRuntimeRegistry();
  const adapter = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    caller: "kerneljson",
    tenantId: "estate",
    fetch: mockFetch(
      async () =>
        new Response(JSON.stringify(mockSpawnerCompletedResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
    now: () => FIXED_NOW,
  });
  const plan = planRepositoryRead(repositoryReadInvocation.taskId);
  expect(plan.recipe).toBe("repository-read/v1");
  expect(plan.steps).toHaveLength(1);
  expect(plan.steps[0]?.operation).toBe("REPOSITORY_READ");
  const packed = await adapter.invoke(repositoryReadInvocation);
  const verification = verifyRepositoryRead({
    taskId: packed.taskId,
    result: packed.result,
    evidence: packed.evidence,
    outcome: packed.outcome,
  });
  expect(verification.status).toBe("PASSED");
  expect(verification.failures).toEqual([]);
  // Binary proof digests are full SHA-256
  expect(packed.digests.contentSha256).toHaveLength(64);
  expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
});


it("accepts live Spawner-shaped output including timeout_seconds", async () => {
  const runtime = createRuntimeRegistry();
  const adapter = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    fetch: mockFetch(
      async () =>
        new Response(JSON.stringify(mockSpawnerCompletedResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
    now: () => FIXED_NOW,
  });
  const packed = await adapter.invoke(repositoryReadInvocation);
  expect(packed.result.output).toMatchObject({ timeout_seconds: 45 });
  expect(packed.digests.contentSha256).toBe(CONTENT_SHA256);
});

it("fail-closes on unknown Spawner structured fields (strict contract)", async () => {
  const runtime = createRuntimeRegistry();
  const adapter = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    fetch: mockFetch(
      async () =>
        new Response(
          JSON.stringify(
            mockSpawnerCompletedResponse({
              structured: { unexpected_field: "nope" },
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
    now: () => FIXED_NOW,
  });
  await expect(adapter.invoke(repositoryReadInvocation)).rejects.toMatchObject({
    code: "INVALID_SPAWNER_OUTPUT",
  });
});

it("fail-closes when timeout_seconds is missing from Spawner output", async () => {
  const runtime = createRuntimeRegistry();
  const base = mockSpawnerStructuredOutput();
  const { timeout_seconds: _drop, ...withoutTimeout } = base;
  const adapter = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    fetch: mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            ...mockSpawnerCompletedResponse(),
            output: JSON.stringify(withoutTimeout),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
    now: () => FIXED_NOW,
  });
  await expect(adapter.invoke(repositoryReadInvocation)).rejects.toMatchObject({
    code: "INVALID_SPAWNER_OUTPUT",
  });
});

