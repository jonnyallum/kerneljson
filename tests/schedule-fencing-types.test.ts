import { it, expect } from "vitest";
import type { ScheduleStore, LeaseFence } from "../services/kernel/src/scheduler/index.js";

/**
 * Phase S1-F2 — COMPILE-TIME structural fencing guard.
 *
 * These `@ts-expect-error` lines assert that ordinary runtime code (typed against
 * ScheduleStore) CANNOT call an ownership-sensitive mutation without a LeaseFence.
 * If fencing is ever made optional again, the errors disappear, the
 * `@ts-expect-error` become unused, and `tsc` (pnpm typecheck) FAILS (TS2578).
 * This is a real regression tripwire, not human inspection.
 */
function _protectedMethodsRequireFence(s: ScheduleStore, fence: LeaseFence): void {
  // @ts-expect-error bindAdmission requires a LeaseFence
  void s.bindAdmission("k", { admissionRequestId: "a", childTaskId: "c", at: "t" });
  // @ts-expect-error transition requires a LeaseFence
  void s.transition("k", "FAILED");
  // @ts-expect-error releaseLease requires an epoch fence
  void s.releaseLease("s", "owner");

  // The fenced forms are the only way to compile:
  void s.bindAdmission("k", { admissionRequestId: "a", childTaskId: "c", at: "t" }, fence);
  void s.transition("k", "FAILED", fence);
  void s.releaseLease("s", "owner", 1);

  // Authority-safe / reads remain callable with no fence:
  void s.createOrGetFire({ idempotencyKey: "k", scheduleId: "s", version: "v1", fireWindowKey: "w", fireIdentity: "i", fireAtUtc: "t", createdAt: "t" });
  void s.listFires("s");
}
void _protectedMethodsRequireFence;

it("protected ScheduleStore methods require a lease fence at compile time (S1-F2)", () => {
  expect(typeof _protectedMethodsRequireFence).toBe("function");
});
