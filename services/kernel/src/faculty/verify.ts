import { Evidence } from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { facultyEvidence, validateFacultyPin } from "./policy.js";

/** Called at the canonical completion boundary using DB pins, not model-supplied selection metadata. */
export function verifyFacultyEvidence(pins: readonly unknown[], evidence: readonly unknown[], required = false): void {
  const records = evidence.map(e => Evidence.parse(e));
  if (!pins.length) {
    if (required) throw new Error("Configured mission requires canonical faculty pins");
    if (records.some(e => e.metadata["faculty"])) throw new Error("Unpinned faculty evidence");
    return; // Historical missions before P6 retain their original completion contract.
  }
  if (pins.length !== 2) throw new Error("Both mission faculties must be pinned");
  const parsed = pins.map(validateFacultyPin);
  if (new Set(parsed.map(p => p.operation)).size !== 2) throw new Error("Missing independent faculty");
  for (const p of parsed) {
    const found = records.filter(e => e.taskId === p.taskId && e.stepId === p.stepId && e.source === `kerneljson:runtime/${p.operation === "RUNTIME_ANALYSE" ? "analyst" : "reviewer"}`);
    if (found.length !== 1) throw new Error("Missing faculty execution evidence");
    const e = found[0]!;
    if (capabilityDigest(e.metadata["faculty"] ?? null) !== capabilityDigest(facultyEvidence(p)) || e.metadata["provider"] !== p.provider || e.metadata["model"] !== p.model)
      throw new Error("Faculty evidence differs from canonical pin");
  }
}
