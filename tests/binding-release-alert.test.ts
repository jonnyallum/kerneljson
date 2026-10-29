import { describe, expect, it } from "vitest";
import { reduceCheck } from "../services/kernel/src/alerting/reducer.js";
import { bindingProvenanceVerdict } from "../services/kernel/src/health/release-provenance.js";
import type { CheckResult } from "../services/kernel/src/health/types.js";
import type { BindingProvenance } from "../services/kernel/src/health/snapshot.js";

// After every activation the new epoch has no bindings until the next task runs. That window used to open a
// P3 and announce it twice (open, then recovery) on every release. It is now silent; real faults still notify.
const ID = "authority.bindingReleaseConsistent";
const base: BindingProvenance = { activeEpoch: "16", activeReleaseId: "c5de3f5", currentBindingCount: 3,
  mismatchedBindingCount: 0, missingProvenanceCount: 0, legacyBindingCount: 0 };
const checkOf = (p: BindingProvenance | null): CheckResult => {
  const v = bindingProvenanceVerdict(p);
  return { id: ID, status: v.status, evidence: "database release epochs", message: v.message, checkedAt: "2026-10-25T00:00:00.000Z" };
};
const t = (m: number) => `2026-10-25T00:${String(m).padStart(2, "0")}:00.000Z`;

describe("authority.bindingReleaseConsistent notifications", () => {
  it("a fresh epoch with no bindings opens and closes silently", () => {
    const opened = reduceCheck(null, checkOf({ ...base, currentBindingCount: 0 }), "s", t(0));
    expect(opened.decision).toMatchObject({ kind: "NEW", severity: "P3", notify: false });
    const closed = reduceCheck(opened.nextRow, checkOf(base), "s", t(5));
    expect(closed.decision).toMatchObject({ kind: "RECOVERED", notify: false });
  });
  it("missing provenance still notifies (negative case: not every UNKNOWN is silent)", () => {
    const missing = checkOf({ ...base, missingProvenanceCount: 1 });
    expect(missing.message.startsWith("NO_PROVENANCE")).toBe(true);
    const opened = reduceCheck(null, missing, "s", t(0));
    expect(opened.decision).toMatchObject({ kind: "NEW", severity: "P3", notify: true });
    expect(reduceCheck(opened.nextRow, checkOf(base), "s", t(1)).decision).toMatchObject({ kind: "RECOVERED", notify: true });
    expect(reduceCheck(null, checkOf(null), "s", t(0)).decision).toMatchObject({ severity: "P3", notify: true });
  });
  it("a mismatch is P1 and notifies, including out of a silent window, and its recovery is announced", () => {
    const quiet = reduceCheck(null, checkOf({ ...base, currentBindingCount: 0 }), "s", t(0));
    const loud = reduceCheck(quiet.nextRow, checkOf({ ...base, mismatchedBindingCount: 1 }), "s", t(1));
    expect(loud.decision).toMatchObject({ kind: "ESCALATED", severity: "P1", notify: true });
    expect(reduceCheck(loud.nextRow, checkOf(base), "s", t(2)).decision).toMatchObject({ kind: "RECOVERED", notify: true });
  });
});
