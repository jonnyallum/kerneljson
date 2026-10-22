import { fingerprintFor } from "../alerting/fingerprint.js";
import { intentsFromDecisions } from "../alerting/outbox.js";
import type { NotificationOutboxStore } from "../alerting/outbox-store.js";
import type { AlertDecision } from "../alerting/types.js";
import { briefCheckId } from "../alerting/brief-notice.js";
import { codeChangeCheckId, type CodeChangeNoticeStatus } from "../alerting/code-change-notice.js";

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

/**
 * The morning brief's notice. Same outbox, same replay-safe identity. A completed brief carries the
 * brief itself as its message, which the delivery worker forwards (see alerting/brief-notice.ts); a
 * failed one is an ordinary P2 notice.
 */
export interface BriefNotice {
  taskId: string;
  status: "COMPLETED" | "FAILED";
  at: string;
  /** The verified brief text. Required for COMPLETED, ignored for FAILED. */
  text?: string;
}

export function briefNoticeDecision(n: BriefNotice): AlertDecision {
  const checkId = briefCheckId(n.taskId, n.status);
  if (n.status === "COMPLETED" && !n.text) throw new Error("a completed brief notice needs its text");
  return {
    kind: "NEW",
    severity: n.status === "COMPLETED" ? "P3" : "P2",
    fingerprint: fingerprintFor(checkId, n.taskId),
    checkId,
    entityId: n.taskId,
    message: n.status === "COMPLETED" ? n.text! : "Morning brief FAILED",
    notify: true,
    firstSeenAt: n.at,
    lastSeenAt: n.at,
    lastNotifiedAt: null,
    occurrenceCount: 1,
  };
}

export async function enqueueBriefNotice(
  outbox: NotificationOutboxStore,
  n: BriefNotice,
): Promise<{ notificationId: string }> {
  const intents = intentsFromDecisions([briefNoticeDecision(n)], n.at);
  const [intent] = intents;
  if (intents.length !== 1 || !intent) throw new Error("brief notice must produce exactly one intent");
  await outbox.enqueue(intents);
  return { notificationId: intent.notificationId };
}

/**
 * code-change/v1: started, failed, or the draft PR is open. Same outbox, same replay-safe identity (task and
 * status). The text is built from fixed templates over kernel-held values and is what Jonny reads.
 */
export interface CodeChangeNotice {
  taskId: string;
  status: CodeChangeNoticeStatus;
  at: string;
  text: string;
}

export function codeChangeNoticeDecision(n: CodeChangeNotice): AlertDecision {
  const checkId = codeChangeCheckId(n.taskId, n.status);
  if (!n.text || n.text.length > 1000) throw new Error("a code-change notice needs short text");
  return {
    kind: "NEW",
    // Started and opened are information (P3); a failure needs a look (P2).
    severity: n.status === "FAILED" ? "P2" : "P3",
    fingerprint: fingerprintFor(checkId, n.taskId),
    checkId,
    entityId: n.taskId,
    message: n.text,
    notify: true,
    firstSeenAt: n.at,
    lastSeenAt: n.at,
    lastNotifiedAt: null,
    occurrenceCount: 1,
  };
}

export async function enqueueCodeChangeNotice(
  outbox: NotificationOutboxStore,
  n: CodeChangeNotice,
): Promise<{ notificationId: string }> {
  const intents = intentsFromDecisions([codeChangeNoticeDecision(n)], n.at);
  const [intent] = intents;
  if (intents.length !== 1 || !intent) throw new Error("code-change notice must produce exactly one intent");
  await outbox.enqueue(intents);
  return { notificationId: intent.notificationId };
}
