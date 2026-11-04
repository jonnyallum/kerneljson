import { describe, expect, it } from "vitest";
import { modelDigest, type ModelPort } from "../packages/models/src/index.js";
import { createConversationPort } from "../services/kernel/src/channel/telegram/conversation.js";
import { harness, msg } from "./support/telegram-fixture.js";

describe("ordinary Telegram text", () => {
  it("uses a tool-free bounded model request and validates its receipt", async () => {
    const model: ModelPort = {
      generate: async (request) => {
        expect(request.messages).toHaveLength(2);
        expect(request.messages[1]).toEqual({ role: "user", content: "What can you do?" });
        expect(request.maxOutputTokens).toBeLessThanOrEqual(700);
        expect(Object.keys(request)).not.toContain("tools");
        const answer = "I can explain KernelJSON. Use /status for live state.";
        return {
          status: "SUCCEEDED",
          text: answer,
          receipt: {
            status: "SUCCEEDED",
            callId: request.callId,
            taskId: request.taskId,
            stepId: request.stepId,
            trace: request.trace,
            provider: "test",
            model: "chat-test",
            requestDigest: modelDigest({ provider: "test", model: "chat-test", request }),
            finishedAt: "2026-11-04T12:00:00.000Z",
            durationMs: 1,
            providerRequestId: "test-1",
            responseModel: "chat-test",
            usage: { inputTokens: 8, outputTokens: 10, totalTokens: 18 },
            outputDigest: modelDigest(answer),
          },
        };
      },
    };
    expect(await createConversationPort(model).answer("What can you do?")).toContain("/status");
  });
  it("answers once via the durable inbox and outbox without admitting a task", async () => {
    const h = harness();
    const calls: string[] = [];
    h.deps.conversation = { answer: async (text) => { calls.push(text); return "Hello from KernelJSON."; } };
    h.source.updates = [msg(701, "hello"), msg(701, "hello")];
    await h.poll();
    await h.poll();
    expect(calls).toEqual(["hello"]);
    expect(h.door.admitCalls).toHaveLength(0);
    expect(h.inbox.rows.get(701)).toMatchObject({ command: "CHAT", disposition: "ANSWERED", mission: false });
    expect(await h.replies()).toEqual(["Hello from KernelJSON."]);
  });

  it("answers a model failure with a fixed message and preserves the offset", async () => {
    const h = harness();
    h.deps.conversation = { answer: async () => { throw new Error("private provider detail"); } };
    h.source.updates = [msg(702, "Can you help?")];
    await h.poll();
    expect(h.inbox.next).toBe(703);
    expect((await h.replies())[0]).toContain("could not answer");
    expect((await h.replies())[0]).not.toContain("private provider detail");
  });

  it("keeps unknown slash commands on the existing usage route", async () => {
    const h = harness();
    h.source.updates = [msg(703, "/unknown")];
    await h.poll();
    expect(h.inbox.rows.get(703)?.disposition).toBe("MALFORMED");
  });
});
