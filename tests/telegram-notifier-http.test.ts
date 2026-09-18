import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { TelegramNotifier } from "../services/kernel/src/alerting/telegram-notifier.js";
import { runDeliveryWorker } from "../services/kernel/src/alerting/delivery-worker.js";
import { InMemoryNotificationOutboxStore } from "../services/kernel/src/alerting/outbox-store.js";
import type { NotificationIntent, DeliveryConfig } from "../services/kernel/src/alerting/outbox-types.js";

/**
 * KJ-P2.2 — a REAL local HTTP server (Node's own `http` module, loopback
 * only, never leaving the test process) exercising `TelegramNotifier`'s
 * actual `fetch` call, real JSON request/response parsing, and the full
 * outbox delivery pipeline end to end. No Docker, no external network, no
 * real Telegram bot token — `FAKE_TOKEN` below is an obviously-synthetic
 * value the local server discards immediately. Never calls the real
 * Telegram API; nothing here is gated, since it requires no external
 * infrastructure at all.
 *
 * `localFetch` rewrites the incoming request's origin to the local server
 * before delegating to the REAL global `fetch` — so this proves the
 * notifier's real HTTP/JSON path, not a hand-rolled Response mock.
 */

const FAKE_TOKEN = "999888777:AAFakeLocalOnlyTokenNeverReal00000";
type Responder = (req: IncomingMessage, body: string) => { status: number; body: unknown };

let server: Server;
let serverUrl: string;
let responders: Responder[] = [];
let seenPaths: string[] = [];
let seenAuthHeaders: (string | undefined)[] = [];

function localFetch(): typeof fetch {
  return (async (input, init) => {
    const original = new URL(String(input));
    seenPaths.push(original.pathname);
    const rewritten = new URL(original.pathname + original.search, serverUrl);
    return fetch(rewritten, init);
  }) as typeof fetch;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    seenAuthHeaders.push(req.headers["authorization"]);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const next = responders.shift() ?? (() => ({ status: 200, body: { ok: true } }));
      try {
        const result = next(req, body);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        // A responder assertion failing inside this handler must not cascade
        // into a client-side timeout — surface it as a real HTTP response so
        // the actual assertion failure is what the test reports.
        res.writeHead(599, { "content-type": "text/plain" });
        res.end(`responder threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind a port");
  serverUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  responders = [];
  seenPaths = [];
  seenAuthHeaders = [];
});

function mkIntent(suffix: string, createdAt: string): NotificationIntent {
  return {
    notificationId: `nid-${suffix}`,
    fingerprint: `fp-${suffix}`,
    checkId: `kj-p22-test.${suffix}`,
    entityId: "sched-1",
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
    kind: "NEW",
    occurrenceCount: 1,
    severity: "P1",
    message: `kj-p22-test.${suffix}: NEW (P1)`,
    durationMs: null,
    createdAt,
  };
}

describe("TelegramNotifier against a real local HTTP server", () => {
  it("sends a real HTTP request the local server actually receives and parses correctly", async () => {
    responders.push((_req, body) => {
      const parsed = JSON.parse(body) as { chat_id: string; text: string; parse_mode: string };
      expect(parsed.chat_id).toBe("-100999");
      expect(parsed.parse_mode).toBe("MarkdownV2");
      expect(parsed.text).toContain("kj\\-p22\\-test\\.real\\-http"); // hyphen and dot are both MarkdownV2-special
      return { status: 200, body: { ok: true, result: {} } };
    });
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, localFetch());
    const intent = mkIntent("real-http", "2026-09-18T10:00:00.000Z");
    await expect(
      notifier.notify({
        notificationId: intent.notificationId,
        fingerprint: intent.fingerprint,
        checkId: intent.checkId,
        entityId: intent.entityId,
        firstSeenAt: intent.firstSeenAt,
        lastSeenAt: intent.lastSeenAt,
        kind: intent.kind,
        occurrenceCount: intent.occurrenceCount,
        severity: intent.severity,
        message: intent.message,
        durationMs: intent.durationMs,
      }),
    ).resolves.toBeUndefined();
    expect(seenPaths[0]).toBe(`/bot${FAKE_TOKEN}/sendMessage`);
  });

  it("a real 401 response from the server correctly propagates as TelegramUnauthorizedError, not a generic failure", async () => {
    responders.push(() => ({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } }));
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, localFetch());
    const err = await notifier.notify(mkPayloadFromIntent(mkIntent("real-401", "2026-09-18T10:00:00.000Z"))).catch((e: unknown) => e);
    expect((err as Error).constructor.name).toBe("TelegramUnauthorizedError");
  });
});

describe("full outbox -> delivery-worker -> TelegramNotifier -> real local HTTP -> ACK pipeline", () => {
  const config: DeliveryConfig = { baseDelayMs: 50, maxDelayMs: 500, maxAttempts: 3, staleSendingMs: 60_000 };

  it("delivery worker ACKs (marks DELIVERED) only after the real transport call actually succeeds — a failed first attempt leaves the row PENDING/retryable, never falsely acknowledged", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const intent = mkIntent("ack-only-after-success", "2026-09-18T10:00:00.000Z");
    await outbox.enqueue([intent]);
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, localFetch());

    responders.push(() => ({ status: 500, body: { ok: false } })); // first attempt fails
    const first = await runDeliveryWorker({ outbox, notifier, transport: "telegram", config, now: () => new Date("2026-09-18T10:00:01.000Z") });
    expect(first).toMatchObject({ attempted: 1, delivered: 0, retried: 1 });
    expect((await outbox.getAll())[0]?.status).toBe("PENDING"); // never falsely ACKed

    responders.push(() => ({ status: 200, body: { ok: true, result: {} } })); // second attempt succeeds
    const second = await runDeliveryWorker({ outbox, notifier, transport: "telegram", config, now: () => new Date("2026-09-18T10:00:02.000Z") });
    expect(second).toMatchObject({ attempted: 1, delivered: 1 });
    expect((await outbox.getAll())[0]?.status).toBe("DELIVERED");
  });

  it("transient failures (5xx/429/timeout-shaped) remain retryable under the existing outbox policy, never a second independent retry loop", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const intent = mkIntent("transient-retry", "2026-09-18T10:00:00.000Z");
    await outbox.enqueue([intent]);
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, localFetch());

    responders.push(() => ({ status: 429, body: { ok: false, error_code: 429 } }));
    const attempt1 = await runDeliveryWorker({ outbox, notifier, transport: "telegram", config, now: () => new Date("2026-09-18T10:00:01.000Z") });
    expect(attempt1.retried).toBe(1);
    // Not due again immediately — the outbox's own backoff governs timing, not a second timer.
    const tooSoon = await runDeliveryWorker({ outbox, notifier, transport: "telegram", config, now: () => new Date("2026-09-18T10:00:01.010Z") });
    expect(tooSoon.attempted).toBe(0);
  });

  it("permanent failures (invalid chat) become POISON per the existing outbox semantics, not endless retry", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const intent = mkIntent("permanent-poison", "2026-09-18T10:00:00.000Z");
    await outbox.enqueue([intent]);
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, localFetch());
    responders.push(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } }));
    const result = await runDeliveryWorker({ outbox, notifier, transport: "telegram", config, now: () => new Date("2026-09-18T10:00:01.000Z") });
    expect(result.poisoned).toBe(1);
    expect((await outbox.getAll())[0]?.status).toBe("POISON");
  });

  it("no duplicate send: a delivered notification is never re-attempted by a later run", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const intent = mkIntent("no-duplicate", "2026-09-18T10:00:00.000Z");
    await outbox.enqueue([intent]);
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, localFetch());
    responders.push(() => ({ status: 200, body: { ok: true } }));
    await runDeliveryWorker({ outbox, notifier, transport: "telegram", config, now: () => new Date("2026-09-18T10:00:01.000Z") });
    const rerun = await runDeliveryWorker({ outbox, notifier, transport: "telegram", config, now: () => new Date("2026-09-18T10:05:00.000Z") });
    expect(rerun.attempted).toBe(0);
  });
});

function mkPayloadFromIntent(intent: NotificationIntent) {
  return {
    notificationId: intent.notificationId,
    fingerprint: intent.fingerprint,
    checkId: intent.checkId,
    entityId: intent.entityId,
    firstSeenAt: intent.firstSeenAt,
    lastSeenAt: intent.lastSeenAt,
    kind: intent.kind,
    occurrenceCount: intent.occurrenceCount,
    severity: intent.severity,
    message: intent.message,
    durationMs: intent.durationMs,
  };
}
