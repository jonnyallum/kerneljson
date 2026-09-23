import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { FacultyPin, FacultyVersion } from "../packages/contracts/src/faculty.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";
import { coreTeamTemplates } from "../services/kernel/src/faculty/templates.js";
import { boundFacultyRequest, facultyEvidence, routeFaculty, validateFacultyPin } from "../services/kernel/src/faculty/policy.js";
import { verifyFacultyEvidence } from "../services/kernel/src/faculty/verify.js";
import type { ModelRequest } from "../packages/contracts/src/index.js";

const tenantId = randomUUID(), taskId = randomUUID(), stepId = randomUUID();
const templates = coreTeamTemplates(tenantId, "test:reviewed-seed");
function pin(over: Partial<FacultyVersion> = {}): FacultyPin {
  const faculty = FacultyVersion.parse({ ...templates.find(f => f.id === "intelligence")!, ...over });
  return FacultyPin.parse({ tenantId, taskId, stepId, operation: "RUNTIME_ANALYSE", faculty, facultyDigest: capabilityDigest(faculty), routingReason: "repo-analysis/analyst", provider: "deepseek", model: "deepseek-test", policyVersion: "faculty-routing/v1" });
}
const request: ModelRequest = { taskId, stepId, callId: randomUUID(), trace: { traceId: randomUUID(), correlationId: taskId }, messages: [{ role: "user", content: "safe text" }], maxOutputTokens: 6144 };
describe("P6 deterministic role and capability boundaries", () => {
  it("reuses all eight ADR roles with only two executable templates", () => {
    expect(templates).toHaveLength(8);
    expect(templates.filter(f => f.enabled).map(f => f.id)).toEqual(["intelligence", "verifier"]);
    expect(templates.every(f => f.toolPermissions.length === 0 && f.authorityCeiling === "ADVISORY_TEXT_ONLY")).toBe(true);
  });
  it("routes by sealed plan operation and refuses non-cognitive work", () => {
    expect(routeFaculty("RUNTIME_ANALYSE").id).toBe("intelligence");
    expect(routeFaculty("RUNTIME_REVIEW").id).toBe("verifier");
    for (const op of ["GITHUB_EVIDENCE", "RECONCILE", "REPOSITORY_READ"] as const) expect(() => routeFaculty(op)).toThrow("REFUSED");
  });
  it.each([
    { enabled: false }, { permittedOperations: [] }, { permittedRecipes: [] }, { permittedCapabilityClasses: [] },
    { providerPreferences: ["openrouter"] }, { review: "KERNEL_RECONCILIATION" },
  ] as Partial<FacultyVersion>[])("refuses restrictive configuration %j", over => { expect(() => validateFacultyPin(pin(over))).toThrow(); });
  it("refuses cross-tenant, role, digest and policy substitution", () => {
    for (const mutation of [{ tenantId: randomUUID() }, { facultyDigest: "0".repeat(64) }, { operation: "RUNTIME_REVIEW" }, { policyVersion: "model-override" }]) {
      expect(() => validateFacultyPin({ ...pin(), ...mutation })).toThrow();
    }
  });
  it("refuses authority, tools, secrets fields and self-retry configuration", () => {
    for (const mutation of [{ authorityCeiling: "OWNER" }, { toolPermissions: ["deploy"] }, { apiKey: "secret" }, { budget: { ...pin().faculty.budget, maxAttempts: 2 } }])
      expect(() => FacultyVersion.parse({ ...pin().faculty, ...mutation })).toThrow();
    expect(() => validateFacultyPin(pin({ budget: { ...pin().faculty.budget, maxCostUsd: 1 } }))).toThrow("PRICED_ROUTE_REQUIRED");
  });
  it("bounds output and UTF-8 input bytes and binds the task/step", () => {
    const p = pin({ budget: { maxOutputTokens: 100, maxAttempts: 1, maxCostUsd: null }, contextBudget: { maxInputBytes: 12, maxMemoryTokens: 0 } });
    expect(boundFacultyRequest(p, request).maxOutputTokens).toBe(100);
    expect(() => boundFacultyRequest(p, { ...request, messages: [{ role: "user", content: "😊😊😊😊" }] })).toThrow("CONTEXT_BUDGET");
    expect(() => boundFacultyRequest(p, { ...request, taskId: randomUUID() })).toThrow("BINDING");
  });
  it("permits provider substitution only through an explicit different pin", () => {
    expect(validateFacultyPin({ ...pin(), provider: "openrouter", model: "deepseek/deepseek-test" }).provider).toBe("openrouter");
    expect(() => validateFacultyPin({ ...pin(), provider: "unconfigured" })).toThrow();
  });
  it("rejects missing pins even if execution evidence omits faculty metadata", () => {
    expect(() => verifyFacultyEvidence([], [], true)).toThrow("requires canonical faculty pins");
  });
  it("records version/policy/digest without granting model mutation methods", () => {
    expect(facultyEvidence(pin())).toMatchObject({ faculty_id: "intelligence", faculty_version: 1, policy_version: "faculty-routing/v1" });
    const source = readFileSync("services/kernel/src/faculty/registry.ts", "utf8");
    expect(source).not.toMatch(/insert into public\.(tasks|approvals|memory_versions|faculty_versions)|update public\./);
    const iface = source.slice(source.indexOf("export interface MissionFacultyPort"), source.indexOf("export class"));
    expect(iface).not.toMatch(/admit|approve|promote|install|write|complete|cancel/);
  });
});
