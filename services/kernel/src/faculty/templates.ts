import { FacultyVersion } from "../../../../packages/contracts/src/faculty.js";
import { MISSION_MEMORY_CLASSES } from "../mission/memory-port.js";
import { MISSION_RECIPE } from "../../../../packages/contracts/src/index.js";

/** ADR 0006 / cognition plan Stage C. Configuration only; no agents or processes are created. */
export function coreTeamTemplates(tenantId: string, changeRef: string): FacultyVersion[] {
  const roles = [
    ["primary-executive", "Primary Executive", "User interaction, intent resolution, mission synthesis and final explanation"],
    ["architect", "Architect", "System design, trade-offs, interface boundaries and ADR proposals"],
    ["builder", "Builder", "Implementation planning, code, tests, migrations and integration proposals"],
    ["operator", "Operator", "Deployment planning, observability, incident handling and recovery advice"],
    ["intelligence", "Intelligence", "Research, source comparison and uncertainty reporting"],
    ["archivist", "Archivist", "Memory provenance, consolidation proposals and contradiction detection"],
    ["guardian", "Guardian", "Security review, permission boundaries and policy advice"],
    ["verifier", "Verifier", "Independent acceptance checks, evidence inspection and challenge of unsupported claims"],
  ] as const;
  return roles.map(([id, name, purpose]) => {
    const analyst = id === "intelligence", reviewer = id === "verifier";
    return FacultyVersion.parse({
      tenantId, id, version: 1, name, purpose, responsibilities: [purpose],
      exclusions: ["Cannot admit, approve, assign, retry, complete or cancel tasks", "Cannot mutate canonical memory, identity, policy or faculty configuration", "Cannot execute tools or grant capabilities"],
      enabled: analyst || reviewer,
      permittedRecipes: analyst || reviewer ? [MISSION_RECIPE] : [],
      permittedOperations: analyst ? ["RUNTIME_ANALYSE"] : reviewer ? ["RUNTIME_REVIEW"] : [],
      permittedCapabilityClasses: analyst || reviewer ? ["MODEL_TEXT"] : [],
      permittedMemoryClasses: analyst ? MISSION_MEMORY_CLASSES : [],
      providerPreferences: analyst ? ["deepseek", "openrouter"] : ["openrouter", "deepseek"],
      preferredModelTraits: [reviewer ? "Independent evidence-grounded verification" : "Evidence-grounded structured output"],
      toolPermissions: [], authorityCeiling: "ADVISORY_TEXT_ONLY",
      contextBudget: { maxInputBytes: 512000, maxMemoryTokens: analyst ? 1500 : 0 },
      budget: { maxOutputTokens: analyst ? 6144 : 4096, maxAttempts: 1, maxCostUsd: null },
      review: analyst ? "INDEPENDENT_VERIFIER" : "KERNEL_RECONCILIATION",
      escalationRules: ["Refuse outside the admitted recipe and authority ceiling", "Provider failure ends the attempt; only KernelJSON can authorize new work"],
      policyVersion: "faculty-routing/v1", provenance: { source: "ADR-0006", changeRef },
    });
  });
}
