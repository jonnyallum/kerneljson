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

  it("registers ScheduleDriver when the admission seam + canary are all configured", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    process.env["KJ_ADMISSION_URL"] = "http://gateway:8081";
    process.env["KJ_ADMISSION_BEARER"] = "RAW_TEST_TOKEN_VALUE";
    const mod = await import("../services/kernel/src/index.js");
    const registered = names(mod.services);
    expect(registered).toContain("ScheduleDriver");
    expect(registered).toContain("KernelWorkflowV1");
    expect(registered).toContain("TaskWorkflow");
    expect(registered).toContain("CapabilityServiceV1");
  });

  it("does not register ScheduleDriver without the admission seam configured", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    delete process.env["KJ_ADMISSION_URL"];
    delete process.env["KJ_ADMISSION_BEARER"];
    const mod = await import("../services/kernel/src/index.js");
    const registered = names(mod.services);
    expect(registered).not.toContain("ScheduleDriver");
  });

  it("fails closed if the admission seam is half-configured (URL without bearer)", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    process.env["KJ_ADMISSION_URL"] = "http://gateway:8081";
    delete process.env["KJ_ADMISSION_BEARER"];
    await expect(import("../services/kernel/src/index.js")).rejects.toThrow();
  });

  it("fails closed if the admission seam is configured without the canary", async () => {
    delete process.env["KJ_REPO_ROOT"];
    delete process.env["SCHED_RECIPE"];
    delete process.env["SCHED_APPROVED_SHA256"];
    process.env["KJ_ADMISSION_URL"] = "http://gateway:8081";
    process.env["KJ_ADMISSION_BEARER"] = "RAW_TEST_TOKEN_VALUE";
    await expect(import("../services/kernel/src/index.js")).rejects.toThrow();
  });
});

/**
 * S1D1 — the recurring self-rearm (armNext) config seam. armNext=true is only
 * meaningful once qualified (S1B); production must default to the existing one-shot
 * behaviour and never guess on an ambiguous value.
 */
describe("production recurring-mode (SCHED_ARM_NEXT) config", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env["DATABASE_URL"] = "postgresql://unused@127.0.0.1:1/unused";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("parseArmNext: default/unset is false", async () => {
    delete process.env["SCHED_ARM_NEXT"];
    const mod = await import("../services/kernel/src/index.js");
    expect(mod.parseArmNext(process.env)).toBe(false);
  });

  it('parseArmNext: explicit "false" is false', async () => {
    const mod = await import("../services/kernel/src/index.js");
    expect(mod.parseArmNext({ SCHED_ARM_NEXT: "false" })).toBe(false);
  });

  it('parseArmNext: explicit "true" is true', async () => {
    const mod = await import("../services/kernel/src/index.js");
    expect(mod.parseArmNext({ SCHED_ARM_NEXT: "true" })).toBe(true);
  });

  it("parseArmNext: any other value fails closed (throws, never guesses)", async () => {
    const mod = await import("../services/kernel/src/index.js");
    for (const bad of ["1", "0", "TRUE", "True", " true", "true ", "yes", "on", ""])
      expect(() => mod.parseArmNext({ SCHED_ARM_NEXT: bad }), `value ${JSON.stringify(bad)}`).toThrow();
  });

  it("module load: SCHED_ARM_NEXT unset does not change existing ScheduleDriver registration", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    process.env["KJ_ADMISSION_URL"] = "http://gateway:8081";
    process.env["KJ_ADMISSION_BEARER"] = "RAW_TEST_TOKEN_VALUE";
    delete process.env["SCHED_ARM_NEXT"];
    const mod = await import("../services/kernel/src/index.js");
    expect(names(mod.services)).toContain("ScheduleDriver");
  });

  it('module load: SCHED_ARM_NEXT="false" behaves identically to unset', async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    process.env["KJ_ADMISSION_URL"] = "http://gateway:8081";
    process.env["KJ_ADMISSION_BEARER"] = "RAW_TEST_TOKEN_VALUE";
    process.env["SCHED_ARM_NEXT"] = "false";
    const mod = await import("../services/kernel/src/index.js");
    expect(names(mod.services)).toContain("ScheduleDriver");
  });

  it('module load: SCHED_ARM_NEXT="true" still registers ScheduleDriver (recurring mode is an internal timer-runtime choice, not a registration change)', async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    process.env["KJ_ADMISSION_URL"] = "http://gateway:8081";
    process.env["KJ_ADMISSION_BEARER"] = "RAW_TEST_TOKEN_VALUE";
    process.env["SCHED_ARM_NEXT"] = "true";
    const mod = await import("../services/kernel/src/index.js");
    expect(names(mod.services)).toContain("ScheduleDriver");
  });

  it("module load: an invalid SCHED_ARM_NEXT refuses to start even with everything else valid", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    process.env["KJ_ADMISSION_URL"] = "http://gateway:8081";
    process.env["KJ_ADMISSION_BEARER"] = "RAW_TEST_TOKEN_VALUE";
    process.env["SCHED_ARM_NEXT"] = "yes";
    await expect(import("../services/kernel/src/index.js")).rejects.toThrow();
  });

  it("module load: an invalid SCHED_ARM_NEXT refuses to start even without ScheduleDriver configured (eager, fail-fast)", async () => {
    delete process.env["KJ_REPO_ROOT"];
    delete process.env["SCHED_RECIPE"];
    delete process.env["SCHED_APPROVED_SHA256"];
    delete process.env["KJ_ADMISSION_URL"];
    delete process.env["KJ_ADMISSION_BEARER"];
    process.env["SCHED_ARM_NEXT"] = "banana";
    await expect(import("../services/kernel/src/index.js")).rejects.toThrow();
  });
});
