import { createHash } from "node:crypto";
import { CapabilityInvocation } from "../../packages/contracts/src/index.js";
import { REPOSITORY_READ } from "../../packages/capabilities/src/index.js";

/**
 * Deterministic fixtures for the S1 canary `claude_md_check/v1`. The canary is a
 * read-only repository.read of a CLAUDE.md file; these fixtures pin a fixed
 * CLAUDE.md body and its sha256 as the APPROVED digest so the positive path
 * matches and the negative (drift) path is a one-line override.
 */
export const CLAUDE_MD_BYTES = Buffer.from(
  "# CLAUDE.md (canary fixture)\nApproved governance anchor.\n",
  "utf8",
);

/** The APPROVED CLAUDE.md digest the canary schedule would pin. */
export const APPROVED_CONTENT_SHA256 = createHash("sha256")
  .update(CLAUDE_MD_BYTES)
  .digest("hex");

/** A different, valid 64-hex digest — a CLAUDE.md that drifted from approved. */
export const DRIFTED_CONTENT_SHA256 = createHash("sha256")
  .update(Buffer.concat([CLAUDE_MD_BYTES, Buffer.from("drift\n", "utf8")]))
  .digest("hex");

export const TARGET_PATH = "C:/Users/jonny/Desktop/kerneljson/CLAUDE.md";

export const claudeMdCheckInvocation = CapabilityInvocation.parse({
  runId: "60000000-0000-4000-8000-0000000000a0",
  taskId: "60000000-0000-4000-8000-0000000000a1",
  stepId: "60000000-0000-4000-8000-0000000000a2",
  trace: {
    traceId: "60000000-0000-4000-8000-0000000000a3",
    correlationId: "60000000-0000-4000-8000-0000000000a4",
  },
  capability: REPOSITORY_READ,
  idempotencyKey: "claude-md-check-canary-1",
  input: {
    repo_path: "C:/Users/jonny/Desktop/kerneljson",
    target_file: "CLAUDE.md",
    timeout_seconds: 45,
  },
});

export function mockClaudeMdStructuredOutput(
  overrides: Record<string, unknown> = {},
) {
  return {
    capability: "repository.read",
    project_name: "kerneljson",
    target_path: TARGET_PATH,
    bytes_read: CLAUDE_MD_BYTES.length,
    lines_read: 2,
    content_sha256: APPROVED_CONTENT_SHA256,
    output_hash: APPROVED_CONTENT_SHA256.slice(0, 12),
    skills_mounted: ["repository.read"],
    mutations_detected: 0,
    summary: "Read 'kerneljson' CLAUDE.md successfully with 0 mutations",
    ...overrides,
  };
}

export function mockClaudeMdCompletedResponse(
  overrides: Record<string, unknown> = {},
) {
  const structured = mockClaudeMdStructuredOutput(
    (overrides.structured as Record<string, unknown> | undefined) ?? {},
  );
  const { structured: _drop, ...rest } = overrides;
  return {
    task_id: claudeMdCheckInvocation.taskId,
    worker_id: "worker-mock-canary",
    status: "completed",
    exit_code: 0,
    duration_ms: 9,
    evidence: `repository.read verified: project='kerneljson', hash=${structured.output_hash}, mutations=0`,
    output: JSON.stringify(structured, null, 2),
    project_name: structured.project_name,
    output_hash: structured.output_hash,
    learning_logged: null,
    dsp_posted: false,
    ...rest,
  };
}
