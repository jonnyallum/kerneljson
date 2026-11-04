import { describe, expect, it } from "vitest";
import { harness, msg } from "./support/telegram-fixture.js";

describe("ordinary Telegram text", () => {
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
