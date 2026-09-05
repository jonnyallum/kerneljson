import { z } from "zod";
import { CapabilityRef, Id, Text, Timestamp } from "./common.js";
export const Decision = z.enum(["ALLOW", "DENY", "APPROVAL_REQUIRED"]);
export const PolicyDecision = z.strictObject({
  id: Id,
  taskId: Id,
  stepId: Id.optional(),
  capability: CapabilityRef,
  decision: Decision,
  reasonCode: Text,
  evaluatedAt: Timestamp,
  policyVersion: Text,
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;
