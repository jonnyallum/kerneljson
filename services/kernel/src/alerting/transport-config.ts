/**
 * KJ-P2.2 — which `Notifier` transport to wire up. Same fail-closed
 * discipline as `runner-config.ts`'s `loadMonitorConfig`/`select-store.ts`'s
 * `loadAlertStoreMode`: never guess on an ambiguous or partial value.
 */

export interface ConsoleTransportConfig {
  mode: "console";
}

export interface TelegramTransportConfig {
  mode: "telegram";
  botToken: string;
  chatId: string;
}

export type TransportConfig = ConsoleTransportConfig | TelegramTransportConfig;

/**
 * `ALERT_TRANSPORT=console|telegram`. Unset/empty defaults to `"console"` —
 * the safe default (no external call, no credential required). Selecting
 * `telegram` REQUIRES both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; a
 * missing one throws rather than silently falling back to console — a
 * caller who explicitly asked for Telegram getting silent console output
 * instead would be a worse failure than a loud one at startup.
 */
export function loadTransportConfig(env: NodeJS.ProcessEnv): TransportConfig {
  const raw = env["ALERT_TRANSPORT"];
  const mode = raw === undefined || raw === "" ? "console" : raw;
  if (mode === "console") return { mode: "console" };
  if (mode === "telegram") {
    const botToken = env["TELEGRAM_BOT_TOKEN"];
    const chatId = env["TELEGRAM_CHAT_ID"];
    if (!botToken || !chatId) {
      throw new Error(
        "ALERT_TRANSPORT=telegram requires both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID " +
          "to be set — refusing to silently fall back to console. Set both explicitly, " +
          "or unset ALERT_TRANSPORT to use console.",
      );
    }
    return { mode: "telegram", botToken, chatId };
  }
  throw new Error(
    `ALERT_TRANSPORT must be exactly "console" or "telegram" when set (got ${JSON.stringify(raw)}) ` +
      "— refusing to guess the transport",
  );
}
