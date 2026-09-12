import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { DATABASE, INGRESS, ADMIN, migrate, until, compose } from "./support/local.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";

/**
 * Gate 3 executor/verifier qualification against the ACTUAL production worker
 * entrypoint `services/kernel/src/index.ts` (not tests/support/worker.ts) behind a
 * real containerised Restate + Postgres. Proves the production path executes
 * claude_md_check/v1 end to end: sealed repository.read -> TOOL_RECEIPT -> verifier ->
 * ledger completion, and terminates as FAILED on digest drift.
 *
 * Gated on KJ_GATE3_LIVE=1 (needs the disposable validation `db` + `restate`). Skips
 * cleanly otherwise.
 */
const RUN = process.env["KJ_GATE3_LIVE"] === "1";
const run = RUN ? describe : describe.skip;

const WORKER_PORT = 9092;
const WORKER_URI = `http://host.docker.internal:${WORKER_PORT}`;
const APPROVED_BODY = "# CLAUDE.md\nApproved governance anchor for Gate 3.\n";
const APPROVED = createHash("sha256").update(Buffer.from(APPROVED_BODY, "utf8")).digest("hex");

run("Gate 3 executor — production worker (index.ts) end to end", () => {
  let pool: pg.Pool;
  let worker: ChildProcess | undefined;
  let repoRoot: string;
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const logs: string[] = [];

  const submission = (objective: string) => ({
    recipe: "claude_md_check/v1",
    intent: {
      id: randomUUID(),
      principal: { id: principalId, kind: "HUMAN" as const },
      tenant: { id: tenantId },
      source: "gate3-executor-test",
      objective,
      attachments: [],
      contextRefs: [],
      receivedAt: new Date().toISOString(),
      trace: { traceId: randomUUID(), correlationId: randomUUID() },
    },
  });

  const invoke = async (body: unknown): Promise<string> => {
    const taskId = compileIntent(body).task.id;
    await fetch(`${INGRESS}/KernelWorkflowV1/${taskId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    }).catch(() => undefined); // terminal FAILED surfaces as a non-2xx; the DB is authoritative
    return taskId;
  };

  const status = (taskId: string) =>
    until(
      () =>
        pool
          .query<{ status: string }>("select status from public.tasks where id=$1", [taskId])
          .then((r) => r.rows[0]?.status ?? "NONE"),
      (s) => s === "COMPLETED" || s === "FAILED",
      45000,
    );

  beforeAll(async () => {
    compose("up", "-d", "--wait", "db", "restate");
    pool = new pg.Pool({ connectionString: DATABASE });
    await until(() => pool.query("select 1").then(() => true), (v) => v, 60000);
    await migrate(pool);
    await pool.query("insert into principals(id,kind) values($1,'HUMAN') on conflict do nothing", [principalId]);
    await pool.query("insert into tenants(id,name) values($1,'gate3') on conflict do nothing", [tenantId]);
    await pool.query(
      "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'operator') on conflict do nothing",
      [tenantId, principalId],
    );

    repoRoot = mkdtempSync(join(tmpdir(), "kj-gate3-repo-"));
    writeFileSync(join(repoRoot, "CLAUDE.md"), APPROVED_BODY, "utf8");

    worker = spawn(process.execPath, ["--import", "tsx", "services/kernel/src/index.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: DATABASE,
        PORT: String(WORKER_PORT),
        KJ_REPO_ROOT: repoRoot,
        SCHED_RECIPE: "claude_md_check/v1",
        SCHED_APPROVED_SHA256: APPROVED,
        KERNELJSON_RELEASE_ID: "gate3-executor-qualification",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout?.on("data", (b: Buffer) => logs.push(b.toString()));
    worker.stderr?.on("data", (b: Buffer) => logs.push(b.toString()));

    // Register the production worker deployment with Restate (retries until it is up).
    await until(
      async () => {
        const r = await fetch(`${ADMIN}/deployments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uri: WORKER_URI, force: true }),
        });
        return r.status;
      },
      (s) => s === 200 || s === 201,
      60000,
    );
  }, 180000);

  afterAll(async () => {
    worker?.kill("SIGKILL");
    await pool?.end();
    if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
    try {
      compose("down", "--volumes");
    } catch {
      /* best effort */
    }
  });

  it("completes claude_md_check/v1 with a digest-verified TOOL_RECEIPT when CLAUDE.md matches", async () => {
    const taskId = await invoke(submission("gate3 pass"));
    expect(await status(taskId)).toBe("COMPLETED");
    const ev = await pool.query<{ type: string; digest: string; metadata: Record<string, unknown> }>(
      "select type,digest,metadata from public.evidence where task_id=$1",
      [taskId],
    );
    const receipt = ev.rows.find((r) => r.type === "TOOL_RECEIPT");
    expect(receipt).toBeTruthy();
    expect(receipt!.digest).toBe(APPROVED);
    expect(receipt!.metadata["content_sha256"]).toBe(APPROVED);
    expect(receipt!.metadata["mutations_detected"]).toBe(0);
    const outcome = await pool.query<{ status: string }>(
      "select status from public.outcomes where task_id=$1",
      [taskId],
    );
    expect(outcome.rows[0]?.status).toBe("COMPLETED");
  }, 120000);

  it("terminates FAILED (no COMPLETED) when CLAUDE.md drifts from the approved digest", async () => {
    writeFileSync(join(repoRoot, "CLAUDE.md"), APPROVED_BODY + "drifted line\n", "utf8");
    const taskId = await invoke(submission("gate3 drift"));
    expect(await status(taskId)).toBe("FAILED");
    const task = await pool.query<{ status: string }>("select status from public.tasks where id=$1", [taskId]);
    expect(task.rows[0]?.status).not.toBe("COMPLETED");
    const failed = await pool.query<{ type: string }>(
      "select type from public.task_events where task_id=$1 and type='TASK_FAILED'",
      [taskId],
    );
    expect(failed.rows.length).toBeGreaterThan(0);
  }, 120000);
});
