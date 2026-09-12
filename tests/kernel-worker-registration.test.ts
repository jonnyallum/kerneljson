import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Production worker registration. Imports the ACTUAL production entrypoint
 * `services/kernel/src/index.ts` (not tests/support/worker.ts) and asserts which
 * Restate services it registers. This is the exact substitution that hid the Gate 3
 * gap: the test worker had capabilities the production worker did not. The entrypoint
 * only calls `restate.serve` when run directly, so importing it here is side-effect
 * free apart from a lazy pg.Pool (never connected).
 */

const DIGEST = "27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10";

function names(services: readonly unknown[]): string[] {
  return services.map((s) => (s as { name: string }).name);
}

describe("production worker service registration", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env["DATABASE_URL"] = "postgresql://unused@127.0.0.1:1/unused";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("registers KernelWorkflowV1 + TaskWorkflow + CapabilityServiceV1 when the canary is configured", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    const mod = await import("../services/kernel/src/index.js");
    const registered = names(mod.services);
    expect(registered).toContain("KernelWorkflowV1");
    expect(registered).toContain("TaskWorkflow");
    expect(registered).toContain("CapabilityServiceV1");
  });

  it("registers only the deterministic workflows without a repository root", async () => {
    delete process.env["KJ_REPO_ROOT"];
    delete process.env["SCHED_RECIPE"];
    delete process.env["SCHED_APPROVED_SHA256"];
    const mod = await import("../services/kernel/src/index.js");
    const registered = names(mod.services);
    expect(registered).toContain("KernelWorkflowV1");
    expect(registered).toContain("TaskWorkflow");
    expect(registered).not.toContain("CapabilityServiceV1");
  });

  it("fails closed if the canary is half-configured (root without approved digest)", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    delete process.env["SCHED_APPROVED_SHA256"];
    await expect(import("../services/kernel/src/index.js")).rejects.toThrow();
  });
});
