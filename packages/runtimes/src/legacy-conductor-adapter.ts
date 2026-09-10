import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  CONDUCTOR_BRAIN_QUERY,
  ConductorBrainQueryInput,
  ConductorBrainQueryOutput,
} from "../../capabilities/src/index.js";

const Digest64 = z.string().regex(/^[a-f0-9]{64}$/);

const BridgeOk = z.object({
  ok: z.literal(true),
  capability: z.literal("conductor.brain_query"),
  tool: z.literal("brain_query_projects"),
  table: z.literal("projects"),
  scope: z.literal("projects"),
  query: z.string(),
  limit: z.number().int().min(1).max(8),
  text: z.string(),
  row_count: z.number().int().nonnegative(),
  result_digest: Digest64,
  result_chars: z.number().int().nonnegative(),
  mutations: z.literal(0),
  discovered_work: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string(),
        suggestedCapability: z.string(),
        priorityHint: z.string(),
        evidenceRefs: z.array(z.string()),
      }),
    )
    .optional(),
  duration_ms: z.number().optional(),
  env_keys_loaded: z.array(z.string()).optional(),
  transport: z.string().optional(),
  taskId: z.string().nullable().optional(),
  executionId: z.string().nullable().optional(),
});

const BridgeErr = z.object({
  ok: z.literal(false),
  code: z.string(),
  error: z.string(),
  mutations: z.literal(0).optional(),
});

/** Explicit pre-Conductor denials (collar). */
export const LEGACY_CONDUCTOR_DENIED = Object.freeze([
  "marcus_chat",
  "telegram_send",
  "spawner_run",
  "jaios_run",
  "cloud_escalate",
  "boardroom_post_dsp",
  "brain_log_learning",
  "orchestra_save_skill",
  "repository.write",
  "shell.execute",
  "email.send",
  "message.whatsapp",
  "message.telegram",
  "conductor.marcus_chat",
  "conductor.telegram_send",
  "conductor.spawner_run",
  "conductor.cloud_escalate",
] as const);

export type LegacyConductorAdapterConfig = {
  /** Absolute path to new-system adapters/legacy_conductor/brain_query_bridge.py */
  bridgePath: string;
  pythonPath?: string;
  conductorMcpDir?: string;
  envFile?: string;
  timeoutMs?: number;
  now?: () => string;
  /** Test seam: replace subprocess bridge. */
  runBridge?: (request: Record<string, unknown>) => Promise<unknown>;
};

export type LegacyConductorInvokeResult = {
  result: CapabilityResult;
  evidence: Evidence;
  outcome: Outcome;
  executionId: string;
  taskId: string;
  discoveredWork: Array<Record<string, unknown>>;
  digests: {
    resultDigest: string;
    requestDigest: string;
    descriptorDigest: string;
    outputDigest: string;
  };
  bridgeMeta: {
    transport: string;
    envKeysLoaded: string[];
    durationMs: number | null;
    rowCount: number;
  };
};

export class LegacyConductorError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "UNSUPPORTED_CAPABILITY"
      | "DENIED"
      | "INVALID_SCHEMA"
      | "UNAVAILABLE"
      | "TIMEOUT"
      | "BRAIN_ERROR"
      | "CRASH"
      | "INVALID_BRIDGE_OUTPUT"
      | "VERIFICATION_FAILED"
      | "MUTATIONS_DETECTED",
    message?: string,
  ) {
    super(message ?? code);
  }
}

function defaultNow(): string {
  const d = new Date().toISOString();
  return d.endsWith("Z") ? d.replace(/Z$/, "+00:00") : d;
}

function runBridgeSubprocess(
  config: LegacyConductorAdapterConfig,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const python = config.pythonPath ?? "python";
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: "1" };
    if (config.conductorMcpDir) env.CONDUCTOR_MCP_DIR = config.conductorMcpDir;
    // Strip accidental full-env inheritance markers — bridge loads min subset itself.
    const child = spawn(python, [config.bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new LegacyConductorError("TIMEOUT", `bridge exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LegacyConductorError("UNAVAILABLE", err.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const parsed: unknown = JSON.parse(stdout.trim() || "null");
        resolve(parsed);
      } catch {
        reject(
          new LegacyConductorError(
            "CRASH",
            `bridge exit=${code} invalid JSON stdout; stderr_chars=${stderr.length}`,
          ),
        );
      }
    });
    child.stdin.write(JSON.stringify(request), "utf8");
    child.stdin.end();
  });
}

/**
 * KJ CapabilityInvocation → private Conductor brain_query bridge → Evidence/Outcome.
 * Conductor is LEGACY EXECUTION RUNTIME only. KJ remains sole task authority.
 */
export class LegacyConductorAdapter {
  readonly #registry: CapabilityRegistry;
  readonly #config: LegacyConductorAdapterConfig;
  readonly #now: () => string;
  readonly #idempotency = new Map<string, LegacyConductorInvokeResult>();

  constructor(registry: CapabilityRegistry, config: LegacyConductorAdapterConfig) {
    if (!config.bridgePath) throw new Error("bridgePath required");
    this.#registry = registry;
    this.#config = config;
    this.#now = config.now ?? defaultNow;
  }

  describeBrainQuery(): Capability {
    return this.#registry.describe(CONDUCTOR_BRAIN_QUERY).metadata;
  }

  /** Collar: deny unauthorised tools/capabilities BEFORE any Conductor call. */
  assertAllowed(capabilityOrTool: string): void {
    const lowered = capabilityOrTool.trim();
    if (
      (LEGACY_CONDUCTOR_DENIED as readonly string[]).includes(lowered) ||
      lowered.startsWith("conductor.") && lowered !== "conductor.brain_query"
    ) {
      throw new LegacyConductorError("DENIED", `collar denied: ${lowered}`);
    }
    if (
      lowered !== "conductor.brain_query" &&
      lowered !== CONDUCTOR_BRAIN_QUERY.id &&
      lowered !== "brain_query_projects"
    ) {
      throw new LegacyConductorError("DENIED", `collar denied: ${lowered}`);
    }
  }

  async invoke(raw: unknown): Promise<LegacyConductorInvokeResult> {
    const parsed = CapabilityInvocation.safeParse(raw);
    if (!parsed.success) throw new LegacyConductorError("INVALID_REQUEST");
    const invocation = parsed.data;

    if (
      invocation.capability.id !== CONDUCTOR_BRAIN_QUERY.id ||
      invocation.capability.version !== CONDUCTOR_BRAIN_QUERY.version
    ) {
      throw new LegacyConductorError("UNSUPPORTED_CAPABILITY");
    }

    const cached = this.#idempotency.get(invocation.idempotencyKey);
    if (cached) {
      if (capabilityDigest(cached.result.capability) !== capabilityDigest(invocation.capability))
        throw new LegacyConductorError("INVALID_REQUEST", "idempotency key conflict");
      if (cached.result.taskId !== invocation.taskId || cached.result.stepId !== invocation.stepId)
        throw new LegacyConductorError("INVALID_REQUEST", "idempotency key conflict");
      return cached;
    }

    const input = ConductorBrainQueryInput.safeParse(invocation.input);
    if (!input.success) throw new LegacyConductorError("INVALID_SCHEMA", "invalid input");
    // Digest equality — no silent coerce
    if (capabilityDigest(input.data) !== capabilityDigest(invocation.input))
      throw new LegacyConductorError("INVALID_SCHEMA", "input digest mismatch");

    this.assertAllowed("conductor.brain_query");

    const executionId = invocation.stepId;
    const timeoutMs = this.#config.timeoutMs ?? 45_000;
    const bridgeRequest: Record<string, unknown> = {
      capability: "conductor.brain_query",
      tool: "brain_query_projects",
      args: {
        query: input.data.query,
        scope: "projects",
        limit: input.data.limit,
      },
      taskId: invocation.taskId,
      executionId,
      timeout_seconds: Math.min(60, Math.max(1, Math.floor(timeoutMs / 1000))),
    };
    if (this.#config.envFile) bridgeRequest.env_file = this.#config.envFile;

    const run = this.#config.runBridge ?? ((req) => runBridgeSubprocess(this.#config, req, timeoutMs));
    let bridgeRaw: unknown;
    try {
      bridgeRaw = await run(bridgeRequest);
    } catch (error) {
      if (error instanceof LegacyConductorError) throw error;
      throw new LegacyConductorError(
        "UNAVAILABLE",
        error instanceof Error ? error.message : "bridge failed",
      );
    }

    const err = BridgeErr.safeParse(bridgeRaw);
    if (err.success && err.data.ok === false) {
      const code = err.data.code;
      if (code === "DENIED") throw new LegacyConductorError("DENIED", err.data.error);
      if (code === "INVALID_SCHEMA") throw new LegacyConductorError("INVALID_SCHEMA", err.data.error);
      if (code === "TIMEOUT") throw new LegacyConductorError("TIMEOUT", err.data.error);
      if (code === "UNAVAILABLE") throw new LegacyConductorError("UNAVAILABLE", err.data.error);
      if (code === "CRASH") throw new LegacyConductorError("CRASH", err.data.error);
      throw new LegacyConductorError("BRAIN_ERROR", err.data.error);
    }

    const ok = BridgeOk.safeParse(bridgeRaw);
    if (!ok.success)
      throw new LegacyConductorError(
        "INVALID_BRIDGE_OUTPUT",
        ok.error.issues.map((i) => i.message).join("; "),
      );
    if (ok.data.mutations !== 0) throw new LegacyConductorError("MUTATIONS_DETECTED");

    const discoveredWork = (ok.data.discovered_work ?? []).map((d) => ({
      title: d.title,
      rationale: d.rationale,
      suggestedCapability: d.suggestedCapability,
      priorityHint: d.priorityHint,
      evidenceRefs: d.evidenceRefs,
    }));

    const output = ConductorBrainQueryOutput.parse({
      capability: "conductor.brain_query",
      scope: "projects",
      limit: ok.data.limit,
      query: input.data.query,
      tool: "brain_query_projects",
      row_count: ok.data.row_count,
      result_digest: ok.data.result_digest,
      result_chars: ok.data.result_chars,
      mutations: 0,
      discovered_work: discoveredWork,
      summary: `Legacy Conductor brain_query_projects returned ${ok.data.row_count} project row(s) (limit=${ok.data.limit}); mutations=0`,
      transport: "private-stdio-import",
      env_keys_loaded: ok.data.env_keys_loaded ?? [],
    });

    const descriptor = this.#registry.describe(CONDUCTOR_BRAIN_QUERY);
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
      throw new LegacyConductorError(
        "VERIFICATION_FAILED",
        error instanceof CapabilityError ? error.code : "verify failed",
      );
    }

    const evidenceId = randomUUID();
    const boundedRequestDigest = createHash("sha256")
      .update(
        JSON.stringify({
          query: input.data.query,
          scope: "projects",
          limit: input.data.limit,
        }),
      )
      .digest("hex");

    const evidence = Evidence.parse({
      id: evidenceId,
      taskId: invocation.taskId,
      stepId: invocation.stepId,
      type: "TOOL_RECEIPT",
      source: "legacy-conductor-adapter/conductor.brain_query",
      digest: output.result_digest,
      capturedAt: this.#now(),
      metadata: {
        executionId,
        capability: "conductor.brain_query",
        tool: "brain_query_projects",
        bounded_request_digest: boundedRequestDigest,
        result_digest: output.result_digest,
        row_count: output.row_count,
        mutations: 0,
        transport: "private-stdio-import",
        env_keys_loaded: output.env_keys_loaded,
        correlation_trace_id: invocation.trace.traceId,
        correlation_id: invocation.trace.correlationId,
        conductor_done_is_not_kj_completion: true,
        discovered_work_count: discoveredWork.length,
      },
    });

    // KJ decides completion from evidence — adapter proposes Outcome for KJ verification.
    const outcome = Outcome.parse({
      taskId: invocation.taskId,
      status: "COMPLETED",
      acceptanceResults: [
        {
          criterion:
            "conductor.brain_query returns result_digest (64 hex) with mutations=0 and scope=projects",
          passed: true,
          evidenceRefs: [evidenceId],
        },
      ],
      evidenceRefs: [evidenceId],
      summary: output.summary,
      completedAt: this.#now(),
    });

    const packed: LegacyConductorInvokeResult = {
      result,
      evidence,
      outcome,
      executionId,
      taskId: invocation.taskId,
      discoveredWork,
      digests: {
        resultDigest: output.result_digest,
        requestDigest: result.requestDigest,
        descriptorDigest: result.descriptorDigest,
        outputDigest: result.outputDigest,
      },
      bridgeMeta: {
        transport: "private-stdio-import",
        envKeysLoaded: output.env_keys_loaded,
        durationMs: ok.data.duration_ms ?? null,
        rowCount: output.row_count,
      },
    };
    this.#idempotency.set(invocation.idempotencyKey, packed);
    return packed;
  }
}
