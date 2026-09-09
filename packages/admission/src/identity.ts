import { capabilityDigest } from "../../capabilities/src/index.js";
import { stableId } from "../../../services/kernel/src/compiler/index.js";
import type { PrincipalRef } from "../../contracts/src/index.js";

/** Shadow-only recipe placeholder — never submitted to live gateway this pass. */
export const SHADOW_EMAIL_RECIPE = "estate-email-triage/v1" as const;

export const SHADOW_CONSUMER = "kj-admission-shadow-email" as const;

export const LIVE_INGEST_SUFFIX = "email-ingest-live" as const;

/** Deterministic estate tenant — documented mapping, not body-spoofed authority. */
export const ESTATE_TENANT_ID = stableId(["estate-tenant/v1", "estate"]);

/** Deterministic email-ingest SERVICE principal (auth-resolved mapping). */
export const ESTATE_EMAIL_PRINCIPAL: PrincipalRef = {
  id: stableId(["estate-principal/v1", "service", "email-ingest"]),
  kind: "SERVICE",
};

/**
 * Normalise Message-ID for key stability:
 * strip whitespace + angle brackets, lower-case.
 * Fallback: hostinger-uid-{uid} when missing.
 */
export function normalizeEmailSourceEventId(
  rawMessageId: string | null | undefined,
  uid?: string | number | null,
): string {
  const trimmed = String(rawMessageId ?? "").trim();
  const normalised = trimmed.replace(/[\s<>]/g, "").toLowerCase();
  if (normalised.length > 0) return normalised;
  if (uid !== undefined && uid !== null && String(uid).trim() !== "") {
    return `hostinger-uid-${String(uid).trim()}`;
  }
  throw new Error("missing Message-ID and uid for email_source_event_id");
}

export function estateDiscoveryKey(emailSourceEventId: string): string {
  return `email:${emailSourceEventId}|${LIVE_INGEST_SUFFIX}`;
}

/**
 * Gateway Idempotency-Key charset: /^[A-Za-z0-9._:-]{8,128}$/
 * 64-hex digest fits. Derived from (tenant, principal, estate_discovery_key).
 */
export function deriveIdempotencyKey(input: {
  tenantId: string;
  principalId: string;
  estate_discovery_key: string;
}): string {
  return capabilityDigest({
    tenantId: input.tenantId,
    principalId: input.principalId,
    estate_discovery_key: input.estate_discovery_key,
  });
}

export function deriveKeyDigest(idempotencyKey: string): string {
  return capabilityDigest(idempotencyKey);
}

export function scrubObjectiveSubject(subject: string | null | undefined): string {
  const raw = String(subject ?? "").trim() || "(no subject)";
  const patterns = [
    /\bsk-[A-Za-z0-9_\-]{20,}\b/g,
    /\bsb_secret_[A-Za-z0-9_\-]{16,}\b/g,
    /\bghp_[A-Za-z0-9]{20,}\b/g,
    /\bBearer\s+[A-Za-z0-9._\-]{20,}\b/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  ];
  let scrubbed = raw.slice(0, 200);
  for (const pat of patterns) scrubbed = scrubbed.replace(pat, "[REDACTED_SECRET]");
  return `Email triage: ${scrubbed}`;
}

export function ownerHintFromAssignee(
  assignee: string | null | undefined,
  urgency?: string | null,
): string {
  if (assignee && assignee.trim()) return assignee.trim();
  return urgency === "urgent" ? "@jonny" : "@keith";
}

export function priorityHintFromUrgency(
  urgency: string | null | undefined,
): "P1" | "P3" | "P4" {
  if (urgency === "urgent") return "P1";
  if (urgency === "low") return "P4";
  return "P3";
}

/** Live source_ref uses raw message id; Track B normalises — compare after normalising both. */
export function normalizeLiveSourceRef(sourceRef: string): string {
  const m = /^email:(.+)\|email-ingest-live$/.exec(sourceRef.trim());
  if (!m?.[1]) return sourceRef.trim();
  const eventId = m[1].replace(/[\s<>]/g, "").toLowerCase();
  return estateDiscoveryKey(eventId);
}
