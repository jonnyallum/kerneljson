import { formatDecisionHuman } from "./format.js";
import type { AlertDecision, Notifier } from "./types.js";

/**
 * Stdout notifier — the only wired transport in KJ-P1.2. Deliberately no
 * Telegram/WhatsApp/email/Slack here: "keep transport abstraction separate from
 * alert evaluation... do not wire [a provider] unless it already exists cleanly
 * and can be added without scope creep." The engine works completely without any
 * notifier at all (see engine.ts — notifier is optional); this is the minimal
 * concrete one so `notify: true` decisions are visible somewhere by default.
 */
export class ConsoleNotifier implements Notifier {
  async notify(decision: AlertDecision): Promise<void> {
    console.log(formatDecisionHuman(decision));
  }
}

/** Collects every decision it's handed instead of printing — used by tests and
 *  by the live-validation CLI run to assert/display exactly what would have been
 *  sent, without actually depending on stdout ordering. */
export class RecordingNotifier implements Notifier {
  readonly sent: AlertDecision[] = [];
  async notify(decision: AlertDecision): Promise<void> {
    this.sent.push(decision);
  }
}
