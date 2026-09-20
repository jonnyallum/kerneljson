import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

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
    delete process.env["ALERT_RUNNER_ENABLED"];
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
    expect(registered).not.toContain("ProductionAlertMonitor");
  });

  it("registers the observational monitor only on explicit opt-in, independent of admission", async () => {
    delete process.env["KJ_REPO_ROOT"];
    delete process.env["KJ_ADMISSION_URL"];
    delete process.env["KJ_ADMISSION_BEARER"];
    process.env["ALERT_RUNNER_ENABLED"] = "true";
    process.env["ALERT_STATE_STORE"] = "postgres";
    const mod = await import("../services/kernel/src/index.js");
    expect(names(mod.services)).toContain("ProductionAlertMonitor");
    expect(names(mod.services)).not.toContain("ScheduleDriver");
  });

  // KJ-P3: the mission runtimes follow the same all-or-nothing rule as the seams above.
  const MISSION_ENV = {
    MISSION_OPENROUTER_API_KEY: "sk-or-v1-" + "a".repeat(64),
    MISSION_ANALYST_MODEL: "anthropic/claude-test",
    MISSION_REVIEWER_MODEL: "x-ai/grok-test",
  };

  it("serves no mission, and registers exactly what it did before, when no mission env is set", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    for (const k of Object.keys(MISSION_ENV)) delete process.env[k];
    const mod = await import("../services/kernel/src/index.js");
    expect(names(mod.services)).toEqual(["TaskWorkflow", "KernelWorkflowV1", "CapabilityServiceV1"]);
  });

  it("starts with the mission runtimes configured alongside the canary, registering the same services", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    Object.assign(process.env, MISSION_ENV);
    const mod = await import("../services/kernel/src/index.js");
    expect(names(mod.services)).toEqual(["TaskWorkflow", "KernelWorkflowV1", "CapabilityServiceV1"]);
  });

  // KJ-P4A: the Telegram operator channel follows the same all-or-nothing rule as every seam above.
  const OPERATOR_ENV = {
    TELEGRAM_INBOUND_ENABLED: "true",
    ALERT_TRANSPORT: "telegram",
    TELEGRAM_BOT_TOKEN: "123456789:" + "A".repeat(35),
    TELEGRAM_CHAT_ID: "6543210987",
    KJ_ADMISSION_URL: "http://gateway:8081",
    KJ_ADMISSION_BEARER: "SYNTHETIC-DOOR-BEARER-0123456789-abcdef",
  };
  const withCanary = () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
  };

  it("registers the Telegram operator only when explicitly enabled, and nothing else changes", async () => {
    withCanary();
    for (const k of Object.keys(OPERATOR_ENV)) delete process.env[k];
    Object.assign(process.env, { KJ_ADMISSION_URL: OPERATOR_ENV.KJ_ADMISSION_URL, KJ_ADMISSION_BEARER: OPERATOR_ENV.KJ_ADMISSION_BEARER });
    const off = await import("../services/kernel/src/index.js");
    const offNames = names(off.services);
    expect(offNames).not.toContain("TelegramOperator");
    vi.resetModules();
    Object.assign(process.env, OPERATOR_ENV);
    const on = await import("../services/kernel/src/index.js");
    // Exactly one new service, and every service that was there before is still there.
    expect(names(on.services)).toEqual([...offNames, "TelegramOperator"]);
  });

  it("serves no inbound channel for an empty or false switch", async () => {
    withCanary();
    Object.assign(process.env, OPERATOR_ENV);
    for (const off of ["", "false"]) {
      vi.resetModules();
      process.env["TELEGRAM_INBOUND_ENABLED"] = off;
      const mod = await import("../services/kernel/src/index.js");
      expect(names(mod.services), JSON.stringify(off)).not.toContain("TelegramOperator");
    }
  });

  it("refuses to start with the channel enabled but a dependency missing or wrong, without printing a value", async () => {
    withCanary();
    const cases: Array<[string, Record<string, string | undefined>]> = [
      ["no bot token", { TELEGRAM_BOT_TOKEN: undefined }],
      ["no admission bearer", { KJ_ADMISSION_BEARER: undefined }],
      ["console transport", { ALERT_TRANSPORT: "console" }],
      ["a group chat id", { TELEGRAM_CHAT_ID: "-1001234567890" }],
      ["a guessed switch", { TELEGRAM_INBOUND_ENABLED: "yes" }],
      ["a bad cap", { TELEGRAM_MISSION_DAILY_CAP: "0" }],
    ];
    for (const [label, over] of cases) {
      vi.resetModules();
      Object.assign(process.env, OPERATOR_ENV);
      delete process.env["TELEGRAM_MISSION_DAILY_CAP"];
      for (const [k, v] of Object.entries(over)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      let message = "";
      try {
        await import("../services/kernel/src/index.js");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, label).not.toBe("");
      for (const secret of [OPERATOR_ENV.TELEGRAM_BOT_TOKEN, OPERATOR_ENV.KJ_ADMISSION_BEARER]) expect(message, label).not.toContain(secret);
    }
  });

  it("starts with a cross-provider mission pair (DeepSeek analyst, Claude reviewer through OpenRouter) and refuses it once a key is dropped", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    for (const k of Object.keys(MISSION_ENV)) delete process.env[k];
    Object.assign(process.env, {
      MISSION_DEEPSEEK_API_KEY: "sk-" + "a".repeat(32),
      MISSION_OPENROUTER_API_KEY: MISSION_ENV.MISSION_OPENROUTER_API_KEY,
      MISSION_ANALYST_MODEL: "deepseek-v4-flash",
      MISSION_REVIEWER_MODEL: "anthropic/claude-sonnet-5",
    });
    const mod = await import("../services/kernel/src/index.js");
    expect(names(mod.services)).toEqual(["TaskWorkflow", "KernelWorkflowV1", "CapabilityServiceV1"]);
    vi.resetModules();
    delete process.env["MISSION_OPENROUTER_API_KEY"];
    let message = "";
    try {
      await import("../services/kernel/src/index.js");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/MISSION_OPENROUTER_API_KEY must be set/);
    expect(message).not.toMatch(/sk-or-v1|sk-a{8}/);
  });

  it("starts with DeepSeek mission runtimes, and refuses a provider key that no configured model uses", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    for (const k of Object.keys(MISSION_ENV)) delete process.env[k];
    Object.assign(process.env, {
      MISSION_DEEPSEEK_API_KEY: "sk-" + "a".repeat(32),
      MISSION_ANALYST_MODEL: "deepseek-v4-flash",
      MISSION_REVIEWER_MODEL: "deepseek-v4-pro",
    });
    const mod = await import("../services/kernel/src/index.js");
    expect(names(mod.services)).toEqual(["TaskWorkflow", "KernelWorkflowV1", "CapabilityServiceV1"]);
    vi.resetModules();
    process.env["MISSION_OPENROUTER_API_KEY"] = MISSION_ENV.MISSION_OPENROUTER_API_KEY;
    let message = "";
    try {
      await import("../services/kernel/src/index.js");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/MISSION_OPENROUTER_API_KEY is set but no mission model uses/);
    expect(message).not.toMatch(/sk-or-v1|sk-a{8}/);
  });

  it("refuses to start with mission runtimes but no capability service (no repository root)", async () => {
    delete process.env["KJ_REPO_ROOT"];
    delete process.env["SCHED_RECIPE"];
    delete process.env["SCHED_APPROVED_SHA256"];
    Object.assign(process.env, MISSION_ENV);
    await expect(import("../services/kernel/src/index.js")).rejects.toThrow(/Mission runtimes are configured/);
  });

  it("refuses to start with a partial mission configuration, without printing the key", async () => {
    process.env["KJ_REPO_ROOT"] = process.cwd();
    process.env["SCHED_RECIPE"] = "claude_md_check/v1";
    process.env["SCHED_APPROVED_SHA256"] = DIGEST;
    process.env["MISSION_OPENROUTER_API_KEY"] = MISSION_ENV.MISSION_OPENROUTER_API_KEY;
    delete process.env["MISSION_ANALYST_MODEL"];
    delete process.env["MISSION_REVIEWER_MODEL"];
    let message = "";
    try { await import("../services/kernel/src/index.js"); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/all be set or all left unset/);
    expect(message).not.toContain("sk-or-v1");
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

  it('parseArmNext: empty string is false (execution.compose.yaml\'s ${SCHED_ARM_NEXT:-} default — a genuinely-unset deploy reaches the container as "", not undefined; caught live during S1D2)', async () => {
    const mod = await import("../services/kernel/src/index.js");
    expect(mod.parseArmNext({ SCHED_ARM_NEXT: "" })).toBe(false);
  });

  it('parseArmNext: explicit "false" is false', async () => {
    const mod = await import("../services/kernel/src/index.js");
    expect(mod.parseArmNext({ SCHED_ARM_NEXT: "false" })).toBe(false);
  });

  it('parseArmNext: explicit "true" is true', async () => {
    const mod = await import("../services/kernel/src/index.js");
    expect(mod.parseArmNext({ SCHED_ARM_NEXT: "true" })).toBe(true);
  });

  it("parseArmNext: any other value fails closed (throws, never guesses) — excluding empty string, which is the compose-default falsy case tested separately", async () => {
    const mod = await import("../services/kernel/src/index.js");
    for (const bad of ["1", "0", "TRUE", "True", " true", "true ", "yes", "on"])
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

/**
 * S1D2 — guards the exact defect class that bit KJ_ADMISSION_URL/KJ_ADMISSION_BEARER
 * (PR #21) and then SCHED_ARM_NEXT itself, live in production, on 2026-09-14:
 * execution.compose.yaml's worker `environment:` block is an explicit allowlist — Compose
 * does not forward arbitrary --env-file contents to a container. A production env var
 * that index.ts reads but this file does not declare is silently dropped: no crash, no
 * error, the worker just runs as if the var were never set. Unit tests against index.ts
 * directly (via process.env) cannot catch this — they never go through Compose. This
 * reads the actual YAML text and is the only regression guard for this class of bug.
 */
describe("execution.compose.yaml worker env passthrough (S1D2 regression guard)", () => {
  const yaml = readFileSync("infrastructure/docker/execution.compose.yaml", "utf8");
  // Isolate the worker service's `environment:` block only (not restate's, not comments).
  const workerBlock = yaml.slice(yaml.indexOf("\n  worker:"), yaml.indexOf("\nvolumes:"));

  it("declares every env var services/kernel/src/index.ts reads from process.env", () => {
    const indexTs = readFileSync("services/kernel/src/index.ts", "utf8");
    const readVars = [...indexTs.matchAll(/process\.env\["([A-Z0-9_]+)"\]/g)].map((m) => m[1]!);
    // DATABASE_URL/KJ_REPO_ROOT/PORT are pinned/derived, not passthrough-declared the same
    // way; every other var index.ts reads must appear as a declared key in the compose
    // worker block, or a production deploy can silently drop it exactly like SCHED_ARM_NEXT did.
    const passthroughVars = readVars.filter((v) => !["DATABASE_URL", "KJ_REPO_ROOT", "PORT"].includes(v));
    for (const v of new Set(passthroughVars))
      expect(workerBlock, `${v} must be declared in execution.compose.yaml's worker environment: block`).toMatch(
        new RegExp(`^\\s+${v}:`, "m"),
      );
  });

  it("SCHED_ARM_NEXT specifically is declared (the exact var that was missing on 2026-09-14)", () => {
    expect(workerBlock).toMatch(/^\s+SCHED_ARM_NEXT:/m);
  });

  // KJ-P2.2B: the same silent-drop defect class, for the Telegram transport. Without
  // these declarations a value in runtime.env never reaches the container, the worker
  // stays on console, and nothing errors.
  const TRANSPORT_SOURCES = ["transport-config.ts", "telegram-notifier.ts", "select-notifier.ts"];
  const envVarsRead = (src: string): string[] => [
    ...new Set(
      [...src.matchAll(/\b(?:process\.)?env\[\s*"([A-Z][A-Z0-9_]+)"\s*\]|\bprocess\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => (m[1] ?? m[2])!),
    ),
  ];
  const undeclared = (vars: string[], block: string): string[] => vars.filter((v) => !new RegExp(`^\\s+${v}:`, "m").test(block));

  it("declares every env var the Telegram alert transport reads (KJ-P2.2B)", () => {
    const read = TRANSPORT_SOURCES.flatMap((f) => envVarsRead(readFileSync(`services/kernel/src/alerting/${f}`, "utf8")));
    expect([...new Set(read)].sort()).toEqual(["ALERT_TRANSPORT", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
    expect(undeclared(read, workerBlock)).toEqual([]);
  });

  it("the transport vars default to empty (console mode, no credential) rather than to a live value", () => {
    for (const v of ["ALERT_TRANSPORT", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"])
      expect(workerBlock, v).toMatch(new RegExp(`^\\s+${v}: \\$\\{${v}:-\\}\\s*$`, "m"));
  });

  // KJ-P3: the same silent-drop defect class for the mission runtimes and the GitHub token.
  it("declares every env var the mission runtime config reads, and the GitHub token index.ts reads", () => {
    const read = envVarsRead(readFileSync("services/kernel/src/mission/config.ts", "utf8"));
    expect(read.sort()).toEqual(["MISSION_ANALYST_MODEL", "MISSION_DEEPSEEK_API_KEY", "MISSION_OPENROUTER_API_KEY", "MISSION_REVIEWER_MODEL"]);
    expect(undeclared([...read, "GITHUB_READ_TOKEN"], workerBlock)).toEqual([]);
  });

  it("the mission vars default to empty, so an unconfigured deploy serves no mission", () => {
    for (const v of ["MISSION_OPENROUTER_API_KEY", "MISSION_DEEPSEEK_API_KEY", "MISSION_ANALYST_MODEL", "MISSION_REVIEWER_MODEL", "GITHUB_READ_TOKEN"])
      expect(workerBlock, v).toMatch(new RegExp(`^\\s+${v}: \\$\\{${v}:-\\}\\s*$`, "m"));
  });

  // KJ-P4A: the same silent-drop defect class for the Telegram operator channel. Without these
  // declarations a value in runtime.env never reaches the container and the channel stays off.
  it("declares every env var the Telegram operator channel reads (KJ-P4A)", () => {
    const read = envVarsRead(readFileSync("services/kernel/src/channel/telegram/operator-config.ts", "utf8"));
    expect(read.sort()).toEqual([
      "ALERT_TRANSPORT", "DATABASE_URL", "KJ_ADMISSION_BEARER", "KJ_ADMISSION_URL",
      "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_INBOUND_ENABLED", "TELEGRAM_MISSION_DAILY_CAP",
    ]);
    expect(undeclared(read, workerBlock)).toEqual([]);
  });

  it("the channel's own vars default to empty, so an unconfigured deploy serves no inbound channel", () => {
    for (const v of ["TELEGRAM_INBOUND_ENABLED", "TELEGRAM_MISSION_DAILY_CAP"])
      expect(workerBlock, v).toMatch(new RegExp(`^\\s+${v}: \\$\\{${v}:-\\}\\s*$`, "m"));
  });

  it("negative case: without its passthrough lines the inventory flags the channel's vars", () => {
    const without = workerBlock.replace(/^\s+TELEGRAM_INBOUND_ENABLED:.*\r?\n/m, "").replace(/^\s+TELEGRAM_MISSION_DAILY_CAP:.*\r?\n/m, "");
    expect(undeclared(["TELEGRAM_INBOUND_ENABLED", "TELEGRAM_MISSION_DAILY_CAP"], without)).toEqual(["TELEGRAM_INBOUND_ENABLED", "TELEGRAM_MISSION_DAILY_CAP"]);
  });

  it("negative case: the inventory scan flags a transport var the compose file does not declare", () => {
    const hypothetical = readFileSync("services/kernel/src/alerting/transport-config.ts", "utf8") + '\nconst x = env["ZZZ_UNDECLARED_TRANSPORT_VAR"];\n';
    expect(undeclared(envVarsRead(hypothetical), workerBlock)).toEqual(["ZZZ_UNDECLARED_TRANSPORT_VAR"]);
    const withoutFix = workerBlock.replace(/^\s+ALERT_TRANSPORT:.*\r?\n/m, "");
    expect(undeclared(["ALERT_TRANSPORT"], withoutFix)).toEqual(["ALERT_TRANSPORT"]);
  });
});
