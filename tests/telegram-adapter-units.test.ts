import { describe, expect, it } from "vitest";
import {
  HttpDoorClient,
  idempotencyKeyFor,
  traceIdFor,
} from "../services/kernel/src/channel/telegram/door-client.js";
import { loadOperatorConfig } from "../services/kernel/src/channel/telegram/operator-config.js";
import {
  HttpUpdateSource,
  TelegramPollConflictError,
  TelegramPollMalformedError,
  TelegramPollTransientError,
  TelegramPollUnauthorizedError,
  classifyUpdate,
} from "../services/kernel/src/channel/telegram/updates.js";
import { CHAT, msg } from "./support/telegram-fixture.js";

const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BEARER = "SYNTHETIC-DOOR-BEARER-0123456789-abcdef-xyz";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("KJ-P4A classification of an update", () => {
  it("accepts only a fresh text message from the allow-listed private chat", () => {
    expect(classifyUpdate(msg(1, "/status"), CHAT)).toEqual({ kind: "COMMAND", text: "/status", date: expect.any(Number) });
    expect(classifyUpdate(msg(1, "/status", { chatId: 1, fromId: 1 }), CHAT)).toEqual({ kind: "UNAUTHORISED" });
    expect(classifyUpdate(msg(1, "/status", { chatType: "channel" }), CHAT)).toEqual({ kind: "UNAUTHORISED" });
    expect(classifyUpdate(msg(1, undefined), CHAT)).toEqual({ kind: "IGNORED" });
    expect(classifyUpdate({ update_id: 1 }, CHAT)).toEqual({ kind: "IGNORED" });
    expect(classifyUpdate({ update_id: 1, message: "not an object" }, CHAT)).toEqual({ kind: "IGNORED" });
  });

  it("compares as strings, so a chat id that merely resembles the allow-listed one does not pass", () => {
    expect(classifyUpdate(msg(1, "/status", { chatId: Number(CHAT) + 1, fromId: Number(CHAT) + 1 }), CHAT).kind).toBe("UNAUTHORISED");
    expect(classifyUpdate(msg(1, "/status", { chatId: -Number(CHAT), fromId: -Number(CHAT) }), CHAT).kind).toBe("UNAUTHORISED");
  });
});

describe("KJ-P4A long-poll client", () => {
  const ok = (result: unknown[]) => json({ ok: true, result });

  it("asks for messages only, from the persisted offset, with the token only in the URL", async () => {
    const calls: Array<{ url: string; body: unknown; method: string }> = [];
    const source = new HttpUpdateSource({ botToken: TOKEN }, (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), method: String(init.method) });
      return ok([{ update_id: 10, message: { text: "x" } }, { nope: true }, { update_id: 11 }]);
    }) as unknown as typeof fetch);
    const updates = await source.getUpdates(10, 20);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ offset: 10, timeout: 20, limit: 100, allowed_updates: ["message"] });
    // An element with no usable update_id cannot be acknowledged, so it is dropped.
    expect(updates.map((u) => u.update_id)).toEqual([10, 11]);
  });

  it("classifies failures by status, as terminal or retryable, and never puts the token in an error", async () => {
    const cases: Array<[string, () => Promise<Response>, new () => Error]> = [
      ["401", async () => json({ ok: false }, 401), TelegramPollUnauthorizedError],
      ["409 (a webhook or a second poller)", async () => json({ ok: false }, 409), TelegramPollConflictError],
      ["429", async () => json({ ok: false }, 429), TelegramPollTransientError],
      ["500", async () => json({ ok: false }, 500), TelegramPollTransientError],
      ["400", async () => json({ ok: false }, 400), TelegramPollMalformedError],
      ["not json", async () => new Response("<html>", { status: 200 }), TelegramPollMalformedError],
      ["ok:false", async () => json({ ok: false, result: [] }), TelegramPollMalformedError],
      ["result not an array", async () => json({ ok: true, result: {} }), TelegramPollMalformedError],
      ["network", async () => { throw new Error(`connect ECONNRESET https://api.telegram.org/bot${TOKEN}/getUpdates`); }, TelegramPollTransientError],
    ];
    for (const [label, respond, expected] of cases) {
      const source = new HttpUpdateSource({ botToken: TOKEN }, respond as unknown as typeof fetch);
      const error = await source.getUpdates(0, 1).then(() => null, (e: unknown) => e as Error);
      expect(error, label).toBeInstanceOf(expected);
      expect(String(error?.message) + String(error?.stack), label).not.toContain(TOKEN);
    }
  });
});

describe("KJ-P4A door client", () => {
  const admitting = (status: number, body?: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return body === undefined ? new Response(null, { status }) : json(body, status);
    }) as unknown as typeof fetch;
    return { calls, client: new HttpDoorClient("http://door:8081/", `Bearer ${BEARER}`, fetchImpl) };
  };

  it("sends the update-derived key, the channel and a deterministic trace, and the bearer only as a header", async () => {
    const { calls, client } = admitting(202, { taskId: "d10442d5-f208-859d-af74-c4d16a9d379f" });
    const r = await client.admitMission({ updateId: 4242, recipe: "repo-analysis-mission/v1", objective: "o/r findings=3 q" });
    expect(r).toEqual({ ok: true, taskId: "d10442d5-f208-859d-af74-c4d16a9d379f" });
    const { url, init } = calls[0]!;
    expect(url).toBe("http://door:8081/v1/tasks");
    const h = init.headers as Record<string, string>;
    expect(h["authorization"]).toBe(`Bearer ${BEARER}`);
    expect(h["idempotency-key"]).toBe("tg:upd:4242");
    expect(h["x-kj-channel"]).toBe("telegram/v1");
    expect(h["x-correlation-id"]).toBe(traceIdFor(4242));
    expect(JSON.parse(String(init.body))).toEqual({ recipe: "repo-analysis-mission/v1", objective: "o/r findings=3 q" });
    expect(init.redirect).toBe("error");
    expect(JSON.stringify(r)).not.toContain(BEARER);
  });

  it("derives a stable, valid trace id per update, and a different one for each update", () => {
    expect(traceIdFor(1)).toBe(traceIdFor(1));
    expect(traceIdFor(1)).not.toBe(traceIdFor(2));
    expect(traceIdFor(1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idempotencyKeyFor(1)).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });

  it("classifies the door's answers without reading an error body", async () => {
    const outcomes: Array<[number, unknown]> = [[409, "CONFLICT"], [400, "REJECTED"], [401, "REJECTED"], [403, "REJECTED"], [429, "UNAVAILABLE"], [500, "UNAVAILABLE"], [503, "UNAVAILABLE"]];
    for (const [status, reason] of outcomes) {
      const { client } = admitting(status, { error: `boom ${BEARER}` });
      expect(await client.admitMission({ updateId: 1, recipe: "r", objective: "o" }), String(status)).toEqual({ ok: false, reason });
    }
    // 202 with an unusable body is not a task id we can vouch for.
    expect(await admitting(202, { taskId: "not-a-uuid" }).client.admitMission({ updateId: 1, recipe: "r", objective: "o" })).toEqual({ ok: false, reason: "UNAVAILABLE" });
    const down = new HttpDoorClient("http://door:8081", `Bearer ${BEARER}`, (async () => { throw new Error(`ECONNREFUSED ${BEARER}`); }) as unknown as typeof fetch);
    const r = await down.admitMission({ updateId: 1, recipe: "r", objective: "o" });
    expect(r).toEqual({ ok: false, reason: "UNAVAILABLE" });
  });

  it("reads a task through the door's GET routes only, and reports not-found and errors distinctly", async () => {
    const id = "d10442d5-f208-859d-af74-c4d16a9d379f";
    const seen: string[] = [];
    const respond = (map: Record<string, Response>) => (async (url: string, init: RequestInit) => {
      seen.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
      return map[new URL(url).pathname] ?? new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const good = new HttpDoorClient("http://door:8081", `Bearer ${BEARER}`, respond({
      [`/v1/tasks/${id}`]: json({ taskId: id, status: "COMPLETED" }),
      [`/v1/tasks/${id}/evidence`]: json([]),
    }));
    expect(await good.readTask(id)).toEqual({ found: true, status: { taskId: id, status: "COMPLETED" }, evidence: [] });
    expect(seen).toEqual([`GET /v1/tasks/${id}`, `GET /v1/tasks/${id}/evidence`]);
    const missing = new HttpDoorClient("http://door:8081", `Bearer ${BEARER}`, respond({ [`/v1/tasks/${id}`]: new Response(null, { status: 404 }) }));
    expect(await missing.readTask(id)).toEqual({ found: false });
    const broken = new HttpDoorClient("http://door:8081", `Bearer ${BEARER}`, respond({}));
    expect(await broken.readTask(id)).toEqual({ found: "ERROR" });
  });
});

describe("KJ-P4A operator configuration (fail closed)", () => {
  const base = {
    TELEGRAM_INBOUND_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHAT_ID: CHAT,
    KJ_ADMISSION_URL: "http://door:8081",
    KJ_ADMISSION_BEARER: BEARER,
    DATABASE_URL: "postgresql://user:pw@127.0.0.1:1/db",
    ALERT_TRANSPORT: "telegram",
  } as Record<string, string>;

  it("serves no inbound channel unless explicitly enabled, exactly as the worker did before", () => {
    expect(loadOperatorConfig({})).toBeUndefined();
    for (const off of [undefined, "", "false"]) {
      expect(loadOperatorConfig({ ...base, TELEGRAM_INBOUND_ENABLED: off as string })).toBeUndefined();
    }
  });

  it("builds a config with the safe defaults when enabled", () => {
    const c = loadOperatorConfig(base)!;
    expect(c.limits).toEqual({ chatId: CHAT, dailyMissionCap: 5, ratePerMinute: 10, pollTimeoutSec: 20 });
    expect(c.authorization).toBe(`Bearer ${BEARER}`);
    expect(c.admissionUrl).toBe("http://door:8081");
  });

  it("refuses an ambiguous switch rather than guessing", () => {
    for (const bad of ["yes", "TRUE", "1", "on", " true"]) {
      expect(() => loadOperatorConfig({ ...base, TELEGRAM_INBOUND_ENABLED: bad }), bad).toThrow(/exactly "true" or "false"/);
    }
  });

  it("refuses to start half-configured, naming the variable and never printing a value", () => {
    for (const drop of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "KJ_ADMISSION_URL", "KJ_ADMISSION_BEARER", "DATABASE_URL"]) {
      const env = { ...base };
      delete env[drop];
      let message = "";
      try { loadOperatorConfig(env); } catch (e) { message = (e as Error).message; }
      expect(message, drop).toContain(drop);
      expect(message).toMatch(/refusing to start half-configured/);
      for (const secret of [TOKEN, BEARER, base["DATABASE_URL"]!]) expect(message).not.toContain(secret);
    }
  });

  it("requires the Telegram transport, so replies reach the chat and not the console", () => {
    for (const transport of ["console", "", undefined]) {
      expect(() => loadOperatorConfig({ ...base, ALERT_TRANSPORT: transport as string })).toThrow(/ALERT_TRANSPORT=telegram/);
    }
  });

  it("answers exactly one person: a group or malformed chat id is refused", () => {
    for (const chat of ["-1001234567890", "-5", "abc", "12.5", "1".repeat(21)]) {
      expect(() => loadOperatorConfig({ ...base, TELEGRAM_CHAT_ID: chat }), chat).toThrow(/positive private-chat id/);
    }
  });

  it("takes a whole-number daily cap from 1 to 100", () => {
    expect(loadOperatorConfig({ ...base, TELEGRAM_MISSION_DAILY_CAP: "3" })!.limits.dailyMissionCap).toBe(3);
    expect(loadOperatorConfig({ ...base, TELEGRAM_MISSION_DAILY_CAP: "100" })!.limits.dailyMissionCap).toBe(100);
    expect(loadOperatorConfig({ ...base, TELEGRAM_MISSION_DAILY_CAP: "" })!.limits.dailyMissionCap).toBe(5);
    for (const bad of ["0", "101", "abc", "2.5", "-1", "1e2", " 3", "0003x"]) {
      expect(() => loadOperatorConfig({ ...base, TELEGRAM_MISSION_DAILY_CAP: bad }), bad).toThrow(/whole number from 1 to 100/);
    }
  });
});
