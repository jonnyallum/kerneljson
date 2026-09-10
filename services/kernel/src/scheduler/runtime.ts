import type { ScheduleSpec } from "./spec.js";
import {
  dueFireWindows,
  fireIdentity,
  idempotencyKey,
  type FireWindow,
} from "./fire.js";
import { canFire } from "./policy.js";

/**
 * Phase S1 — in-memory scheduler tick + idempotent admission sink (prep).
 *
 * This is the durability *model*, not the durable runtime. It exists to prove
 * the core safety invariant deterministically without a DB or Restate:
 *
 *   NO (scheduleId, version, fireWindow) is ever admitted more than once,
 *   across scheduler retries, duplicate worker wakes, restarts, and replays.
 *
 * KernelJSON Admission is modelled by AdmissionSink.admit(), which dedupes on
 * the fire identity. The real implementation persists the same identity as a
 * unique key (see the S1 report, "Persistence"); this class stands in for that
 * durable dedupe so the simulations can assert the invariant.
 */
export interface AdmissionRequest {
  identity: string; // fireIdentity — the admission-request id
  idempotencyKey: string; // scheduleId|version|fireWindow
  scheduleId: string;
  version: string;
  fireWindowKey: string;
  fireAtUtcMs: number;
}

export class AdmissionSink {
  private readonly seen = new Map<string, AdmissionRequest>();
  /** Idempotent: a repeated identity is refused (models the durable unique key). */
  admit(req: AdmissionRequest): { admitted: boolean } {
    if (this.seen.has(req.identity)) return { admitted: false };
    this.seen.set(req.identity, req);
    return { admitted: true };
  }
  count(): number {
    return this.seen.size;
  }
  identities(): string[] {
    return [...this.seen.keys()];
  }
}

function toRequest(spec: ScheduleSpec, w: FireWindow): AdmissionRequest {
  return {
    identity: fireIdentity(spec, w.fireWindowKey),
    idempotencyKey: idempotencyKey(spec, w.fireWindowKey),
    scheduleId: spec.scheduleId,
    version: spec.version,
    fireWindowKey: w.fireWindowKey,
    fireAtUtcMs: w.fireAtUtcMs,
  };
}

export interface TickResult {
  admitted: AdmissionRequest[];
  duplicatesSuppressed: number;
  fired: number;
  reason: string;
}

/**
 * Advance one scheduler tick over (lastTickMs, nowMs]. Emits an idempotent
 * admission request for each due fire window. Safe to call twice for the same
 * interval (duplicate worker wake) or after a restart (replay): the sink dedupes.
 */
export function tick(
  spec: ScheduleSpec,
  opts: {
    lastTickMs: number;
    nowMs: number;
    productionRuntime: boolean;
    sink: AdmissionSink;
  },
): TickResult {
  const gate = canFire(spec, { productionRuntime: opts.productionRuntime });
  if (!gate.ok)
    return { admitted: [], duplicatesSuppressed: 0, fired: 0, reason: gate.reason };

  const windows = dueFireWindows(spec, opts.lastTickMs, opts.nowMs);
  const admitted: AdmissionRequest[] = [];
  let dup = 0;
  for (const w of windows) {
    const req = toRequest(spec, w);
    const res = opts.sink.admit(req);
    if (res.admitted) admitted.push(req);
    else dup++;
  }
  return {
    admitted,
    duplicatesSuppressed: dup,
    fired: windows.length,
    reason: "fired",
  };
}
