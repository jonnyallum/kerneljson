import { classifyTelegramOutcome } from "../../alerting/telegram-notifier.js";
import type { CardText, InlineKeyboard } from "./approval-cards.js";

/**
 * KJ-P4B - the three Bot API calls an approval card needs: send the card, take its buttons away when
 * the approval is settled, and answer a button press so the phone stops spinning.
 *
 * Every argument that becomes visible text is a `CardText`, which only `approval-cards.ts` can mint,
 * so free text cannot reach the chat through here. The destination is fixed at construction to the one
 * allow-listed private chat: there is no way to address another.
 *
 * SECRET HANDLING: exactly the notifier's discipline. `botToken` sits in one private field and is
 * embedded only in the URL handed to `fetch`. Every catch builds a NEW error from a fixed class and
 * never inspects, logs or rethrows the caught value, because a library's own message can carry the
 * token-bearing URL. Status classification is the notifier's own `classifyTelegramOutcome`.
 */
export interface BotApi {
  /** Send the card; resolves with Telegram's message id. */
  sendCard(text: CardText, keyboard: InlineKeyboard): Promise<{ messageId: number }>;
  /** Replace the card's text and remove its buttons (an edit to an empty keyboard removes them). */
  closeCard(messageId: number, text: CardText): Promise<void>;
  /** Answer a button press with a short pop-up. Best effort: Telegram drops it after about a minute. */
  answer(callbackQueryId: string, text: CardText): Promise<void>;
}

const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;

export class TelegramApiTimeoutError extends Error {
  constructor() {
    super("Telegram request timed out");
  }
}
export class TelegramApiNetworkError extends Error {
  constructor() {
    super("Telegram request failed at the network layer");
  }
}
export class TelegramApiMalformedError extends Error {
  constructor() {
    super("Telegram returned an unexpected body");
  }
}
/** Editing a message to identical content is refused with 400 "message is not modified": harmless. */
export class TelegramApiRefusedError extends Error {
  constructor() {
    super("Telegram refused the request");
  }
}

export interface HttpBotApiConfig {
  botToken: string;
  chatId: string;
}

export class HttpBotApi implements BotApi {
  readonly #botToken: string;
  readonly #chatId: string;
  readonly #fetch: typeof fetch;

  constructor(config: HttpBotApiConfig, fetchImpl: typeof fetch = fetch) {
    this.#botToken = config.botToken;
    this.#chatId = config.chatId;
    this.#fetch = fetchImpl;
  }

  async #call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${API_BASE}/bot${this.#botToken}/${method}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") throw new TelegramApiTimeoutError();
      throw new TelegramApiNetworkError();
    }
    let parsed: { ok?: unknown; result?: unknown } | null;
    try {
      parsed = (await response.json()) as { ok?: unknown; result?: unknown };
    } catch {
      parsed = null;
    }
    const failure = classifyTelegramOutcome(response.status, parsed === null ? null : parsed.ok === true);
    if (failure) throw failure;
    return parsed?.result;
  }

  async sendCard(text: CardText, keyboard: InlineKeyboard): Promise<{ messageId: number }> {
    const result = (await this.#call("sendMessage", {
      chat_id: this.#chatId,
      text,
      reply_markup: keyboard,
      // Plain text: no parse mode, so nothing in the card can be read as markup.
    })) as { message_id?: unknown } | undefined;
    const id = result?.message_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new TelegramApiMalformedError();
    return { messageId: id };
  }

  async closeCard(messageId: number, text: CardText): Promise<void> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new TelegramApiRefusedError();
    // An explicitly empty keyboard: the buttons go, so a settled approval cannot be pressed again.
    await this.#call("editMessageText", {
      chat_id: this.#chatId,
      message_id: messageId,
      text,
      reply_markup: { inline_keyboard: [] },
    });
  }

  async answer(callbackQueryId: string, text: CardText): Promise<void> {
    if (typeof callbackQueryId !== "string" || callbackQueryId.length === 0 || callbackQueryId.length > 128)
      throw new TelegramApiRefusedError();
    await this.#call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }
}
