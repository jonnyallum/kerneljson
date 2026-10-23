import {
  MISSION_RUNTIME_FAMILIES,
  RepoSlug,
  modelFamily,
} from "../../../../packages/contracts/src/index.js";
import type { ModelPort } from "../../../../packages/models/src/index.js";
import { createMissionPort, type MissionProvider } from "./config.js";

/**
 * code-change/v1 deployment configuration, in the same fail-closed style as the mission runtimes: nothing set
 * means the recipe is not served; a partial or wrong configuration stops the worker at startup.
 *
 *   KJ_CODE_CHANGE_GITHUB_TOKEN     fine-grained token for the allowlisted repositories only
 *                                   (Actions read/write, Contents read, Pull requests read/write)
 *   KJ_CODE_CHANGE_REPOS            comma-separated `owner/repo` allowlist (at most 5 for the pilot)
 *   KJ_CODE_CHANGE_CODER_MODEL      the runner's model, vendor-qualified (`anthropic/...`)
 *   KJ_CODE_CHANGE_REVIEWER_MODEL   the diff reviewer, a different model family from the coder, served by a
 *                                   mission provider whose key is already set (same naming rule as
 *                                   MISSION_REVIEWER_MODEL)
 *
 * The reviewer is its own setting, not the mission reviewer: the morning brief's reviewer is an Anthropic model,
 * the same family as the Claude Code coder, and changing it to suit this recipe would change the brief. The token
 * is read from the environment only and never printed.
 */
export interface CodeChangeConfig {
  token: string;
  allowedRepos: string[];
  coderModel: string;
  reviewerModel: string;
  reviewerProvider: MissionProvider;
  reviewer: ModelPort;
}

const FAMILIES = MISSION_RUNTIME_FAMILIES as readonly string[];

export function loadCodeChangeConfig(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): CodeChangeConfig | undefined {
  // Literal names on purpose: the compose/inventory guard finds every env read by scanning for them.
  const token = env["KJ_CODE_CHANGE_GITHUB_TOKEN"] || undefined;
  const repos = env["KJ_CODE_CHANGE_REPOS"] || undefined;
  const coderModel = env["KJ_CODE_CHANGE_CODER_MODEL"] || undefined;
  const reviewerModel = env["KJ_CODE_CHANGE_REVIEWER_MODEL"] || undefined;
  if (!token && !repos && !coderModel && !reviewerModel) return undefined;
  if (!token || !repos || !coderModel || !reviewerModel)
    throw new Error(
      "KJ_CODE_CHANGE_GITHUB_TOKEN, KJ_CODE_CHANGE_REPOS, KJ_CODE_CHANGE_CODER_MODEL and KJ_CODE_CHANGE_REVIEWER_MODEL " +
        "must all be set or all left unset - refusing to start half-configured",
    );
  if (!/^[^\s]{20,512}$/.test(token)) throw new Error("KJ_CODE_CHANGE_GITHUB_TOKEN is malformed - refusing to start");
  const allowedRepos = repos.split(",").map((r) => r.trim()).filter(Boolean);
  if (allowedRepos.length === 0 || allowedRepos.length > 5 || allowedRepos.some((r) => !RepoSlug.safeParse(r).success))
    throw new Error("KJ_CODE_CHANGE_REPOS must list 1 to 5 owner/repo names - refusing to start");
  if (!coderModel.includes("/") || !FAMILIES.includes(modelFamily(coderModel)))
    throw new Error(`KJ_CODE_CHANGE_CODER_MODEL must be a vendor/model name from one of: ${FAMILIES.join(", ")}`);
  if (modelFamily(reviewerModel) === modelFamily(coderModel))
    throw new Error("KJ_CODE_CHANGE_REVIEWER_MODEL must be a different model family from KJ_CODE_CHANGE_CODER_MODEL");
  const { port, provider } = createMissionPort(env, "KJ_CODE_CHANGE_REVIEWER_MODEL", reviewerModel, fetchImpl);
  return { token, allowedRepos, coderModel, reviewerModel, reviewerProvider: provider, reviewer: port };
}
