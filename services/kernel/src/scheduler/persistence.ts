import { z } from "zod";
import {
  Id,
  Timestamp,
  PrincipalRef,
  TenantRef,
} from "../../../../packages/contracts/src/index.js";
import { CalendarSpec, MissedRunPolicy, OverlapPolicy, NonexistentTimePolicy, ScheduleState } from "./spec.js";

/**
 * Phase S1 — persisted scheduler entities (contracts for the durable store).
 *
 * Source of truth ownership (see S1 report "Restate boundary"):
 *   - ScheduleSpec / ScheduleState / ScheduleFire / Backfill / Observation:
 *       the KernelJSON scheduler DB (this schema) is source of truth.
 *   - Child task lifecycle after admission: KernelJSON Admission owns it.
 *   - Restate (later) owns only timer execution + workflow continuation; it must
 *     NOT own schedule truth — it reads/writes these rows, it is not the record.
 *
 * The core invariant is enforced by the DB (unique on
 * (schedule_id, schedule_version, fire_window_key)), not by app code alone.
 */

/** Immutable, versioned schedule definition. A semantic change = a new version. */
export const PersistedScheduleSpec = z.strictObject({
  scheduleId: Id,
  version: z.string().min(1),
  tenant: TenantRef,
  principal: PrincipalRef,
  owner: PrincipalRef, // HUMAN, enforced by ScheduleSpec on the way in
  name: z.string().min(1).max(200),
  timezone: z.string().min(1),
  calendar: CalendarSpec,
  missedRunPolicy: MissedRunPolicy,
  overlapPolicy: OverlapPolicy,
  nonexistentTimePolicy: NonexistentTimePolicy,
  maxBackfillRuns: z.number().int().min(0),
  perScheduleConcurrency: z.number().int().min(1),
  enabledForProduction: z.boolean(),
  createdAt: Timestamp,
  createdBy: Id,
});
export type PersistedScheduleSpec = z.infer<typeof PersistedScheduleSpec>;

/** Current lifecycle state — toggling this is NOT a semantic version change. */
export const PersistedScheduleState = z.strictObject({
  scheduleId: Id,
  state: ScheduleState,
  activeVersion: z.string().min(1),
  updatedAt: Timestamp,
  updatedBy: Id,
});
export type PersistedScheduleState = z.infer<typeof PersistedScheduleState>;

/**
 * Fire lifecycle. S1-R Option B semantics:
 *   PLANNED           — a due window with no admission attempt yet.
 *   ADMISSION_PENDING — an admission attempt has not yet produced a successful
 *                       canonical admission (transient/retrying).
 *   ADMITTED          — KernelJSON Admission SUCCEEDED and the fire is bound to its
 *                       CANONICAL taskId via kernel_private.task_admissions.
 *                       ADMITTED does NOT mean public.tasks has materialised —
 *                       task materialisation/execution belongs to the child task
 *                       lifecycle (downstream), not to the ScheduleFire lifecycle.
 */
export const FireState = z.enum([
  "PLANNED",
  "ADMISSION_PENDING",
  "ADMITTED",
  "SKIPPED",
  "FAILED",
  "CANCELLED",
]);
export type FireState = z.infer<typeof FireState>;

/** One logical schedule fire. Identity = (scheduleId, version, fireWindowKey). */
export const ScheduleFire = z.strictObject({
  idempotencyKey: z.string().min(1), // scheduleId|version|fireWindowKey
  scheduleId: Id,
  version: z.string().min(1),
  fireWindowKey: z.string().min(1),
  fireIdentity: Id, // content-derived admission-request identity
  fireAtUtc: Timestamp,
  state: FireState,
  admissionRequestId: Id.nullable(),
  admittedChildTaskId: Id.nullable(),
  admittedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type ScheduleFire = z.infer<typeof ScheduleFire>;

export const BackfillStatus = z.enum(["PREVIEW", "APPROVED", "EXECUTED", "REJECTED"]);
export type BackfillStatus = z.infer<typeof BackfillStatus>;

/** Audited, bounded backfill request. No self-approval, no unbounded range. */
export const ScheduleBackfillRequest = z
  .strictObject({
    id: Id,
    scheduleId: Id,
    version: z.string().min(1),
    requestedBy: Id,
    requestedFrom: Timestamp,
    requestedTo: Timestamp,
    computedWindows: z.number().int().min(0),
    maxRuns: z.number().int().min(1),
    previewDigest: z.string().min(1),
    status: BackfillStatus,
    approvedBy: Id.nullable(),
    createdAt: Timestamp,
    executedAt: Timestamp.nullable(),
  })
  .refine((b) => b.computedWindows <= b.maxRuns, "backfill exceeds maxRuns")
  .refine(
    (b) => b.status === "PREVIEW" || b.status === "REJECTED" || b.approvedBy !== null,
    "APPROVED/EXECUTED require an approver (no self-approval)",
  )
  .refine(
    (b) => b.approvedBy === null || b.approvedBy !== b.requestedBy,
    "approver must differ from requester (no self-approval)",
  );
export type ScheduleBackfillRequest = z.infer<typeof ScheduleBackfillRequest>;

export const ObservationKind = z.enum([
  "MISS",
  "OVERLAP",
  "FAILURE",
  "REPLAY",
  "AUTHORITY",
  "LEASE_RECOVERED",
]);
export type ObservationKind = z.infer<typeof ObservationKind>;

/** Operator-visible observation. Never task authority. */
export const ScheduleObservation = z.strictObject({
  id: Id,
  scheduleId: Id,
  idempotencyKey: z.string().nullable(),
  kind: ObservationKind,
  detail: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
});
export type ScheduleObservation = z.infer<typeof ScheduleObservation>;

/** Bounded claim/lease so a crashed worker cannot orphan a schedule forever. */
export const ScheduleLease = z.strictObject({
  scheduleId: Id,
  owner: z.string().min(1),
  epoch: z.number().int().min(0),
  acquiredAt: Timestamp,
  expiresAt: Timestamp,
});
export type ScheduleLease = z.infer<typeof ScheduleLease>;
