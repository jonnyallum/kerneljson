import * as restate from "@restatedev/restate-sdk";
import {
  CapabilityInvocation,
  type CapabilityResult,
} from "../../../packages/contracts/src/index.js";
import {
  CapabilityError,
  REPOSITORY_READ,
  createRuntimeRegistry,
} from "../../../packages/capabilities/src/index.js";
import { createSealedRepositoryReader } from "../../../packages/runtimes/src/repository-read-local.js";
import {
  createGithubReader,
  GithubReadError,
  type GithubReaderConfig,
} from "../../../packages/runtimes/src/github-read.js";

/**
 * Production capability-execution boundary (Gate 3): `CapabilityServiceV1`.
 *
 * A registered Restate service that executes capability-class I/O for the kernel
 * workflow. It performs the sealed-local `repository.read` inside a durable `ctx.run`
 * and returns a verified `CapabilityResult`. It deliberately does NOT touch the task
 * ledger — the calling `KernelWorkflowV1` persists the returned receipt into the same
 * task's ledger. Keeping the read here (not inline in the workflow) holds filesystem
 * I/O out of the deterministic orchestration path, and lets later capabilities reuse
 * the same seam without a second workflow.
 *
 * No shell, no network, no credential. A deterministic capability failure (bad path,
 * missing file, invalid input/output) is TERMINAL so it cannot retry forever.
 */

export const CAPABILITY_SERVICE = "CapabilityServiceV1" as const;

export interface CapabilityServiceConfig {
  /** Absolute repository root the sealed read is confined to. */
  repositoryRoot: string;
  /** Optional file-size cap (bytes); a larger file fails closed. */
  maxBytes?: number;
  /** KJ-P3: read-only GitHub evidence. The token is optional (public repositories). */
  github?: GithubReaderConfig;
}

/** KJ-P3: which repository to read. Validated as owner/repo by the reader. */
export interface GithubReadRequest {
  repo: string;
}

/** Request from the workflow. The target file is fixed by the caller (the recipe),
 *  never derived from task payload; `repo_path` is not accepted (root is config). */
export interface RepositoryReadRequest {
  runId: string;
  taskId: string;
  stepId: string;
  trace: { traceId: string; correlationId: string };
  idempotencyKey: string;
  targetFile: string;
}

export function createCapabilityService(config: CapabilityServiceConfig) {
  const registry = createRuntimeRegistry(
    createSealedRepositoryReader({
      repositoryRoot: config.repositoryRoot,
      ...(config.maxBytes !== undefined ? { maxBytes: config.maxBytes } : {}),
    }),
  );
  const githubReader = createGithubReader(config.github);
  return restate.service({
    name: CAPABILITY_SERVICE,
    handlers: {
      // KJ-P3: read-only GitHub facts for one repository. Transient upstream failures are
      // retried a bounded number of times; a deterministic failure (not found, no access,
      // renamed) is terminal so it cannot retry forever.
      githubRead: async (ctx: restate.Context, req: GithubReadRequest) =>
        ctx.run(
          "github.read",
          async () => {
            try {
              return await githubReader({ repo: req.repo });
            } catch (error) {
              if (error instanceof GithubReadError && error.retryable) throw error;
              throw new restate.TerminalError(
                error instanceof GithubReadError ? error.code : "GITHUB_READ_FAILED",
                { errorCode: 422 },
              );
            }
          },
          { maxRetryAttempts: 4, initialRetryInterval: 2_000 },
        ),
      repositoryRead: async (
        ctx: restate.Context,
        req: RepositoryReadRequest,
      ): Promise<CapabilityResult> =>
        ctx.run("repository.read", () => {
          const invocation = CapabilityInvocation.parse({
            runId: req.runId,
            taskId: req.taskId,
            stepId: req.stepId,
            trace: req.trace,
            capability: REPOSITORY_READ,
            idempotencyKey: req.idempotencyKey,
            input: { target_file: req.targetFile },
          });
          try {
            return registry.execute(invocation);
          } catch (error) {
            // Deterministic capability failure: fail closed, do not retry forever.
            throw new restate.TerminalError(
              error instanceof CapabilityError ? error.code : "CAPABILITY_FAILED",
              { errorCode: 422 },
            );
          }
        }),
    },
  });
}

export type CapabilityService = ReturnType<typeof createCapabilityService>;
