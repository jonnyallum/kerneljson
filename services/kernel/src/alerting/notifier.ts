import { formatPayloadHuman } from "./format.js";
import type { Notifier, NotificationPayload } from "./outbox-types.js";

/**
 * Stdout notifier — the only wired transport through KJ-P2.1. Deliberately no
 * Telegram/WhatsApp/email/Slack here: "keep transport abstraction separate from
 * alert evaluation... do not wire [a provider] unless it already exists cleanly
 * and can be added without scope creep." (KJ-P2.1: called only by
 * `delivery-worker.ts`, against a durable `NotificationPayload` — see
 * outbox-types.ts's header for why that's no longer a live `AlertDecision`.)
 */
export class ConsoleNotifier implements Notifier {
  async notify(payload: NotificationPayload): Promise<void> {
    console.log(formatPayloadHuman(payload));
  }
}

/** Collects every payload it's handed instead of printing — used by tests and
 *  by the live-validation CLI run to assert/display exactly what would have been
 *  sent, without actually depending on stdout ordering. */
export class RecordingNotifier implements Notifier {
  readonly sent: NotificationPayload[] = [];
  async notify(payload: NotificationPayload): Promise<void> {
    this.sent.push(payload);
  }
}
