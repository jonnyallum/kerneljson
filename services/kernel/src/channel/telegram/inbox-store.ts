/**
 * KJ-P4A - the adapter's durable memory of what it has already handled. Not task state: tasks,
 * evidence and outcomes live only in the ledger, and nothing here can create or complete one.
 *
 * Replay safety rests on three facts, each tested:
 *  1. A row is CLAIMED (RECEIVED) before any work and closed (DONE) after, keyed by Telegram's own
 *     update_id, so an update is never handled twice and a crash mid-way is resumed, not repeated.
 *  2. Every step in between is idempotent: the door dedupes on `tg:upd:<update_id>`, and the outbox
 *     dedupes on an id derived from the same update.
 *  3. The offset advances only after a whole batch is handled, and never backwards.
 */
export type Disposition = "ADMITTED" | "ANSWERED" | "MALFORMED" | "RATE_LIMITED" | "CAP_EXCEEDED" | "ADMISSION_FAILED";
export type CommandKind = "STATUS" | "MISSION" | "TASK" | "MALFORMED" | "REMEMBER" | "MEMORIES" | "MEMORY" | "FORGET";

export interface InboxRow {
  updateId: number;
  state: "RECEIVED" | "DONE";
  command: CommandKind | null;
  disposition: Disposition | null;
  mission: boolean;
  taskId: string | null;
  replyNotificationId: string | null;
  receivedAt: string;
}

export interface CompleteInput {
  updateId: number;
  command: CommandKind;
  disposition: Disposition;
  mission: boolean;
  taskId: string | null;
  replyNotificationId: string | null;
  now: string;
}

export interface InboxStore {
  /** The getUpdates offset to ask for next (0 when nothing has been read). */
  offset(): Promise<number>;
  /** Move the offset forward (never back) and add to the count of unauthorised updates. */
  advanceOffset(next: number, unauthorisedDelta: number, now: string): Promise<void>;
  /** Insert the row if absent and return it (new, or the existing one). */
  claim(input: { updateId: number; now: string; textSha256: string }): Promise<InboxRow>;
  /** Commands accepted since `sinceIso`, not counting `excludeUpdateId` or rate-limited ones. */
  countRecent(sinceIso: string, excludeUpdateId: number): Promise<number>;
  /** Has a rate-limit notice already been sent since `sinceIso`? Keeps a flood from earning a flood of replies. */
  hasRecentRateNotice(sinceIso: string): Promise<boolean>;
  /** Missions the door admitted since `sinceIso`, not counting `excludeUpdateId`. */
  countMissionsSince(sinceIso: string, excludeUpdateId: number): Promise<number>;
  complete(input: CompleteInput): Promise<void>;
}

/** Deterministic in-memory store for unit tests. Same semantics as the Postgres one. */
export class InMemoryInboxStore implements InboxStore {
  readonly rows = new Map<number, InboxRow>();
  next = 0;
  unauthorisedTotal = 0;

  async offset(): Promise<number> {
    return this.next;
  }
  async advanceOffset(next: number, unauthorisedDelta: number): Promise<void> {
    this.next = Math.max(this.next, next);
    this.unauthorisedTotal += unauthorisedDelta;
  }
  async claim(input: { updateId: number; now: string }): Promise<InboxRow> {
    const existing = this.rows.get(input.updateId);
    if (existing) return { ...existing };
    const row: InboxRow = {
      updateId: input.updateId,
      state: "RECEIVED",
      command: null,
      disposition: null,
      mission: false,
      taskId: null,
      replyNotificationId: null,
      receivedAt: input.now,
    };
    this.rows.set(input.updateId, row);
    return { ...row };
  }
  async countRecent(sinceIso: string, excludeUpdateId: number): Promise<number> {
    return [...this.rows.values()].filter(
      (r) => r.updateId !== excludeUpdateId && r.receivedAt > sinceIso && r.disposition !== "RATE_LIMITED",
    ).length;
  }
  async hasRecentRateNotice(sinceIso: string): Promise<boolean> {
    return [...this.rows.values()].some(
      (r) => r.disposition === "RATE_LIMITED" && r.replyNotificationId !== null && r.receivedAt > sinceIso,
    );
  }
  async countMissionsSince(sinceIso: string, excludeUpdateId: number): Promise<number> {
    return [...this.rows.values()].filter(
      (r) => r.updateId !== excludeUpdateId && r.mission && r.receivedAt >= sinceIso,
    ).length;
  }
  async complete(input: CompleteInput): Promise<void> {
    const row = this.rows.get(input.updateId);
    if (!row) throw new Error("update was never claimed");
    row.state = "DONE";
    row.command = input.command;
    row.disposition = input.disposition;
    row.mission = input.mission;
    row.taskId = input.taskId;
    row.replyNotificationId = input.replyNotificationId;
  }
}
