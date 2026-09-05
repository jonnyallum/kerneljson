import { z } from "zod";
import { Id, Text, Timestamp } from "./common.js";
import { PrincipalRef } from "./identity.js";
export const Approval = z
  .strictObject({
    id: Id,
    taskId: Id,
    stepId: Id.optional(),
    requestedFrom: PrincipalRef,
    requestedAt: Timestamp,
    status: z.enum(["PENDING", "GRANTED", "DENIED", "EXPIRED"]),
    resolvedAt: Timestamp.optional(),
    evidenceRef: Text.optional(),
  })
  .superRefine((a, ctx) => {
    if (a.status !== "PENDING" && (!a.resolvedAt || !a.evidenceRef))
      ctx.addIssue({
        code: "custom",
        message: "Resolution requires timestamp and evidence",
      });
    if (a.status === "PENDING" && (a.resolvedAt || a.evidenceRef))
      ctx.addIssue({
        code: "custom",
        message: "Pending approval cannot be resolved",
      });
    if (a.resolvedAt && Date.parse(a.resolvedAt) < Date.parse(a.requestedAt))
      ctx.addIssue({ code: "custom", message: "Resolution precedes request" });
  });
export type Approval = z.infer<typeof Approval>;
