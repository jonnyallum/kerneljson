import { z } from "zod";
import { Json, Timestamp } from "./common.js";
export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const EvaluationSuite = z
  .strictObject({
    id: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
    cases: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(128),
          input: Json,
          expected: Json,
        }),
      )
      .min(1)
      .max(100),
  })
  .refine(
    (s) => new Set(s.cases.map((c) => c.id)).size === s.cases.length,
    "Duplicate evaluation case",
  );
export type EvaluationSuite = z.infer<typeof EvaluationSuite>;
export const EvaluationReport = z
  .strictObject({
    evaluatorVersion: z.literal("golden-eval/1"),
    suiteId: z.string().min(1),
    suiteDigest: Digest,
    candidateDigest: Digest,
    createdAt: Timestamp,
    cases: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          expectedDigest: Digest,
          actualDigest: Digest.nullable(),
          passed: z.boolean(),
          error: z.enum(["EXECUTION_ERROR", "INVALID_OUTPUT"]).nullable(),
        }),
      )
      .min(1)
      .max(100),
    passed: z.boolean(),
  })
  .superRefine((r, ctx) => {
    if (
      new Set(r.cases.map((c) => c.id)).size !== r.cases.length ||
      r.cases.some(
        (c) =>
          c.passed !==
          (c.error === null && c.actualDigest === c.expectedDigest),
      ) ||
      r.passed !== r.cases.every((c) => c.passed)
    )
      ctx.addIssue({
        code: "custom",
        message: "Inconsistent evaluation result",
      });
  });
export type EvaluationReport = z.infer<typeof EvaluationReport>;
