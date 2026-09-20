import { PermanentDeliveryError } from "../../alerting/outbox-types.js";
import { TelegramUnauthorizedError } from "../../alerting/telegram-notifier.js";
import {
  parseCallbackData,
  renderCard,
  renderClosed,
  renderToast,
  type Decision,
  type ToastKind,
} from "./approval-cards.js";
import type { BotApi } from "./bot-api.js";
import type { CallbackDisposition, CardStore } from "./card-store.js";
import type { ApprovalDoor } from "./door-client.js";

/**
 * KJ-P4B - Telegram as the human interface onto approvals KernelJSON already owns.
 *
 *   ledger records a PENDING approval (policy workflow, ApprovalStore.record)      [existing]
 *     -> `serviceApprovals` shows it once: a card with APPROVE / REJECT               [this module]
 *   Jonny presses a button
 *     -> the channel adapter authenticates the press (same allow-list as commands)    [updates.ts]
 *     -> `handleCallback` resolves the opaque handle to (approval, decision) SERVER SIDE
 *     -> the door's existing `POST /v1/tasks/:id/approve` control, with the ledger's own digest
 *     -> the policy workflow authenticates the approver, ApprovalStore.resolve checks named
 *        approver, tenant, task, exact scope digest, DB-clock expiry, and first decision wins
 *     -> the durable workflow resumes (granted) or ends the step (denied)             [existing]
 *
 * This module has NO authority. It never writes an approval, a task, evidence or an event: it reads
 * the ledger's status to know what to say, and asks the door, exactly as any other client would. If it
 * were deleted, every approval would still be resolvable through the door and would still be checked
 * identically. A button press can only ask; the ledger decides.
 *
 * The scope digest the door receives is the FULL digest copied from the ledger's POLICY_CHECKED event
 * when the card was created. It is never taken from, or compared against, anything Telegram carries,
 * because the callback carries only an opaque handle.
 */
export interface ApprovalsConfig {
  tenantId: string;
  approverId: string;
}

export interface ApprovalsDeps extends ApprovalsConfig {
  cards: CardStore;
  bot: BotApi;
  door: ApprovalDoor;
  now: () => Date;
}

export interface ServiceSummary {
  discovered: number;
  sent: number;
  sendFailed: number;
  closed: number;
  closeFailed: number;
}

/** A button press that already passed the channel's allow-list. `messageId` is null when Telegram omitted it. */
export interface Callback {
  updateId: number;
  queryId: string;
  data: string | null;
  messageId: number | null;
}

export type CallbackResult = "DUPLICATE" | CallbackDisposition;

const DISCOVER_LIMIT = 20;
const SEND_LIMIT = 5;
const CLOSE_LIMIT = 20;
/** A card claimed for sending but never marked sent (a crash) is retried after this long. A duplicate
 *  card is harmless: both carry the same handles, and the second press is an idempotent no-op. */
const STALE_SENDING_MS = 120_000;
const MAX_SEND_ATTEMPTS = 5;

const emptySummary = (): ServiceSummary => ({ discovered: 0, sent: 0, sendFailed: 0, closed: 0, closeFailed: 0 });

/** Show every unseen approval once, and take the buttons off every settled or expired one. */
export async function serviceApprovals(deps: ApprovalsDeps): Promise<ServiceSummary> {
  const summary = emptySummary();
  const nowIso = deps.now().toISOString();
  summary.discovered = await deps.cards.discover({
    tenantId: deps.tenantId,
    approverId: deps.approverId,
    now: nowIso,
    limit: DISCOVER_LIMIT,
  });

  const toSend = await deps.cards.claimToSend({
    now: nowIso,
    staleMs: STALE_SENDING_MS,
    maxAttempts: MAX_SEND_ATTEMPTS,
    limit: SEND_LIMIT,
  });
  for (const { card, handles } of toSend) {
    try {
      const view = renderCard(card, deps.now());
      const sent = await deps.bot.sendCard(view.text, view.keyboard(handles));
      await deps.cards.markSent(card.approvalId, sent.messageId, deps.now().toISOString());
      summary.sent++;
    } catch {
      // Hand it back for the next poll. Nothing is lost: the approval is still in the ledger.
      await deps.cards.releaseUnsent(card.approvalId);
      summary.sendFailed++;
    }
  }

  const toClose = await deps.cards.listToClose({ now: nowIso, limit: CLOSE_LIMIT });
  for (const { card, status } of toClose) {
    if (card.messageId === null) {
      // Never shown, so nothing to edit; it is simply over.
      await deps.cards.markResolved(card.approvalId, deps.now().toISOString());
      summary.closed++;
      continue;
    }
    try {
      await deps.bot.closeCard(card.messageId, renderClosed(card, status));
      await deps.cards.markResolved(card.approvalId, deps.now().toISOString());
      summary.closed++;
    } catch (error) {
      // A message Telegram will never let us edit (deleted, chat gone) is not retried for ever. A
      // rejected token is not "settled": it is a fault, and stays for the next poll.
      if (error instanceof PermanentDeliveryError && !(error instanceof TelegramUnauthorizedError)) {
        await deps.cards.markResolved(card.approvalId, deps.now().toISOString());
        summary.closed++;
      } else {
        summary.closeFailed++;
      }
    }
  }
  return summary;
}

/**
 * Handle one authenticated button press. Every outcome is a fixed pop-up, and the door is asked at
 * most once, and only for an approval the ledger still shows as PENDING and unexpired.
 */
export async function handleCallback(deps: ApprovalsDeps, cb: Callback): Promise<CallbackResult> {
  const nowIso = deps.now().toISOString();
  const claim = await deps.cards.claimCallback({ updateId: cb.updateId, now: nowIso });
  // A Telegram redelivery of a press already handled: no second door call.
  if (claim.state === "DONE") return "DUPLICATE";

  let disposition: CallbackDisposition;
  let toast: ToastKind;
  let approvalId: string | null = null;
  let pressed: Decision | null = null;

  const handle = parseCallbackData(cb.data);
  const found = handle === null ? null : await deps.cards.byHandle(handle);
  if (!found) {
    disposition = "UNKNOWN_HANDLE";
    toast = { kind: "UNKNOWN" };
  } else {
    const { card, decision } = found;
    approvalId = card.approvalId;
    pressed = decision;
    if (cb.messageId === null || card.messageId === null || cb.messageId !== card.messageId) {
      // A real handle, pressed from somewhere other than the card it was minted for.
      disposition = "WRONG_MESSAGE";
      toast = { kind: "UNKNOWN" };
    } else {
      const status = await deps.cards.statusOf(card.approvalId);
      if (status === null) {
        disposition = "NOT_FOUND";
        toast = { kind: "REFUSED" };
      } else if (status !== "PENDING") {
        disposition = "ALREADY_RESOLVED";
        toast = { kind: "ALREADY", status, pressed: decision };
      } else if (deps.now().getTime() >= Date.parse(card.expiresAt)) {
        // Only a courtesy: the ledger refuses on its own clock whatever this adapter thinks.
        disposition = "EXPIRED";
        toast = { kind: "EXPIRED" };
      } else {
        const answer = await deps.door.approve({
          taskId: card.taskId,
          scopeDigest: card.scopeDigest,
          decision,
          updateId: cb.updateId,
        });
        // What to say is read back from the ledger, never inferred from the door's reply.
        const after = await deps.cards.statusOf(card.approvalId);
        if (answer === "ACCEPTED" && after === decision) {
          disposition = "RESOLVED";
          toast = decision === "GRANTED" ? { kind: "APPROVED" } : { kind: "REJECTED" };
        } else if (after !== null && after !== "PENDING") {
          disposition = "ALREADY_RESOLVED";
          toast = { kind: "ALREADY", status: after, pressed: decision };
        } else if (answer === "UNAVAILABLE") {
          disposition = "UNAVAILABLE";
          toast = { kind: "UNAVAILABLE" };
        } else if (answer === "NOT_FOUND") {
          disposition = "NOT_FOUND";
          toast = { kind: "REFUSED" };
        } else {
          disposition = "DOOR_REFUSED";
          toast = { kind: "REFUSED" };
        }
      }
    }
  }

  await deps.cards.completeCallback({ updateId: cb.updateId, disposition, approvalId, pressed, now: nowIso });
  // The pop-up is a courtesy and Telegram drops it after about a minute: never let it fail the press.
  try {
    await deps.bot.answer(cb.queryId, renderToast(toast));
  } catch {
    // The card edit that follows shows the outcome regardless.
  }
  return disposition;
}

/** What the poll loop needs from approvals: settle-and-show, and handle one press. */
export interface ApprovalsPort {
  service(): Promise<ServiceSummary>;
  handle(cb: Callback): Promise<CallbackResult>;
}

export const createApprovalsPort = (deps: ApprovalsDeps): ApprovalsPort => ({
  service: () => serviceApprovals(deps),
  handle: (cb) => handleCallback(deps, cb),
});
