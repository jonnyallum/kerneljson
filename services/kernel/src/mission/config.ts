import {
  MISSION_ANALYST_FAMILY,
  MISSION_REVIEWER_FAMILY,
} from "../../../../packages/contracts/src/index.js";
import { createOpenRouterPort, type ModelPort } from "../../../../packages/models/src/index.js";

/**
 * KJ-P3 - deployment configuration for the two mission runtimes, in the same fail-closed
 * style as the canary and admission seams: nothing set means the mission is simply not
 * served (the production worker's existing behaviour); a partial or wrong configuration
 * stops the worker at startup instead of silently serving a weaker mission.
 *
 * The API key is read from the environment only and never printed. Model slugs are
 * deployment choices, but the role each family plays is fixed by the recipe.
 */
export interface MissionRuntimes {
  analyst: ModelPort;
  reviewer: ModelPort;
  analystModel: string;
  reviewerModel: string;
}

export function loadMissionConfig(
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): MissionRuntimes | undefined {
  const apiKey = env["MISSION_OPENROUTER_API_KEY"] || undefined;
  const analystModel = env["MISSION_ANALYST_MODEL"] || undefined;
  const reviewerModel = env["MISSION_REVIEWER_MODEL"] || undefined;
  if (!apiKey && !analystModel && !reviewerModel) return undefined;
  if (!apiKey || !analystModel || !reviewerModel)
    throw new Error(
      "MISSION_OPENROUTER_API_KEY, MISSION_ANALYST_MODEL and MISSION_REVIEWER_MODEL " +
        "must all be set or all left unset - refusing to start half-configured",
    );
  if (!analystModel.startsWith(`${MISSION_ANALYST_FAMILY}/`))
    throw new Error(`MISSION_ANALYST_MODEL must be a ${MISSION_ANALYST_FAMILY}/... model`);
  if (!reviewerModel.startsWith(`${MISSION_REVIEWER_FAMILY}/`))
    throw new Error(`MISSION_REVIEWER_MODEL must be a ${MISSION_REVIEWER_FAMILY}/... model`);
  const shared = { apiKey, timeoutMs: 110_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
  return {
    analyst: createOpenRouterPort({ ...shared, model: analystModel }),
    reviewer: createOpenRouterPort({ ...shared, model: reviewerModel }),
    analystModel,
    reviewerModel,
  };
}
