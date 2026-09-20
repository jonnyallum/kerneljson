import {
  MISSION_RUNTIME_FAMILIES,
  modelFamily,
  sameModel,
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
 * KJ-P3.1: the provider is chosen PER ROLE from the shape of the model name, so the analyst and
 * the reviewer can be served by different providers (the preferred production configuration):
 *   bare `deepseek-...`       DeepSeek direct   needs MISSION_DEEPSEEK_API_KEY
 *   `family/slug`             OpenRouter        needs MISSION_OPENROUTER_API_KEY (anthropic/, x-ai/, deepseek/)
 * plus MISSION_ANALYST_MODEL and MISSION_REVIEWER_MODEL. Every key a model needs must be set, and a
 * key that no model uses is refused, so a worker never holds a credential it does not exercise.
 * The two models must be different models: a reviewer that is the same model as the analyst is
 * marking its own work, and one model reached by two routes is still one model. Keys are read from
 * the environment only and never printed.
 */
export type MissionProvider = "deepseek" | "openrouter";

export interface MissionRuntimes {
  analyst: ModelPort;
  reviewer: ModelPort;
  analystModel: string;
  reviewerModel: string;
  analystProvider: MissionProvider;
  reviewerProvider: MissionProvider;
}

const FAMILIES = MISSION_RUNTIME_FAMILIES as readonly string[];

const KEY_NAME: Record<MissionProvider, string> = {
  deepseek: "MISSION_DEEPSEEK_API_KEY",
  openrouter: "MISSION_OPENROUTER_API_KEY",
};

/** DeepSeek direct takes bare `deepseek-...` names; OpenRouter takes `family/slug`. */
function providerFor(name: string, model: string): MissionProvider {
  if (!FAMILIES.includes(modelFamily(model)))
    throw new Error(`${name} must be a model from one of: ${FAMILIES.join(", ")}`);
  if (model.includes("/")) return "openrouter";
  if (modelFamily(model) !== "deepseek")
    throw new Error(`${name} must be a provider/slug model unless it is a bare deepseek-... model`);
  return "deepseek";
}

export function loadMissionConfig(
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): MissionRuntimes | undefined {
  // Literal names on purpose: the compose/inventory guard finds every env read by scanning for them.
  const keys: Record<MissionProvider, string | undefined> = {
    deepseek: env["MISSION_DEEPSEEK_API_KEY"] || undefined,
    openrouter: env["MISSION_OPENROUTER_API_KEY"] || undefined,
  };
  const analystModel = env["MISSION_ANALYST_MODEL"] || undefined;
  const reviewerModel = env["MISSION_REVIEWER_MODEL"] || undefined;
  if (!keys.openrouter && !keys.deepseek && !analystModel && !reviewerModel) return undefined;
  if ((!keys.openrouter && !keys.deepseek) || !analystModel || !reviewerModel)
    throw new Error(
      "A mission provider key (MISSION_DEEPSEEK_API_KEY or MISSION_OPENROUTER_API_KEY), " +
        "MISSION_ANALYST_MODEL and MISSION_REVIEWER_MODEL must all be set or all left unset " +
        "- refusing to start half-configured",
    );
  const analystProvider = providerFor("MISSION_ANALYST_MODEL", analystModel);
  const reviewerProvider = providerFor("MISSION_REVIEWER_MODEL", reviewerModel);
  if (sameModel(analystModel, reviewerModel))
    throw new Error(
      "MISSION_ANALYST_MODEL and MISSION_REVIEWER_MODEL must differ - " +
        "the reviewer must be a different model from the analyst",
    );
  const used = new Set<MissionProvider>([analystProvider, reviewerProvider]);
  for (const provider of used)
    if (!keys[provider]) throw new Error(`${KEY_NAME[provider]} must be set: a configured mission model uses that provider`);
  for (const provider of ["deepseek", "openrouter"] as const)
    if (keys[provider] && !used.has(provider))
      throw new Error(`${KEY_NAME[provider]} is set but no mission model uses that provider - refusing to hold an unused key`);

  const build = (provider: MissionProvider, model: string): ModelPort =>
    (provider === "deepseek" ? createDeepSeekPort : createOpenRouterPort)({
      apiKey: keys[provider]!,
      timeoutMs: 110_000,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      model,
    });
  return {
    analyst: build(analystProvider, analystModel),
    reviewer: build(reviewerProvider, reviewerModel),
    analystModel,
    reviewerModel,
    analystProvider,
    reviewerProvider,
  };
}
