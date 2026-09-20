import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { Context } from "@restatedev/restate-sdk";
import { DATABASE, compose, migrate, until, holdRuntime } from "./support/local.js";
import {
  KernelSubmission,
  MISSION_RECIPE,
  Task,
  TaskEvent,
  type Outcome,
} from "../packages/contracts/src/index.js";
import { Ledger } from "../services/kernel/src/ledger.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { planTask, projectStep } from "../services/kernel/src/planner/index.js";
import { digest } from "../services/kernel/src/deterministic.js";
import { runRepoAnalysisMission, type Emit } from "../services/kernel/src/mission/run.js";
import { enqueueMissionNotice, type MissionNotice } from "../services/kernel/src/mission/notify.js";
import { PgNotificationOutboxStore } from "../services/kernel/src/alerting/pg-outbox-store.js";
import type { ModelPort } from "../packages/models/src/index.js";
import { id as fixtureId, principal } from "../evals/fixtures/contracts.js";
import {
  CITED, REPO, analysisJson, cite, fakeClaude, fakeGrok, githubResult, makeFacts, reviewJson, shaFor,
} from "./support/mission-fixture.js";

/**
 * KJ-P3 end to end, against a REAL Postgres ledger and the REAL completion verifier. Only
 * the two model runtimes and GitHub are doubles, and the doubles read the prompt like a real
 * model would. Restate itself is exercised by the worker registration test and, live, by the
 * first mission; here `ctx.run` simply calls its action, which is the same thing on first
 * execution.
 */
const name = `kj_p3_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
let pool: pg.Pool;
let ledger: Ledger;
let outbox: PgNotificationOutboxStore;
let releaseRuntime = () => {};

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
  await admin.query(`create database ${name}`);
  pool = new pg.Pool({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`), max: 4 });
  // A late socket error on an idle client must never become an unhandled exception.
  pool.on("error", () => {});
  await migrate(pool);
  await pool.query("insert into principals(id,kind) values($1,$2)", [principal.id, principal.kind]);
  await pool.query("insert into tenants(id,name) values($1,$2)", [fixtureId, "fixture"]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,$3)", [fixtureId, principal.id, "owner"]);
  ledger = new Ledger(pool);
  outbox = new PgNotificationOutboxStore(pool);
});

afterAll(async () => {
  await pool?.end();
  // Wait for the sessions to actually close, then drop without FORCE. Forcing while a client is
  // still closing races its socket and surfaces as an unhandled 57P01 in the test run.
  await until(
    () => admin.query("select count(*)::int as n from pg_stat_activity where datname = $1", [name]),
    (r) => r.rows[0].n === 0,
    15000,
  );
  await admin.query(`drop database if exists ${name}`);
  await admin.end();
  releaseRuntime();
});

/** Deterministic ids and clock, so a replay presents the ledger with byte-identical writes. */
function deterministic(seed: string, startMs: number) {
  let n = 0;
  let t = 0;
  return {
    uuid: () => {
      const h = createHash("sha256").update(`${seed}:${n++}`).digest("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
    now: async () => new Date(startMs + 1000 * ++t).toISOString(),
  };
}

interface Scenario {
  objective?: string;
  /**
   * Run the workflow against a DIFFERENT objective than the one the ledger admitted, to model a
   * workflow that got the contract wrong. The ledger backstop must still hold the admitted one.
   */
  workflowObjective?: string;
  github?: () => Promise<{ facts: unknown; factsDigest: string }>;
  analyst?: ModelPort;
  reviewer?: ModelPort;
  notify?: (n: MissionNotice) => Promise<void>;
  afterVerify?: (taskId: string) => Promise<void>;
  intentId?: string;
  seed?: string;
  /** Pin the intent time so a replay presents the identical task. */
  createdMs?: number;
}

async function runMission(s: Scenario = {}): Promise<{ outcome: Outcome; taskId: string; notices: MissionNotice[] }> {
  const createdMs = s.createdMs ?? Date.now() - 120_000;
  const intentId = s.intentId ?? randomUUID();
  const seed = s.seed ?? randomUUID();
  const th = createHash("sha256").update(`${seed}:trace`).digest("hex");
  const trace = `${th.slice(0, 8)}-${th.slice(8, 12)}-4${th.slice(13, 16)}-a${th.slice(17, 20)}-${th.slice(20, 32)}`;
  const submission = KernelSubmission.parse({
    recipe: MISSION_RECIPE,
    intent: {
      id: intentId, principal, tenant: { id: fixtureId }, source: "test",
      objective: s.objective ?? `${REPO} What are the biggest risks?`,
      attachments: [], contextRefs: [], receivedAt: new Date(createdMs).toISOString(),
      trace: { traceId: trace, correlationId: trace },
    },
  });
  const compiled = compileIntent(submission);
  const plan = planTask(compiled.task, MISSION_RECIPE);
  let task = compiled.task;
  const det = deterministic(seed, createdMs + 10_000);
  const notices: MissionNotice[] = [];

  // Mirrors KernelWorkflowV1's emit: same event shape, and COMPLETED goes through ledger.finish.
  const emit: Emit = async (key, type, status, extra = {}, payload = {}) => {
    const occurredAt = await det.now();
    task = Task.parse({
      ...task, status,
      ...(key === "start" ? { startedAt: occurredAt } : {}),
      ...(status === "COMPLETED" ? { completedAt: occurredAt } : {}),
    });
    const event = TaskEvent.parse({
      id: det.uuid(), taskId: task.id, type, occurredAt, actor: task.principal, traceId: task.traceId,
      ...(extra.step ? { stepId: extra.step.id } : {}), payload: { status, ...payload },
    });
    if (status === "COMPLETED") return ledger.finish({ key, task, event, ...extra });
    await ledger.write({ key, task, event, ...extra });
    if (key === "verify") await s.afterVerify?.(task.id);
  };

  await emit("create", "TASK_CREATED", "RECEIVED", {}, { intent: submission.intent, recipe: plan.recipe, compilerVersion: 1 });
  await emit("intent", "INTENT_RESOLVED", "RECEIVED", {}, { intentId, correlationId: trace });
  await emit("compile", "PLAN_COMPILED", "COMPILED", { steps: plan.steps.map(projectStep) }, { plan, planDigest: digest(plan) });
  await emit("ready", "TASK_READY", "READY");
  await emit("start", "TASK_STARTED", "RUNNING");

  const ctx = { run: async (_n: string, action: () => unknown) => action() } as unknown as Pick<Context, "run">;
  const workflowTask = s.workflowObjective ? Task.parse({ ...task, objective: s.workflowObjective }) : task;
  const outcome = await runRepoAnalysisMission({
    ctx, task: workflowTask, plan, emit, now: det.now, uuid: det.uuid,
    githubRead: s.github ?? (async () => githubResult()),
    analyst: s.analyst ?? fakeClaude(),
    reviewer: s.reviewer ?? fakeGrok(),
    notify: async (n) => { notices.push(n); await (s.notify ?? ((x) => enqueueMissionNotice(outbox, x).then(() => undefined)))(n); },
  });
  return { outcome, taskId: task.id, notices };
}

const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
const taskStatus = async (id: string) => (await q<{ status: string }>("select status from public.tasks where id=$1", [id]))[0]?.status;
const evidenceOf = (id: string) => q<{ source: string; type: string; digest: string; metadata: Record<string, unknown> }>(
  "select source, type, digest, metadata from public.evidence where task_id=$1 order by captured_at, source", [id]);
const noticesOf = (id: string) => q<{ check_id: string; severity: string; status: string; kind: string }>(
  "select check_id, severity, status, kind from kernel_private.notification_outbox where check_id like $1", [`MISSION.repoAnalysis.${id.slice(0, 8)}.%`]);

describe("KJ-P3 repository-analysis mission, end to end", () => {
  it("completes only on evidence: four evidence rows, an accepted reconciliation, one P3 notice", async () => {
    const { outcome, taskId } = await runMission();
    expect(outcome.status).toBe("COMPLETED");
    expect(outcome.summary).toMatch(/^Accepted: KernelJSON is a durable task kernel/);
    expect(await taskStatus(taskId)).toBe("COMPLETED");

    const ev = await evidenceOf(taskId);
    expect(ev.map((e) => e.source).sort()).toEqual([
      "kerneljson:github-read/v1", "kerneljson:mission-reconcile/v1", "kerneljson:runtime/analyst", "kerneljson:runtime/reviewer",
    ]);
    expect(outcome.evidenceRefs).toHaveLength(4);
    const rec = ev.find((e) => e.source === "kerneljson:mission-reconcile/v1")!;
    expect(rec.metadata["decision"]).toBe("ACCEPTED");
    expect(rec.metadata).toMatchObject({ contract: { requestedFindings: null, minFindings: 1, maxFindings: 8 }, findingCount: 1 });
    expect(rec.metadata["findingEvidenceDigests"]).toHaveLength(1);
    const analyst = ev.find((e) => e.source === "kerneljson:runtime/analyst")!;
    expect(analyst.metadata).toMatchObject({ role: "analyst", provider: "openrouter", model: "anthropic/claude-test", response_model: "anthropic/claude-test" });
    expect(analyst.digest).toBe(createHash("sha256").update(String(analyst.metadata["text"])).digest("hex"));
    expect(JSON.stringify(ev)).not.toMatch(/sk-or-v1|Bearer /);

    const steps = await q<{ status: string }>("select status from public.task_steps where task_id=$1", [taskId]);
    expect(steps.map((s) => s.status)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"]);
    const types = (await q<{ type: string }>("select type from public.task_events where task_id=$1 order by occurred_at", [taskId])).map((e) => e.type);
    expect(types).toContain("TASK_COMPLETED");
    expect(types.filter((t) => t === "STEP_COMPLETED")).toHaveLength(4);

    expect(await noticesOf(taskId)).toEqual([{ check_id: `MISSION.repoAnalysis.${taskId.slice(0, 8)}.completed`, severity: "P3", status: "PENDING", kind: "NEW" }]);
  });

  const rejected: Array<[string, Scenario, string]> = [
    ["the reviewer rejects", { reviewer: fakeGrok({ verdict: "reject" }) }, "review_verdict_acceptable"],
    ["the reviewer flags an unsupported finding", { reviewer: fakeGrok({ unsupported: [0] }) }, "review_flags_no_unsupported_findings"],
    ["the analyst cites a file that is not in the GitHub evidence", { analyst: fakeClaude({ paths: [...CITED, "services/kernel/src/imaginary.ts"] }) }, "analysis_paths_exist_in_evidence"],
    ["the analyst cites a real path with an object id that does not match the captured commit", { analyst: fakeClaude({ evidence: [{ path: "README.md", blobSha: "0".repeat(12) }] }) }, "analysis_evidence_binds_to_commit"],
    ["the analyst cites another commit's version of the same files", { analyst: fakeClaude({ evidence: CITED.map((p) => cite(p, "another-commit")) }) }, "analysis_evidence_binds_to_commit"],
    ["a finding cites nothing", { analyst: fakeClaude({ evidence: [] }) }, "analysis_findings_cited"],
    ["the question asked for three findings and the analyst returned eight", { objective: `${REPO} findings=3 Identify the three highest-value improvements`, analyst: fakeClaude({ findings: 8 }) }, "analysis_finding_count_within_contract"],
    ["the question asked for three findings and the analyst returned two", { objective: `${REPO} findings=3 Identify the three highest-value improvements`, analyst: fakeClaude({ findings: 2 }) }, "analysis_finding_count_within_contract"],
    ["nothing was asked for and the analyst returned nine (over the default ceiling of eight)", { analyst: fakeClaude({ findings: 9 }) }, "analysis_finding_count_within_contract"],
    ["the analyst reports a different head sha", { analyst: fakeClaude({ headSha: "f".repeat(40) }) }, "analysis_head_sha_matches_evidence"],
    ["the reviewer did not review this analysis (wrong digest)", { reviewer: fakeGrok({ echoDigest: "0".repeat(64) }) }, "review_binds_to_analysis"],
    ["the reviewer is the same model as the analyst (not independent)", { reviewer: fakeGrok({ responseModel: "anthropic/claude-test" }) }, "reviewer_is_independent"],
    ["the analyst is not an allowed runtime family", { analyst: fakeClaude({ responseModel: "openai/gpt-test" }) }, "analyst_runtime_allowed"],
    ["both runtimes are DeepSeek but the reviewer is the same model", { analyst: fakeClaude({ model: "deepseek-v4-pro", responseModel: "deepseek-v4-pro" }), reviewer: fakeGrok({ model: "deepseek-v4-pro", responseModel: "deepseek-v4-pro" }) }, "reviewer_is_independent"],
    ["the analyst answers in prose instead of the required JSON", { analyst: fakeClaude({ reply: "Looks great, ship it!" }) }, "analysis_schema_valid"],
  ];
  for (const [label, scenario, check] of rejected) {
    it(`ends FAILED with evidence and a P2 notice when ${label}`, async () => {
      const { outcome, taskId } = await runMission(scenario);
      expect(outcome.status).toBe("FAILED");
      expect(outcome.summary).toContain("mission REJECTED");
      expect(outcome.summary).toContain(check);
      expect(await taskStatus(taskId)).toBe("FAILED");
      const ev = await evidenceOf(taskId);
      expect(ev).toHaveLength(4);
      expect(ev.find((e) => e.source === "kerneljson:mission-reconcile/v1")!.metadata["decision"]).toBe("REJECTED");
      expect(await noticesOf(taskId)).toEqual([{ check_id: `MISSION.repoAnalysis.${taskId.slice(0, 8)}.failed`, severity: "P2", status: "PENDING", kind: "NEW" }]);
    });
  }

  it("completes on a DeepSeek pair of two different models, and records that it is the weaker same-lineage pairing", async () => {
    const { outcome, taskId } = await runMission({
      analyst: fakeClaude({ model: "deepseek-v4-flash", responseModel: "deepseek-v4-flash", provider: "deepseek" }),
      reviewer: fakeGrok({ model: "deepseek-v4-pro", responseModel: "deepseek-v4-pro", provider: "deepseek" }),
    });
    expect(outcome.status).toBe("COMPLETED");
    const ev = await evidenceOf(taskId);
    expect(ev.find((e) => e.source === "kerneljson:runtime/analyst")!.metadata["response_model"]).toBe("deepseek-v4-flash");
    expect(ev.find((e) => e.source === "kerneljson:runtime/reviewer")!.metadata["response_model"]).toBe("deepseek-v4-pro");
    expect(ev.find((e) => e.source === "kerneljson:mission-reconcile/v1")!.metadata).toMatchObject({
      decision: "ACCEPTED", analystModel: "deepseek-v4-flash", reviewerModel: "deepseek-v4-pro",
      independence: { analystProvider: "deepseek", reviewerProvider: "deepseek", crossProvider: false, crossFamily: false },
    });
  });

  it("KJ-P3.1 completes on a cross-provider pair and records requested model, reported model, provider and artifact digest for each role", async () => {
    const { outcome, taskId } = await runMission({
      analyst: fakeClaude({ model: "deepseek-v4-flash", responseModel: "deepseek-v4-flash", provider: "deepseek" }),
      reviewer: fakeGrok({ model: "anthropic/claude-sonnet-5", responseModel: "anthropic/claude-sonnet-5-20260901", provider: "openrouter" }),
    });
    expect(outcome.status).toBe("COMPLETED");
    const ev = await evidenceOf(taskId);
    const analyst = ev.find((e) => e.source === "kerneljson:runtime/analyst")!;
    const reviewer = ev.find((e) => e.source === "kerneljson:runtime/reviewer")!;
    expect(analyst.metadata).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash", response_model: "deepseek-v4-flash" });
    // What was asked for and what the router says answered are recorded separately, as reported by the provider.
    expect(reviewer.metadata).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-5", response_model: "anthropic/claude-sonnet-5-20260901" });
    for (const e of [analyst, reviewer]) {
      expect(e.digest).toBe(createHash("sha256").update(String(e.metadata["text"])).digest("hex"));
      expect(e.metadata["output_digest"]).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    }
    expect(ev.find((e) => e.source === "kerneljson:mission-reconcile/v1")!.metadata).toMatchObject({
      decision: "ACCEPTED",
      independence: { analystProvider: "deepseek", reviewerProvider: "openrouter", analystFamily: "deepseek", reviewerFamily: "anthropic", crossProvider: true, crossFamily: true },
    });
  });

  it("KJ-P3.1 completes a mission that asked for exactly three findings and got three, and tells the analyst so", async () => {
    const seen: string[] = [];
    const inner = fakeClaude({ findings: 3 });
    const analyst: ModelPort = { generate: async (r) => { seen.push(r.messages.map((m) => m.content).join("\n")); return inner.generate(r); } };
    const { outcome, taskId } = await runMission({ objective: `${REPO} findings=3 Identify the three highest-value improvements`, analyst });
    expect(outcome.status).toBe("COMPLETED");
    expect(seen[0]).toContain("EXACTLY 3 findings");
    expect(seen[0]).toContain("Identify the three highest-value improvements");
    expect(seen[0]).not.toContain("findings=3");
    const rec = (await evidenceOf(taskId)).find((e) => e.source === "kerneljson:mission-reconcile/v1")!;
    expect(rec.metadata).toMatchObject({ decision: "ACCEPTED", findingCount: 3, contract: { requestedFindings: 3, minFindings: 3, maxFindings: 3 } });
    expect(rec.metadata["findingEvidenceDigests"]).toHaveLength(3);
  });

  it("fails closed and leaves failure evidence when the analyst provider errors, never reaching the reviewer", async () => {
    let reviewerCalled = false;
    const { outcome, taskId } = await runMission({
      analyst: fakeClaude({ reply: { fail: "RATE_LIMIT" } }),
      reviewer: { generate: async (r) => { reviewerCalled = true; return fakeGrok().generate(r); } },
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.summary).toBe("mission FAILED: ANALYST_RATE_LIMIT");
    expect(reviewerCalled).toBe(false);
    const ev = await evidenceOf(taskId);
    expect(ev.map((e) => e.source).sort()).toEqual(["kerneljson:github-read/v1", "kerneljson:runtime/analyst"]);
    expect(ev.find((e) => e.source === "kerneljson:runtime/analyst")!.metadata).toMatchObject({ error: "RATE_LIMIT", retryable: true, role: "analyst" });
    expect((await noticesOf(taskId))[0]).toMatchObject({ severity: "P2" });
  });

  it("fails with evidence, without calling a runtime or throwing, when the prompt cannot fit the port limit", async () => {
    // 1000 paths of 250 characters is far beyond the 128k prompt limit but valid GitHub evidence.
    const huge = makeFacts({
      tree: Array.from({ length: 1000 }, (_, i) => {
        const path = `${String(i).padStart(4, "0")}/${"x".repeat(244)}`;
        return { path, type: "blob" as const, sha: shaFor(path) };
      }),
    });
    let called = false;
    const spy = { generate: async () => { called = true; throw new Error("must not be called"); } } as ModelPort;
    const { outcome, taskId } = await runMission({ github: async () => githubResult(huge), analyst: spy, reviewer: spy });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.summary).toBe("mission FAILED: ANALYST_PROMPT_TOO_LARGE");
    expect(called).toBe(false);
    expect((await evidenceOf(taskId)).map((e) => e.source).sort()).toEqual(["kerneljson:github-read/v1", "kerneljson:runtime/analyst"]);
    expect(await taskStatus(taskId)).toBe("FAILED");
  });

  it("fails with evidence when the GitHub read fails, and never calls either runtime", async () => {
    let called = false;
    const spy = { generate: async () => { called = true; throw new Error("must not be called"); } } as ModelPort;
    const { outcome, taskId } = await runMission({ github: async () => { throw new Error("NOT_FOUND"); }, analyst: spy, reviewer: spy });
    expect(outcome.summary).toBe("mission FAILED: GITHUB_NOT_FOUND");
    expect(called).toBe(false);
    expect((await evidenceOf(taskId)).map((e) => e.source)).toEqual(["kerneljson:github-read/v1"]);
    expect(await taskStatus(taskId)).toBe("FAILED");
  });

  it("refuses to trust GitHub evidence whose digest does not match its facts", async () => {
    const { outcome } = await runMission({ github: async () => ({ ...githubResult(), factsDigest: "0".repeat(64) }) });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.summary).toMatch(/^mission FAILED: GITHUB_/);
  });

  describe("the ledger is the backstop: it refuses a completion the workflow got wrong", () => {
    it("refuses when evidence describes a different repository than the task asked about", async () => {
      const wrong = makeFacts({ repo: "someone-else/other-repo" });
      const { outcome, taskId } = await runMission({ github: async () => githubResult(wrong) });
      expect(outcome.status).toBe("FAILED");
      expect(outcome.summary).toBe("Persisted completion verification failed");
      expect(await taskStatus(taskId)).toBe("FAILED");
    });

    it("KJ-P3.1 refuses a workflow that accepted eight findings when the admitted objective asked for three", async () => {
      // The workflow is handed a relaxed objective, so it accepts. The ledger re-derives the contract
      // from the immutable task it admitted, so its recomputed reconciliation rejects.
      const { outcome, taskId } = await runMission({
        objective: `${REPO} findings=3 Identify the three highest-value improvements`,
        workflowObjective: `${REPO} Identify the three highest-value improvements`,
        analyst: fakeClaude({ findings: 8 }),
      });
      expect(outcome.status).toBe("FAILED");
      expect(outcome.summary).toBe("Persisted completion verification failed");
      expect(await taskStatus(taskId)).toBe("FAILED");
    });

    it("KJ-P3.1 the control for that test: the same eight findings complete when the admitted objective allows them", async () => {
      const { outcome } = await runMission({
        objective: `${REPO} Identify the highest-value improvements`,
        workflowObjective: `${REPO} Identify the highest-value improvements`,
        analyst: fakeClaude({ findings: 8 }),
      });
      expect(outcome.status).toBe("COMPLETED");
    });

    it("refuses when a persisted step no longer matches its evidence", async () => {
      const { outcome, taskId } = await runMission({
        afterVerify: async (id) => {
          await pool.query("update task_steps set contract=jsonb_set(contract,'{output,head_sha}','\"forged\"') where task_id=$1 and contract->>'kind'='TOOL_CALL'", [id]);
        },
      });
      expect(outcome.status).toBe("FAILED");
      expect(outcome.summary).toBe("Persisted completion verification failed");
      expect(await taskStatus(taskId)).toBe("FAILED");
    });

    it("either blocks tampering with persisted runtime text or refuses the completion (never accepts a forged review)", async () => {
      let tampered = false;
      const { outcome } = await runMission({
        afterVerify: async (id) => {
          const forged = reviewJson({ analysisText: analysisJson(), verdict: "approve" });
          try {
            await pool.query("update evidence set metadata=jsonb_set(metadata,'{text}',to_jsonb($2::text)) where task_id=$1 and source='kerneljson:runtime/reviewer'", [id, forged + " "]);
            tampered = true;
          } catch { tampered = false; }
        },
      });
      expect(outcome.status).toBe(tampered ? "FAILED" : "COMPLETED");
    });
  });

  it("is replay-safe: the same mission again yields the same outcome, evidence and exactly one notice", async () => {
    const intentId = randomUUID();
    const seed = randomUUID();
    const createdMs = Date.now() - 120_000;
    const first = await runMission({ intentId, seed, createdMs });
    const second = await runMission({ intentId, seed, createdMs });
    expect(second.taskId).toBe(first.taskId);
    expect(second.outcome).toEqual(first.outcome);
    expect(await evidenceOf(first.taskId)).toHaveLength(4);
    expect(await noticesOf(first.taskId)).toHaveLength(1);
    expect(await q("select id from public.outcomes where task_id=$1", [first.taskId])).toHaveLength(1);
  });

  it("never lets a notification failure change the outcome", async () => {
    const { outcome, taskId } = await runMission({ notify: async () => { throw new Error("outbox down"); } });
    expect(outcome.status).toBe("COMPLETED");
    expect(await taskStatus(taskId)).toBe("COMPLETED");
    expect(await noticesOf(taskId)).toHaveLength(0);
  });

  it("touches no business table outside the ledger and the outbox (no admission, fire or binding)", async () => {
    const count = async (t: string) => Number((await q<{ n: string }>(`select count(*)::text n from ${t}`))[0]!.n);
    const tables = ["kernel_private.task_admissions", "public.schedule_fires", "kernel_private.execution_bindings", "kernel_private.alert_state"];
    const before = await Promise.all(tables.map(count));
    await runMission();
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });
});
