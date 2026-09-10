import { z } from "zod";
import {
  ExecutionPlan,
  Outcome,
  Evidence,
  CapabilityResult,
} from "../../contracts/src/index.js";
import { REPOSITORY_READ, capabilityDigest } from "../../capabilities/src/index.js";

export const KJ_000000_CRITERION =
  "repository.read returns content_sha256 (64 hex) with mutations_detected=0";

const Digest64 = z.string().regex(/^[a-f0-9]{64}$/);

export type RepositoryReadPlan = z.infer<typeof ExecutionPlan>;

function deriveStepId(taskId: string): string {
  const h = capabilityDigest(["kj-000000", taskId, "REPOSITORY_READ"]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Minimum KJ-000000 plan: single REPOSITORY_READ step. */
export function planRepositoryRead(taskId: string): RepositoryReadPlan {
  const sid = deriveStepId(taskId);
  return ExecutionPlan.parse({
    version: 1,
    taskId,
    recipe: "repository-read/v1",
    steps: [
      {
        id: sid,
        taskId,
        operation: "REPOSITORY_READ",
        dependencies: [],
        input: { source: "TASK_OBJECTIVE" },
      },
    ],
    resultStepId: sid,
  });
}

export type RepositoryReadVerification = {
  status: "PASSED" | "FAILED";
  failures: string[];
  evidenceRefs: string[];
  verifierVersion: "capability-repository-read/1";
  taskId: string;
};

/** Minimum verifier for KJ-000000 evidence + capability result. */
export function verifyRepositoryRead(args: {
  taskId: string;
  result: unknown;
  evidence: unknown;
  outcome: unknown;
}): RepositoryReadVerification {
  const failures: string[] = [];
  const check = (ok: boolean, reason: string) => {
    if (!ok) failures.push(reason);
  };
  let evidenceRefs: string[] = [];
  try {
    const result = CapabilityResult.parse(args.result);
    const evidence = Evidence.parse(args.evidence);
    const outcome = Outcome.parse(args.outcome);
    check(result.taskId === args.taskId, "TASK_MISMATCH");
    check(evidence.taskId === args.taskId, "EVIDENCE_TASK_MISMATCH");
    check(outcome.taskId === args.taskId, "OUTCOME_TASK_MISMATCH");
    check(
      result.capability.id === REPOSITORY_READ.id &&
        result.capability.version === REPOSITORY_READ.version,
      "CAPABILITY_MISMATCH",
    );
    const output = result.output as Record<string, unknown>;
    check(output.capability === "repository.read", "OUTPUT_CAPABILITY");
    check(output.mutations_detected === 0, "MUTATIONS_DETECTED");
    check(Digest64.safeParse(output.content_sha256).success, "CONTENT_SHA256");
    check(evidence.digest === output.content_sha256, "EVIDENCE_DIGEST_MISMATCH");
    check(evidence.type === "TOOL_RECEIPT", "EVIDENCE_TYPE");
    check(outcome.status === "COMPLETED", "OUTCOME_STATUS");
    check(
      outcome.acceptanceResults.every((r) => r.passed && r.evidenceRefs.length > 0),
      "ACCEPTANCE",
    );
    evidenceRefs = [...outcome.evidenceRefs];
  } catch {
    failures.push("PARSE_FAILED");
  }
  return {
    taskId: args.taskId,
    verifierVersion: "capability-repository-read/1",
    status: failures.length ? "FAILED" : "PASSED",
    failures,
    evidenceRefs: failures.length ? [] : evidenceRefs,
  };
}
