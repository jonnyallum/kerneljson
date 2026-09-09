import { expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRuntimeRegistry } from "../packages/capabilities/src/index.js";
import {
  NewSystemRuntimeAdapter,
  planRepositoryRead,
  verifyRepositoryRead,
} from "../packages/runtimes/src/index.js";
import {
  mockSpawnerCompletedResponse,
  repositoryReadInvocation,
} from "../evals/fixtures/repository-read.js";

const FIXED_NOW = "2026-09-09T18:20:00.000+00:00";

it("KJ-000000 binary proof via mocked Spawner HTTP (repository.read)", async () => {
  const runtime = createRuntimeRegistry();
  const fetchImpl = (async () =>
    new Response(JSON.stringify(mockSpawnerCompletedResponse()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const adapter = new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    caller: "kerneljson",
    tenantId: "estate",
    fetch: fetchImpl,
    now: () => FIXED_NOW,
  });

  const plan = planRepositoryRead(repositoryReadInvocation.taskId);
  let status: "PASSED" | "FAILED";
  let packed: Awaited<ReturnType<typeof adapter.invoke>> | undefined;
  let verification: ReturnType<typeof verifyRepositoryRead> | undefined;
  let error: string | undefined;
  try {
    packed = await adapter.invoke(repositoryReadInvocation);
    verification = verifyRepositoryRead({
      taskId: packed.taskId,
      result: packed.result,
      evidence: packed.evidence,
      outcome: packed.outcome,
    });
    status = verification.status;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    status = "FAILED";
  }

  const report = {
    mission: "KJ-000000",
    status,
    taskId: repositoryReadInvocation.taskId,
    executionKey: packed?.executionKey ?? repositoryReadInvocation.taskId,
    digests: packed?.digests ?? null,
    outcome: packed?.outcome?.status ?? null,
    verification,
    planRecipe: plan.recipe,
    repositoryReadUuid: "60000000-0000-4000-8000-000000000003",
    spawnerContract: "feat/spawner-input-data-preserve@071eae4",
    error: error ?? null,
    recordedAt: FIXED_NOW,
  };
  mkdirSync("artifacts/local", { recursive: true });
  writeFileSync(
    "artifacts/local/kj-000000-proof.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  expect(status).toBe("PASSED");
  expect(packed?.digests.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(packed?.outcome.status).toBe("COMPLETED");
});
