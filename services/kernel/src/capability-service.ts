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
import { createGithubActivityReader } from "../../../packages/runtimes/src/github-activity.js";
import {
  createGithubRunner,
  GithubRunnerError,
  type GithubRunnerConfig,
} from "../../../packages/runtimes/src/github-runner.js";

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
  /** code-change/v1: the scoped token and the repository allowlist. Absent, every code-change handler refuses. */
  codeChange?: Pick<GithubRunnerConfig, "token" | "allowedRepos">;
}

/** code-change/v1 requests. Each names the repository; the runner client refuses any outside the allowlist. */
export interface CodeChangeRepoRequest {
  repo: string;
}
export interface CodeChangeTaskRequest extends CodeChangeRepoRequest {
  taskId: string;
}
export interface CodeChangeDispatchRequest extends CodeChangeTaskRequest {
  baseSha: string;
  instructions: string;
}
export interface CodeChangeRunRequest extends CodeChangeTaskRequest {
  kind: "code" | "test";
}
export interface CodeChangeCaptureRequest extends CodeChangeTaskRequest {
  baseSha: string;
  defaultBranch: string;
  codeRunId: number;
  testRunId: number;
}
export interface CodeChangePrRequest extends CodeChangeTaskRequest {
  defaultBranch: string;
  expectedHeadSha: string;
  title: string;
  body: string;
}

/** KJ-P3: which repository to read. Validated as owner/repo by the reader. */
export interface GithubReadRequest {
  repo: string;
}

/** The morning brief: activity across every repository the token can see, for the window ending here. */
export interface GithubActivityRequest {
  windowEnd: string;
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
  const activityReader = createGithubActivityReader(config.github);
  const runner = config.codeChange ? createGithubRunner(config.codeChange) : undefined;
  /**
   * One GitHub call for code-change/v1, journaled. Transient failures retry a bounded number of times; anything
   * deterministic (refused repository, auth, not found, a moved head) is terminal with its code, never its body.
   */
  const codeChange = <T>(ctx: restate.Context, name: string, call: (r: NonNullable<typeof runner>) => Promise<T>) =>
    ctx.run(
      name,
      async () => {
        if (!runner) throw new restate.TerminalError("CODE_CHANGE_NOT_CONFIGURED", { errorCode: 422 });
        try {
          return await call(runner);
        } catch (error) {
          if (error instanceof GithubReadError && error.retryable) throw error;
          throw new restate.TerminalError(
            error instanceof GithubReadError || error instanceof GithubRunnerError ? error.code : "GITHUB_RUNNER_FAILED",
            { errorCode: 422 },
          );
        }
      },
      { maxRetryAttempts: 4, initialRetryInterval: 2_000 },
    );
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
      // The morning brief's evidence. Same retry and terminal rules as githubRead.
      githubActivity: async (ctx: restate.Context, req: GithubActivityRequest) =>
        ctx.run(
          "github.activity",
          async () => {
            try {
              return await activityReader({ windowEnd: req.windowEnd });
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
      // code-change/v1. The two dispatches look for the task's run first, so a retried dispatch never starts a second one.
      codeChangeBase: async (ctx: restate.Context, req: CodeChangeRepoRequest) =>
        codeChange(ctx, "code-change.base", (r) => r.baseCommit({ repo: req.repo })),
      codeChangeDispatch: async (ctx: restate.Context, req: CodeChangeDispatchRequest) =>
        codeChange(ctx, "code-change.dispatch", async (r) => {
          if (await r.findRun({ repo: req.repo, taskId: req.taskId, kind: "code" })) return { dispatched: false };
          await r.dispatchCode(req);
          return { dispatched: true };
        }),
      codeChangeDispatchTest: async (ctx: restate.Context, req: CodeChangeTaskRequest) =>
        codeChange(ctx, "code-change.dispatch-test", async (r) => {
          if (await r.findRun({ repo: req.repo, taskId: req.taskId, kind: "test" })) return { dispatched: false };
          await r.dispatchTest(req);
          return { dispatched: true };
        }),
      codeChangeRun: async (ctx: restate.Context, req: CodeChangeRunRequest) =>
        codeChange(ctx, "code-change.run", (r) => r.findRun(req)),
      codeChangeBranchHead: async (ctx: restate.Context, req: CodeChangeTaskRequest) =>
        codeChange(ctx, "code-change.branch-head", (r) => r.branchHead(req)),
      codeChangeCapture: async (ctx: restate.Context, req: CodeChangeCaptureRequest) =>
        codeChange(ctx, "code-change.capture", (r) => r.captureChange(req)),
      codeChangeOpenPr: async (ctx: restate.Context, req: CodeChangePrRequest) =>
        codeChange(ctx, "code-change.open-pr", (r) => r.openDraftPr(req)),
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
