import {
  verifyClaudeMdCheck,
  type ClaudeMdCheckVerification,
} from "../../../../packages/runtimes/src/index.js";

/**
 * S1 canary — scheduler worker/runtime configuration contract (Gate 1.5).
 *
 * The schedule row is recipe-agnostic; THIS is where the otherwise-agnostic
 * schedule is bound to the canary's execution identity at run time (Gate 3):
 *   - the exact allowed recipe: `claude_md_check/v1`;
 *   - the APPROVED CLAUDE.md content digest (committed LF-form SHA-256).
 *
 * It is prepared and tested here but is NOT activated against production.
 * Everything fails closed: no permissive default, no fallback to "current file".
 */

export const CANARY_RECIPE = "claude_md_check/v1" as const;
export type CanaryRecipe = typeof CANARY_RECIPE;

/** Exactly 64 lowercase hex chars. No normalisation of other casings/whitespace. */
export const APPROVED_DIGEST_RE = /^[0-9a-f]{64}$/;

export type CanaryConfigCode = "RECIPE_MISSING_OR_NOT_ALLOWED" | "DIGEST_ABSENT" | "DIGEST_SHAPE";

export class CanaryConfigError extends Error {
  constructor(
    readonly code: CanaryConfigCode,
    message: string,
  ) {
    super(message);
    this.name = "CanaryConfigError";
  }
}

export interface CanaryRuntimeConfig {
  recipe: CanaryRecipe;
  approvedContentSha256: string;
}

/** Env var names (project convention: SCHED_* for the scheduler worker). */
export const CANARY_RECIPE_ENV = "SCHED_RECIPE";
export const CANARY_APPROVED_SHA256_ENV = "SCHED_APPROVED_SHA256";

/**
 * Load + validate the canary runtime config, fail-closed. The recipe must be
 * exactly the allowed canary recipe; the digest must be present and exactly 64
 * lowercase hex chars (the committed LF-form SHA-256). No defaults, no fallback.
 */
export function loadCanaryConfig(
  env: Record<string, string | undefined>,
): CanaryRuntimeConfig {
  const recipe = env[CANARY_RECIPE_ENV];
  if (recipe !== CANARY_RECIPE)
    throw new CanaryConfigError(
      "RECIPE_MISSING_OR_NOT_ALLOWED",
      `${CANARY_RECIPE_ENV} must be exactly "${CANARY_RECIPE}"`,
    );

  const digest = env[CANARY_APPROVED_SHA256_ENV];
  if (digest === undefined || digest === "")
    throw new CanaryConfigError("DIGEST_ABSENT", `${CANARY_APPROVED_SHA256_ENV} is required`);
  if (!APPROVED_DIGEST_RE.test(digest))
    throw new CanaryConfigError(
      "DIGEST_SHAPE",
      `${CANARY_APPROVED_SHA256_ENV} must be 64 lowercase hex chars (committed LF SHA-256)`,
    );

  return { recipe: CANARY_RECIPE, approvedContentSha256: digest };
}

/**
 * Typed bridge: run the canary verification using the loaded config's approved
 * digest. This is the single path by which the configured digest reaches
 * `verifyClaudeMdCheck({ approvedContentSha256 })`.
 */
export function verifyWithCanaryConfig(
  config: CanaryRuntimeConfig,
  args: { taskId: string; result: unknown; evidence: unknown; outcome: unknown },
): ClaudeMdCheckVerification {
  return verifyClaudeMdCheck({
    taskId: args.taskId,
    result: args.result,
    evidence: args.evidence,
    outcome: args.outcome,
    approvedContentSha256: config.approvedContentSha256,
  });
}
