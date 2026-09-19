import type { ModelPort } from "./port.js";
import { createChatCompletionsPort } from "./chat-completions.js";

/**
 * OpenRouter reaches many providers (Anthropic, xAI, ...) through one
 * OpenAI-compatible endpoint. The model slug is deployment configuration, never a
 * task input. `responseModel` on each receipt is what the provider reports it ran,
 * which is what the mission verifier checks, not what was requested.
 */
export function createOpenRouterPort(config: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): ModelPort {
  return createChatCompletionsPort({
    ...config,
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    invalidConfigMessage:
      "Invalid OpenRouter configuration; inject credentials from jVault, never from a task",
    extraHeaders: { "x-title": "KernelJSON" },
  });
}
