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

/**
 * The single semantic assertion for a claude_md_check receipt: the read targeted a
 * CLAUDE.md file, its content hash is a 64-hex string equal to the approved digest,
 * and (when supplied) it detected zero mutations. Returns the failure codes ([] =
 * pass). This is the ONE place these checks live; both `verifyClaudeMdCheck` (over a
 * live CapabilityResult+evidence+outcome bundle) and the ledger completion backstop
 * (over the persisted TOOL_RECEIPT evidence metadata) call it, so the drift logic is
 * never duplicated divergently.
 */
export function assertClaudeMdReceipt(
  receipt: {
    targetPath: unknown;
    contentSha256: unknown;
    mutationsDetected?: unknown;
  },
  approvedContentSha256: string,
): string[] {
  const failures: string[] = [];
  const approvedOk = Digest64.safeParse(approvedContentSha256).success;
  if (!approvedOk) failures.push("APPROVED_DIGEST_SHAPE");
  if (!targetIsClaudeMd(receipt.targetPath)) failures.push("TARGET_NOT_CLAUDE_MD");
  if (
    receipt.mutationsDetected !== undefined &&
    receipt.mutationsDetected !== 0
  )
    failures.push("MUTATIONS_DETECTED");
  const shaOk =
    typeof receipt.contentSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(receipt.contentSha256);
  if (!shaOk) failures.push("CONTENT_SHA256");
  else if (approvedOk && receipt.contentSha256 !== approvedContentSha256)
    failures.push("CLAUDE_MD_DRIFT");
  return failures;
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
 * 64-hex content hash, evidence/outcome linkage) and adds the canary-specific,
 * deterministic assertions from `assertClaudeMdReceipt` (target is CLAUDE.md, content
 * hash equals the approved digest, approved digest well-formed). Content-shape and
 * mutations are already covered by `verifyRepositoryRead` over a parseable result, so
 * those codes are not double-added here.
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

  const parsed = CapabilityResult.safeParse(args.result);
  const output = parsed.success
    ? (parsed.data.output as Record<string, unknown>)
    : undefined;

  // Canary-specific semantic checks, shared with the ledger backstop. CONTENT_SHA256
  // and MUTATIONS_DETECTED are owned by the base over a parseable result; TARGET and
  // DRIFT are only meaningful over a parseable result.
  for (const code of assertClaudeMdReceipt(
    { targetPath: output?.["target_path"], contentSha256: output?.["content_sha256"] },
    args.approvedContentSha256,
  )) {
    if (code === "CONTENT_SHA256") continue;
    if ((code === "TARGET_NOT_CLAUDE_MD" || code === "CLAUDE_MD_DRIFT") && !parsed.success)
      continue;
    if (!failures.includes(code)) failures.push(code);
  }

  return {
    taskId: args.taskId,
    verifierVersion: "canary-claude-md-check/1",
    status: failures.length ? "FAILED" : "PASSED",
    failures,
    evidenceRefs: failures.length ? [] : base.evidenceRefs,
  };
}
