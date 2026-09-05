import { z } from "zod";
import { Id, RiskClass, Text } from "./common.js";
export const Capability = z.strictObject({
  id: Id,
  version: Text,
  description: Text,
  inputSchemaRef: Text,
  outputSchemaRef: Text,
  riskClass: RiskClass,
  permissions: z.array(Text),
  implementationType: z.enum([
    "DETERMINISTIC",
    "MCP",
    "API",
    "SKILL",
    "SANDBOX",
    "HUMAN",
    "HYBRID",
  ]),
  verificationRequirements: z.array(Text).min(1),
});
export type Capability = z.infer<typeof Capability>;
