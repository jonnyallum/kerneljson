import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ChannelService,
  InMemoryChannelStore,
  WebhookWakeNotifier,
  wakeHandles,
  type AgentRegistry,
  type WakeTarget,
} from "../packages/agent-channel/src/index.js";
import { loadWakeTargets, RoomConfigError } from "../apps/mission-control/src/room-main.js";
import type { TenantContext } from "../packages/contracts/src/index.js";

const KEY = "wake-key-value-0123456789-abcdefghij";
const grok: WakeTarget = { handle: "grok", url: "https://wake.example/hook", key: KEY };
const tenant = randomUUID();
const claude: TenantContext = { tenantId: tenant, principal: { id: randomUUID(), kind: "SERVICE" } };
const registry: AgentRegistry = {
  handleFor: async (c) => (c.principal.id === claude.principal.id ? "claude-code" : null),
  members: async () => [{ principalId: claude.principal.id, handle: "claude-code" }],
};
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("wake mention matching", () => {
  it("matches @handle, @all and @agents, not look-alikes, and never the author", () => {
    expect(wakeHandles("hello @grok", "claude-code", [grok])).toHaveLength(1);
    expect(wakeHandles("@all please read", "claude-code", [grok])).toHaveLength(1);
    expect(wakeHandles("@agents please read", "claude-code", [grok])).toHaveLength(1);
    expect(wakeHandles("hello @grokbot", "claude-code", [grok])).toHaveLength(0);
    expect(wakeHandles("mail a@grok.example", "claude-code", [grok])).toHaveLength(0);
    expect(wakeHandles("no mention", "claude-code", [grok])).toHaveLength(0);
    expect(wakeHandles("@grok note to self", "grok", [grok])).toHaveLength(0);
  });
});

describe("webhook wake notifier", () => {
  it("posts a body-free ping with the key header, once per message", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const log = vi.fn();
    const service = new ChannelService(
      new InMemoryChannelStore(),
      registry,
      new WebhookWakeNotifier([grok], fetchImpl as never, log),
    );
    const body = "@grok secret-looking text should never be sent";
    const key = `k-${randomUUID()}`;
    await service.post(claude, { kind: "NOTE", body, idempotencyKey: key });
    await service.post(claude, { kind: "NOTE", body, idempotencyKey: key });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(grok.url);
    expect((init.headers as Record<string, string>)["x-room-wake-key"]).toBe(KEY);
    const sent = JSON.parse(String(init.body));
    expect(Object.keys(sent).sort()).toEqual(["handle", "id", "kind", "seq", "threadId"]);
    expect(String(init.body)).not.toContain("secret-looking");
    expect(init.redirect).toBe("error");
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it("a failing endpoint never blocks or fails the post", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const log = vi.fn();
    const service = new ChannelService(
      new InMemoryChannelStore(),
      registry,
      new WebhookWakeNotifier([grok], fetchImpl as never, log),
    );
    const res = await service.post(claude, { kind: "NOTE", body: "@grok hi", idempotencyKey: `k-${randomUUID()}` });
    await flush();
    expect(res.message.seq).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("refuses a non-https target", () => {
    expect(() => new WebhookWakeNotifier([{ ...grok, url: "http://wake.example/hook" }])).toThrow("WAKE_URL_NOT_HTTPS");
  });
});

describe("wake target config", () => {
  const env = {
    ROOM_WAKE_TARGETS: JSON.stringify([
      { handle: "grok", urlEnv: "KJ_ROOM_WAKE_GROK_URL", keyEnv: "KJ_ROOM_WAKE_GROK_KEY" },
    ]),
    KJ_ROOM_WAKE_GROK_URL: "https://wake.example/hook",
    KJ_ROOM_WAKE_GROK_KEY: KEY,
  };
  it("is off when unset and loads a complete target", () => {
    expect(loadWakeTargets({}).targets).toEqual([]);
    expect(loadWakeTargets(env).targets).toHaveLength(1);
  });
  it("skips an incomplete, short-key or non-https target without failing", () => {
    expect(loadWakeTargets({ ROOM_WAKE_TARGETS: env.ROOM_WAKE_TARGETS }).skipped).toEqual(["grok"]);
    expect(loadWakeTargets({ ...env, KJ_ROOM_WAKE_GROK_KEY: "short" }).skipped).toEqual(["grok"]);
    expect(loadWakeTargets({ ...env, KJ_ROOM_WAKE_GROK_URL: "http://x.example" }).skipped).toEqual(["grok"]);
  });
  it("rejects a malformed list without echoing it", () => {
    expect(() => loadWakeTargets({ ROOM_WAKE_TARGETS: "not json PLANTED" })).toThrow(RoomConfigError);
    try {
      loadWakeTargets({ ROOM_WAKE_TARGETS: "not json PLANTED" });
    } catch (e) {
      expect(String(e)).not.toContain("PLANTED");
    }
  });
});
