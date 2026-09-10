import { z } from "zod";
import { Id, Text, Timestamp } from "./common.js";
import { PrincipalRef, TenantRef, TraceRef } from "./identity.js";
export const IntentEnvelope = z.strictObject({
  id: Id,
  principal: PrincipalRef,
  tenant: TenantRef,
  source: Text,
  objective: Text,
  attachments: z.array(Text),
  contextRefs: z.array(Text),
  receivedAt: Timestamp,
  trace: TraceRef,
});
export type IntentEnvelope = z.infer<typeof IntentEnvelope>;
