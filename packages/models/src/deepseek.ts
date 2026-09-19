import type { ModelPort } from "./port.js";
import { createChatCompletionsPort } from "./chat-completions.js";

/** Deployment-only configuration. Never accept these values from a task/prompt. */
export function createDeepSeekPort(config: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): ModelPort {
  return createChatCompletionsPort({
    ...config,
    provider: "deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    invalidConfigMessage:
      "Invalid DeepSeek configuration; inject credentials from jVault kerneljson",
    extraBody: { thinking: { type: "disabled" } },
  });
}
