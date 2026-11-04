import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { InMemoryChannelStore, type AgentRegistry } from "../packages/agent-channel/src/index.js";
import type { TenantContext } from "../packages/contracts/src/index.js";
import {
  ClosedTaskStore,
  RoomConfigError,
  assertRoomDatabaseRole,
  buildRoomHandler,
  loadRoomConfig,
  summariseRoomConfig,
} from "../apps/mission-control/src/room-main.js";

const tenant = randomUUID();
const claude: TenantContext = { tenantId: tenant, principal: { id: randomUUID(), kind: "SERVICE" } };
const jonny: TenantContext = { tenantId: tenant, principal: { id: randomUUID(), kind: "HUMAN" } };
const registry: AgentRegistry = {
  handleFor: async (context) => {
    if (context.principal.id === claude.principal.id) return "claude-code";
    if (context.principal.id === jonny.principal.id) return "jonny";
    return null;
  },
  members: async () => [
    { principalId: claude.principal.id, handle: "claude-code" },
    { principalId: jonny.principal.id, handle: "jonny" },
  ],
};

describe("room configuration", () => {
  const secret = "super-secret-value";
  const bearer = "kjr1_room-test-bearer-value-0000000001";
  const base = {
    DATABASE_URL: `postgresql://role:${secret}@db.internal:5432/kerneljson`,
    ROOM_ORIGIN: "https://kj-room.example",
    ROOM_MEMBERS: JSON.stringify([
      { bearerEnv: "ROOM_BEARER_CODEX", tenantId: tenant, principalId: claude.principal.id, kind: "SERVICE" },
    ]),
    ROOM_BEARER_CODEX: bearer,
  };

  it("rejects a partial config without echoing secrets", () => {
    expect(() => loadRoomConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(RoomConfigError);
    try {
      loadRoomConfig({ DATABASE_URL: base.DATABASE_URL });
    } catch (error) {
      expect(error).toBeInstanceOf(RoomConfigError);
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("rejects a malformed member list without echoing a planted value", () => {
    expect(() =>
      loadRoomConfig({
        ...base,
        ROOM_MEMBERS: JSON.stringify([{ bearerEnv: "ROOM_BEARER_CODEX", tenantId: tenant, principalId: claude.principal.id, kind: "SERVICE", note: secret }]),
      }),
    ).toThrow(RoomConfigError);
    try {
      loadRoomConfig({ ...base, ROOM_BEARER_CODEX: "too-short" });
    } catch (error) {
      expect(error).toBeInstanceOf(RoomConfigError);
      expect((error as RoomConfigError).code).toBe("ROOM_BEARER_CODEX_TOO_SHORT");
      expect(String(error)).not.toContain("too-short");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("refuses a database role other than the room login role", () => {
    expect(() => assertRoomDatabaseRole("agent_room_app")).not.toThrow();
    expect(() => assertRoomDatabaseRole("postgres")).toThrow(RoomConfigError);
    try {
      assertRoomDatabaseRole("postgres");
    } catch (error) {
      expect((error as RoomConfigError).code).toBe("DATABASE_ROLE_INVALID");
      expect(String(error)).not.toContain("postgres");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("loads members and keeps bearers out of the summary", () => {
    const config = loadRoomConfig(base);
    expect(config.origin).toBe("https://kj-room.example");
    expect(config.members).toHaveLength(1);
    expect(config.members[0]?.context.principal.id).toBe(claude.principal.id);
    expect(JSON.stringify(summariseRoomConfig(config))).not.toContain(bearer);
    expect(JSON.stringify(summariseRoomConfig(config))).not.toContain(secret);
  });
});

describe("room process", () => {
  let url = "";
  let close: () => Promise<void> = async () => {};
  let connects = 0;
  const pool = {
    connect() {
      connects += 1;
      return Promise.reject(new Error("room process has no ledger access"));
    },
    query() {
      connects += 1;
      return Promise.reject(new Error("room process has no ledger access"));
    },
  } as unknown as pg.Pool;

  beforeAll(async () => {
    let handler: ReturnType<typeof buildRoomHandler> = () => Promise.resolve();
    const server: Server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    url = `http://127.0.0.1:${address.port}`;
    const tokens: Record<string, TenantContext> = { claude, jonny };
    handler = buildRoomHandler({
      store: new InMemoryChannelStore(),
      registry,
      origin: url,
      taskStore: new ClosedTaskStore(pool),
      authenticate: async (headers) => {
        const who = tokens[(headers.authorization ?? "").replace("Bearer ", "")];
        if (!who) throw new Error("not signed in");
        return who;
      },
    });
    close = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  afterAll(async () => close());

  it("answers liveness without a credential and does not open the ledger", async () => {
    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const page = await fetch(url, { headers: { authorization: "Bearer jonny" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Shared room");
    expect((await fetch(`${url}/tasks/${randomUUID()}`, { headers: { authorization: "Bearer jonny" } })).status).toBe(404);
    expect((await fetch(`${url}/messages`)).status).toBe(401);
    expect(connects).toBe(0);
  });

  it("posts, catches up and acks through the room routes", async () => {
    const sent = await fetch(`${url}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer claude", "content-type": "application/json" },
      body: JSON.stringify({ kind: "NOTE", body: "hello from claude", idempotencyKey: "room-key-0001" }),
    });
    expect(sent.status).toBe(201);
    const again = await fetch(`${url}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer claude", "content-type": "application/json" },
      body: JSON.stringify({ kind: "NOTE", body: "hello from claude", idempotencyKey: "room-key-0001" }),
    });
    expect(again.status).toBe(200);
    const created = (await sent.json()) as { message: { id: string; seq: number } };
    const replay = (await again.json()) as { message: { id: string }; duplicate: boolean };
    expect(replay.duplicate).toBe(true);
    expect(replay.message.id).toBe(created.message.id);
    const seen = (await (await fetch(`${url}/messages?after=0`, { headers: { authorization: "Bearer jonny" } })).json()) as {
      messages: { id: string; body: string }[];
    };
    expect(seen.messages.map((message) => message.body)).toEqual(["hello from claude"]);
    const ack = await fetch(`${url}/acks`, {
      method: "POST",
      headers: { authorization: "Bearer jonny", "content-type": "application/json" },
      body: JSON.stringify({ upToSeq: created.message.seq }),
    });
    expect(ack.status).toBe(200);
    const page = await (await fetch(`${url}/channel`, { headers: { authorization: "Bearer jonny" } })).text();
    expect(page).toContain("acked");
    expect(page).toContain("hello from claude");
    expect(connects).toBe(0);
  });

  it("does not accept a bearer from the URL", async () => {
    const secret = "kjr1_browser-query-bearer-must-not-auth";
    const response = await fetch(`${url}/channel?bearer=${encodeURIComponent(secret)}`);
    const html = await response.text();
    expect(response.status).toBe(401);
    expect(html).not.toContain(secret);
    expect(html).not.toContain("bearer=");
  });
});
