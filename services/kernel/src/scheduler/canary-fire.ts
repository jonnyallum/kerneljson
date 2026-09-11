import { z } from "zod";
import { Id } from "../../../../packages/contracts/src/index.js";
import type { ScheduleStore } from "./store.js";
import {
  ScheduleTimerDriver,
  directJournal,
  runtimeSpecFrom,
  type AdmissionGateway,
  type DurableTimerRuntime,
  type OutstandingWake,
} from "./durable-timer.js";
import { dueFireWindows, fireIdentity, idempotencyKey } from "./fire.js";
import { canFire } from "./policy.js";

/**
 * S1 canary — Gate 3 single-shot production fire tool (repo-only; NOT executed here).
 *
 * The SMALLEST wrapper that authorises EXACTLY ONE logical fire of the approved schedule
 * through the already-qualified `ScheduleTimerDriver.onWake` path (create-or-get fire ->
 * KernelJSON Admission with `Idempotency-Key = fireIdentity` -> fenced bind-once), with:
 *   - an explicit `productionRuntime=true` acknowledgement (no accidental fire);
 *   - a bounded window that MUST resolve to exactly one due slot (fail closed otherwise);
 *   - NO recurring wake (a local no-op timer; the tool never arms a next fire);
 *   - NO Restate (the durable timer/SDK is not imported — the first controlled fire is
 *     driven directly; Restate is a later, separately-authorised durability layer);
 *   - a `preview` mode that computes the exact window + fireIdentity WITHOUT any write.
 *
 * It mints nothing: the canonical child task id comes only from the injected
 * `AdmissionGateway` (KernelJSON Admission), and every dedupe/fence guarantee lives in
 * Postgres + the admission door, exactly as qualified in S1-R.
 */

/** No-op durable timer: never arms a recurring wake. Semantically the SDK-free equivalent of
 *  restate-service.ts `NoopDurableTimerRuntime`, defined locally so this one-shot tool never
 *  imports `@restatedev/restate-sdk`. This is what structurally guarantees "no recurring wake". */
class NoRecurringTimer implements DurableTimerRuntime {
  async scheduleWake(): Promise<void> {}
  async cancelWake(): Promise<void> {}
  async observe(): Promise<OutstandingWake[]> {
    return [];
  }
}

export type CanaryFireCode =
  | "PRODUCTION_ACK_REQUIRED"
  | "MALFORMED_INPUT"
  | "UNKNOWN_SCHEDULE"
  | "TENANT_MISMATCH"
  | "NOT_FIRABLE"
  | "WINDOW_NOT_UNIQUE";

export class CanaryFireError extends Error {
  constructor(
    readonly code: CanaryFireCode,
    message: string,
  ) {
    super(message);
    this.name = "CanaryFireError";
  }
}

export const FireOnceInput = z.strictObject({
  scheduleId: Id,
  tenantId: Id,
  lastTickMs: z.number().int(),
  nowMs: z.number().int(),
  owner: z.string().min(1), // lease owner id for this one-shot driver instance
  productionRuntime: z.literal(true), // explicit acknowledgement; anything else is refused
  leaseTtlMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
  preview: z.boolean().default(false),
});
export type FireOnceInput = z.infer<typeof FireOnceInput>;

export interface FireOnceCommon {
  scheduleId: string;
  version: string;
  fireWindowKey: string;
  fireIdentity: string;
  idempotencyKey: string;
  fireAtUtc: string;
}
export interface FireOncePreview extends FireOnceCommon {
  preview: true;
}
export interface FireOnceExecuted extends FireOnceCommon {
  preview: false;
  childTaskId: string;
  fireCreated: boolean; // the schedule_fires row was newly created this invocation
  admissionReplay: boolean; // the fire was already bound before this invocation
}
export type FireOnceResult = FireOncePreview | FireOnceExecuted;

/**
 * Compute (and, unless `preview`, execute) exactly one fire.
 *
 * @param store    the schedule store (PgScheduleStore in production).
 * @param gateway  KernelJSON Admission seam; may be null ONLY in preview mode.
 */
export async function fireOnce(
  store: ScheduleStore,
  gateway: AdmissionGateway | null,
  rawInput: unknown,
): Promise<FireOnceResult> {
  // Explicit production acknowledgement BEFORE anything else.
  if ((rawInput as { productionRuntime?: unknown } | null)?.productionRuntime !== true)
    throw new CanaryFireError(
      "PRODUCTION_ACK_REQUIRED",
      "productionRuntime=true must be supplied explicitly",
    );
  const parsed = FireOnceInput.safeParse(rawInput);
  if (!parsed.success)
    throw new CanaryFireError("MALFORMED_INPUT", "fire-once input failed validation");
  const input = parsed.data;
  if (!(input.nowMs > input.lastTickMs))
    throw new CanaryFireError("MALFORMED_INPUT", "nowMs must be strictly after lastTickMs");

  const current = await store.getSchedule(input.scheduleId);
  if (!current) throw new CanaryFireError("UNKNOWN_SCHEDULE", "schedule does not exist");
  if (current.spec.tenant.id !== input.tenantId)
    throw new CanaryFireError("TENANT_MISMATCH", "schedule tenant does not match input");

  const spec = runtimeSpecFrom(current.spec, current.state);

  // Must be firable in production (enabled + enabled_for_production=true). Fail closed otherwise.
  const gate = canFire(spec, { productionRuntime: true });
  if (!gate.ok) throw new CanaryFireError("NOT_FIRABLE", `not firable: ${gate.reason}`);

  // The bounded window MUST resolve to exactly one due slot. Zero or many => fail closed.
  const windows = dueFireWindows(spec, input.lastTickMs, input.nowMs);
  if (windows.length !== 1)
    throw new CanaryFireError(
      "WINDOW_NOT_UNIQUE",
      `expected exactly one due window, found ${windows.length}`,
    );
  const w = windows[0]!;
  const common: FireOnceCommon = {
    scheduleId: input.scheduleId,
    version: spec.version,
    fireWindowKey: w.fireWindowKey,
    fireIdentity: fireIdentity(spec, w.fireWindowKey),
    idempotencyKey: idempotencyKey(spec, w.fireWindowKey),
    fireAtUtc: w.fireAtUtcIso,
  };

  if (input.preview) return { ...common, preview: true };

  if (!gateway)
    throw new CanaryFireError("MALFORMED_INPUT", "an admission gateway is required to execute");

  // Drive the ONE window through the reviewed, qualified path. NoRecurringTimer never arms a
  // next wake; directJournal runs each step inline (no Restate). All dedupe/fence guarantees
  // live in the store + admission door.
  const driver = new ScheduleTimerDriver(
    store,
    new NoRecurringTimer(),
    gateway,
    { owner: input.owner, productionRuntime: true, leaseTtlMs: input.leaseTtlMs },
    directJournal,
  );
  const result = await driver.onWake(input.scheduleId, input.lastTickMs, input.nowMs);
  if (result.gated)
    throw new CanaryFireError("NOT_FIRABLE", `wake gated: ${result.reason}`);

  // Read the bound fire back (read-only) for the canonical child id.
  const fires = await store.listFires(input.scheduleId);
  const fire = fires.find((f) => f.fireWindowKey === w.fireWindowKey);
  if (!fire || fire.admittedChildTaskId === null)
    throw new CanaryFireError("NOT_FIRABLE", "fire did not bind a canonical child task");

  return {
    ...common,
    preview: false,
    childTaskId: fire.admittedChildTaskId,
    fireCreated: result.createdFires > 0,
    admissionReplay: result.replays > 0,
  };
}
