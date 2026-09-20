import { createHash } from "node:crypto";
import type { NotificationOutboxStore } from "../../alerting/outbox-store.js";
import { admissionRequest, parseCommand, type Command } from "./commands.js";
import type { CommandKind, Disposition, InboxStore } from "./inbox-store.js";
import type { DoorClient } from "./door-client.js";
import { enqueueReply } from "./reply-outbox.js";
import { renderReply, type ReplyInput } from "./replies.js";
import type { StatusReader } from "./status.js";
import { classifyUpdate, type RawUpdate, type UpdateSource } from "./updates.js";
import { summariseTask } from "./views.js";

/**
 * KJ-P4A - one cycle of the Telegram channel adapter.
 *
 *   Telegram update -> authenticate + classify -> parse command -> claim the update (durable)
 *     -> rate limit / daily cap -> the existing admission door, or a read-only query
 *     -> templated reply through the durable outbox -> close the update -> advance the offset
 *
 * The adapter is a CLIENT of KernelJSON, never an authority. It cannot create, complete or mutate a
 * task: a mission goes through the door (which authenticates, applies policy and builds the
 * IntentEnvelope); `/status` and `/task` only read. It has no scheduler, no second task store, and no
 * model in the loop. Replies are fixed templates over validated fields.
 */
export interface OperatorLimits {
  /** The one allow-listed private chat (also the allow-listed sender). */
  chatId: string;
  /** Telegram-originated missions per UTC day. `/status` and `/task` do not count. */
  dailyMissionCap: number;
  /** Accepted commands per rolling minute. */
  ratePerMinute: number;
  pollTimeoutSec: number;
}

export interface OperatorDeps {
  limits: OperatorLimits;
  source: UpdateSource;
  inbox: InboxStore;
  door: DoorClient;
  status: StatusReader;
  outbox: NotificationOutboxStore;
  /** Send these outbox rows now. Failures stay PENDING and are retried, never lost. */
  deliver: (notificationIds: readonly string[]) => Promise<void>;
  /** Retry replies an earlier attempt could not send (Telegram outage, restart). */
  deliverDue: () => Promise<void>;
  now: () => Date;
}

export interface PollSummary {
  result: "OK" | "POLL_FAILED";
  errorClass: string | null;
  received: number;
  commands: number;
  duplicates: number;
  ignored: number;
  unauthorised: number;
  admitted: number;
  answered: number;
  refused: number;
  nextOffset: number;
}

const MINUTE_MS = 60_000;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const kindOf = (c: Command): CommandKind => c.kind;
const dayStart = (now: Date): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

export async function pollOnce(deps: OperatorDeps): Promise<PollSummary> {
  const summary: PollSummary = {
    result: "OK",
    errorClass: null,
    received: 0,
    commands: 0,
    duplicates: 0,
    ignored: 0,
    unauthorised: 0,
    admitted: 0,
    answered: 0,
    refused: 0,
    nextOffset: 0,
  };
  await deps.deliverDue();
  const offset = await deps.inbox.offset();
  summary.nextOffset = offset;

  let updates: RawUpdate[];
  try {
    updates = await deps.source.getUpdates(offset, deps.limits.pollTimeoutSec);
  } catch (error) {
    // Class name only: a library's own message can carry the token-bearing URL.
    summary.result = "POLL_FAILED";
    summary.errorClass = error instanceof Error ? error.constructor.name : "Unknown";
    return summary;
  }
  updates.sort((a, b) => a.update_id - b.update_id);
  summary.received = updates.length;

  let maxId = offset - 1;
  const replyIds: string[] = [];
  for (const update of updates) {
    maxId = Math.max(maxId, update.update_id);
    // Telegram never sends below the offset we asked for; if it ever did, it is already handled.
    if (update.update_id < offset) {
      summary.duplicates++;
      continue;
    }
    const classified = classifyUpdate(update, deps.limits.chatId);
    if (classified.kind === "UNAUTHORISED") {
      summary.unauthorised++;
      continue;
    }
    if (classified.kind === "IGNORED") {
      summary.ignored++;
      continue;
    }
    const outcome = await handleCommand(deps, update.update_id, classified.text, classified.date, summary);
    if (outcome) replyIds.push(outcome);
  }

  if (updates.length > 0) {
    await deps.inbox.advanceOffset(maxId + 1, summary.unauthorised, deps.now().toISOString());
    summary.nextOffset = maxId + 1;
  }
  if (replyIds.length > 0) await deps.deliver(replyIds);
  return summary;
}

/** Returns the notification id of the reply it queued, if any. */
async function handleCommand(
  deps: OperatorDeps,
  updateId: number,
  text: string,
  messageDate: number,
  summary: PollSummary,
): Promise<string | null> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const command = parseCommand(text);
  const row = await deps.inbox.claim({ updateId, now: nowIso, textSha256: sha256(text) });
  // Already handled (a Telegram retry, or a redelivered batch): no second task, no second reply.
  if (row.state === "DONE") {
    summary.duplicates++;
    return null;
  }
  summary.commands++;

  // Every path below queues its reply BEFORE closing the row, and both are idempotent, so a crash
  // between them is resumed on the next poll and converges on the same reply.
  const finish = async (
    reply: ReplyInput | null,
    done: { disposition: Disposition; mission?: boolean; taskId?: string },
  ): Promise<string | null> => {
    const replyId = reply ? (await enqueueReply(deps.outbox, updateId, renderReply(reply), messageDate)).notificationId : null;
    await deps.inbox.complete({
      updateId,
      command: kindOf(command),
      disposition: done.disposition,
      mission: done.mission ?? false,
      taskId: done.taskId ?? null,
      replyNotificationId: replyId,
      now: nowIso,
    });
    if (done.disposition === "ADMITTED") summary.admitted++;
    else if (done.disposition === "ANSWERED") summary.answered++;
    else summary.refused++;
    return replyId;
  };

  // 1. Rate limit. A flood earns one notice a minute, not one reply per message.
  const windowStart = new Date(now.getTime() - MINUTE_MS).toISOString();
  if ((await deps.inbox.countRecent(windowStart, updateId)) >= deps.limits.ratePerMinute) {
    const alreadyTold = await deps.inbox.hasRecentRateNotice(windowStart);
    return finish(alreadyTold ? null : { kind: "RATE_LIMITED", perMinute: deps.limits.ratePerMinute }, { disposition: "RATE_LIMITED" });
  }

  switch (command.kind) {
    case "MALFORMED":
      return finish({ kind: "USAGE" }, { disposition: "MALFORMED" });

    case "STATUS": {
      const status = await deps.status.read();
      const missionsToday = await deps.inbox.countMissionsSince(dayStart(now), updateId);
      return finish(
        { kind: "STATUS", status, missionsToday, cap: deps.limits.dailyMissionCap, asOf: nowIso },
        { disposition: "ANSWERED" },
      );
    }

    case "TASK": {
      const read = await deps.door.readTask(command.taskId);
      if (read.found === false) return finish({ kind: "TASK_NOT_FOUND", taskId: command.taskId }, { disposition: "ANSWERED" });
      if (read.found === "ERROR") return finish({ kind: "TASK_UNAVAILABLE" }, { disposition: "ANSWERED" });
      const view = summariseTask(read.status, read.evidence);
      return finish(view ? { kind: "TASK", view } : { kind: "TASK_UNAVAILABLE" }, { disposition: "ANSWERED" });
    }

    case "MISSION": {
      // 2. Daily cap: deterministic, recorded, and it never counts /status or /task.
      const used = await deps.inbox.countMissionsSince(dayStart(now), updateId);
      if (used >= deps.limits.dailyMissionCap) {
        return finish({ kind: "CAP_EXCEEDED", used, cap: deps.limits.dailyMissionCap }, { disposition: "CAP_EXCEEDED" });
      }
      // 3. The door. Its idempotency key is derived from this update, so a replay of an admission
      //    that already succeeded returns the same task instead of creating a second.
      const admitted = await deps.door.admitMission({ updateId, ...admissionRequest(command) });
      if (!admitted.ok) return finish({ kind: "ADMISSION_FAILED", reason: admitted.reason }, { disposition: "ADMISSION_FAILED" });
      return finish(
        {
          kind: "ADMITTED",
          command: command.command,
          repo: command.repo,
          findings: command.findings,
          taskId: admitted.taskId,
          used: used + 1,
          cap: deps.limits.dailyMissionCap,
        },
        { disposition: "ADMITTED", mission: true, taskId: admitted.taskId },
      );
    }
  }
}
