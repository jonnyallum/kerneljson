import { createHash } from "node:crypto";
import { CapabilityInvocation } from "../../packages/contracts/src/index.js";
import { CONDUCTOR_BRAIN_QUERY } from "../../packages/capabilities/src/index.js";

export const SAMPLE_BRAIN_TEXT = `## projects (limit=8, offset=0)
[{"id":"p1","name":"KernelJSON Migration","status":"active"},{"id":"p2","name":"AgentHub","status":"active"}]
`;

export const SAMPLE_RESULT_DIGEST = createHash("sha256")
  .update(SAMPLE_BRAIN_TEXT, "utf8")
  .digest("hex");

export const conductorBrainQueryInvocation = CapabilityInvocation.parse({
  runId: "60000000-0000-4000-8000-000000000040",
  taskId: "60000000-0000-4000-8000-000000000041",
  stepId: "60000000-0000-4000-8000-000000000042",
  trace: {
    traceId: "60000000-0000-4000-8000-000000000043",
    correlationId: "60000000-0000-4000-8000-000000000044",
  },
  capability: CONDUCTOR_BRAIN_QUERY,
  idempotencyKey: "phase6-conductor-brain-query-1",
  input: {
    query: "KernelJSON migration project knowledge",
    scope: "projects",
    limit: 8,
  },
});

export function mockBridgeOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    capability: "conductor.brain_query" as const,
    tool: "brain_query_projects" as const,
    table: "projects" as const,
    scope: "projects" as const,
    query: "KernelJSON migration project knowledge",
    limit: 8,
    text: SAMPLE_BRAIN_TEXT,
    row_count: 2,
    result_digest: SAMPLE_RESULT_DIGEST,
    result_chars: SAMPLE_BRAIN_TEXT.length,
    mutations: 0 as const,
    discovered_work: [
      {
        title: "Review Brain project rows for KernelJSON migration relevance",
        rationale: "Adapter returned bounded projects snapshot; KJ may admit follow-on read tasks",
        suggestedCapability: "conductor.brain_query",
        priorityHint: "P3",
        evidenceRefs: [] as string[],
      },
    ],
    duration_ms: 15,
    env_keys_loaded: ["ANTIGRAVITY_BRAIN_URL", "ANTIGRAVITY_BRAIN_SERVICE_ROLE_KEY"],
    transport: "private-stdio-import",
    ...overrides,
  };
}
