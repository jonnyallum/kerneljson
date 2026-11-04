import { describe, expect, it } from "vitest";
import { HttpAgentRoom, roomTools } from "../apps/mcp/src/room.js";
import { handleMessage } from "../apps/mcp/src/protocol.js";
import { loadConfig } from "../apps/mcp/src/main.js";
import type { OperatorDoor } from "../apps/mcp/src/door.js";

const TOKENS = {
  chatgpt: "kjr1_0123456789abcdefghij0123456789abcdefghij",
  grokbot: "kjr1_abcdefghij0123456789abcdefghij0123456789",
};
const DOOR = {} as OperatorDoor;
const OPERATOR = { profile: "chatgpt", readOnly: false, client: "ChatGPT" };
const GROK = { profile: "grokbot", readOnly: false, client: "Grok Bot" };
const READ_ONLY = { profile: "chatgpt", readOnly: true, client: "ChatGPT" };

function call(name: string, args: unknown, caller = OPERATOR, fetchImpl?: typeof fetch) {
  const room = new HttpAgentRoom("http://kerneljson-agent-room:8092", TOKENS, fetchImpl);
  return handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    DOOR, "test-release", () => {}, caller, roomTools(room),
  );
}

describe("operator MCP shared room bridge", () => {
  it("only lists room tools when configured, and hides writes from a read-only caller", async () => {
    const list = (extra: boolean, caller = OPERATOR) => handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" }, DOOR, "test-release", () => {}, caller,
      extra ? roomTools(new HttpAgentRoom("http://kerneljson-agent-room:8092", TOKENS)) : [],
    );
    const names = (value: Awaited<ReturnType<typeof list>>) =>
      ((value as { result: { tools: Array<{ name: string }> } }).result.tools).map((tool) => tool.name);
    expect(names(await list(false))).not.toContain("kj_room_read");
    expect(names(await list(true))).toEqual(expect.arrayContaining(["kj_room_read", "kj_room_post", "kj_room_ack", "kj_room_acks"]));
    expect(names(await list(true, READ_ONLY))).toContain("kj_room_read");
    expect(names(await list(true, READ_ONLY))).not.toContain("kj_room_post");
  });

  it("attributes posts to the OAuth profile and never sends the door bearer", async () => {
    const requests: Array<{ url: string; bearer: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        bearer: String((init?.headers as Record<string, string>)?.authorization),
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return new Response(JSON.stringify({ message: { seq: 1 }, duplicate: false }), { status: 201 });
    }) as typeof fetch;
    const input = { request_id: "room-req-1234", kind: "QUESTION", body: "Can you review this?" };
    const chat = await call("kj_room_post", input, OPERATOR, fetchImpl);
    const grok = await call("kj_room_post", input, GROK, fetchImpl);
    expect((chat as { result: { isError: boolean } }).result.isError).toBe(false);
    expect((grok as { result: { isError: boolean } }).result.isError).toBe(false);
    expect(requests).toEqual([
      { url: "http://kerneljson-agent-room:8092/messages", bearer: `Bearer ${TOKENS.chatgpt}`, body: { kind: "QUESTION", body: "Can you review this?", idempotencyKey: "mcp-room:chatgpt:room-req-1234" } },
      { url: "http://kerneljson-agent-room:8092/messages", bearer: `Bearer ${TOKENS.grokbot}`, body: { kind: "QUESTION", body: "Can you review this?", idempotencyKey: "mcp-room:grokbot:room-req-1234" } },
    ]);
  });

  it("classifies room errors without returning the room response or credential", async () => {
    const fetchImpl = (async () => new Response("private room error with a credential", { status: 403 })) as typeof fetch;
    const answer = await call("kj_room_read", {}, OPERATOR, fetchImpl);
    const result = (answer as { result: { isError: boolean; structuredContent: unknown } }).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: "FORBIDDEN", doorStatus: 403 });
    expect(JSON.stringify(answer)).not.toContain("private room error");
    expect(JSON.stringify(answer)).not.toContain(TOKENS.chatgpt);
  });

  it("requires the room URL and both distinct bearers together", () => {
    const base = { MCP_HOST: "127.0.0.1", MCP_AUTH: "local-unauthenticated", KJ_ADMISSION_URL: "http://127.0.0.1:8081", KJ_MCP_BEARER: "door-bearer-for-tests-0123456789" };
    expect(loadConfig(base).room).toBeNull();
    expect(() => loadConfig({ ...base, KJ_ROOM_URL: "http://kerneljson-agent-room:8092" })).toThrow(/both room bearers/);
    expect(loadConfig({ ...base, KJ_ROOM_URL: "http://kerneljson-agent-room:8092", ROOM_BEARER_CHATGPT: TOKENS.chatgpt, ROOM_BEARER_GROK: TOKENS.grokbot }).room).toMatchObject({ url: "http://kerneljson-agent-room:8092" });
    expect(() => loadConfig({ ...base, MCP_AUTH: "oauth", KJ_ROOM_URL: "https://outside.example", ROOM_BEARER_CHATGPT: TOKENS.chatgpt, ROOM_BEARER_GROK: TOKENS.grokbot })).toThrow(/private agent-room service/);
  });
});
