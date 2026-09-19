import { describe, it, expect } from "vitest";
import { createOpenRouterPort } from "../packages/models/src/index.js";
import { ModelRequest } from "../packages/contracts/src/index.js";
import { validateModelResult } from "../packages/models/src/index.js";

const id = "10000000-0000-4000-8000-000000000001";
const request = ModelRequest.parse({
  callId: id, taskId: id, stepId: id, trace: { traceId: id, correlationId: id },
  messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], maxOutputTokens: 64,
});
const KEY = "sk-or-v1-" + "b".repeat(64);

const completion = (over: Record<string, unknown> = {}) => ({
  id: "gen-1731-abc", object: "chat.completion", model: "anthropic/claude-sonnet-x",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, ...over,
});

function port(respond: (url: string, init: RequestInit) => Response, model = "anthropic/claude-sonnet-x") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(url, init); }) as unknown as typeof fetch;
  return { port: createOpenRouterPort({ apiKey: KEY, model, fetch: fetchImpl }), calls };
}

describe("KJ-P3 OpenRouter runtime port", () => {
  it("calls the fixed OpenRouter endpoint with the standard body and no provider-specific extras", async () => {
    const { port: p, calls } = port(() => new Response(JSON.stringify(completion())));
    const result = validateModelResult(request, await p.generate(request));
    expect(result.status).toBe("SUCCEEDED");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ model: "anthropic/claude-sonnet-x", messages: request.messages, max_tokens: 64, stream: false });
    expect(calls[0]!.init.redirect).toBe("error");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("records the provider label and the model the provider says it ran, which is what the mission verifies", async () => {
    const { port: p } = port(() => new Response(JSON.stringify(completion({ model: "x-ai/grok-real-1" }))), "x-ai/grok-requested");
    const result = await p.generate(request);
    if (result.status !== "SUCCEEDED") throw new Error("expected success");
    expect(result.receipt.provider).toBe("openrouter");
    expect(result.receipt.model).toBe("x-ai/grok-requested");
    expect(result.receipt.responseModel).toBe("x-ai/grok-real-1");
    expect(result.receipt.usage.totalTokens).toBe(15);
  });

  it("classifies provider errors without reading or echoing the body (which can contain the prompt or key)", async () => {
    const cases: Array<[number, string, boolean]> = [[401, "AUTHENTICATION", false], [402, "INSUFFICIENT_BALANCE", false], [429, "RATE_LIMIT", true], [503, "PROVIDER_UNAVAILABLE", true], [400, "REQUEST_REJECTED", false]];
    for (const [status, code, retryable] of cases) {
      const { port: p } = port(() => new Response(JSON.stringify({ error: `bad key ${KEY} for prompt u` }), { status }));
      const result = await p.generate(request);
      expect(result.status).toBe("FAILED");
      if (result.status !== "FAILED") continue;
      expect([result.receipt.error.code, result.receipt.error.retryable], String(status)).toEqual([code, retryable]);
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });

  it("fails closed on a response that does not look like a chat completion", async () => {
    const { port: p } = port(() => new Response(JSON.stringify({ hello: "world" })));
    const result = await p.generate(request);
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") expect(result.receipt.error.code).toBe("MALFORMED_RESPONSE");
  });

  it("refuses an invalid configuration with a message that never contains the key", () => {
    let message = "";
    try { createOpenRouterPort({ apiKey: "has space " + KEY, model: "anthropic/claude-x" }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/Invalid OpenRouter configuration/);
    expect(message).not.toContain("sk-or-v1");
    expect(() => createOpenRouterPort({ apiKey: KEY, model: "bad model!" })).toThrow(/Invalid OpenRouter configuration/);
  });
});
