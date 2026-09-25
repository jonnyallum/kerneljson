import { describe, expect, it } from "vitest";
import { bindingProvenanceVerdict } from "../services/kernel/src/health/release-provenance.js";
import { evaluateAuthority, evaluateReleaseParity } from "../services/kernel/src/health/evaluate.js";
import { loadHealthExpectations } from "../services/kernel/src/health/config.js";
import { reduceCheck } from "../services/kernel/src/alerting/reducer.js";
import type { BindingProvenance } from "../services/kernel/src/health/snapshot.js";

const at = "2026-09-16T20:00:00Z";
const exp = loadHealthExpectations({ EXPECTED_RELEASE_ID: "new" });
const healthy = (): BindingProvenance => ({ activeEpoch: "3", activeReleaseId: "new",
  currentBindingCount: 1, mismatchedBindingCount: 0, missingProvenanceCount: 0, legacyBindingCount: 2 });
function checks(p: BindingProvenance | null, running = "new", rejected = false) {
  return [...evaluateAuthority({ dbReachable: true, bindingProvenance: p,
    admittedFireTaskIdsMissingAdmission: [], admittedFireTaskIdsUnmaterialised: [],
    boundReleaseRejectionSeen: rejected }, at, exp.releaseId).checks,
  ...evaluateReleaseParity({ dbReachable: true, bindingProvenance: p,
    selfReportedReleaseId: running, boundReleaseRejectionSeen: rejected }, exp, at).checks];
}
describe("release epoch health semantics", () => {
  it.each([
    ["current release and historical baseline", healthy(), "HEALTHY"],
    ["wrong post-cutover binding", { ...healthy(), mismatchedBindingCount: 1 }, "CRITICAL"],
    ["zero current observations", { ...healthy(), currentBindingCount: 0 }, "UNKNOWN"],
    ["missing activation", null, "UNKNOWN"],
    ["baseline without activation", { ...healthy(), activeEpoch: "0", activeReleaseId: null }, "UNKNOWN"],
    ["missing binding provenance", { ...healthy(), missingProvenanceCount: 1 }, "UNKNOWN"],
    ["active release differs from expected", { ...healthy(), activeReleaseId: "wrong" }, "CRITICAL"],
    ["prior epoch violation remains visible", { ...healthy(), currentBindingCount: 0, mismatchedBindingCount: 1 }, "CRITICAL"],
  ] as const)("%s", (_name, p, status) => {
    const bindingChecks = checks(p).filter(c => ["authority.bindingReleaseConsistent", "releaseParity.recentBindingsConsistent"].includes(c.id));
    expect(bindingChecks).toHaveLength(2);
    for (const check of bindingChecks) {
      expect(check.status).toBe(status);
      if (status === "CRITICAL") expect(reduceCheck(null, check, exp.scheduleId, at).decision?.severity).toBe("P1");
    }
  });
  it("labels no observation explicitly", () => {
    expect(bindingProvenanceVerdict({ ...healthy(), currentBindingCount: 0 }).message).toContain("NO_OBSERVATION");
  });
  it("preserves running release mismatch", () => {
    expect(checks(healthy(), "old").find(c => c.id === "releaseParity.matchesExpected")?.status).toBe("CRITICAL");
  });
  it("preserves real rejection independently of historical bindings", () => {
    for (const id of ["releaseParity.noBoundReleaseRejection", "authority.noReleaseMismatchIncidents"]) {
      expect(checks(healthy(), "new", true).find(c => c.id === id)?.status).toBe("CRITICAL");
    }
  });
});
