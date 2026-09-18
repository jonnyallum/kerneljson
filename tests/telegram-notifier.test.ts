import { describe, it, expect, vi } from "vitest";
import {
  TelegramNotifier,
  TelegramUnauthorizedError,
  TelegramForbiddenError,
  TelegramBadRequestError,
  TelegramRateLimitedError,
  TelegramServerError,
  TelegramTimeoutError,
  TelegramNetworkError,
  TelegramUnexpectedStatusError,
  classifyTelegramOutcome,
} from "../services/kernel/src/alerting/telegram-notifier.js";
import { escapeTelegramMarkdownV2, formatTelegramMessage } from "../services/kernel/src/alerting/format.js";
import { PermanentDeliveryError } from "../services/kernel/src/alerting/outbox-types.js";
import type { NotificationPayload } from "../services/kernel/src/alerting/outbox-types.js";

/**
 * KJ-P2.2 deterministic tests — entirely synthetic, no Docker, no Postgres,
 * no Restate, and (per the fake `fetchImpl` used throughout) no real
 * network call and no real Telegram bot token. Mirrors the rest of this
 * module's split: `classifyTelegramOutcome`/`escapeTelegramMarkdownV2`/
 * `formatTelegramMessage` are pure and tested directly; `TelegramNotifier`
 * is tested with an injected fake `fetch`.
 */

const FAKE_TOKEN = "123456789:AAFakeTokenForTestsOnlyNeverReal000";

function mkPayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    notificationId: "0483a8e626b28b2c586cf2be049c3f32",
    fingerprint: "fp-a",
    checkId: "authority.bindingReleaseConsistent",
    entityId: "sched-1",
    firstSeenAt: "2026-09-17T21:46:35.000Z",
    lastSeenAt: "2026-09-17T21:46:35.988Z",
    kind: "NEW",
    occurrenceCount: 1,
    severity: "P1",
    message: "authority.bindingReleaseConsistent: NEW (P1)",
    durationMs: null,
    ...overrides,
  };
}

function fakeFetch(
  handler: (url: string, init: RequestInit) => { status: number; body?: unknown } | Promise<never>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const result = await handler(url, init ?? {});
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
    });
  }) as typeof fetch;
}

describe("escapeTelegramMarkdownV2", () => {
  it("escapes every MarkdownV2 special character", () => {
    const specials = "_*[]()~`>#+-=|{}.!\\";
    const escaped = escapeTelegramMarkdownV2(specials);
    for (const ch of specials) expect(escaped).toContain(`\\${ch}`);
  });

  it("leaves plain text untouched", () => {
    expect(escapeTelegramMarkdownV2("hello world 123")).toBe("hello world 123");
  });

  it("a real check id (containing a dot) round-trips safely", () => {
    expect(escapeTelegramMarkdownV2("authority.bindingReleaseConsistent")).toBe(
      "authority\\.bindingReleaseConsistent",
    );
  });

  it("a synthetic message (containing parens) round-trips safely", () => {
    expect(escapeTelegramMarkdownV2("authority.bindingReleaseConsistent: NEW (P1)")).toBe(
      "authority\\.bindingReleaseConsistent: NEW \\(P1\\)",
    );
  });
});

describe("formatTelegramMessage", () => {
  it("includes severity, kind, check id, message, occurrence count, timestamp and a shortened notification id", () => {
    const text = formatTelegramMessage(mkPayload());
    expect(text).toContain("P1");
    expect(text).toContain("NEW");
    expect(text).toContain("authority\\.bindingReleaseConsistent");
    expect(text).toContain("Occurrences: 1");
    expect(text).toContain("2026\\-09\\-17T21:46:35\\.988Z");
    expect(text).toContain("0483a8e6"); // first 8 chars of notificationId
    expect(text).not.toContain("0483a8e626b28b2c586cf2be049c3f32"); // full id not leaked, only the short form
  });

  it("includes duration only for RECOVERED", () => {
    const recovered = formatTelegramMessage(mkPayload({ kind: "RECOVERED", durationMs: 9 * 60_000 + 14_000 }));
    expect(recovered).toContain("Duration:");
    const fresh = formatTelegramMessage(mkPayload({ kind: "NEW", durationMs: null }));
    expect(fresh).not.toContain("Duration:");
  });

  it("never includes the entityId, fingerprint, or any field outside the required list", () => {
    const p = mkPayload({ entityId: "should-not-appear-verbatim", fingerprint: "should-not-appear-either" });
    const text = formatTelegramMessage(p);
    expect(text).not.toContain("should-not-appear-verbatim");
    expect(text).not.toContain("should-not-appear-either");
  });

  it("is deterministic — the same payload always produces the same message (stable identity for correlation)", () => {
    const p = mkPayload();
    expect(formatTelegramMessage(p)).toBe(formatTelegramMessage(p));
  });

  it("a check id or message containing every MarkdownV2 special character never breaks formatting (escaped, not stripped)", () => {
    const hostile = mkPayload({
      checkId: "weird.check_*[]()~`>#+-=|{}.!\\id",
      message: "weird.check_*[]()~`>#+-=|{}.!\\message",
    });
    const text = formatTelegramMessage(hostile);
    // Every literal special character from the hostile input appears
    // preceded by a backslash in the output — nothing was silently dropped.
    for (const ch of "_*[]()~`>#+-=|{}.!") {
      const raw = ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(text).toMatch(new RegExp(`\\\\${raw}`));
    }
  });
});

describe("classifyTelegramOutcome (pure)", () => {
  it("a 2xx with a genuine {ok:true} body is delivered (null = no error)", () => {
    expect(classifyTelegramOutcome(200, true)).toBeNull();
  });
  it("401 -> permanent, TelegramUnauthorizedError", () => {
    const err = classifyTelegramOutcome(401, false);
    expect(err).toBeInstanceOf(TelegramUnauthorizedError);
    expect(err).toBeInstanceOf(PermanentDeliveryError);
  });
  it("403 -> permanent, TelegramForbiddenError", () => {
    expect(classifyTelegramOutcome(403, false)).toBeInstanceOf(TelegramForbiddenError);
    expect(classifyTelegramOutcome(403, false)).toBeInstanceOf(PermanentDeliveryError);
  });
  it("400 -> permanent, TelegramBadRequestError (covers both malformed payload and unknown chat)", () => {
    expect(classifyTelegramOutcome(400, false)).toBeInstanceOf(TelegramBadRequestError);
    expect(classifyTelegramOutcome(400, false)).toBeInstanceOf(PermanentDeliveryError);
  });
  it("429 -> transient, TelegramRateLimitedError, NOT a PermanentDeliveryError", () => {
    const err = classifyTelegramOutcome(429, false);
    expect(err).toBeInstanceOf(TelegramRateLimitedError);
    expect(err).not.toBeInstanceOf(PermanentDeliveryError);
  });
  it("5xx -> transient, TelegramServerError", () => {
    expect(classifyTelegramOutcome(500, false)).toBeInstanceOf(TelegramServerError);
    expect(classifyTelegramOutcome(503, false)).toBeInstanceOf(TelegramServerError);
    expect(classifyTelegramOutcome(500, false)).not.toBeInstanceOf(PermanentDeliveryError);
  });
  it("a 2xx with an unparseable or ok:false body is treated as unverified, not silently successful", () => {
    expect(classifyTelegramOutcome(200, null)).toBeInstanceOf(TelegramUnexpectedStatusError);
    expect(classifyTelegramOutcome(200, false)).toBeInstanceOf(TelegramUnexpectedStatusError);
  });
  it("any other status falls to TelegramUnexpectedStatusError, never silently dropped", () => {
    expect(classifyTelegramOutcome(418, false)).toBeInstanceOf(TelegramUnexpectedStatusError);
  });
});

describe("TelegramNotifier (fake fetch, no real network, no real bot token)", () => {
  it("successful delivery: sends chat_id/text/parse_mode, resolves without throwing", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetchImpl = fakeFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body));
      return { status: 200, body: { ok: true, result: {} } };
    });
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, fetchImpl);
    await expect(notifier.notify(mkPayload())).resolves.toBeUndefined();
    expect(capturedUrl).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    expect(capturedBody).toMatchObject({ chat_id: "-100999", parse_mode: "MarkdownV2" });
  });

  it("timeout: the notifier's own AbortSignal firing classifies as TelegramTimeoutError", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "TimeoutError";
          reject(err);
        });
      });
    };
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999", timeoutMs: 20 }, fetchImpl);
    await expect(notifier.notify(mkPayload())).rejects.toBeInstanceOf(TelegramTimeoutError);
  });

  it("network failure: a generic thrown error classifies as TelegramNetworkError, not timeout", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    };
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, fetchImpl);
    await expect(notifier.notify(mkPayload())).rejects.toBeInstanceOf(TelegramNetworkError);
  });

  it("HTTP 429 classifies as TelegramRateLimitedError (transient)", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests" } }));
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, fetchImpl);
    await expect(notifier.notify(mkPayload())).rejects.toBeInstanceOf(TelegramRateLimitedError);
  });

  it("HTTP 500 classifies as TelegramServerError (transient)", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 500, body: { ok: false } }));
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, fetchImpl);
    await expect(notifier.notify(mkPayload())).rejects.toBeInstanceOf(TelegramServerError);
  });

  it("invalid credentials (HTTP 401) classifies as TelegramUnauthorizedError (permanent)", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } }));
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, fetchImpl);
    const err = await notifier.notify(mkPayload()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramUnauthorizedError);
    expect(err).toBeInstanceOf(PermanentDeliveryError);
  });

  it("invalid/nonexistent chat (HTTP 400) classifies as TelegramBadRequestError (permanent)", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } }));
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, fetchImpl);
    await expect(notifier.notify(mkPayload())).rejects.toBeInstanceOf(TelegramBadRequestError);
  });

  it("malformed request (HTTP 400, different description) classifies the same way — permanent, no retry storm", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message text is empty" } }));
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, fetchImpl);
    await expect(notifier.notify(mkPayload())).rejects.toBeInstanceOf(TelegramBadRequestError);
  });

  it("makes exactly one HTTP attempt per notify() call — no internal retry loop", async () => {
    const calls = vi.fn();
    const fetchImpl = fakeFetch(() => {
      calls();
      return { status: 500, body: { ok: false } };
    });
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, fetchImpl);
    await notifier.notify(mkPayload()).catch(() => {});
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe("secret redaction (adversarial)", () => {
  it("the bot token never appears in any thrown error's message across every failure path", async () => {
    const scenarios: Array<() => typeof fetch> = [
      () => fakeFetch(() => ({ status: 401, body: { ok: false } })),
      () => fakeFetch(() => ({ status: 403, body: { ok: false } })),
      () => fakeFetch(() => ({ status: 400, body: { ok: false } })),
      () => fakeFetch(() => ({ status: 429, body: { ok: false } })),
      () => fakeFetch(() => ({ status: 500, body: { ok: false } })),
      () => (async () => { throw new TypeError(`fetch failed for https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`); }) as typeof fetch,
    ];
    for (const makeFetch of scenarios) {
      const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, makeFetch());
      const err = await notifier.notify(mkPayload()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(FAKE_TOKEN);
      expect(String(err)).not.toContain(FAKE_TOKEN);
    }
  });

  it("the bot token never appears in the URL a console.log/console.error call could see, because the notifier never logs at all", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetchImpl = fakeFetch(() => ({ status: 200, body: { ok: true } }));
      const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, fetchImpl);
      await notifier.notify(mkPayload());
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("a hostile fetch that echoes the full request URL (including the token) into its own thrown error is still redacted at the notifier boundary", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      throw new Error(`connection refused: ${String(input)}`);
    };
    const notifier = new TelegramNotifier({ botToken: FAKE_TOKEN, chatId: "-100999" }, fetchImpl);
    const err = await notifier.notify(mkPayload()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramNetworkError);
    expect((err as Error).message).not.toContain(FAKE_TOKEN);
  });
});
