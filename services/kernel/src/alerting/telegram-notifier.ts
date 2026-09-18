import { PermanentDeliveryError } from "./outbox-types.js";
import type { Notifier, NotificationPayload } from "./outbox-types.js";
import { formatTelegramMessage } from "./format.js";

/**
 * KJ-P2.2 — the first real external `Notifier`. Implements the exact
 * abstraction `delivery-worker.ts` already calls (`notify(payload): Promise<void>`)
 * — nothing about the outbox, the delivery worker, the retry/backoff model,
 * or the alert engine changes for this to exist. Makes exactly ONE HTTP
 * attempt per `notify()` call and either resolves or throws; it has no
 * internal retry loop or sleep of its own — all retry timing belongs to the
 * outbox (`outbox.ts`'s `decideNextOutboxState`/`computeBackoffMs`), never
 * duplicated here.
 *
 * SECRET HANDLING (read before touching this file): `botToken` lives only in
 * a private field, and is embedded ONLY in the URL handed directly to
 * `fetchImpl` — Telegram's Bot API has no header-based auth for
 * `sendMessage`, so the token-in-URL shape is unavoidable, not a choice made
 * here. Every `catch` below constructs a NEW, curated error from a small
 * fixed set of classes (below) — it never logs, rethrows, or inspects the
 * caught value's own `.message`/stack, because a library's own error text is
 * exactly where a token-bearing URL could otherwise leak (see the global
 * CLAUDE.md's secret-handling incidents — this is the same class of bug,
 * defended against structurally rather than by discipline alone). Nothing in
 * this file ever calls `console.log`/`console.error`/`JSON.stringify` on a
 * response body, a caught error, or the request itself.
 */
export interface TelegramNotifierConfig {
  botToken: string;
  chatId: string;
  /** Request timeout in ms — strict and bounded, since this notifier never
   *  retries internally; a hang here would otherwise hold the delivery
   *  worker's whole tick hostage. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const TELEGRAM_API_BASE = "https://api.telegram.org";

interface TelegramApiResponse {
  ok?: boolean;
}

// One subclass per classification — delivery-worker.ts's `classifyError`
// records `err.constructor.name` (never `.message`) into
// `notification_outbox.last_error` / `notification_delivery_events.error_class`,
// so distinct classes are what make each failure mode operationally
// distinguishable, without touching that already-qualified code at all.
// The permanent ones extend `PermanentDeliveryError` (KJ-P2.1's existing
// hook — see outbox-types.ts) so `attemptDelivery` classifies them
// `permanent: true` and they skip straight to POISON; the transient ones
// extend plain `Error` and are retried with the outbox's own bounded backoff.

/** Bot token rejected outright (HTTP 401) — retrying the identical token
 *  never succeeds. Operational/config failure: rotate the token. */
export class TelegramUnauthorizedError extends PermanentDeliveryError {
  constructor() {
    super("Telegram bot token was rejected (401)");
  }
}

/** Bot blocked/kicked from the chat, or otherwise forbidden (HTTP 403). */
export class TelegramForbiddenError extends PermanentDeliveryError {
  constructor() {
    super("Telegram request was forbidden (403)");
  }
}

/** Malformed request or an unknown/invalid chat id (HTTP 400 — Telegram
 *  uses this single status for both "chat not found" and a genuinely
 *  malformed payload; either way, retrying the identical request never
 *  succeeds, so both are permanent). */
export class TelegramBadRequestError extends PermanentDeliveryError {
  constructor() {
    super("Telegram rejected the request as malformed or the chat was not found (400)");
  }
}

/** HTTP 429 — rate limited. Transient by nature: the SAME request will
 *  likely succeed once the limit window passes. Telegram exposes a
 *  `retry_after` hint in its response body; this notifier does not act on
 *  it directly (see the header) — the outbox's own bounded backoff is the
 *  single source of retry timing, never a second one layered on top. */
export class TelegramRateLimitedError extends Error {
  constructor() {
    super("Telegram rate-limited the request (429)");
  }
}

/** HTTP 5xx — Telegram's own outage/error. Transient. */
export class TelegramServerError extends Error {
  constructor() {
    super("Telegram returned a server error (5xx)");
  }
}

/** The request timed out (this notifier's own `AbortSignal.timeout`) before
 *  Telegram responded at all. Transient — indistinguishable from a slow
 *  network from this notifier's point of view. */
export class TelegramTimeoutError extends Error {
  constructor() {
    super("Telegram request timed out");
  }
}

/** `fetch` itself threw for a reason other than our own timeout (DNS
 *  failure, connection refused, TLS error, etc). Transient. */
export class TelegramNetworkError extends Error {
  constructor() {
    super("Telegram request failed at the network layer");
  }
}

/** Any HTTP status this notifier doesn't have an explicit rule for, or a
 *  2xx response whose body wasn't the expected `{"ok":true}` shape (Telegram
 *  always returns valid JSON on success; an unparseable or `ok`-less 2xx
 *  body is treated as an unverified, not-yet-confirmed delivery — fails
 *  closed toward "retry", never silently assumed delivered). Transient,
 *  bounded like everything else by the outbox's own `maxAttempts`. */
export class TelegramUnexpectedStatusError extends Error {
  constructor() {
    super("Telegram returned an unexpected response");
  }
}

/**
 * PURE classification: given the HTTP status and whether the parsed
 * response body was genuinely `{"ok":true}` (`null` when the body wasn't
 * valid JSON, or had no `ok` field at all), return the error to throw, or
 * `null` for a confirmed successful delivery. No I/O, no secret material —
 * directly unit-testable against every status/body combination without a
 * real or fake HTTP call.
 */
export function classifyTelegramOutcome(status: number, bodyOk: boolean | null): Error | null {
  if (status >= 200 && status < 300 && bodyOk === true) return null;
  if (status === 401) return new TelegramUnauthorizedError();
  if (status === 403) return new TelegramForbiddenError();
  if (status === 400) return new TelegramBadRequestError();
  if (status === 429) return new TelegramRateLimitedError();
  if (status >= 500) return new TelegramServerError();
  return new TelegramUnexpectedStatusError();
}

export class TelegramNotifier implements Notifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TelegramNotifierConfig, fetchImpl: typeof fetch = fetch) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl;
  }

  async notify(payload: NotificationPayload): Promise<void> {
    const text = formatTelegramMessage(payload);
    // Token lives only in this freshly-constructed URL, held in a local
    // const never assigned anywhere durable (no field, no log call ever
    // touches this variable).
    const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: "MarkdownV2" }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Never inspect/forward `err` itself (see the class header) — some
      // fetch implementations embed the request URL in a thrown error's
      // message or cause chain. Classify by TYPE only.
      if (err instanceof Error && err.name === "TimeoutError") throw new TelegramTimeoutError();
      throw new TelegramNetworkError();
    }
    let bodyOk: boolean | null;
    try {
      const parsed = (await response.json()) as TelegramApiResponse;
      bodyOk = parsed.ok === true;
    } catch {
      bodyOk = null;
    }
    const err = classifyTelegramOutcome(response.status, bodyOk);
    if (err) throw err;
  }
}
