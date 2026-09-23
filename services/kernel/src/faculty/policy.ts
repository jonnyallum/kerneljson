import { FacultyPin, FacultyVersion } from "../../../../packages/contracts/src/faculty.js";
import { MISSION_RECIPE, type ModelRequest, type PlanStep } from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";

export class FacultyRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}
export function routeFaculty(operation: PlanStep["operation"]) {
  if (operation === "RUNTIME_ANALYSE") return { id: "intelligence", reason: "repo-analysis/analyst" } as const;
  if (operation === "RUNTIME_REVIEW") return { id: "verifier", reason: "repo-analysis/independent-reviewer" } as const;
  throw new FacultyRefusal("FACULTY_OPERATION_REFUSED");
}
export function validateFacultyPin(raw: unknown): FacultyPin {
  const p = FacultyPin.parse(raw), f = FacultyVersion.parse(p.faculty), route = routeFaculty(p.operation);
  if (p.tenantId !== f.tenantId || f.id !== route.id || p.routingReason !== route.reason || p.policyVersion !== f.policyVersion || capabilityDigest(f) !== p.facultyDigest)
    throw new FacultyRefusal("FACULTY_BINDING_REFUSED");
  if (!f.enabled) throw new FacultyRefusal("FACULTY_DISABLED");
  if (!f.permittedRecipes.includes(MISSION_RECIPE) || !f.permittedOperations.includes(p.operation) || !f.permittedCapabilityClasses.includes("MODEL_TEXT") || !f.providerPreferences.includes(p.provider))
    throw new FacultyRefusal("FACULTY_CAPABILITY_REFUSED");
  if (p.operation === "RUNTIME_REVIEW" && (f.permittedMemoryClasses.length || f.contextBudget.maxMemoryTokens || f.review !== "KERNEL_RECONCILIATION"))
    throw new FacultyRefusal("FACULTY_REVIEW_ISOLATION_REFUSED");
  if (p.operation === "RUNTIME_ANALYSE" && f.review !== "INDEPENDENT_VERIFIER") throw new FacultyRefusal("FACULTY_REVIEW_REQUIRED");
  if (f.budget.maxCostUsd !== null) throw new FacultyRefusal("FACULTY_PRICED_ROUTE_REQUIRED");
  return p;
}
export function boundFacultyRequest(raw: FacultyPin, request: ModelRequest): ModelRequest {
  const p = validateFacultyPin(raw);
  if (request.taskId !== p.taskId || request.stepId !== p.stepId) throw new FacultyRefusal("FACULTY_REQUEST_BINDING_REFUSED");
  if (request.messages.reduce((n, m) => n + Buffer.byteLength(m.content, "utf8"), 0) > p.faculty.contextBudget.maxInputBytes)
    throw new FacultyRefusal("FACULTY_CONTEXT_BUDGET_REFUSED");
  return { ...request, maxOutputTokens: Math.min(request.maxOutputTokens, p.faculty.budget.maxOutputTokens) };
}
/** A bounded advisory role projection, never credentials, mutable identity, tools or authority. */
export function projectFacultyRequest(raw: FacultyPin, request: ModelRequest): ModelRequest {
  const p = validateFacultyPin(raw);
  const role = `Kernel faculty: ${p.faculty.name} v${p.faculty.version}.\nPurpose: ${p.faculty.purpose}\nAuthority: advisory text only; KernelJSON owns decisions and execution.\n`;
  const messages = request.messages.map((m, i) => i === 0 && m.role === "system" ? { ...m, content: role + m.content } : m);
  return boundFacultyRequest(p, { ...request, messages });
}
export function facultyEvidence(p: FacultyPin): Record<string, unknown> {
  validateFacultyPin(p);
  return { faculty_id: p.faculty.id, faculty_version: p.faculty.version, faculty_digest: p.facultyDigest,
    routing_reason: p.routingReason, policy_version: p.policyVersion, provider: p.provider, model: p.model };
}
