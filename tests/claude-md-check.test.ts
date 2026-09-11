import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRuntimeRegistry } from "../packages/capabilities/src/index.js";
import {
  NewSystemRuntimeAdapter,
  verifyClaudeMdCheck,
  CLAUDE_MD_CHECK_CRITERION,
} from "../packages/runtimes/src/index.js";
import { CapabilityResult } from "../packages/contracts/src/index.js";
import { compileIntent, criteria } from "../services/kernel/src/compiler/index.js";
import { planTask, projectStep } from "../services/kernel/src/planner/index.js";
import { kernelSubmission } from "../evals/fixtures/kernel.js";
import {
  claudeMdCheckInvocation,
  mockClaudeMdCompletedResponse,
  APPROVED_CONTENT_SHA256,
  DRIFTED_CONTENT_SHA256,
} from "../evals/fixtures/claude-md-check.js";

const FIXED_NOW = "2026-09-11T09:00:00.000+00:00";
const RECIPE = "claude_md_check/v1";
const REPOSITORY_READ_CAP = "60000000-0000-4000-8000-000000000003";

function adapterWith(response: Record<string, unknown>) {
  const runtime = createRuntimeRegistry();
  const fetchImpl = (async () =>
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return new NewSystemRuntimeAdapter(runtime, {
    spawnerBaseUrl: "http://127.0.0.1:8766",
    caller: "kerneljson",
    tenantId: "estate",
    fetch: fetchImpl,
    now: () => FIXED_NOW,
  });
}

async function invoke(response: Record<string, unknown>) {
  return adapterWith(response).invoke(claudeMdCheckInvocation);
}

describe("S1 canary claude_md_check/v1 — recipe registration (normal task path)", () => {
  it("compiles and plans to a single read-only REPOSITORY_READ step", () => {
    const { task } = compileIntent({ ...kernelSubmission, recipe: RECIPE });
    expect(task.riskClass).toBe("LOW");
    expect(task.acceptanceCriteria).toEqual([criteria[RECIPE]]);

    const plan = planTask(task, RECIPE);
    expect(plan.recipe).toBe(RECIPE);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.operation).toBe("REPOSITORY_READ");

    const step = projectStep(plan.steps[0]!);
    expect(step.kind).toBe("SANDBOX_EXEC");
    expect(step.requiredCapabilities).toEqual([
      { id: REPOSITORY_READ_CAP, version: "1.0.0" },
    ]);
    expect(step.retryPolicy).toEqual({ maxAttempts: 1, backoffMs: 0 });
  });

  it("keeps the compiler criterion byte-identical to the runtime constant", () => {
    expect(criteria[RECIPE]).toBe(CLAUDE_MD_CHECK_CRITERION);
  });
});

describe("S1 canary claude_md_check/v1 — read-only verification (PASS)", () => {
  it("PASSES when the read matches the approved CLAUDE.md digest with 0 mutations", async () => {
    const packed = await invoke(mockClaudeMdCompletedResponse());
    const v = verifyClaudeMdCheck({
      taskId: packed.taskId,
      result: packed.result,
      evidence: packed.evidence,
      outcome: packed.outcome,
      approvedContentSha256: APPROVED_CONTENT_SHA256,
    });
    expect(v.status).toBe("PASSED");
    expect(v.failures).toEqual([]);
    expect(v.evidenceRefs.length).toBeGreaterThan(0);
    expect(packed.digests.contentSha256).toBe(APPROVED_CONTENT_SHA256);
    expect(packed.outcome.status).toBe("COMPLETED");

    // Evidence artifact for the change-window record.
    mkdirSync("artifacts/local", { recursive: true });
    writeFileSync(
      "artifacts/local/claude-md-check-canary-proof.json",
      JSON.stringify(
        {
          canary: "claude_md_check/v1",
          status: v.status,
          taskId: packed.taskId,
          approvedContentSha256: APPROVED_CONTENT_SHA256,
          observedContentSha256: packed.digests.contentSha256,
          outcome: packed.outcome.status,
          verifierVersion: v.verifierVersion,
          recordedAt: FIXED_NOW,
        },
        null,
        2,
      ) + "\n",
    );
  });
});

describe("S1 canary claude_md_check/v1 — fail-on-purpose negatives", () => {
  it("FAILS with CLAUDE_MD_DRIFT when the read digest differs from approved", async () => {
    const packed = await invoke(
      mockClaudeMdCompletedResponse({
        structured: {
          content_sha256: DRIFTED_CONTENT_SHA256,
          output_hash: DRIFTED_CONTENT_SHA256.slice(0, 12),
        },
      }),
    );
    const v = verifyClaudeMdCheck({
      taskId: packed.taskId,
      result: packed.result,
      evidence: packed.evidence,
      outcome: packed.outcome,
      approvedContentSha256: APPROVED_CONTENT_SHA256,
    });
    expect(v.status).toBe("FAILED");
    expect(v.failures).toContain("CLAUDE_MD_DRIFT");
    expect(v.evidenceRefs).toEqual([]);
  });

  it("FAILS with TARGET_NOT_CLAUDE_MD when the read targeted another file", async () => {
    const packed = await invoke(
      mockClaudeMdCompletedResponse({
        structured: {
          target_path: "C:/Users/jonny/Desktop/kerneljson/NOTES.md",
        },
      }),
    );
    const v = verifyClaudeMdCheck({
      taskId: packed.taskId,
      result: packed.result,
      evidence: packed.evidence,
      outcome: packed.outcome,
      approvedContentSha256: APPROVED_CONTENT_SHA256,
    });
    expect(v.status).toBe("FAILED");
    expect(v.failures).toContain("TARGET_NOT_CLAUDE_MD");
  });

  it("FAILS with MUTATIONS_DETECTED when the read reports any mutation", async () => {
    const packed = await invoke(mockClaudeMdCompletedResponse());
    const result = CapabilityResult.parse(packed.result);
    const mutated = {
      ...result,
      output: {
        ...(result.output as Record<string, unknown>),
        mutations_detected: 1,
      },
    };
    const v = verifyClaudeMdCheck({
      taskId: packed.taskId,
      result: mutated,
      evidence: packed.evidence,
      outcome: packed.outcome,
      approvedContentSha256: APPROVED_CONTENT_SHA256,
    });
    expect(v.status).toBe("FAILED");
    expect(v.failures).toContain("MUTATIONS_DETECTED");
  });

  it("FAILS with APPROVED_DIGEST_SHAPE when the pinned digest is malformed", async () => {
    const packed = await invoke(mockClaudeMdCompletedResponse());
    const v = verifyClaudeMdCheck({
      taskId: packed.taskId,
      result: packed.result,
      evidence: packed.evidence,
      outcome: packed.outcome,
      approvedContentSha256: "not-a-valid-digest",
    });
    expect(v.status).toBe("FAILED");
    expect(v.failures).toContain("APPROVED_DIGEST_SHAPE");
  });

  it("FAILS with TASK_MISMATCH when verified against the wrong task id", async () => {
    const packed = await invoke(mockClaudeMdCompletedResponse());
    const v = verifyClaudeMdCheck({
      taskId: "60000000-0000-4000-8000-0000000000ff",
      result: packed.result,
      evidence: packed.evidence,
      outcome: packed.outcome,
      approvedContentSha256: APPROVED_CONTENT_SHA256,
    });
    expect(v.status).toBe("FAILED");
    expect(v.failures).toContain("TASK_MISMATCH");
  });

  it("FAILS with PARSE_FAILED on a malformed capability result", () => {
    const v = verifyClaudeMdCheck({
      taskId: claudeMdCheckInvocation.taskId,
      result: { not: "a capability result" },
      evidence: {},
      outcome: {},
      approvedContentSha256: APPROVED_CONTENT_SHA256,
    });
    expect(v.status).toBe("FAILED");
    expect(v.failures).toContain("PARSE_FAILED");
  });
});
