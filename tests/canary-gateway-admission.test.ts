import { describe, it, expect } from "vitest";
import { PublicSubmission, recipeTarget } from "../apps/gateway/src/server.js";
import { workflowTargets } from "../services/kernel/src/execution-binding.js";

const ok = (recipe: string) =>
  PublicSubmission.safeParse({ recipe, objective: "canary admission" }).success;

describe("gateway admission accept-list — claude_md_check/v1 (Gate 1.5)", () => {
  it("admits the exact authorised canary recipe", () => {
    expect(ok("claude_md_check/v1")).toBe(true);
  });

  it("keeps the existing recipes admissible", () => {
    expect(ok("uppercase/v1")).toBe(true);
    expect(ok("uppercase-reverse/v1")).toBe(true);
  });

  it("rejects unrelated, malformed and version-mismatched recipe ids (no wildcard)", () => {
    for (const bad of [
      "claude_md_check", // no version
      "claude_md_check/v2", // wrong version
      "claude-md-check/v1", // wrong separator
      "repository-read/v1", // real recipe, but NOT admitted via the public door
      "shell/v1",
      "anything/v1",
      "",
      "CLAUDE_MD_CHECK/v1",
    ]) {
      expect(ok(bad)).toBe(false);
    }
    // non-string recipe and empty objective also rejected
    expect(PublicSubmission.safeParse({ recipe: 123, objective: "x" }).success).toBe(false);
    expect(
      PublicSubmission.safeParse({ recipe: "claude_md_check/v1", objective: "" }).success,
    ).toBe(false);
  });

  it("routes the canary to the kernel workflow, not the golden workflow", () => {
    expect(recipeTarget("claude_md_check/v1")).toEqual(workflowTargets.KernelWorkflowV1);
    expect(recipeTarget("uppercase/v1")).toEqual(workflowTargets.GoldenTaskWorkflowV1);
    expect(recipeTarget("uppercase-reverse/v1")).toEqual(workflowTargets.KernelWorkflowV1);
  });
});
