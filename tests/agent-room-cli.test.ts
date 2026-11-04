import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelService, InMemoryChannelStore, createChannelHandler, type AgentRegistry } from "../packages/agent-channel/src/index.js";
import { runRoomCli } from "../packages/agent-channel/src/cli.js";
import type { TenantContext } from "../packages/contracts/src/index.js";

const tenant = randomUUID();
const codex: TenantContext = { tenantId: tenant, principal: { id: randomUUID(), kind: "SERVICE" } };
const claude: TenantContext = { tenantId: tenant, principal: { id: randomUUID(), kind: "SERVICE" } };
const bearers = {
  codex: "kjr1_codex-room-bearer-value-00000001",
  claude: "kjr1_claude-room-bearer-value-0000001",
};
const registry: AgentRegistry = {
  handleFor: async (context) => {
    if (context.principal.id === codex.principal.id) return "codex";
    if (context.principal.id === claude.principal.id) return "claude-code";
    return null;
  },
  members: async () => [
    { principalId: codex.principal.id, handle: "codex" },
    { principalId: claude.principal.id, handle: "claude-code" },
  ],
};

describe("room CLI", () => {
  let url = "";
  let close: () => Promise<void> = async () => {};
  const logs: string[] = [];
  const errors: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);

  beforeAll(async () => {
    const service = new ChannelService(new InMemoryChannelStore(), registry);
    const tokens: Record<string, TenantContext> = { [bearers.codex]: codex, [bearers.claude]: claude };
    const handler = createChannelHandler({
      service,
      authenticate: async (headers) => {
        const token = (headers.authorization ?? "").replace("Bearer ", "");
        const who = tokens[token];
        if (!who) throw new Error("not signed in");
        return who;
      },
    });
    const server: Server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    url = `http://127.0.0.1:${address.port}`;
    close = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });
  afterAll(async () => {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    await close();
  });

  it("sends, the other agent reads and acks, and the sender reads that ack", async () => {
    expect(await runRoomCli(["send", "--kind", "NOTE", "--body", "from codex", "--key", "cli-round-trip-1"], { ROOM_URL: url, ROOM_BEARER: bearers.codex })).toBe(0);
    const sent = JSON.parse(logs.at(-1) ?? "{}") as { message: { id: string; seq: number } };
    expect(await runRoomCli(["read", "--after", "0"], { ROOM_URL: url, ROOM_BEARER: bearers.claude })).toBe(0);
    const seen = JSON.parse(logs.at(-1) ?? "{}") as { messages: { id: string }[] };
    expect(seen.messages.map((message) => message.id)).toEqual([sent.message.id]);
    expect(await runRoomCli(["ack", "--up-to", String(sent.message.seq)], { ROOM_URL: url, ROOM_BEARER: bearers.claude })).toBe(0);
    expect(await runRoomCli(["acks"], { ROOM_URL: url, ROOM_BEARER: bearers.codex })).toBe(0);
    const acks = JSON.parse(logs.at(-1) ?? "{}") as { acks: { handle: string; upToSeq: number }[] };
    expect(acks.acks).toEqual([{ principalId: claude.principal.id, handle: "claude-code", upToSeq: sent.message.seq, at: expect.any(String) }]);
    expect(JSON.stringify(logs)).not.toContain(bearers.codex);
    expect(errors.join("")).not.toContain(bearers.claude);
  });

  it("refuses a door-shaped bearer without calling the room", async () => {
    expect(await runRoomCli(["read"], { ROOM_URL: url, ROOM_BEARER: "door-bearer-not-a-room-token-0001" })).toBe(2);
    expect(errors.at(-1)).toContain("ROOM_CLIENT_CONFIG");
  });
});
