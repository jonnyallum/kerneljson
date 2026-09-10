import { it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import {
  ModelRequest,
  ModelCallResult,
  ModelUsage,
  PolicyDecision,
  Outcome,
} from "../packages/contracts/src/index.js";
import {
  createDeepSeekPort,
  modelDigest,
  validateModelResult,
  type ModelPort,
} from "../packages/models/src/index.js";
import { modelRequest, deepSeekResponse } from "../evals/fixtures/models.js";

const fakeKey = "test-only-not-a-secret";
const model = "deepseek-v4-flash";
function adapter(body: unknown = deepSeekResponse, status = 200) {
  const send = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
  return {
    send,
    port: createDeepSeekPort({ apiKey: fakeKey, model, fetch: send }),
  };
}

it("rejects mismatched task/trace/input/output provenance before persistence", async () => {
  const result = await adapter().port.generate(modelRequest);
  expect(validateModelResult(modelRequest, result)).toEqual(result);
  for (const receipt of [
    { ...result.receipt, taskId: modelRequest.stepId },
    { ...result.receipt, callId: modelRequest.stepId },
    { ...result.receipt, stepId: modelRequest.taskId },
    {
      ...result.receipt,
      trace: { ...modelRequest.trace, traceId: modelRequest.taskId },
    },
    { ...result.receipt, requestDigest: "0".repeat(64) },
    { ...result.receipt, outputDigest: "0".repeat(64) },
  ])
    expect(() =>
      validateModelResult(modelRequest, { ...result, receipt }),
    ).toThrow();
  expect(() =>
    validateModelResult(modelRequest, { ...result, text: "tampered" }),
  ).toThrow();
  expect(() =>
    validateModelResult(
      { ...modelRequest, messages: [{ role: "user", content: "changed" }] },
      result,
    ),
  ).toThrow();
});

it("keeps ModelPort results provider-independent and normalizes property order", async () => {
  const original = await adapter().port.generate(modelRequest);
  const other = {
    ...original,
    receipt: {
      ...original.receipt,
      provider: "other",
      model: "test-v1",
      requestDigest: modelDigest({
        provider: "other",
        model: "test-v1",
        request: modelRequest,
      }),
    },
  };
  const substitute: ModelPort = {
    generate: async () => ModelCallResult.parse(other),
  };
  const { maxOutputTokens, ...rest } = modelRequest;
  expect(
    validateModelResult(
      { maxOutputTokens, ...rest },
      await substitute.generate(modelRequest),
    ),
  ).toEqual(other);
});

it("returns validated text and a task/step/trace-bound receipt with usage and digests", async () => {
  const { port, send } = adapter();
  const result = await port.generate(modelRequest);
  expect(result).toMatchObject({
    status: "SUCCEEDED",
    text: "untrusted answer",
    receipt: {
      status: "SUCCEEDED",
      taskId: modelRequest.taskId,
      stepId: modelRequest.stepId,
      callId: modelRequest.callId,
      trace: modelRequest.trace,
      provider: "deepseek",
      model,
      providerRequestId: deepSeekResponse.id,
      usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      outputDigest: modelDigest("untrusted answer"),
      requestDigest: modelDigest({
        provider: "deepseek",
        model,
        request: modelRequest,
      }),
    },
  });
  expect(ModelCallResult.safeParse(result).success).toBe(true);
  const receipt = JSON.stringify(result.receipt);
  for (const secret of [
    fakeKey,
    "private test prompt",
    "private reasoning",
    "untrusted answer",
  ])
    expect(receipt).not.toContain(secret);
  expect(send).toHaveBeenCalledTimes(1);
  expect(PolicyDecision.safeParse(result).success).toBe(false);
  expect(Outcome.safeParse(result).success).toBe(false);
});

it.each([
  { ...modelRequest, callId: "invalid" },
  { ...modelRequest, stepId: undefined },
  { ...modelRequest, trace: {} },
  { ...modelRequest, messages: [] },
  { ...modelRequest, messages: [{ role: "tool", content: "run" }] },
  { ...modelRequest, messages: [{ role: "user", content: "" }] },
  {
    ...modelRequest,
    messages: [{ role: "user", content: "x".repeat(128_001) }],
  },
  {
    ...modelRequest,
    messages: Array.from({ length: 2 }, () => ({
      role: "user",
      content: "x".repeat(64_001),
    })),
  },
  { ...modelRequest, maxOutputTokens: 0 },
  { ...modelRequest, maxOutputTokens: 8193 },
  { ...modelRequest, maxOutputTokens: 1.5 },
  { ...modelRequest, model: "attacker-model" },
  { ...modelRequest, endpoint: "https://attacker.invalid" },
  { ...modelRequest, tools: [{ name: "grant_permissions" }] },
])(
  "rejects invalid or scope-expanding model requests before I/O (%#)",
  async (raw) => {
    expect(ModelRequest.safeParse(raw).success).toBe(false);
    const { port, send } = adapter();
    await expect(port.generate(raw as ModelRequest)).rejects.toThrow(
      "Invalid ModelRequest",
    );
    expect(send).not.toHaveBeenCalled();
  },
);

it.each([
  [400, "REQUEST_REJECTED", false],
  [401, "AUTHENTICATION", false],
  [403, "AUTHENTICATION", false],
  [402, "INSUFFICIENT_BALANCE", false],
  [429, "RATE_LIMIT", true],
  [500, "PROVIDER_UNAVAILABLE", true],
  [503, "PROVIDER_UNAVAILABLE", true],
] as const)(
  "classifies HTTP %i without retries or leaking its body",
  async (status, code, retryable) => {
    const { port, send } = adapter(
      { error: `${fakeKey} private test prompt` },
      status,
    );
    const result = await port.generate(modelRequest);
    expect(result).toMatchObject({
      status: "FAILED",
      receipt: { error: { code, retryable, httpStatus: status } },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(fakeKey);
    expect(JSON.stringify(result)).not.toContain("private test prompt");
  },
);

it.each([
  ["length", "OUTPUT_LIMIT"],
  ["content_filter", "CONTENT_FILTER"],
  ["tool_calls", "UNSUPPORTED_RESPONSE"],
  ["insufficient_system_resource", "PROVIDER_UNAVAILABLE"],
] as const)(
  "does not treat finish reason %s as successful output",
  async (finish, code) => {
    const body = structuredClone(deepSeekResponse);
    body.choices[0]!.finish_reason = finish;
    expect(await adapter(body).port.generate(modelRequest)).toMatchObject({
      status: "FAILED",
      receipt: { error: { code } },
    });
  },
);

it.each([
  {},
  { ...deepSeekResponse, choices: [] },
  { ...deepSeekResponse, usage: undefined },
  {
    ...deepSeekResponse,
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 9 },
  },
  {
    ...deepSeekResponse,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: null },
      },
    ],
  },
  {
    ...deepSeekResponse,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "  " },
      },
    ],
  },
])("fails closed on malformed provider data (%#)", async (raw) => {
  expect(await adapter(raw).port.generate(modelRequest)).toMatchObject({
    status: "FAILED",
    receipt: { error: { code: "MALFORMED_RESPONSE" } },
  });
});

it("rejects unsolicited tool calls even with a stop finish reason", async () => {
  const raw = {
    ...deepSeekResponse,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "ok",
          tool_calls: [{ function: "grant_permissions" }],
        },
      },
    ],
  };
  expect(await adapter(raw).port.generate(modelRequest)).toMatchObject({
    status: "FAILED",
    receipt: { error: { code: "UNSUPPORTED_RESPONSE" } },
  });
});

it("bounds response bytes and rejects invalid JSON", async () => {
  for (const [body, code] of [
    ["x".repeat(1_048_577), "RESPONSE_TOO_LARGE"],
    ["invalid JSON", "MALFORMED_RESPONSE"],
  ]) {
    const port = createDeepSeekPort({
      apiKey: fakeKey,
      model,
      fetch: async () => new Response(body),
    });
    expect(await port.generate(modelRequest)).toMatchObject({
      status: "FAILED",
      receipt: { error: { code } },
    });
  }
});

it("sanitizes transport exceptions and exposes uncertain execution", async () => {
  const send = vi.fn<typeof fetch>(async () => {
    throw new Error(fakeKey);
  });
  const result = await createDeepSeekPort({
    apiKey: fakeKey,
    model,
    fetch: send,
  }).generate(modelRequest);
  expect(result).toMatchObject({
    status: "FAILED",
    receipt: { error: { code: "NETWORK", retryable: true, mayHaveRun: true } },
  });
  expect(JSON.stringify(result)).not.toContain(fakeKey);
  expect(send).toHaveBeenCalledTimes(1);
});

it("does not send a pre-cancelled request", async () => {
  const { port, send } = adapter();
  const result = await port.generate(modelRequest, {
    signal: AbortSignal.abort(),
  });
  expect(result).toMatchObject({
    status: "FAILED",
    receipt: { error: { code: "CANCELLED", mayHaveRun: false } },
  });
  expect(send).not.toHaveBeenCalled();
});

it("rejects invalid deployment configuration and inconsistent usage", () => {
  for (const apiKey of ["", " ", "header\ninjection"])
    expect(() => createDeepSeekPort({ apiKey, model })).toThrow(
      "Invalid DeepSeek configuration",
    );
  for (const timeoutMs of [0, 120001, NaN])
    expect(() =>
      createDeepSeekPort({ apiKey: fakeKey, model, timeoutMs }),
    ).toThrow("Invalid model timeout");
  expect(
    ModelUsage.safeParse({ inputTokens: 1, outputTokens: 2, totalTokens: 2 })
      .success,
  ).toBe(false);
});

// Real local HTTP covers native fetch serialization, redirects and cancellation.
let handle = (_request: IncomingMessage, response: ServerResponse) => {
  response.end();
};
const server = createServer((request, response) => handle(request, response));
let address: string;
beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string")
    throw new Error("Missing local test address");
  address = `http://127.0.0.1:${bound.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});
function localPort(timeoutMs = 2000): ModelPort {
  return createDeepSeekPort({
    apiKey: fakeKey,
    model,
    timeoutMs,
    fetch: async (url, init) => {
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      return fetch(address, init);
    },
  });
}

it("sends only the documented bounded text request over HTTP", async () => {
  let received: unknown;
  let authorization: string | undefined;
  handle = (request, response) => {
    authorization = request.headers.authorization;
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      received = JSON.parse(body);
      response.end(JSON.stringify(deepSeekResponse));
    });
  };
  expect((await localPort().generate(modelRequest)).status).toBe("SUCCEEDED");
  expect(authorization).toBe(`Bearer ${fakeKey}`);
  expect(received).toEqual({
    model,
    messages: modelRequest.messages,
    max_tokens: 64,
    stream: false,
    thinking: { type: "disabled" },
  });
});

it.each([false, true])(
  "enforces timeout before headers or during body reads (body=%s)",
  async (body) => {
    handle = (_request, response) => {
      if (body) {
        response.writeHead(200);
        response.write("{");
      }
    };
    expect(await localPort(100).generate(modelRequest)).toMatchObject({
      status: "FAILED",
      receipt: { error: { code: "TIMEOUT", mayHaveRun: true } },
    });
  },
);

it("supports cancellation after dispatch", async () => {
  const controller = new AbortController();
  handle = () => controller.abort();
  expect(
    await localPort().generate(modelRequest, { signal: controller.signal }),
  ).toMatchObject({
    status: "FAILED",
    receipt: { error: { code: "CANCELLED", mayHaveRun: true } },
  });
});

it("does not follow redirects with authorization", async () => {
  let attempts = 0;
  handle = (_request, response) => {
    attempts++;
    response.writeHead(307, { location: `${address}/redirected` });
    response.end();
  };
  expect(await localPort().generate(modelRequest)).toMatchObject({
    status: "FAILED",
    receipt: { error: { code: "NETWORK" } },
  });
  expect(attempts).toBe(1);
});
