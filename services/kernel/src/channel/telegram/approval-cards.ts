import { randomBytes } from "node:crypto";
import { REVERSE, UPPERCASE } from "../../../../../packages/capabilities/src/index.js";

/**
 * KJ-P4B - what an approval looks like in Telegram, and nothing else.
 *
 * Telegram is a human INTERFACE onto approvals KernelJSON already owns. This module only decides
 * what the card says and what a button press carries. It has no way to grant, deny or expire an
 * approval: that authority is the ApprovalStore, reached only through the door's existing `approve`
 * control, for the named approver, against the exact scope digest, before the DB-clock deadline.
 *
 * Three rules make the card safe to send and the buttons safe to press:
 *
 *  1. Text is a `CardText`, a branded string only this module can mint, built from fixed templates
 *     over fields that are validated here (uuid, hex digest, capability id, ISO instant). No model
 *     output, task objective, step input or repository text ever reaches the chat.
 *  2. A button carries `kj1:<handle>` and NOTHING else: an unguessable random token. The decision,
 *     task and digest are looked up server side. There is no decision, task id or digest in the
 *     callback data to forge, edit or replay onto another card.
 *  3. The digest shown is shortened for reading only. The digest the door is given is the full one
 *     copied from the ledger's own POLICY_CHECKED event, never the short one and never Telegram's.
 */
export type CardText = string & { readonly __brand: "ApprovalCardText" };

export type Decision = "GRANTED" | "DENIED";
export type ApprovalStatus = "PENDING" | "GRANTED" | "DENIED" | "EXPIRED";
export type CardState = "QUEUED" | "SENDING" | "SENT" | "RESOLVED";

/** An approval as the ledger recorded it, ready to be shown. Every field is validated on creation. */
export interface ApprovalRequest {
  approvalId: string;
  taskId: string;
  tenantId: string;
  scopeDigest: string;
  invocationDigest: string;
  capability: string;
  /** ISO instant, from the ledger's own evaluation. */
  expiresAt: string;
}

export interface ApprovalCard extends ApprovalRequest {
  state: CardState;
  attemptCount: number;
  claimedAt: string | null;
  messageId: number | null;
}

export interface Handles {
  granted: string;
  denied: string;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CAPABILITY = /^[a-zA-Z0-9._/-]{1,80}$/;
const HANDLE = /^[A-Za-z0-9_-]{22}$/;
const CALLBACK = /^kj1:([A-Za-z0-9_-]{22})$/;

export const CALLBACK_PREFIX = "kj1:";
export const SHORT_DIGEST_CHARS = 12;

/**
 * What the action is, in words. A closed vocabulary: the ledger records a capability by uuid, and the
 * card names only the ones KernelJSON ships as deterministic, side-effect-free text transforms. Any
 * other well-formed id is shown as its short id, and anything malformed prints "?".
 */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [UPPERCASE.id]: "uppercase text (no side effects)",
  [REVERSE.id]: "reverse text (no side effects)",
});
export const capabilityLabel = (id: string): string =>
  !CAPABILITY.test(id) ? "?" : (CAPABILITY_LABELS[id] ?? `capability ${id.slice(0, 8)}`);
export const shortDigest = (digest: string): string => (HEX64.test(digest) ? digest.slice(0, SHORT_DIGEST_CHARS) : "?");
const shortId = (id: string): string => (UUID.test(id) ? id.slice(0, 8) : "?");

/** A fresh unguessable handle: 128 random bits, 22 URL-safe characters. */
export const mintHandle = (): string => randomBytes(16).toString("base64url");
export const isHandle = (value: string): boolean => HANDLE.test(value);

/** The callback data for a handle. Always under Telegram's 64-byte limit (4 + 22 = 26). */
export const callbackDataFor = (handle: string): string => {
  if (!HANDLE.test(handle)) throw new Error("invalid approval handle");
  return `${CALLBACK_PREFIX}${handle}`;
};

/** The handle in a callback's data, or null when the data is not exactly this scheme. */
export function parseCallbackData(data: unknown): string | null {
  if (typeof data !== "string") return null;
  const m = CALLBACK.exec(data);
  return m?.[1] ?? null;
}

/** Keeps newline and printable characters; drops every other control character, whatever the inputs were. */
function stripControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 10 || (code >= 32 && code !== 127)) out += ch;
  }
  return out;
}
const mint = (lines: string[]): CardText => stripControls(lines.join("\n")).slice(0, 1000) as CardText;

/** UK date and 24-hour UTC time, e.g. "20/09/2026 14:32 UTC". Anything that is not an instant prints "?". */
export function ukInstant(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function isValidRequest(r: ApprovalRequest): boolean {
  return (
    UUID.test(r.approvalId) &&
    UUID.test(r.taskId) &&
    UUID.test(r.tenantId) &&
    HEX64.test(r.scopeDigest) &&
    HEX64.test(r.invocationDigest) &&
    CAPABILITY.test(r.capability) &&
    Number.isFinite(Date.parse(r.expiresAt))
  );
}

/** The one message sent when an approval is requested. Concise: no secrets, no raw input, no model text. */
export function renderCard(card: ApprovalRequest, now: Date): { text: CardText; keyboard: (h: Handles) => InlineKeyboard } {
  const minutes = Math.max(0, Math.round((Date.parse(card.expiresAt) - now.getTime()) / 60_000));
  const text = mint([
    "Approval needed",
    `Task: ${shortId(card.taskId)}`,
    `Action: ${capabilityLabel(card.capability)} (input ${shortDigest(card.invocationDigest)})`,
    `Digest: ${shortDigest(card.scopeDigest)}`,
    `Expires: ${ukInstant(card.expiresAt)} (about ${minutes} min)`,
    "Approve this exact action?",
  ]);
  return {
    text,
    keyboard: (h) => ({
      inline_keyboard: [
        [
          { text: "APPROVE", callback_data: callbackDataFor(h.granted) },
          { text: "REJECT", callback_data: callbackDataFor(h.denied) },
        ],
      ],
    }),
  };
}

/** The card after the approval is settled: the keyboard is removed by editing without one. */
export function renderClosed(card: ApprovalRequest, status: ApprovalStatus): CardText {
  const word: Record<ApprovalStatus, string> = {
    PENDING: "Pending",
    GRANTED: "Approved",
    DENIED: "Rejected",
    EXPIRED: "Expired",
  };
  return mint([
    `${word[status]}`,
    `Task: ${shortId(card.taskId)}`,
    `Action: ${capabilityLabel(card.capability)} (input ${shortDigest(card.invocationDigest)})`,
    `Digest: ${shortDigest(card.scopeDigest)}`,
  ]);
}

export type ToastKind =
  | { kind: "APPROVED" }
  | { kind: "REJECTED" }
  | { kind: "ALREADY"; status: ApprovalStatus; pressed: Decision }
  | { kind: "EXPIRED" }
  | { kind: "UNKNOWN" }
  | { kind: "REFUSED" }
  | { kind: "UNAVAILABLE" };

/** The short pop-up shown on the button press. Fixed wording, never derived from the callback data. */
export function renderToast(t: ToastKind): CardText {
  switch (t.kind) {
    case "APPROVED":
      return mint(["Approved. The task will continue."]);
    case "REJECTED":
      return mint(["Rejected. The task will not run this action."]);
    case "ALREADY": {
      const done = t.status === "GRANTED" ? "approved" : t.status === "DENIED" ? "rejected" : t.status === "EXPIRED" ? "expired" : "pending";
      const pressed = t.pressed === "GRANTED" ? "approve" : "reject";
      return mint([t.status === "PENDING" ? "Still pending." : `Already ${done}. Your ${pressed} changed nothing.`]);
    }
    case "EXPIRED":
      return mint(["This approval has expired. Nothing was approved."]);
    case "UNKNOWN":
      return mint(["That button is not recognised. Nothing was changed."]);
    case "REFUSED":
      return mint(["KernelJSON refused that answer. Nothing was changed."]);
    case "UNAVAILABLE":
      return mint(["Could not reach KernelJSON. Nothing was changed. Press again."]);
  }
}
