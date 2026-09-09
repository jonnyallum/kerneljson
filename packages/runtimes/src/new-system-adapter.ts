import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CapabilityInvocation,
  CapabilityResult,
  Evidence,
  Outcome,
  type Capability,
} from "../../contracts/src/index.js";
import {
  CapabilityError,
  CapabilityRegistry,
  capabilityDigest,
  REPOSITORY_READ,
  RepositoryReadInput,
  RepositoryReadOutput,
} from "../../capabilities/src/index.js";

const Digest64 = z.string().regex(/^[a-f0-9]{64}$/);

/** Target Spawner POST body (coordinate with new-system SpawnRequest + input_data). */
export const SpawnRequestBody = z.strictObject({
  task_id: z.string().min(1),
  caller: z.string().min(1),
  tenant_id: z.string().min(1),
  mission: z.literal("repository.read"),
  brief: z.string().min(1),
  skills: z.tuple([z.literal("repository.read")]),
  timeout_seconds: z.number().int().positive().max(3600),
  input_data: z.strictObject({
    repo_path: z.string().min(1).optional(),
    target_file: z.string().min(1).optional(),
    timeout_seconds: z.number().int().positive().max(3600).optional(),
  }),
  dry_run: z.boolean().optional(),
});
export type SpawnRequestBody = z.infer<typeof SpawnRequestBody>;

const SpawnerStructuredOutput = z.strictObject({
  capability: z.literal("repository.read"),
  project_name: z.string(),
  target_path: z.string(),
  bytes_read: z.number().int().nonnegative(),
  lines_read: z.number().int().nonnegative(),
  content_sha256: Digest64,
  output_hash: z.string().min(1),
  skills_mounted: z.array(z.string()),
  mutations_detected: z.literal(0),
  timeout_seconds: z.number().int().positive().max(3600),
  summary: z.string(),
});

const SpawnerResponse = z
  .object({
    task_id: z.string().optional(),
    worker_id: z.string().optional(),
    status: z.enum(["completed", "failed", "denied", "cancelled"]),
    exit_code: z.number().int().optional(),
    duration_ms: z.number().optional(),
    evidence: z.string().optional(),
    output: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type NewSystemRuntimeAdapterConfig = {
  spawnerBaseUrl: string;
  caller?: string;
  tenantId?: string;
  fetch?: typeof globalThis.fetch;
  /** Optional clock for deterministic tests. */
  now?: () => string;
};

export type RuntimeInvokeResult = {
  result: CapabilityResult;
  evidence: Evidence;
  outcome: Outcome;
  spawnRequest: SpawnRequestBody;
  executionKey: string;
  taskId: string;
  digests: {
    contentSha256: string;
    requestDigest: string;
    descriptorDigest: string;
    outputDigest: string;
  };
};

export class NewSystemRuntimeError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "UNSUPPORTED_CAPABILITY"
      | "SPAWNER_HTTP"
      | "SPAWNER_FAILED"
      | "INVALID_SPAWNER_OUTPUT"
      | "VERIFICATION_FAILED"
      | "MUTATIONS_DETECTED",
    message?: string,
  ) {
    super(message ?? code);
  }
}

function parseStructuredOutput(raw: unknown): z.infer<typeof SpawnerStructuredOutput> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new NewSystemRuntimeError("INVALID_SPAWNER_OUTPUT", "output is not JSON");
    }
  }
  const parsed = SpawnerStructuredOutput.safeParse(value);
  if (!parsed.success)
    throw new NewSystemRuntimeError(
      "INVALID_SPAWNER_OUTPUT",
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  return parsed.data;
}

/**
 * CapabilityInvocation → Spawner POST → CapabilityResult + Evidence.
 * Named NewSystemRuntimeAdapter (not AgentHubRuntime).
 */
export class NewSystemRuntimeAdapter {
  readonly #baseUrl: string;
  readonly #caller: string;
  readonly #tenantId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => string;
  readonly #registry: CapabilityRegistry;
  readonly #idempotency = new Map<string, RuntimeInvokeResult>();

  constructor(registry: CapabilityRegistry, config: NewSystemRuntimeAdapterConfig) {
    if (!config.spawnerBaseUrl || !/^https?:\/\//.test(config.spawnerBaseUrl))
      throw new Error("Invalid spawnerBaseUrl");
    this.#registry = registry;
    this.#baseUrl = config.spawnerBaseUrl.replace(/\/$/, "");
    this.#caller = config.caller ?? "kerneljson";
    this.#tenantId = config.tenantId ?? "estate";
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#now =
      config.now ??
      (() => {
        const d = new Date().toISOString();
        return d.endsWith("Z") ? d.replace(/Z$/, "+00:00") : d;
      });
  }

  describeRepositoryRead(): Capability {
    return this.#registry.describe(REPOSITORY_READ).metadata;
  }

  async invoke(raw: unknown): Promise<RuntimeInvokeResult> {
    const parsed = CapabilityInvocation.safeParse(raw);
    if (!parsed.success) throw new NewSystemRuntimeError("INVALID_REQUEST");
    const invocation = parsed.data;
    if (
      invocation.capability.id !== REPOSITORY_READ.id ||
      invocation.capability.version !== REPOSITORY_READ.version
    )
      throw new NewSystemRuntimeError("UNSUPPORTED_CAPABILITY");

    const cached = this.#idempotency.get(invocation.idempotencyKey);
    if (cached) {
      if (capabilityDigest(cached.result.capability) !== capabilityDigest(invocation.capability))
        throw new NewSystemRuntimeError("INVALID_REQUEST", "idempotency key conflict");
      if (cached.result.taskId !== invocation.taskId || cached.result.stepId !== invocation.stepId)
        throw new NewSystemRuntimeError("INVALID_REQUEST", "idempotency key conflict");
      return cached;
    }

    const input = RepositoryReadInput.safeParse(invocation.input);
    if (!input.success) throw new NewSystemRuntimeError("INVALID_REQUEST", "invalid input");

    const timeout = input.data.timeout_seconds ?? 120;
    const spawnRequest = SpawnRequestBody.parse({
      task_id: invocation.taskId,
      caller: this.#caller,
      tenant_id: this.#tenantId,
      mission: "repository.read",
      brief: `KJ-000000 repository.read${input.data.target_file ? ` of ${input.data.target_file}` : ""}`,
      skills: ["repository.read"],
      timeout_seconds: timeout,
      input_data: {
        ...(input.data.repo_path ? { repo_path: input.data.repo_path } : {}),
        ...(input.data.target_file ? { target_file: input.data.target_file } : {}),
        ...(input.data.timeout_seconds
          ? { timeout_seconds: input.data.timeout_seconds }
          : {}),
      },
      dry_run: false,
    });

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/v1/spawn`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(spawnRequest),
        redirect: "error",
      });
    } catch (error) {
      throw new NewSystemRuntimeError(
        "SPAWNER_HTTP",
        error instanceof Error ? error.message : "fetch failed",
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new NewSystemRuntimeError(
        "SPAWNER_HTTP",
        `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }

    const bodyJson: unknown = await response.json();
    const body = SpawnerResponse.safeParse(bodyJson);
    if (!body.success)
      throw new NewSystemRuntimeError("INVALID_SPAWNER_OUTPUT", "response shape");

    if (body.data.status !== "completed" || body.data.exit_code !== 0) {
      throw new NewSystemRuntimeError(
        "SPAWNER_FAILED",
        body.data.error ?? body.data.evidence ?? body.data.status,
      );
    }

    const structured = parseStructuredOutput(body.data.output);
    if (structured.mutations_detected !== 0)
      throw new NewSystemRuntimeError("MUTATIONS_DETECTED");

    const output = RepositoryReadOutput.parse(structured);
    const descriptor = this.#registry.describe(REPOSITORY_READ);
    const result = CapabilityResult.parse({
      runId: invocation.runId,
      taskId: invocation.taskId,
      stepId: invocation.stepId,
      trace: invocation.trace,
      capability: invocation.capability,
      idempotencyKey: invocation.idempotencyKey,
      requestDigest: capabilityDigest(invocation),
      descriptorDigest: descriptor.digest,
      output,
      outputDigest: capabilityDigest(output),
      verification: "PASSED",
    });

    try {
      this.#registry.verify(invocation, result);
    } catch (error) {
      throw new NewSystemRuntimeError(
        "VERIFICATION_FAILED",
        error instanceof CapabilityError ? error.code : "verify failed",
      );
    }

    const evidenceId = randomUUID();
    const evidence = Evidence.parse({
      id: evidenceId,
      taskId: invocation.taskId,
      stepId: invocation.stepId,
      type: "TOOL_RECEIPT",
      source: "new-system-spawner/repository.read",
      digest: output.content_sha256,
      capturedAt: this.#now(),
      metadata: {
        content_sha256: output.content_sha256,
        output_hash: output.output_hash,
        mutations_detected: 0,
        project_name: output.project_name,
        target_path: output.target_path,
        worker_id: body.data.worker_id ?? null,
        spawner_status: body.data.status,
        executionKey: invocation.taskId,
      },
    });

    const outcome = Outcome.parse({
      taskId: invocation.taskId,
      status: "COMPLETED",
      acceptanceResults: [
        {
          criterion:
            "repository.read returns content_sha256 (64 hex) with mutations_detected=0",
          passed: true,
          evidenceRefs: [evidenceId],
        },
      ],
      evidenceRefs: [evidenceId],
      summary: output.summary,
      completedAt: this.#now(),
    });

    const packed: RuntimeInvokeResult = {
      result,
      evidence,
      outcome,
      spawnRequest,
      executionKey: invocation.taskId,
      taskId: invocation.taskId,
      digests: {
        contentSha256: output.content_sha256,
        requestDigest: result.requestDigest,
        descriptorDigest: result.descriptorDigest,
        outputDigest: result.outputDigest,
      },
    };
    this.#idempotency.set(invocation.idempotencyKey, packed);
    return packed;
  }
}
