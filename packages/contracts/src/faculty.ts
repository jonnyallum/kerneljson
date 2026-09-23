import { z } from "zod";
import { Id } from "./common.js";
import { MemoryClass } from "./canonical-memory.js";

export const FacultyId = z.enum(["primary-executive", "architect", "builder", "operator", "intelligence", "archivist", "guardian", "verifier"]);
const Label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/);
const Text = z.string().min(1).max(1000);
export const FacultyVersion = z.strictObject({
  tenantId: Id,
  id: FacultyId,
  version: z.number().int().positive(),
  name: Text,
  purpose: Text,
  responsibilities: z.array(Text).min(1).max(20),
  exclusions: z.array(Text).min(1).max(20),
  enabled: z.boolean(),
  permittedRecipes: z.array(Label).max(20),
  permittedOperations: z.array(z.enum(["RUNTIME_ANALYSE", "RUNTIME_REVIEW"])).max(2),
  permittedCapabilityClasses: z.array(z.literal("MODEL_TEXT")).max(1),
  permittedMemoryClasses: z.array(MemoryClass).max(8),
  // Preferences never grant a provider credential or override the deployed provider allowlist.
  providerPreferences: z.array(z.enum(["deepseek", "openrouter"])).min(1).max(2),
  preferredModelTraits: z.array(Text).max(10),
  toolPermissions: z.array(z.never()).max(0),
  authorityCeiling: z.literal("ADVISORY_TEXT_ONLY"),
  contextBudget: z.strictObject({ maxInputBytes: z.number().int().positive().max(512000), maxMemoryTokens: z.number().int().nonnegative().max(1500) }),
  budget: z.strictObject({
    maxOutputTokens: z.number().int().positive().max(8192),
    maxAttempts: z.literal(1),
    // A monetary ceiling is expressible but must fail closed until a priced provider route exists.
    maxCostUsd: z.number().nonnegative().nullable(),
  }),
  review: z.enum(["INDEPENDENT_VERIFIER", "KERNEL_RECONCILIATION"]),
  escalationRules: z.array(Text).min(1).max(10),
  policyVersion: z.literal("faculty-routing/v1"),
  provenance: z.strictObject({ source: z.literal("ADR-0006"), changeRef: Text }),
});
export type FacultyVersion = z.infer<typeof FacultyVersion>;

export const FacultyPin = z.strictObject({
  tenantId: Id, taskId: Id, stepId: Id,
  operation: z.enum(["RUNTIME_ANALYSE", "RUNTIME_REVIEW"]),
  faculty: FacultyVersion,
  facultyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  routingReason: z.enum(["repo-analysis/analyst", "repo-analysis/independent-reviewer"]),
  provider: z.enum(["deepseek", "openrouter"]),
  model: Label,
  policyVersion: z.literal("faculty-routing/v1"),
});
export type FacultyPin = z.infer<typeof FacultyPin>;
