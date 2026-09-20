import {
  MISSION_RUNTIME_FAMILIES,
  modelFamily,
} from "../../../../packages/contracts/src/index.js";
import {
  createDeepSeekPort,
  createOpenRouterPort,
  type ModelPort,
} from "../../../../packages/models/src/index.js";

/**
 * KJ-P3 - deployment configuration for the two mission runtimes, in the same fail-closed
 * style as the canary and admission seams: nothing set means the mission is simply not
 * served (the production worker's existing behaviour); a partial or wrong configuration
 * stops the worker at startup instead of silently serving a weaker mission.
 *
 * One provider group per deployment:
 *   DeepSeek direct  MISSION_DEEPSEEK_API_KEY   models `deepseek-...` for both roles
 *   OpenRouter       MISSION_OPENROUTER_API_KEY models as `family/slug` (anthropic/, x-ai/, deepseek/)
 * plus MISSION_ANALYST_MODEL and MISSION_REVIEWER_MODEL. The two models must differ: a reviewer
 * that is the same model as the analyst is marking its own work. The API key is read from the
 * environment only and never printed.
 */
export interface MissionRuntimes {
  analyst: ModelPort;
  reviewer: ModelPort;
  analystModel: string;
  reviewerModel: string;
  provider: "deepseek" | "openrouter";
}

const FAMILIES = MISSION_RUNTIME_FAMILIES as readonly string[];

export function loadMissionConfig(
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): MissionRuntimes | undefined {
  const openrouterKey = env["MISSION_OPENROUTER_API_KEY"] || undefined;
  const deepseekKey = env["MISSION_DEEPSEEK_API_KEY"] || undefined;
  const analystModel = env["MISSION_ANALYST_MODEL"] || undefined;
  const reviewerModel = env["MISSION_REVIEWER_MODEL"] || undefined;
  if (!openrouterKey && !deepseekKey && !analystModel && !reviewerModel) return undefined;
  if (openrouterKey && deepseekKey)
    throw new Error(
      "MISSION_OPENROUTER_API_KEY and MISSION_DEEPSEEK_API_KEY are both set - " +
        "choose one provider, refusing to guess",
    );
  const apiKey = openrouterKey ?? deepseekKey;
  if (!apiKey || !analystModel || !reviewerModel)
    throw new Error(
      "A mission provider key (MISSION_DEEPSEEK_API_KEY or MISSION_OPENROUTER_API_KEY), " +
        "MISSION_ANALYST_MODEL and MISSION_REVIEWER_MODEL must all be set or all left unset " +
        "- refusing to start half-configured",
    );
  for (const [name, model] of [
    ["MISSION_ANALYST_MODEL", analystModel],
    ["MISSION_REVIEWER_MODEL", reviewerModel],
  ] as const) {
    if (!FAMILIES.includes(modelFamily(model)))
      throw new Error(`${name} must be a model from one of: ${FAMILIES.join(", ")}`);
    // DeepSeek direct takes bare model names; OpenRouter takes provider/slug.
    if (deepseekKey && (modelFamily(model) !== "deepseek" || model.includes("/")))
      throw new Error(`${name} must be a bare deepseek-... model when MISSION_DEEPSEEK_API_KEY is used`);
    if (openrouterKey && !model.includes("/"))
      throw new Error(`${name} must be a provider/slug model when MISSION_OPENROUTER_API_KEY is used`);
  }
  if (analystModel === reviewerModel)
    throw new Error(
      "MISSION_ANALYST_MODEL and MISSION_REVIEWER_MODEL must differ - " +
        "the reviewer must be a different model from the analyst",
    );
  const shared = { apiKey, timeoutMs: 110_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
  const make = deepseekKey ? createDeepSeekPort : createOpenRouterPort;
  return {
    analyst: make({ ...shared, model: analystModel }),
    reviewer: make({ ...shared, model: reviewerModel }),
    analystModel,
    reviewerModel,
    provider: deepseekKey ? "deepseek" : "openrouter",
  };
}
