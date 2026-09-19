import { fingerprintFor } from "../alerting/fingerprint.js";
import { intentsFromDecisions } from "../alerting/outbox.js";
import type { NotificationOutboxStore } from "../alerting/outbox-store.js";
import type { AlertDecision } from "../alerting/types.js";

/**
 * KJ-P3 - tell Jonny a mission finished. A notice, never an authority: it is queued
 * AFTER the task's terminal commit, through the existing durable outbox, so the running
 * monitor's delivery worker sends it over whichever transport is live (Telegram in
 * production). It touches no alert state and no business table.
 *
 * Identity comes from the task and its terminal status, not the moment, so a Restate
 * replay derives the same notification id and the outbox's insert-if-absent makes the
 * second attempt a no-op. The task id prefix is in the check id because the delivered
 * text is `<checkId>: <kind> (<severity>)` and that is the only place to carry it.
 */
export interface MissionNotice {
  taskId: string;
  status: "COMPLETED" | "FAILED";
  /** The outcome's completedAt. Journaled by Restate, so identical on replay. */
  at: string;
}

export function missionNoticeDecision(n: MissionNotice): AlertDecision {
  const checkId = `MISSION.repoAnalysis.${n.taskId.slice(0, 8)}.${n.status.toLowerCase()}`;
  return {
    kind: "NEW",
    // A finished analysis is good news (P3); a failed mission needs a look (P2).
    severity: n.status === "COMPLETED" ? "P3" : "P2",
    fingerprint: fingerprintFor(checkId, n.taskId),
    checkId,
    entityId: n.taskId,
    message: `Repository analysis mission ${n.status}`,
    notify: true,
    firstSeenAt: n.at,
    lastSeenAt: n.at,
    lastNotifiedAt: null,
    occurrenceCount: 1,
  };
}

export async function enqueueMissionNotice(
  outbox: NotificationOutboxStore,
  n: MissionNotice,
): Promise<{ notificationId: string }> {
  const intents = intentsFromDecisions([missionNoticeDecision(n)], n.at);
  const [intent] = intents;
  if (intents.length !== 1 || !intent) throw new Error("mission notice must produce exactly one intent");
  await outbox.enqueue(intents);
  return { notificationId: intent.notificationId };
}
