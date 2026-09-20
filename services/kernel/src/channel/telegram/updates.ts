import { z } from "zod";

/**
 * KJ-P4A - Telegram inbound: the update shape, who may command KernelJSON, and the long-poll client.
 *
 * Authentication is a fixed allow-list of ONE: the configured private chat. In a private chat the
 * chat id and the sender's user id are the same number, so `TELEGRAM_CHAT_ID` is the whole allow-list
 * and no new secret is needed. Groups, channels, other users, bots, and anything that is not a fresh
 * text message typed by that user (edits, forwards, buttons, media) never becomes a command.
 */
export const RawUpdate = z.looseObject({ update_id: z.number().int().nonnegative() });
export type RawUpdate = z.infer<typeof RawUpdate>;

const Message = z.looseObject({
  message_id: z.number().int(),
  date: z.number().int().nonnegative(),
  text: z.string().max(4096).optional(),
  chat: z.looseObject({ id: z.number().int(), type: z.string() }),
  from: z.looseObject({ id: z.number().int(), is_bot: z.boolean().optional() }).optional(),
  forward_origin: z.unknown().optional(),
  forward_date: z.unknown().optional(),
  via_bot: z.unknown().optional(),
});

const CallbackQuery = z.looseObject({
  id: z.string().min(1).max(128),
  from: z.looseObject({ id: z.number().int(), is_bot: z.boolean().optional() }),
  // Absent when the button's message is too old for Telegram to hand back. The handler refuses those.
  message: z.looseObject({ message_id: z.number().int(), chat: z.looseObject({ id: z.number().int(), type: z.string() }) }).optional(),
  data: z.string().max(64).optional(),
});

export type Classified =
  /** A fresh text message from the allow-listed private chat. `date` is Telegram's own unix seconds. */
  | { kind: "COMMAND"; text: string; date: number }
  /**
   * KJ-P4B: an inline-button press by the allow-listed user, on a message in the allow-listed private
   * chat. It is only ever a request to look a handle up: nothing in `data` is trusted as a decision.
   */
  | { kind: "CALLBACK"; queryId: string; data: string | null; messageId: number | null }
  /** Authorised sender, but not something this channel acts on. Consumed silently. */
  | { kind: "IGNORED" }
  /** Anyone or anything else. Never answered, never admitted, only counted. */
  | { kind: "UNAUTHORISED" };

export interface ClassifyOptions {
  /** KJ-P4B: recognise button presses. Off, a callback query is ignored exactly as in KJ-P4A. */
  callbacks?: boolean;
}

export function classifyUpdate(update: RawUpdate, chatId: string, options: ClassifyOptions = {}): Classified {
  const raw = update as Record<string, unknown>;
  if (options.callbacks === true && raw["callback_query"] !== undefined) return classifyCallback(raw["callback_query"], chatId);
  // Edits, callback queries, channel posts and every other update kind are not messages.
  if (raw["message"] === undefined) return { kind: "IGNORED" };
  const parsed = Message.safeParse(raw["message"]);
  if (!parsed.success) return { kind: "IGNORED" };
  const m = parsed.data;
  const authorised =
    m.chat.type === "private" &&
    String(m.chat.id) === chatId &&
    m.from !== undefined &&
    String(m.from.id) === chatId &&
    m.from.is_bot !== true;
  if (!authorised) return { kind: "UNAUTHORISED" };
  // A forwarded or bot-relayed message is text Jonny did not type: never a command.
  if (m.forward_origin !== undefined || m.forward_date !== undefined || m.via_bot !== undefined) return { kind: "IGNORED" };
  if (m.text === undefined) return { kind: "IGNORED" };
  return { kind: "COMMAND", text: m.text, date: m.date };
}

/** The same allow-list as a command: the configured private chat is both the only sender and the only chat. */
function classifyCallback(value: unknown, chatId: string): Classified {
  const parsed = CallbackQuery.safeParse(value);
  if (!parsed.success) return { kind: "IGNORED" };
  const q = parsed.data;
  const authorised =
    String(q.from.id) === chatId &&
    q.from.is_bot !== true &&
    (q.message === undefined || (q.message.chat.type === "private" && String(q.message.chat.id) === chatId));
  if (!authorised) return { kind: "UNAUTHORISED" };
  return { kind: "CALLBACK", queryId: q.id, data: q.data ?? null, messageId: q.message?.message_id ?? null };
}

/** Where updates come from. Injected so the adapter is testable without a network. */
export interface UpdateSource {
  /** Updates with `update_id >= offset`, waiting up to `timeoutSec` when there are none. */
  getUpdates(offset: number, timeoutSec: number): Promise<RawUpdate[]>;
}

// One class per failure mode. Callers record `constructor.name`, never a message, so a library's
// own error text (which can carry the token-bearing URL) never reaches a log or a row.
export class TelegramPollUnauthorizedError extends Error {
  constructor() {
    super("Telegram bot token was rejected (401)");
  }
}
/** 409: a webhook is set, or another consumer is polling this bot. Two pollers must never coexist. */
export class TelegramPollConflictError extends Error {
  constructor() {
    super("Telegram reports a conflicting consumer (409)");
  }
}
export class TelegramPollTransientError extends Error {
  constructor() {
    super("Telegram poll failed transiently");
  }
}
export class TelegramPollMalformedError extends Error {
  constructor() {
    super("Telegram poll returned an unexpected body");
  }
}

const API_BASE = "https://api.telegram.org";
const MAX_BATCH = 100;

export interface HttpUpdateSourceConfig {
  botToken: string;
  /** KJ-P4B: also ask Telegram for inline-button presses. Off by default: KJ-P4A asks for messages only. */
  callbackQueries?: boolean;
}

/**
 * SECRET HANDLING: `botToken` lives in one private field and is embedded only in the URL handed to
 * `fetch`, exactly as the outbound notifier does. Every catch builds a NEW curated error and never
 * inspects, logs, or rethrows the caught value.
 */
export class HttpUpdateSource implements UpdateSource {
  readonly #botToken: string;
  readonly #allowed: string[];
  readonly #fetch: typeof fetch;

  constructor(config: HttpUpdateSourceConfig, fetchImpl: typeof fetch = fetch) {
    this.#botToken = config.botToken;
    this.#allowed = config.callbackQueries === true ? ["message", "callback_query"] : ["message"];
    this.#fetch = fetchImpl;
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<RawUpdate[]> {
    const url = `${API_BASE}/bot${this.#botToken}/getUpdates`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Only fresh messages (and, when approvals are on, button presses); nothing else is delivered.
        body: JSON.stringify({ offset, timeout: timeoutSec, limit: MAX_BATCH, allowed_updates: this.#allowed }),
        signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
      });
    } catch {
      throw new TelegramPollTransientError();
    }
    if (response.status === 401) throw new TelegramPollUnauthorizedError();
    if (response.status === 409) throw new TelegramPollConflictError();
    if (response.status === 429 || response.status >= 500) throw new TelegramPollTransientError();
    if (!response.ok) throw new TelegramPollMalformedError();
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TelegramPollMalformedError();
    }
    const envelope = z.object({ ok: z.literal(true), result: z.array(z.unknown()) }).safeParse(body);
    if (!envelope.success) throw new TelegramPollMalformedError();
    const updates: RawUpdate[] = [];
    for (const item of envelope.data.result) {
      const u = RawUpdate.safeParse(item);
      // An element with no usable update_id cannot be acknowledged, so it is dropped here.
      if (u.success) updates.push(u.data);
    }
    return updates;
  }
}
