import { describe, it, expect } from "vitest";
import { createRuntimeRegistry } from "../packages/capabilities/src/index.js";
import { NewSystemRuntimeAdapter } from "../packages/runtimes/src/index.js";
import {
  loadCanaryConfig,
  verifyWithCanaryConfig,
  CanaryConfigError,
  type CanaryConfigCode,
} from "../services/kernel/src/scheduler/canary-config.js";
import {
  claudeMdCheckInvocation,
  mockClaudeMdCompletedResponse,
  APPROVED_CONTENT_SHA256,
  DRIFTED_CONTENT_SHA256,
} from "../evals/fixtures/claude-md-check.js";

// The authoritative approved LF digest for CLAUDE.md (jonnyallum/kerneljson @ 289be33).
const APPROVED_LF = "27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10";

function code(env: Record<string, string | undefined>): CanaryConfigCode | "OK" {
  try {
    loadCanaryConfig(env);
    return "OK";
  } catch (e) {
    return e instanceof CanaryConfigError ? e.code : ("OK" as never);
  }
}

describe("canary runtime config — fail closed", () => {
  it("loads a valid recipe + approved digest", () => {
    const cfg = loadCanaryConfig({
      SCHED_RECIPE: "claude_md_check/v1",
      SCHED_APPROVED_SHA256: APPROVED_LF,
    });
    expect(cfg).toEqual({
      recipe: "claude_md_check/v1",
      approvedContentSha256: APPROVED_LF,
    });
  });

  it("rejects a missing or non-authorised recipe", () => {
    expect(code({ SCHED_APPROVED_SHA256: APPROVED_LF })).toBe("RECIPE_MISSING_OR_NOT_ALLOWED");
    expect(
      code({ SCHED_RECIPE: "uppercase/v1", SCHED_APPROVED_SHA256: APPROVED_LF }),
    ).toBe("RECIPE_MISSING_OR_NOT_ALLOWED");
  });

  it("rejects an absent digest (no permissive default, no current-file fallback)", () => {
    expect(code({ SCHED_RECIPE: "claude_md_check/v1" })).toBe("DIGEST_ABSENT");
    expect(code({ SCHED_RECIPE: "claude_md_check/v1", SCHED_APPROVED_SHA256: "" })).toBe(
      "DIGEST_ABSENT",
    );
  });

  it("rejects a malformed digest (wrong length, uppercase, non-hex)", () => {
    const bad = [
      APPROVED_LF.slice(0, 63), // 63 chars
      APPROVED_LF + "a", // 65 chars
      APPROVED_LF.toUpperCase(), // uppercase not accepted (committed LF form is lowercase)
      "z".repeat(64), // non-hex
      "27255772 beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10", // whitespace
    ];
    for (const d of bad)
      expect(code({ SCHED_RECIPE: "claude_md_check/v1", SCHED_APPROVED_SHA256: d })).toBe(
        "DIGEST_SHAPE",
      );
  });
});

describe("canary runtime config — digest reaches verifyClaudeMdCheck", () => {
  async function packed(structuredOverride: Record<string, unknown> = {}) {
    const runtime = createRuntimeRegistry();
    const fetchImpl = (async () =>
      new Response(JSON.stringify(mockClaudeMdCompletedResponse({ structured: structuredOverride })), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const adapter = new NewSystemRuntimeAdapter(runtime, {
      spawnerBaseUrl: "http://127.0.0.1:8766",
      caller: "kerneljson",
      tenantId: "estate",
      fetch: fetchImpl,
      now: () => "2026-09-11T09:00:00.000+00:00",
    });
    return adapter.invoke(claudeMdCheckInvocation);
  }

  it("PASSES when the configured approved digest matches the read", async () => {
    const p = await packed();
    const cfg = loadCanaryConfig({
      SCHED_RECIPE: "claude_md_check/v1",
      SCHED_APPROVED_SHA256: APPROVED_CONTENT_SHA256,
    });
    const v = verifyWithCanaryConfig(cfg, {
      taskId: p.taskId,
      result: p.result,
      evidence: p.evidence,
      outcome: p.outcome,
    });
    expect(v.status).toBe("PASSED");
  });

  it("FAILS with CLAUDE_MD_DRIFT when the configured digest differs from the read", async () => {
    const p = await packed({
      content_sha256: DRIFTED_CONTENT_SHA256,
      output_hash: DRIFTED_CONTENT_SHA256.slice(0, 12),
    });
    const cfg = loadCanaryConfig({
      SCHED_RECIPE: "claude_md_check/v1",
      SCHED_APPROVED_SHA256: APPROVED_CONTENT_SHA256,
    });
    const v = verifyWithCanaryConfig(cfg, {
      taskId: p.taskId,
      result: p.result,
      evidence: p.evidence,
      outcome: p.outcome,
    });
    expect(v.status).toBe("FAILED");
    expect(v.failures).toContain("CLAUDE_MD_DRIFT");
  });
});
