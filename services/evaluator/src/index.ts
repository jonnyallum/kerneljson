import type { z } from "zod";
import {
  EvaluationSuite,
  EvaluationReport,
  Digest,
  Json,
  Timestamp,
} from "../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../packages/capabilities/src/index.js";
// Deliberately synchronous: only bounded, deployment-owned pure candidates.
export interface EvaluationCandidate {
  digest: string;
  execute: (input: z.infer<typeof Json>) => unknown;
}
export function evaluate(
  rawSuite: EvaluationSuite,
  candidate: EvaluationCandidate,
  at: string,
): EvaluationReport {
  const suite = EvaluationSuite.parse(rawSuite);
  Digest.parse(candidate.digest);
  Timestamp.parse(at);
  const cases = suite.cases.map((c) => {
    const expectedDigest = capabilityDigest(c.expected);
    let output: unknown;
    try {
      output = candidate.execute(structuredClone(c.input));
    } catch {
      return {
        id: c.id,
        expectedDigest,
        actualDigest: null,
        passed: false,
        error: "EXECUTION_ERROR" as const,
      };
    }
    const parsed = Json.safeParse(output);
    if (!parsed.success)
      return {
        id: c.id,
        expectedDigest,
        actualDigest: null,
        passed: false,
        error: "INVALID_OUTPUT" as const,
      };
    const actualDigest = capabilityDigest(parsed.data);
    return {
      id: c.id,
      expectedDigest,
      actualDigest,
      passed: actualDigest === expectedDigest,
      error: null,
    };
  });
  return EvaluationReport.parse({
    evaluatorVersion: "golden-eval/1",
    suiteId: suite.id,
    suiteDigest: capabilityDigest(suite),
    candidateDigest: candidate.digest,
    createdAt: at,
    cases,
    passed: cases.every((c) => c.passed),
  });
}
export function promotionAllowed(
  raw: unknown,
  rawSuite: EvaluationSuite,
  candidateDigest: string,
): boolean {
  const parsed = EvaluationReport.safeParse(raw),
    suite = EvaluationSuite.parse(rawSuite);
  Digest.parse(candidateDigest);
  if (!parsed.success) return false;
  const report = parsed.data;
  return (
    report.passed &&
    report.suiteId === suite.id &&
    report.suiteDigest === capabilityDigest(suite) &&
    report.candidateDigest === candidateDigest &&
    report.cases.length === suite.cases.length &&
    suite.cases.every((c) =>
      report.cases.some(
        (r) =>
          r.id === c.id && r.expectedDigest === capabilityDigest(c.expected),
      ),
    )
  );
}
