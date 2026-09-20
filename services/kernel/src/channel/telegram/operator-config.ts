import type { OperatorLimits } from "./operator.js";

/**
 * KJ-P4A - deployment configuration for the Telegram operator channel, in the same fail-closed style
 * as the canary, admission and mission seams: unset serves no inbound channel (the worker's existing
 * behaviour), and a partial or ambiguous configuration stops the worker at startup instead of
 * silently serving something weaker or different from what was asked for.
 *
 *   TELEGRAM_INBOUND_ENABLED      "true" turns the channel on; unset, empty or "false" leaves it off
 *   TELEGRAM_MISSION_DAILY_CAP    Telegram-originated missions per UTC day, 1 to 100 (default 5)
 *
 * It also needs what the outbound path and the door client already need, and refuses to start
 * without them: ALERT_TRANSPORT=telegram, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, KJ_ADMISSION_URL,
 * KJ_ADMISSION_BEARER and DATABASE_URL. Values are read from the environment only and never printed.
 */
export interface OperatorConfig {
  botToken: string;
  chatId: string;
  admissionUrl: string;
  authorization: string;
  databaseUrl: string;
  limits: OperatorLimits;
  /** Pause between polls. The long poll itself paces the loop; this only prevents a hot spin. */
  pollIntervalMs: number;
  /** Pause after a failed poll (network, 409, 401), so a bad token or a webhook clash is not hammered. */
  errorDelayMs: number;
}

export const DEFAULT_DAILY_MISSION_CAP = 5;
export const RATE_PER_MINUTE = 10;
export const POLL_TIMEOUT_SEC = 20;

export function loadOperatorConfig(env: NodeJS.ProcessEnv): OperatorConfig | undefined {
  const flag = env["TELEGRAM_INBOUND_ENABLED"];
  if (flag === undefined || flag === "" || flag === "false") return undefined;
  if (flag !== "true")
    throw new Error('TELEGRAM_INBOUND_ENABLED must be exactly "true" or "false" when set - refusing to guess');

  const botToken = env["TELEGRAM_BOT_TOKEN"];
  const chatId = env["TELEGRAM_CHAT_ID"];
  const admissionUrl = env["KJ_ADMISSION_URL"];
  const bearer = env["KJ_ADMISSION_BEARER"];
  const databaseUrl = env["DATABASE_URL"];
  const missing = [
    ["TELEGRAM_BOT_TOKEN", botToken],
    ["TELEGRAM_CHAT_ID", chatId],
    ["KJ_ADMISSION_URL", admissionUrl],
    ["KJ_ADMISSION_BEARER", bearer],
    ["DATABASE_URL", databaseUrl],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0)
    throw new Error(
      `TELEGRAM_INBOUND_ENABLED=true requires ${missing.join(", ")} - refusing to start half-configured`,
    );
  // Replies go out through the durable outbox, which sends through the configured transport. With
  // anything but Telegram, every answer would silently go to the console instead of the phone.
  if (env["ALERT_TRANSPORT"] !== "telegram")
    throw new Error("TELEGRAM_INBOUND_ENABLED=true requires ALERT_TRANSPORT=telegram so replies reach the chat");
  // A private chat's id is a positive number. A group or channel id is negative and is refused: this
  // channel answers exactly one person.
  if (!/^\d{1,20}$/.test(chatId!))
    throw new Error("TELEGRAM_CHAT_ID must be a positive private-chat id for the inbound channel");

  const rawCap = env["TELEGRAM_MISSION_DAILY_CAP"];
  const cap = rawCap === undefined || rawCap === "" ? DEFAULT_DAILY_MISSION_CAP : Number(rawCap);
  if (!(typeof rawCap === "undefined" || rawCap === "" || /^\d{1,3}$/.test(rawCap)) || !Number.isInteger(cap) || cap < 1 || cap > 100)
    throw new Error("TELEGRAM_MISSION_DAILY_CAP must be a whole number from 1 to 100");

  return {
    botToken: botToken!,
    chatId: chatId!,
    admissionUrl: admissionUrl!,
    authorization: `Bearer ${bearer!}`,
    databaseUrl: databaseUrl!,
    limits: { chatId: chatId!, dailyMissionCap: cap, ratePerMinute: RATE_PER_MINUTE, pollTimeoutSec: POLL_TIMEOUT_SEC },
    pollIntervalMs: 1000,
    errorDelayMs: 30_000,
  };
}
