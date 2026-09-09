import { createHash } from "node:crypto";
import { CapabilityInvocation } from "../../packages/contracts/src/index.js";
import { REPOSITORY_READ } from "../../packages/capabilities/src/index.js";

export const FIXTURE_BYTES = Buffer.from("KJ-000000 fixture notes\n", "utf8");

export const CONTENT_SHA256 = createHash("sha256")
  .update(FIXTURE_BYTES)
  .digest("hex");

export const repositoryReadInvocation = CapabilityInvocation.parse({
  runId: "60000000-0000-4000-8000-000000000020",
  taskId: "60000000-0000-4000-8000-000000000021",
  stepId: "60000000-0000-4000-8000-000000000022",
  trace: {
    traceId: "60000000-0000-4000-8000-000000000023",
    correlationId: "60000000-0000-4000-8000-000000000024",
  },
  capability: REPOSITORY_READ,
  idempotencyKey: "kj-000000-proof-1",
  input: {
    repo_path: "C:/Users/jonny/Desktop/kerneljson",
    target_file: "NOTES.md",
    timeout_seconds: 45,
  },
});

export function mockSpawnerStructuredOutput(overrides: Record<string, unknown> = {}) {
  return {
    capability: "repository.read",
    project_name: "kerneljson",
    target_path: "C:/Users/jonny/Desktop/kerneljson/NOTES.md",
    bytes_read: FIXTURE_BYTES.length,
    lines_read: 1,
    content_sha256: CONTENT_SHA256,
    output_hash: CONTENT_SHA256.slice(0, 12),
    skills_mounted: ["repository.read"],
    mutations_detected: 0,
    timeout_seconds: 45,
    summary: "Read 'kerneljson' NOTES.md successfully with 0 mutations",
    ...overrides,
  };
}

/** HTTP body shape matching sibling Spawner PR #21 / feat/spawner-input-data-preserve. */
export function mockSpawnerCompletedResponse(overrides: Record<string, unknown> = {}) {
  const structured = mockSpawnerStructuredOutput(
    (overrides.structured as Record<string, unknown> | undefined) ?? {},
  );
  const { structured: _drop, ...rest } = overrides;
  return {
    task_id: repositoryReadInvocation.taskId,
    worker_id: "worker-mock-1",
    status: "completed",
    exit_code: 0,
    duration_ms: 12,
    evidence: `repository.read verified: project='kerneljson', hash=${structured.output_hash}, mutations=0`,
    output: JSON.stringify(structured, null, 2),
    project_name: structured.project_name,
    output_hash: structured.output_hash,
    learning_logged: null,
    dsp_posted: false,
    ...rest,
  };
}
