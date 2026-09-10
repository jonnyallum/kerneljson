import { z } from "zod";
import { Id, Json, Text, Timestamp } from "./common.js";
export const Evidence = z
  .strictObject({
    id: Id,
    taskId: Id,
    stepId: Id.optional(),
    type: z.enum([
      "DETERMINISTIC_RESULT",
      "TOOL_RECEIPT",
      "ARTIFACT",
      "HUMAN_DECISION",
    ]),
    source: Text,
    ref: Text.optional(),
    uri: z.url().optional(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    capturedAt: Timestamp,
    metadata: z.record(z.string(), Json),
  })
  .refine(
    (e) => Boolean(e.ref || e.uri || e.digest),
    "Evidence requires a machine-checkable reference or digest",
  );
export type Evidence = z.infer<typeof Evidence>;
