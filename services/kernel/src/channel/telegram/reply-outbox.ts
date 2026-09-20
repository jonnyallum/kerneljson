import { fingerprintFor } from "../../alerting/fingerprint.js";
import { operatorReplyCheckId } from "../../alerting/operator-reply.js";
import { intentsFromDecisions } from "../../alerting/outbox.js";
import type { NotificationOutboxStore } from "../../alerting/outbox-store.js";
import type { AlertDecision } from "../../alerting/types.js";
import type { ReplyText } from "./replies.js";

/**
 * KJ-P4A - queue one reply through the existing durable outbox.
 *
 * Identity comes from the Telegram update alone (its id, and its own `date` as the timestamp), never
 * from the moment of processing, so a replay derives the same notification id and the outbox's
 * insert-if-absent turns the second enqueue into a no-op. `text` is a `ReplyText`: only the reply
 * templates can produce one, which is what makes forwarding this row's text to the transport safe.
 */
export function replyDecision(updateId: number, text: ReplyText, messageDate: number): AlertDecision {
  const checkId = operatorReplyCheckId(updateId);
  const at = new Date(messageDate * 1000).toISOString();
  return {
    kind: "NEW",
    severity: "P3",
    fingerprint: fingerprintFor(checkId, String(updateId)),
    checkId,
    entityId: String(updateId),
    message: text,
    notify: true,
    firstSeenAt: at,
    lastSeenAt: at,
    lastNotifiedAt: null,
    occurrenceCount: 1,
  };
}

export async function enqueueReply(
  outbox: NotificationOutboxStore,
  updateId: number,
  text: ReplyText,
  messageDate: number,
): Promise<{ notificationId: string }> {
  const decision = replyDecision(updateId, text, messageDate);
  const intents = intentsFromDecisions([decision], decision.firstSeenAt);
  const [intent] = intents;
  if (intents.length !== 1 || !intent) throw new Error("a reply must produce exactly one intent");
  await outbox.enqueue(intents);
  return { notificationId: intent.notificationId };
}
