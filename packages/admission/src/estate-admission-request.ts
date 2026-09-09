import { z } from "zod";
import { Id, Timestamp } from "../../contracts/src/index.js";

/** Attachment metadata only — never raw bytes or secret bodies. */
export const AttachmentManifestItem = z.strictObject({
  filename: z.string().trim().min(1).max(512),
  size_bytes: z.number().int().nonnegative(),
  mime_type: z.string().trim().min(1).max(256),
});
export type AttachmentManifestItem = z.infer<typeof AttachmentManifestItem>;

/**
 * Compatibility-only fields: hints and legacy ledger cross-refs.
 * Never become KJ canonical identity or authority.
 */
export const CompatibilityHints = z.strictObject({
  action_id: z.string().trim().min(1).max(128).optional(),
  source_ref: z.string().trim().min(1).max(512).optional(),
  urgency: z.enum(["urgent", "normal", "low"]).optional(),
  label: z.string().trim().min(1).max(128).optional(),
  client: z.string().trim().min(1).max(256).optional(),
  needs_action: z.boolean().optional(),
  owner_hint: z.string().trim().min(1).max(64).optional(),
  priority_hint: z.enum(["P1", "P2", "P3", "P4"]).optional(),
});
export type CompatibilityHints = z.infer<typeof CompatibilityHints>;

/**
 * Estate → KJ Compatibility Admission Adapter input.
 * Field classes per Phase 2.6 / 2.7 — REQUIRED / OPTIONAL / COMPATIBILITY-ONLY.
 * FORBIDDEN: credentials, tokens, raw secret bodies, estate-supplied taskId.
 */
export const EstateAdmissionRequest = z
  .strictObject({
    channel: z.literal("email"),
    estate_discovery_key: z
      .string()
      .trim()
      .min(8)
      .max(512)
      .regex(/^email:[^|]+\|email-ingest-live$/),
    objective: z.string().trim().min(1).max(8000),
    received_at: Timestamp,
    tenant_ref: z.strictObject({ id: Id }),
    principal_ref: z.strictObject({
      id: Id,
      kind: z.enum(["HUMAN", "SERVICE"]),
    }),
    correlation_id: Id.optional(),
    sender: z.string().trim().min(1).max(512).optional(),
    subject: z.string().trim().max(998).optional(),
    message_id: z.string().trim().min(1).max(512).optional(),
    thread_refs: z.array(z.string().trim().min(1).max(512)).max(32).optional(),
    attachments_manifest: z.array(AttachmentManifestItem).max(64).optional(),
    compatibility: CompatibilityHints.optional(),
  })
  .superRefine((req, ctx) => {
    const forbidden = JSON.stringify(req);
    if (
      /sk-[A-Za-z0-9_\-]{20,}/.test(forbidden) ||
      /Bearer\s+[A-Za-z0-9._\-]{20,}/i.test(forbidden) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(forbidden)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Forbidden secret material in EstateAdmissionRequest",
      });
    }
  });
export type EstateAdmissionRequest = z.infer<typeof EstateAdmissionRequest>;

export const ShadowVerdict = z.enum([
  "MATCH",
  "ACCEPTABLE_DIFFERENCE",
  "MATERIAL_DIFFERENCE",
  "CONFLICT",
  "ERROR",
]);
export type ShadowVerdict = z.infer<typeof ShadowVerdict>;
