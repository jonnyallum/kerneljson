import { z } from "zod";
import { CapabilityResult } from "../../contracts/src/index.js";
import { verifyRepositoryRead } from "./kj-000000.js";

/**
 * S1 production canary — `claude_md_check/v1`.
 *
 * DESIGN: additive and isolated. The canary reuses the sealed, read-only
 * `repository.read` capability (Track A / KJ-000000) — it introduces NO new
 * capability, NO new plan operation, and NO shell. Its only job is to exercise
 * the full scheduler -> admission -> task -> evidence chain safely and to assert,
 * deterministically, that CLAUDE.md still matches an APPROVED content digest
 * (drift detection). The approved digest is supplied by the caller (the schedule
 * pins it), never hardcoded here, so this module has no fragile constant to churn.
 *
 * It is a pure verifier over a repository.read result/evidence/outcome plus the
 * approved digest. It performs no I/O. It cannot mutate anything and cannot create
 * schedules or tasks — the read-only capability and `mutations_detected === 0`
 * (enforced by `verifyRepositoryRead`) are the load-bearing safety guarantees.
 */
export const CLAUDE_MD_CHECK_CRITERION =
  "repository.read of CLAUDE.md returns content_sha256 == approved digest with mutations_detected=0";

const Digest64 = z.string().regex(/^[a-f0-9]{64}$/);

/** A read whose target file is CLAUDE.md (path may use `/` or `\` separators). */
function targetIsClaudeMd(targetPath: unknown): boolean {
  return (
    typeof targetPath === "string" &&
    /(^|[/\\])CLAUDE\.md$/.test(targetPath.trim())
  );
}

export type ClaudeMdCheckVerification = {
  status: "PASSED" | "FAILED";
  failures: string[];
  evidenceRefs: string[];
  verifierVersion: "canary-claude-md-check/1";
  taskId: string;
};

/**
 * Verify a `claude_md_check/v1` run. Reuses the KJ-000000 repository.read
 * verification (capability id, `repository.read` output, `mutations_detected===0`,
 * 64-hex content hash, evidence/outcome linkage) and adds two canary-specific,
 * deterministic assertions:
 *  - the read targeted a CLAUDE.md file (`TARGET_NOT_CLAUDE_MD`);
 *  - the read's content hash equals the approved digest (`CLAUDE_MD_DRIFT`).
 * The approved digest itself must be a 64-hex string (`APPROVED_DIGEST_SHAPE`).
 */
export function verifyClaudeMdCheck(args: {
  taskId: string;
  result: unknown;
  evidence: unknown;
  outcome: unknown;
  approvedContentSha256: string;
}): ClaudeMdCheckVerification {
  const base = verifyRepositoryRead({
    taskId: args.taskId,
    result: args.result,
    evidence: args.evidence,
    outcome: args.outcome,
  });
  const failures = [...base.failures];

  if (!Digest64.safeParse(args.approvedContentSha256).success)
    failures.push("APPROVED_DIGEST_SHAPE");

  // Canary-specific assertions are only meaningful over a parseable result.
  const parsed = CapabilityResult.safeParse(args.result);
  if (parsed.success) {
    const output = parsed.data.output as Record<string, unknown>;
    if (!targetIsClaudeMd(output["target_path"]))
      failures.push("TARGET_NOT_CLAUDE_MD");
    if (
      Digest64.safeParse(args.approvedContentSha256).success &&
      typeof output["content_sha256"] === "string" &&
      output["content_sha256"] !== args.approvedContentSha256
    )
      failures.push("CLAUDE_MD_DRIFT");
  }

  return {
    taskId: args.taskId,
    verifierVersion: "canary-claude-md-check/1",
    status: failures.length ? "FAILED" : "PASSED",
    failures,
    evidenceRefs: failures.length ? [] : base.evidenceRefs,
  };
}
