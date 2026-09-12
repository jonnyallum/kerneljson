import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gate 3 topology-validator negative proofs.
 *
 * scripts/check-execution-topology.mjs exists to catch exactly two defects found while
 * running D1 (the Gate 3 production execution-path deploy): the gateway declaring
 * kerneljson-exec as Compose-owned instead of external, and the gateway image resolving
 * to nothing at all because only `build:` (no `image:`) was set. A check is not
 * trustworthy until it has failed on purpose (see CLAUDE.md) — this file proves the
 * validator actually rejects both regressions, plus that it passes cleanly with the
 * exact production image supplied.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const GATEWAY_COMPOSE = join(REPO_ROOT, "infrastructure/docker/gateway.compose.yaml");
const CHECKER = join(REPO_ROOT, "scripts/check-execution-topology.mjs");

const EXPECTED_IMAGE = "kerneljson-admission-door:125a0bd";

const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: "postgresql://placeholder@127.0.0.1:5432/placeholder",
  KERNELJSON_RELEASE_ID: "topology-guard-test",
  KJ_ADMISSION_BEARER: "placeholder-bearer-token-0000",
  KJ_ADMISSION_TENANT_ID: "00000000-0000-4000-8000-000000000000",
  KJ_ADMISSION_PRINCIPAL_ID: "00000000-0000-4000-8000-000000000001",
  KJ_ADMISSION_PRINCIPAL_KIND: "HUMAN",
};

function runChecker(env: NodeJS.ProcessEnv): { code: number; output: string } {
  try {
    const out = execFileSync("node", [CHECKER], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: typeof e.status === "number" ? e.status : 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("Gate 3 execution-topology validator — negative proofs", () => {
  it("passes against the real, fixed compose files with the exact production image supplied", () => {
    const { code, output } = runChecker({
      ...BASE_ENV,
      KJ_GATEWAY_IMAGE: EXPECTED_IMAGE,
      EXPECTED_GATEWAY_IMAGE: EXPECTED_IMAGE,
    });
    expect(code, output).toBe(0);
    expect(output).toContain("EXECUTION TOPOLOGY: PASS");
  });

  it("fails if the gateway network reverts to Compose-owned (not external)", () => {
    const original = readFileSync(GATEWAY_COMPOSE, "utf8");
    const reverted = original.replace(/(\r?\n)\s*external:\s*true\s*(\r?\n\s*name:\s*kerneljson-exec)/, "$1$2");
    expect(reverted, "fixture setup must actually remove external: true").not.toBe(original);
    const fixturePath = join(REPO_ROOT, "infrastructure/docker/gateway.compose.negative-owned.yaml");
    writeFileSync(fixturePath, reverted);
    try {
      const { code, output } = runChecker({
        ...BASE_ENV,
        GATEWAY_COMPOSE_FILE: "infrastructure/docker/gateway.compose.negative-owned.yaml",
        KJ_GATEWAY_IMAGE: EXPECTED_IMAGE,
      });
      expect(code, output).toBe(1);
      expect(output).toContain("must be external in gateway.compose.yaml");
    } finally {
      unlinkSync(fixturePath);
    }
  });

  it("fails if the resolved gateway image does not match the supplied production tag", () => {
    const { code, output } = runChecker({
      ...BASE_ENV,
      KJ_GATEWAY_IMAGE: EXPECTED_IMAGE,
      EXPECTED_GATEWAY_IMAGE: "kerneljson-admission-door:not-the-real-tag",
    });
    expect(code, output).toBe(1);
    expect(output).toContain("expected exactly 'kerneljson-admission-door:not-the-real-tag'");
  });
});
