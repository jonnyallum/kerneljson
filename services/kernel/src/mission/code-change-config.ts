import {
  MISSION_RUNTIME_FAMILIES,
  RepoSlug,
  modelFamily,
} from "../../../../packages/contracts/src/index.js";

/**
 * code-change/v1 deployment configuration, in the same fail-closed style as the mission runtimes: nothing set
 * means the recipe is not served; a partial or wrong configuration stops the worker at startup.
 *
 *   KJ_CODE_CHANGE_GITHUB_TOKEN  fine-grained token for the allowlisted repositories only
 *                                (Actions read/write, Contents read, Pull requests read/write)
 *   KJ_CODE_CHANGE_REPOS         comma-separated `owner/repo` allowlist (at most 5 for the pilot)
 *   KJ_CODE_CHANGE_CODER_MODEL   the runner's model, vendor-qualified (`anthropic/...`)
 *
 * The reviewer is the mission reviewer runtime, which must be a different model family from the coder. The
 * token is read from the environment only and never printed.
 */
export interface CodeChangeConfig {
  token: string;
  allowedRepos: string[];
  coderModel: string;
}

const FAMILIES = MISSION_RUNTIME_FAMILIES as readonly string[];

export function loadCodeChangeConfig(env: NodeJS.ProcessEnv, reviewerModel: string | undefined): CodeChangeConfig | undefined {
  // Literal names on purpose: the compose/inventory guard finds every env read by scanning for them.
  const token = env["KJ_CODE_CHANGE_GITHUB_TOKEN"] || undefined;
  const repos = env["KJ_CODE_CHANGE_REPOS"] || undefined;
  const coderModel = env["KJ_CODE_CHANGE_CODER_MODEL"] || undefined;
  if (!token && !repos && !coderModel) return undefined;
  if (!token || !repos || !coderModel)
    throw new Error(
      "KJ_CODE_CHANGE_GITHUB_TOKEN, KJ_CODE_CHANGE_REPOS and KJ_CODE_CHANGE_CODER_MODEL must all be set or all " +
        "left unset - refusing to start half-configured",
    );
  if (!/^[^\s]{20,512}$/.test(token)) throw new Error("KJ_CODE_CHANGE_GITHUB_TOKEN is malformed - refusing to start");
  const allowedRepos = repos.split(",").map((r) => r.trim()).filter(Boolean);
  if (allowedRepos.length === 0 || allowedRepos.length > 5 || allowedRepos.some((r) => !RepoSlug.safeParse(r).success))
    throw new Error("KJ_CODE_CHANGE_REPOS must list 1 to 5 owner/repo names - refusing to start");
  if (!coderModel.includes("/") || !FAMILIES.includes(modelFamily(coderModel)))
    throw new Error(`KJ_CODE_CHANGE_CODER_MODEL must be a vendor/model name from one of: ${FAMILIES.join(", ")}`);
  if (!reviewerModel)
    throw new Error("code-change/v1 needs the mission reviewer runtime (MISSION_REVIEWER_MODEL) - refusing to start");
  if (modelFamily(reviewerModel) === modelFamily(coderModel))
    throw new Error("MISSION_REVIEWER_MODEL must be a different model family from KJ_CODE_CHANGE_CODER_MODEL");
  return { token, allowedRepos, coderModel };
}
