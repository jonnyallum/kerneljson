import { ModelRequest } from "../../packages/contracts/src/index.js";
export const modelRequest = ModelRequest.parse({
  callId: "30000000-0000-4000-8000-000000000001",
  taskId: "30000000-0000-4000-8000-000000000002",
  stepId: "30000000-0000-4000-8000-000000000003",
  trace: {
    traceId: "30000000-0000-4000-8000-000000000004",
    correlationId: "30000000-0000-4000-8000-000000000005",
  },
  messages: [{ role: "user", content: "private test prompt" }],
  maxOutputTokens: 64,
});
export const deepSeekResponse = {
  id: "completion-fixture-1",
  object: "chat.completion",
  model: "deepseek-v4-flash",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "untrusted answer",
        reasoning_content: "private reasoning",
      },
    },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
};
