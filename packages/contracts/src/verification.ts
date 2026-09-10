import { z } from "zod";
import { Id } from "./common.js";
export const VerificationReport = z
  .strictObject({
    taskId: Id,
    verifierVersion: z.literal("capability-uppercase/1"),
    status: z.enum(["PASSED", "FAILED"]),
    failures: z.array(z.string().min(1)),
    evidenceRefs: z.array(Id),
  })
  .refine(
    (r) =>
      r.status === "PASSED"
        ? r.failures.length === 0 && r.evidenceRefs.length > 0
        : r.failures.length > 0,
    "Inconsistent verification result",
  );
export type VerificationReport = z.infer<typeof VerificationReport>;
