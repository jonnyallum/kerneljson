import type { ApprovalCard, ApprovalStatus, Decision, Handles } from "./approval-cards.js";

/**
 * KJ-P4B - the adapter's durable memory of approval cards and button presses.
 *
 * Not approval state. Whether an approval is pending, granted, denied or expired is decided only by
 * the ledger's ApprovalStore; `statusOf` and `listToClose` READ that, and nothing in this interface
 * can write it. What is kept here is only: which approvals were already shown (so each is shown once),
 * what each opaque button handle means, and which presses were already handled (so a Telegram
 * redelivery cannot act twice). See `supabase/migrations/20260920150000_telegram_approvals.sql`.
 */
export type CallbackDisposition =
  | "UNKNOWN_HANDLE"
  | "WRONG_MESSAGE"
  | "EXPIRED"
  | "RESOLVED"
  | "ALREADY_RESOLVED"
  | "DOOR_REFUSED"
  | "UNAVAILABLE"
  | "NOT_FOUND";

export interface CardToSend {
  card: ApprovalCard;
  handles: Handles;
}

export interface CardToClose {
  card: ApprovalCard;
  /** What the ledger says now; PENDING past its deadline is reported as EXPIRED, which is what it is. */
  status: ApprovalStatus;
}

export interface CardStore {
  /**
   * Create a QUEUED card (and its two handles) for every PENDING approval that names `approverId` in
   * `tenantId` and has none yet. Fields are copied from the ledger's own POLICY_CHECKED event and
   * validated; a row that fails validation is skipped, never sent. Returns how many were created.
   */
  discover(input: { tenantId: string; approverId: string; now: string; limit: number }): Promise<number>;
  /** Claim cards to send: QUEUED, or SENDING for longer than `staleMs`, unexpired, under `maxAttempts`. */
  claimToSend(input: { now: string; staleMs: number; maxAttempts: number; limit: number }): Promise<CardToSend[]>;
  markSent(approvalId: string, messageId: number, now: string): Promise<void>;
  /** A send failed: hand the card back for the next poll. The attempt stays counted. */
  releaseUnsent(approvalId: string): Promise<void>;
  /** Unresolved cards whose approval the ledger has settled, or whose deadline has passed. */
  listToClose(input: { now: string; limit: number }): Promise<CardToClose[]>;
  markResolved(approvalId: string, now: string): Promise<void>;
  byHandle(handle: string): Promise<{ card: ApprovalCard; decision: Decision } | null>;
  /** The ledger's own status for an approval, or null when there is no such approval. */
  statusOf(approvalId: string): Promise<ApprovalStatus | null>;
  claimCallback(input: { updateId: number; now: string }): Promise<{ state: "RECEIVED" | "DONE" }>;
  completeCallback(input: {
    updateId: number;
    disposition: CallbackDisposition;
    approvalId: string | null;
    pressed: Decision | null;
    now: string;
  }): Promise<void>;
}
