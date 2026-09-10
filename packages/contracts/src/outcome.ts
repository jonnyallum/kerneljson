import { z } from "zod";
import { Id, Text, Timestamp } from "./common.js";
export const Outcome = z
  .strictObject({
    taskId: Id,
    status: z.enum(["COMPLETED", "FAILED", "CANCELLED"]),
    acceptanceResults: z.array(
      z.strictObject({
        criterion: Text,
        passed: z.boolean(),
        evidenceRefs: z.array(Id),
      }),
    ),
    evidenceRefs: z.array(Id),
    summary: Text,
    completedAt: Timestamp,
  })
  .superRefine((o, ctx) => {
    if (
      o.status === "COMPLETED" &&
      (!o.evidenceRefs.length ||
        !o.acceptanceResults.length ||
        o.acceptanceResults.some((r) => !r.passed || !r.evidenceRefs.length))
    )
      ctx.addIssue({
        code: "custom",
        message: "Completion requires evidence for every acceptance result",
      });
    if (
      o.acceptanceResults.some((r) =>
        r.evidenceRefs.some((id) => !o.evidenceRefs.includes(id)),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Acceptance evidence missing from outcome",
      });
  });
export type Outcome = z.infer<typeof Outcome>;
