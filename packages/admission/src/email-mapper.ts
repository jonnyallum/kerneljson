import {
  EstateAdmissionRequest,
  type AttachmentManifestItem,
} from "./estate-admission-request.js";
import {
  ESTATE_EMAIL_PRINCIPAL,
  ESTATE_TENANT_ID,
  estateDiscoveryKey,
  normalizeEmailSourceEventId,
  ownerHintFromAssignee,
  priorityHintFromUrgency,
  scrubObjectiveSubject,
} from "./identity.js";

/** Minimal email envelope accepted by the mapper (Hostinger-adapted or fixture). */
export interface EmailEnvelopeInput {
  message_id?: string | null;
  messageId?: string | null;
  id?: string | null;
  uid?: string | number | null;
  from?: string | null;
  from_addr?: string | null;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  received_at?: string | null;
  correlation_id?: string | null;
  in_reply_to?: string | null;
  references?: string | string[] | null;
  attachments?: Array<{
    filename?: string;
    size_bytes?: number;
    sizeBytes?: number;
    mime_type?: string;
    contentType?: string;
  }> | null;
  /** Optional triage overlay (from triage_email_message shape). */
  triage?: {
    needs_action?: boolean;
    urgency?: string;
    label?: string;
    client?: string | null;
    action_triples?: Array<{
      source_ref?: string;
      assignee?: string;
    }>;
    subject?: string;
  } | null;
  /** Optional legacy public.actions snapshot for compare. */
  legacy_action?: {
    id?: string;
    source?: string;
    source_ref?: string;
    title?: string;
  } | null;
}

function pickMessageId(input: EmailEnvelopeInput): string | null {
  const candidates = [input.message_id, input.messageId, input.id];
  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c).trim() !== "") return String(c);
  }
  return null;
}

function mapAttachments(
  attachments: EmailEnvelopeInput["attachments"],
): AttachmentManifestItem[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map((a) => ({
    filename: String(a.filename || "untitled").slice(0, 512),
    size_bytes: Number(a.size_bytes ?? a.sizeBytes ?? 0) || 0,
    mime_type: String(a.mime_type || a.contentType || "application/octet-stream").slice(
      0,
      256,
    ),
  }));
}

function threadRefs(input: EmailEnvelopeInput): string[] | undefined {
  const refs: string[] = [];
  if (input.in_reply_to) refs.push(String(input.in_reply_to).trim());
  if (Array.isArray(input.references)) {
    for (const r of input.references) if (r) refs.push(String(r).trim());
  } else if (typeof input.references === "string" && input.references.trim()) {
    refs.push(...input.references.split(/\s+/).map((s) => s.trim()).filter(Boolean));
  }
  return refs.length ? refs.slice(0, 32) : undefined;
}

/**
 * Map an email envelope (+ optional triage overlay) → EstateAdmissionRequest.
 * Never invents credentials; never accepts estate-supplied taskId.
 */
export function mapEmailToEstateAdmissionRequest(
  input: EmailEnvelopeInput,
): EstateAdmissionRequest {
  const emailSourceEventId = normalizeEmailSourceEventId(
    pickMessageId(input),
    input.uid,
  );
  const discoveryKey = estateDiscoveryKey(emailSourceEventId);
  const triage = input.triage ?? undefined;
  const subjectRaw = triage?.subject ?? input.subject ?? "";
  const objective = scrubObjectiveSubject(subjectRaw);
  // Never retain raw secret-looking subject text in OPTIONAL subject field.
  const subject = objective.replace(/^Email triage:\s*/i, "");
  const sender = (input.from_addr ?? input.from ?? "").trim() || undefined;
  const triple = triage?.action_triples?.[0];
  const needsAction = triage?.needs_action;
  const urgency = triage?.urgency;
  const ownerHint = ownerHintFromAssignee(triple?.assignee, urgency);
  const receivedAt =
    input.received_at && !Number.isNaN(Date.parse(input.received_at))
      ? new Date(input.received_at).toISOString()
      : new Date().toISOString();

  const attachments = mapAttachments(input.attachments);
  const threads = threadRefs(input);

  const request = {
    channel: "email" as const,
    estate_discovery_key: discoveryKey,
    objective,
    received_at: receivedAt,
    tenant_ref: { id: ESTATE_TENANT_ID },
    principal_ref: ESTATE_EMAIL_PRINCIPAL,
    ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}),
    ...(sender ? { sender } : {}),
    ...(subject
      ? { subject: String(subject).slice(0, 998) }
      : {}),
    message_id: emailSourceEventId,
    ...(threads ? { thread_refs: threads } : {}),
    ...(attachments ? { attachments_manifest: attachments } : {}),
    compatibility: {
      ...(input.legacy_action?.id
        ? { action_id: String(input.legacy_action.id) }
        : {}),
      source_ref: discoveryKey,
      ...(urgency === "urgent" || urgency === "normal" || urgency === "low"
        ? { urgency }
        : {}),
      ...(triage?.label ? { label: String(triage.label).slice(0, 128) } : {}),
      ...(triage?.client ? { client: String(triage.client).slice(0, 256) } : {}),
      ...(typeof needsAction === "boolean" ? { needs_action: needsAction } : {}),
      owner_hint: ownerHint,
      priority_hint: priorityHintFromUrgency(urgency),
    },
  };

  return EstateAdmissionRequest.parse(request);
}
