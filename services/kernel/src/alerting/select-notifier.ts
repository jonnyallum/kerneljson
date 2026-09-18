import { ConsoleNotifier } from "./notifier.js";
import { TelegramNotifier } from "./telegram-notifier.js";
import type { Notifier } from "./outbox-types.js";
import type { TransportConfig } from "./transport-config.js";

/**
 * KJ-P2.2 — construct the wired `Notifier` for `config` (see
 * `transport-config.ts`'s `loadTransportConfig`), plus the `transport` label
 * every delivery-events row is stamped with (`delivery-worker.ts`'s
 * `DeliveryWorkerDeps.transport`). Mirrors `select-store.ts`'s
 * never-silently-substitute discipline: the mode picked here is exactly the
 * mode requested, never guessed or downgraded.
 */
export function selectNotifier(config: TransportConfig): { notifier: Notifier; transport: string } {
  if (config.mode === "console") return { notifier: new ConsoleNotifier(), transport: "console" };
  return {
    notifier: new TelegramNotifier({ botToken: config.botToken, chatId: config.chatId }),
    transport: "telegram",
  };
}
