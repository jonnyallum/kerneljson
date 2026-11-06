import { describe, expect, it } from "vitest";
import { MCP_CHANNEL, MCP_CHANNELS, HttpOperatorDoor, type DoorResult, type OperatorDoor } from "../apps/mcp/src/door.js";
import { handleMessage } from "../apps/mcp/src/protocol.js";
import { CHATGPT_REDIRECT_URIS, CLAUDECODE_REDIRECT_URIS, CLIENT_PROFILES, GROKBOT_REDIRECT_URIS, profileFor } from "../apps/mcp/src/oauth/profiles.js";
import { TOOLS, idempotencyKeyFor } from "../apps/mcp/src/tools.js";
import { CHANNEL_SOURCES, sourceFor } from "../apps/gateway/src/server.js";

/** Claude Code as the third operator client: profile resolution, attribution parity across MCP, door and gateway, and cancel ownership. */
const TASK = "1777e4b0-5e9f-8b57-ad97-8fca00c0aab1";
const OTHER = "2888f5c1-6fa0-4c68-be08-9fdb11d1bbc2";
const CLAUDE = { profile: "claudecode", readOnly: false, client: "Claude Code" };
const GROK = { profile: "grokbot", readOnly: false, client: "Cursor" };
const CHATGPT = { profile: "chatgpt", readOnly: false, client: "ChatGPT" };

function fakeDoor(list: DoorResult = { ok: true, status: 200, body: [] }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ok: DoorResult = { ok: true, status: 200, body: { taskId: TASK, status: "RECEIVED" } };
  const rec = (method: string, answer: DoorResult = ok) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return answer;
  };
  const door: OperatorDoor = {
    listTasks: rec("listTasks", list), task: rec("task"), memory: rec("memory"), world: rec("world"), health: rec("health"), admit: rec("admit"), cancel: rec("cancel"),
  };
  return { door, calls };
}
const run = (name: string, args: unknown, door: OperatorDoor, caller: typeof CLAUDE) =>
  handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, door, "test-release", () => {}, caller) as Promise<{ result: { isError: boolean; structuredContent: Record<string, unknown> } }>;
const item = (taskId: string, source: string | null) => ({ taskId, source, recipe: null, status: "RECEIVED", objective: "", createdAt: "", updatedAt: "" });

describe("profile resolution", () => {
  it("resolves exactly its own two loopback callbacks to claudecode, with operator scope", () => {
    expect(profileFor(CLAUDECODE_REDIRECT_URIS)?.name).toBe("claudecode");
    expect(CLIENT_PROFILES.claudecode).toMatchObject({ scope: "kerneljson.operator", readOnly: false });
    expect(CLAUDECODE_REDIRECT_URIS).toEqual(["http://localhost:53682/callback", "http://127.0.0.1:53682/callback"]);
  });

  it("keeps ChatGPT and Grok Bot resolving as they did, and no URI belongs to two profiles", () => {
    expect(profileFor(CHATGPT_REDIRECT_URIS)?.name).toBe("chatgpt");
    expect(profileFor(GROKBOT_REDIRECT_URIS)?.name).toBe("grokbot");
    const all = Object.values(CLIENT_PROFILES).flatMap((p) => p.redirectUris);
    expect(new Set(all).size).toBe(all.length);
  });

  it.each([
    [["http://localhost:53683/callback"]],
    [["http://localhost:53682/callback/extra"]],
    [["https://localhost:53682/callback"]],
    [["http://localhost:53682/callback", "http://localhost:8787/callback"]],
    [["http://localhost:53682/callback", "https://chatgpt.com/connector_platform_oauth_redirect"]],
    [["http://localhost/callback"]],
    [[]],
  ])("refuses %j", (uris) => {
    expect(profileFor(uris)).toBeNull();
  });
});

describe("attribution is the same list in the MCP, the door client and the gateway", () => {
  it("names claudecode-mcp/v1 in all three, and nothing else is accepted", () => {
    expect(MCP_CHANNELS).toEqual([MCP_CHANNEL, "grokbot-mcp/v1", "claudecode-mcp/v1"]);
    expect(Object.keys(CHANNEL_SOURCES).sort()).toEqual(["telegram/v1", ...MCP_CHANNELS].sort());
    expect(sourceFor("claudecode-mcp/v1")).toBe("kerneljson:channel/claudecode-mcp/v1");
    for (const bad of ["claude/v1", "claudecode/v1", "claudecode-mcp/v2", "CLAUDECODE-MCP/V1", "", "chatgpt-mcp/v1 "]) expect(() => sourceFor(bad)).toThrow();
  });

  it("namespaces idempotency keys per client, leaving ChatGPT's and Grok Bot's unchanged", () => {
    expect(idempotencyKeyFor("req-0001-abcd", "claudecode")).toBe("claudecode-mcp:req-0001-abcd");
    expect(idempotencyKeyFor("req-0001-abcd", "grokbot")).toBe("grokbot-mcp:req-0001-abcd");
    expect(idempotencyKeyFor("req-0001-abcd", "chatgpt")).toBe("mcp:req-0001-abcd");
    expect(idempotencyKeyFor("req-0001-abcd")).toBe("mcp:req-0001-abcd");
    expect(idempotencyKeyFor("req-0001-abcd", "local")).toBe("mcp:req-0001-abcd");
  });

  it("sends the channel header from the door client for claudecode, and refuses a label outside the list without a request", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_u: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return new Response(JSON.stringify({ taskId: TASK }), { status: 202 });
    }) as unknown as typeof fetch;
    const real = new HttpOperatorDoor("http://door.invalid", "door-bearer-for-tests-0123456789", fetchImpl);
    expect((await real.admit({ recipe: "morning-brief/v1", objective: "morning brief", idempotencyKey: "claudecode-mcp:k-0001-abcd", channel: "claudecode-mcp/v1" })).ok).toBe(true);
    expect(seen[0]).toMatchObject({ "x-kj-channel": "claudecode-mcp/v1", "idempotency-key": "claudecode-mcp:k-0001-abcd" });
    expect(await real.admit({ recipe: "morning-brief/v1", objective: "morning brief", idempotencyKey: "k-0002-abcd", channel: "claude/v1" })).toEqual({ ok: false, failure: "REJECTED", status: null });
    expect(seen).toHaveLength(1);
  });

  it.each([
    ["kj_run_brief", { request_id: "claude-0001-abcd" }, "claudecode-mcp:claude-0001-abcd"],
    ["kj_run_analysis", { request_id: "claude-0002-abcd", repo: "jonnyallum/kerneljson" }, "claudecode-mcp:claude-0002-abcd"],
    ["kj_run_code_change", { request_id: "claude-0003-abcd", repo: "jonnyallum/kj-pilot", instructions: "Add a slugify(text) helper with tests." }, "claudecode-mcp:claude-0003-abcd"],
  ])("%s from Claude Code admits on its own channel and key", async (name, args, key) => {
    const { door, calls } = fakeDoor();
    const r = await run(name, args, door, CLAUDE);
    expect(r.result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "admit", args: [{ idempotencyKey: key, channel: "claudecode-mcp/v1" }] });
  });

  it("does not let ChatGPT or Grok Bot be attributed to Claude, and ChatGPT carries no channel override", async () => {
    const g = fakeDoor();
    await run("kj_run_brief", { request_id: "grok-0001-abcd" }, g.door, GROK);
    expect(g.calls[0]!.args[0]).toMatchObject({ channel: "grokbot-mcp/v1", idempotencyKey: "grokbot-mcp:grok-0001-abcd" });
    const c = fakeDoor();
    await run("kj_run_brief", { request_id: "chat-0001-abcd" }, c.door, CHATGPT);
    expect(c.calls[0]!.args[0]).toEqual({ recipe: "morning-brief/v1", objective: "morning brief", idempotencyKey: "mcp:chat-0001-abcd" });
  });
});

describe("Claude Code cancels only its own tasks", () => {
  const own = "kerneljson:channel/claudecode-mcp/v1";

  it("cancels a task whose recorded source is its own channel", async () => {
    const { door, calls } = fakeDoor({ ok: true, status: 200, body: [item(OTHER, "kerneljson:channel/chatgpt-mcp/v1"), item(TASK, own)] });
    const r = await run("kj_cancel_task", { task_id: TASK }, door, CLAUDE);
    expect(r.result.isError).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["listTasks", "cancel"]);
    expect(calls[1]!.args).toEqual([TASK]);
  });

  it.each([
    ["ChatGPT's task", "kerneljson:channel/chatgpt-mcp/v1"],
    ["Grok Bot's task", "kerneljson:channel/grokbot-mcp/v1"],
    ["the scheduled brief", "kerneljson:gateway/v1"],
    ["a Telegram task", "kerneljson:channel/telegram/v1"],
    ["a task with no recorded source", null],
    ["a lookalike source", "kerneljson:channel/claudecode-mcp/v1x"],
  ])("refuses %s without asking the door to cancel", async (_n, source) => {
    const { door, calls } = fakeDoor({ ok: true, status: 200, body: [item(TASK, source)] });
    const r = await run("kj_cancel_task", { task_id: TASK }, door, CLAUDE);
    expect(r.result.isError).toBe(true);
    expect(r.result.structuredContent["error"]).toBe("FORBIDDEN");
    expect(calls.map((c) => c.method)).toEqual(["listTasks"]);
  });

  it("refuses an id that is not in the recent list, an empty list, and a list shape it does not recognise", async () => {
    for (const body of [[item(OTHER, own)], [], { tasks: [item(TASK, own)] }, null]) {
      const { door, calls } = fakeDoor({ ok: true, status: 200, body });
      expect((await run("kj_cancel_task", { task_id: TASK }, door, CLAUDE)).result.isError).toBe(true);
      expect(calls.map((c) => c.method)).toEqual(["listTasks"]);
    }
  });

  it("does not cancel when the list itself fails, and reports that classification", async () => {
    const { door, calls } = fakeDoor({ ok: false, failure: "UNAVAILABLE", status: 503 });
    const r = await run("kj_cancel_task", { task_id: TASK }, door, CLAUDE);
    expect(r.result.isError).toBe(true);
    expect(r.result.structuredContent["error"]).toBe("UNAVAILABLE");
    expect(calls.map((c) => c.method)).toEqual(["listTasks"]);
  });

  it("leaves ChatGPT and Grok Bot cancelling exactly as before: no lookup, straight to the door", async () => {
    for (const caller of [CHATGPT, GROK]) {
      const { door, calls } = fakeDoor();
      expect((await run("kj_cancel_task", { task_id: TASK }, door, caller)).result.isError).toBe(false);
      expect(calls.map((c) => c.method)).toEqual(["cancel"]);
    }
  });

  it("still refuses a malformed id before any call", async () => {
    const { door, calls } = fakeDoor();
    expect((await run("kj_cancel_task", { task_id: "../admin" }, door, CLAUDE)).result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("the tool list gives Claude Code no authority over approval", () => {
  it("has no approve, signal, schedule or identity tool", () => {
    expect(TOOLS.map((t) => t.name).filter((n) => /approve|signal|schedule|identity/i.test(n))).toEqual([]);
  });
});
