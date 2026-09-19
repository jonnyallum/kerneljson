import { fingerprintFor } from "./fingerprint.js";
import { intentsFromDecisions } from "./outbox.js";
import type { NotificationOutboxStore } from "./outbox-store.js";
import type { AlertDecision } from "./types.js";

/**
 * KJ-P2.2B — the one canonical operator test notification.
 *
 * Exists so Telegram activation can be proven through the REAL durable path
 * (outbox row -> the running monitor's delivery worker -> TelegramNotifier ->
 * ACK) without a raw INSERT, a direct Telegram call, or a manufactured P0/P1/P2.
 *
 * Shape of the guarantee, all structural:
 *  - The only dependency is a `NotificationOutboxStore`. There is no handle to
 *    the alert-state store, the ledger, admissions or the scheduler, so this
 *    cannot mutate any of them.
 *  - The intent is built by the same `intentsFromDecisions` the alert engine
 *    uses, so the row is byte-for-byte the shape a real decision produces.
 *  - It never delivers. The running `ProductionAlertMonitor`'s next tick drains
 *    it, which is exactly what proves the production path.
 *  - It never writes `alert_state`, so a later real evaluation cannot "recover"
 *    it into a second notification.
 *  - Identity comes from the label, not the moment: `firstSeenAt` is a fixed
 *    sentinel, so re-running with the same label derives the same
 *    `notificationId` and the outbox's `on conflict do nothing` makes the second
 *    run a no-op. A different label is a deliberate second test.
 */

export const TEST_NOTIFICATION_CHECK_ID = "TEST.telegramActivationVerification";

/** Pins the episode to the label rather than to wall-clock time. */
const IDENTITY_SENTINEL = "1970-01-01T00:00:00.000Z";

const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

export function assertValidTestLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error("test notification label must match [A-Za-z0-9._-]{1,40}");
  }
}

export function buildTestDecision(label: string, now: string): AlertDecision {
  assertValidTestLabel(label);
  return {
    kind: "NEW",
    severity: "P3",
    fingerprint: fingerprintFor(TEST_NOTIFICATION_CHECK_ID, label),
    checkId: TEST_NOTIFICATION_CHECK_ID,
    entityId: label,
    message: "TEST notification (manual activation verification). Not an alert; no action needed.",
    notify: true,
    firstSeenAt: IDENTITY_SENTINEL,
    lastSeenAt: now,
    lastNotifiedAt: null,
    occurrenceCount: 1,
  };
}

export async function enqueueTestNotification(
  outbox: NotificationOutboxStore,
  label: string,
  now: () => Date = () => new Date(),
): Promise<{ notificationId: string }> {
  const nowIso = now().toISOString();
  const intents = intentsFromDecisions([buildTestDecision(label, nowIso)], nowIso);
  const [intent] = intents;
  if (intents.length !== 1 || !intent) throw new Error("test notification must produce exactly one intent");
  await outbox.enqueue(intents);
  return { notificationId: intent.notificationId };
}
