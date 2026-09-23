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
import type { MissionMemoryPort } from "../services/kernel/src/mission/memory-port.js";
import { CanonicalMemory } from "../services/memory/src/canonical/service.js";
import { createMissionMemoryPort } from "../services/memory/src/canonical/mission-port.js";
import { analystRequest } from "../services/kernel/src/mission/prompts.js";
import { PgFacultyRegistry, type MissionFacultyPort } from "../services/kernel/src/faculty/registry.js";
import { coreTeamTemplates } from "../services/kernel/src/faculty/templates.js";
import { FacultyPin, FacultyVersion } from "../packages/contracts/src/faculty.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";
import { boundFacultyRequest } from "../services/kernel/src/faculty/policy.js";
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
  /** KJ-P5: read-only canonical memory for the analyst. */
  memory?: MissionMemoryPort;
  faculties?: MissionFacultyPort;
  journal?: Map<string, unknown>;
  mutateFacultyEvidence?: boolean;
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
    if (s.mutateFacultyEvidence && extra.evidence?.metadata["faculty"]) {
      extra.evidence = { ...extra.evidence, metadata: { ...extra.evidence.metadata, faculty: { ...(extra.evidence.metadata["faculty"] as Record<string, unknown>), faculty_version: 999 } } };
    }
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

  const ctx = { run: async (n: string, action: () => unknown) => {
    if (s.journal?.has(n)) return structuredClone(s.journal.get(n));
    const result = await action();
    s.journal?.set(n, structuredClone(result));
    return result;
  } } as unknown as Pick<Context, "run">;
  const workflowTask = s.workflowObjective ? Task.parse({ ...task, objective: s.workflowObjective }) : task;
  const outcome = await runRepoAnalysisMission({
    ctx, task: workflowTask, plan, emit, now: det.now, uuid: det.uuid,
    githubRead: s.github ?? (async () => githubResult()),
    analyst: s.analyst ?? fakeClaude(),
    reviewer: s.reviewer ?? fakeGrok(),
    ...(s.memory ? { memory: s.memory } : {}),
    ...(s.faculties ? { faculties: s.faculties } : {}),
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
    expect(rec.metadata).toMatchObject({ contract: { outputSchema: "repo-analysis-findings/v2" as const, requestedFindings: null, minFindings: 1, maxFindings: 8 }, findingCount: 1 });
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

describe("KJ-P5 canonical memory in the mission", () => {
  let canonical: CanonicalMemory;
  const owner = { tenantId: fixtureId, principal };
  beforeAll(() => {
    canonical = new CanonicalMemory(pool);
  });
  const remember = (content: string, over: Record<string, unknown> = {}) =>
    canonical.submitOperatorInstruction(owner, {
      idempotencyKey: `mission-mem-${randomUUID()}`,
      class: "PREFERENCE",
      content,
      subject: { kind: "PRINCIPAL", ref: principal.id },
      evidence: [{ type: "TELEGRAM_UPDATE", ref: `update:${randomUUID()}` }],
      reason: "test instruction",
      ...over,
    });
  const spy = (inner: ModelPort, seen: string[]): ModelPort => ({
    generate: async (r) => {
      seen.push(r.messages.map((m) => m.content).join("\n"));
      return inner.generate(r);
    },
  });
  const analystEvidence = async (taskId: string) => (await evidenceOf(taskId)).find((e) => e.source === "kerneljson:runtime/analyst")!;
  type MemoryContext = { status: string; assembly_id: string; context_digest: string; memories: Array<{ memory_id: string; version: number }> };

  it("gives the analyst the operator's memory and records memory ids, versions and the context digest in its evidence", async () => {
    const m = await remember("I prefer concise deployment summaries unless I explicitly ask for detail");
    const seen: string[] = [];
    const port = createMissionMemoryPort(canonical);
    const { outcome, taskId } = await runMission({ memory: port, analyst: spy(fakeClaude(), seen) });
    expect(outcome.status).toBe("COMPLETED");
    expect(seen[0]).toContain("OPERATOR MEMORY");
    expect(seen[0]).toContain("I prefer concise deployment summaries unless I explicitly ask for detail");
    expect(seen[0]).toContain(`v1 ${m.memoryId!.slice(0, 8)}`);
    const ev = await analystEvidence(taskId);
    const ctx = ev.metadata["memory_context"] as MemoryContext;
    expect(ctx.status).toBe("ASSEMBLED");
    expect(ctx.memories).toContainEqual({ memory_id: m.memoryId, version: 1 });
    expect(ctx.context_digest).toMatch(/^[a-f0-9]{64}$/);
    // The assembly is on record, tied to this task and to the model call that used it, with the same digest.
    const rows = await q<{ digest: string; task_id: string; call_id: string; items: Array<{ memoryId: string; version: number }> }>(
      "select digest, task_id, call_id, items from public.memory_context_assemblies where id=$1",
      [ctx.assembly_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ digest: ctx.context_digest, task_id: taskId, call_id: ev.metadata["call_id"] });
    expect(rows[0]!.items).toContainEqual(expect.objectContaining({ memoryId: m.memoryId, version: 1 }));
    // Nothing else about the mission changed: still four evidence rows and an accepted reconciliation.
    expect(await evidenceOf(taskId)).toHaveLength(4);
  });

  it("gives the reviewer no memory", async () => {
    await remember("I prefer reviewer-visible words like zanzibar");
    const seen: string[] = [];
    await runMission({ memory: createMissionMemoryPort(canonical), reviewer: spy(fakeGrok(), seen) });
    expect(seen[0]).not.toContain("OPERATOR MEMORY");
    expect(seen[0]).not.toContain("zanzibar");
  });

  it("does not select a superseded or retracted memory, and the corrected one is selected at its new version", async () => {
    const a = await remember("I prefer verbose reports with every detail");
    const fixed = await remember("I now prefer terse reports", { intent: "CORRECT", targetMemoryId: a.memoryId });
    expect(fixed.version).toBe(2);
    const gone = await remember("I prefer pineapple in commit messages");
    await remember("", { intent: "RETRACT", targetMemoryId: gone.memoryId, reason: "operator asked to forget" });
    const seen: string[] = [];
    const { taskId } = await runMission({ memory: createMissionMemoryPort(canonical), analyst: spy(fakeClaude(), seen) });
    expect(seen[0]).toContain("I now prefer terse reports");
    expect(seen[0]).not.toContain("I prefer verbose reports");
    expect(seen[0]).not.toContain("pineapple");
    const ctx = (await analystEvidence(taskId)).metadata["memory_context"] as MemoryContext;
    expect(ctx.memories).toContainEqual({ memory_id: a.memoryId, version: 2 });
    expect(ctx.memories.map((x) => x.memory_id)).not.toContain(gone.memoryId);
  });

  it("leaves the prompt and the evidence exactly as before when no memory is wired", async () => {
    const seen: string[] = [];
    const { outcome, taskId } = await runMission({ analyst: spy(fakeClaude(), seen) });
    expect(outcome.status).toBe("COMPLETED");
    expect(seen[0]).not.toContain("OPERATOR MEMORY");
    expect((await analystEvidence(taskId)).metadata).not.toHaveProperty("memory_context");
    const common = {
      callId: randomUUID(),
      taskId: randomUUID(),
      stepId: randomUUID(),
      trace: { traceId: randomUUID(), correlationId: randomUUID() },
      facts: makeFacts(),
      factsDigest: "a".repeat(64),
      question: "q",
      contract: { outputSchema: "repo-analysis-findings/v2" as const, requestedFindings: null, minFindings: 1, maxFindings: 8 },
    };
    expect(analystRequest({ ...common, memory: "" })).toEqual(analystRequest(common));
    expect(analystRequest({ ...common, memory: "MEMORY BLOCK" }).messages[1]!.content).toContain("MEMORY BLOCK");
  });

  it("still runs, and says so in the evidence, when the memory service is unavailable", async () => {
    const broken: MissionMemoryPort = {
      assemble: async () => {
        throw new Error("memory database exploded");
      },
    };
    const seen: string[] = [];
    const { outcome, taskId } = await runMission({ memory: broken, analyst: spy(fakeClaude(), seen) });
    expect(outcome.status).toBe("COMPLETED");
    expect(seen[0]).not.toContain("OPERATOR MEMORY");
    const ctx = (await analystEvidence(taskId)).metadata["memory_context"] as Record<string, unknown>;
    expect(ctx).toMatchObject({ status: "UNAVAILABLE", assembly_id: null, context_digest: null, memories: [] });
    expect(JSON.stringify(await evidenceOf(taskId))).not.toContain("exploded");
  });

  it("creates no candidate, promotion or canonical memory by running a mission", async () => {
    const counts = async () =>
      (await q<{ c: number; v: number; p: number }>("select (select count(*) from memory_candidates)::int c, (select count(*) from memory_versions)::int v, (select count(*) from memory_promotions)::int p"))[0];
    const before = await counts();
    await runMission({ memory: createMissionMemoryPort(canonical) });
    expect(await counts()).toEqual(before);
  });

  it("does not put another tenant's or another principal's memory in the context", async () => {
    const otherTenant = randomUUID();
    const otherPrincipal = { id: randomUUID(), kind: "HUMAN" as const };
    await pool.query("insert into tenants(id,name) values($1,'p5-other')", [otherTenant]);
    await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [otherPrincipal.id]);
    await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')", [otherTenant, otherPrincipal.id]);
    await canonical.submitOperatorInstruction(
      { tenantId: otherTenant, principal: otherPrincipal },
      {
        idempotencyKey: `other-${randomUUID()}`,
        class: "PREFERENCE",
        content: "I prefer the marker quokka",
        subject: { kind: "PRINCIPAL", ref: otherPrincipal.id },
        evidence: [{ type: "TELEGRAM_UPDATE", ref: "update:other" }],
        reason: "other tenant",
      },
    );
    const seen: string[] = [];
    await runMission({ memory: createMissionMemoryPort(canonical), analyst: spy(fakeClaude(), seen) });
    expect(seen[0]).not.toContain("quokka");
  });
});

describe("KJ-P6 faculties against the real ledger and Postgres", () => {
  const routes = { analyst: { provider: "openrouter" as const, model: "anthropic/claude-test" }, reviewer: { provider: "openrouter" as const, model: "x-ai/grok-test" } };
  let faculties: PgFacultyRegistry;
  const pinsOf = async (taskId: string) => (await pool.query("select pin from faculty_pins where task_id=$1 order by faculty_id", [taskId])).rows.map(r => FacultyPin.parse(r.pin));
  const current = async () => FacultyVersion.parse((await pool.query("select definition from faculty_current where tenant_id=$1 and faculty_id='intelligence'", [fixtureId])).rows[0].definition);
  const append = async (over: Partial<FacultyVersion>) => {
    const old = await current();
    const f = FacultyVersion.parse({ ...old, ...over, version: old.version + 1 });
    await pool.query("insert into faculty_versions(tenant_id,faculty_id,version,definition,digest) values($1,$2,$3,$4,$5)", [fixtureId, f.id, f.version, f, capabilityDigest(f)]);
    return f;
  };
  beforeAll(async () => {
    for (const f of coreTeamTemplates(fixtureId, "test:reviewed-deployment"))
      await pool.query("insert into faculty_versions(tenant_id,faculty_id,version,definition,digest) values($1,$2,$3,$4,$5)", [fixtureId, f.id, f.version, f, capabilityDigest(f)]);
    faculties = new PgFacultyRegistry(pool, routes);
  });
  it("pins admitted operations, binds evidence, and completes independently", async () => {
    const r = await runMission({ faculties });
    expect(r.outcome.status).toBe("COMPLETED");
    const pins = await pinsOf(r.taskId);
    expect(pins.map(p => p.faculty.id)).toEqual(["intelligence", "verifier"]);
    expect(pins.every(p => p.faculty.version === 1 && p.tenantId === fixtureId)).toBe(true);
    for (const p of pins) {
      const ev = (await evidenceOf(r.taskId)).find(e => e.metadata["role"] === (p.operation === "RUNTIME_ANALYSE" ? "analyst" : "reviewer"))!;
      expect(ev.metadata["faculty"]).toMatchObject({ faculty_id: p.faculty.id, faculty_digest: p.facultyDigest, policy_version: "faculty-routing/v1" });
      expect(ev.metadata["response_model"]).toBe(p.model);
    }
  });
  it("replays journaled calls without rerouting after a newer role version", async () => {
    let calls = 0;
    const inner = fakeClaude();
    const s: Scenario = { faculties, journal: new Map(), seed: randomUUID(), intentId: randomUUID(), createdMs: Date.now() - 120000,
      analyst: { generate: async r => { calls++; return inner.generate(r); } } };
    const first = await runMission(s);
    const old = await pinsOf(first.taskId);
    await append({ purpose: "Updated reviewed research purpose" });
    const replay = await runMission(s);
    expect(replay.outcome).toEqual(first.outcome);
    expect(calls).toBe(1);
    expect(await pinsOf(first.taskId)).toEqual(old);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => faculties.pin({ tenantId: fixtureId, taskId: first.taskId, stepId: old[0]!.stepId })));
    expect(concurrent.every(p => capabilityDigest(p) === capabilityDigest(old[0]))).toBe(true);
  });
  it("refuses disabled faculties before any model call and retains the failure evidence", async () => {
    const old = await current();
    await append({ enabled: false });
    try {
      let calls = 0;
      const r = await runMission({ faculties, analyst: { generate: async () => { calls++; throw new Error("must not run"); } } });
      expect(r.outcome.status).toBe("FAILED");
      expect(r.outcome.summary).toContain("FACULTY_DISABLED");
      expect(calls).toBe(0);
    } finally { await append({ ...old }); }
  });
  it("refuses capability expansion and wrong-tenant requests", async () => {
    const old = await current();
    await append({ permittedCapabilityClasses: [] });
    try {
      const r = await runMission({ faculties });
      expect(r.outcome.summary).toContain("FACULTY_CAPABILITY_REFUSED");
      await expect(faculties.pin({ tenantId: randomUUID(), taskId: r.taskId, stepId: randomUUID() })).rejects.toThrow("TASK_REFUSED");
    } finally { await append({ ...old }); }
  });
  it("substitutes an explicitly configured provider for new tasks, never an existing pin", async () => {
    const changed = new PgFacultyRegistry(pool, { ...routes, analyst: { provider: "deepseek", model: "deepseek-test" } });
    const r = await runMission({ faculties: changed, analyst: fakeClaude({ provider: "deepseek", model: "deepseek-test" }) });
    expect(r.outcome.status).toBe("COMPLETED");
    const p = (await pinsOf(r.taskId))[0]!;
    expect(p.provider).toBe("deepseek");
    expect(await faculties.pin({ tenantId: fixtureId, taskId: r.taskId, stepId: p.stepId })).toEqual(p);
    const req = boundFacultyRequest(p, { taskId: p.taskId, stepId: p.stepId, callId: randomUUID(), trace: { traceId: randomUUID(), correlationId: p.taskId }, messages: [{ role: "user", content: "safe" }], maxOutputTokens: 100 });
    await expect(faculties.authorize(p, req)).rejects.toThrow("PINNED_ROUTE_UNAVAILABLE");
  });
  it("retains a failed provider attempt on replay instead of issuing an unapproved retry", async () => {
    let calls = 0;
    const inner = fakeClaude({ reply: { fail: "RATE_LIMIT" } });
    const s: Scenario = { faculties, journal: new Map(), seed: randomUUID(), intentId: randomUUID(), createdMs: Date.now() - 120000,
      analyst: { generate: async r => { calls++; return inner.generate(r); } } };
    const a = await runMission(s), b = await runMission(s);
    expect(a.outcome.status).toBe("FAILED");
    expect(b.outcome).toEqual(a.outcome);
    expect(calls).toBe(1);
    expect((await evidenceOf(a.taskId)).find(e => e.metadata["role"] === "analyst")?.metadata).toMatchObject({ error: "RATE_LIMIT", faculty: { faculty_id: "intelligence" } });
  });
  it("refuses revocation between selection and execution without calling the provider", async () => {
    const old = await current();
    let called = false;
    try {
      const r = await runMission({
        faculties: { pin: input => faculties.pin(input), authorize: async (pin, req) => { await append({ enabled: false }); await faculties.authorize(pin, req); } },
        analyst: { generate: async () => { called = true; throw new Error("revoked"); } },
      });
      expect(r.outcome.status).toBe("FAILED");
      expect(r.outcome.summary).toContain("REQUEST_REJECTED");
      expect(called).toBe(false);
    } finally { await append(old); }
  });
  it("refuses a provider receipt that differs from the pinned route as a terminal task failure", async () => {
    const r = await runMission({ faculties, analyst: fakeClaude({ provider: "deepseek", model: "deepseek-test" }) });
    expect(r.outcome.status).toBe("FAILED");
    expect(r.outcome.summary).toContain("UNSUPPORTED_RESPONSE");
  });
  it("narrows the memory port and projects the exact faculty into the analyst prompt", async () => {
    const old = await current();
    const configured = await append({ permittedMemoryClasses: ["PREFERENCE"], contextBudget: { ...old.contextBudget, maxMemoryTokens: 32 } });
    const requests: unknown[] = [], prompts: string[] = [];
    const inner = fakeClaude();
    try {
      const r = await runMission({ faculties,
        analyst: { generate: async req => { prompts.push(req.messages[0]!.content); return inner.generate(req); } },
        memory: { assemble: async req => { requests.push(req); return { status: "ASSEMBLED", assemblyId: null, digest: null, text: "", memories: [], externalCount: 0, usedTokens: 0 }; } },
      });
      expect(r.outcome.status).toBe("COMPLETED");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ allowedClasses: ["PREFERENCE"], maxTokens: 32 });
      expect(prompts[0]).toContain(`Kernel faculty: Intelligence v${configured.version}`);
    } finally { await append(old); }
  });
  it("fails canonical completion on mutated or absent faculty evidence", async () => {
    for (const s of [{ faculties, mutateFacultyEvidence: true }, {}]) {
      const r = await runMission(s);
      expect(r.outcome.status).toBe("FAILED");
      expect(r.outcome.summary).toBe("Persisted completion verification failed");
    }
  });
  it("database guards reject edits, deletes, truncation, cross-tenant pins and anonymous writes", async () => {
    const r = await runMission({ faculties });
    const p = (await pinsOf(r.taskId))[0]!;
    const rejects = async (sql: string, params: unknown[] = []) => {
      const c = await pool.connect();
      try { await c.query("begin"); await expect(c.query(sql, params)).rejects.toBeTruthy(); }
      finally { await c.query("rollback"); c.release(); }
    };
    for (const table of ["faculty_versions", "faculty_pins"]) {
      await rejects(`update ${table} set tenant_id=tenant_id`);
      await rejects(`delete from ${table}`);
      await rejects(`truncate ${table} cascade`);
    }
    await rejects("insert into faculty_pins(tenant_id,task_id,step_id,faculty_id,faculty_version,pin) values($1,$2,$3,$4,$5,$6)", [randomUUID(), p.taskId, p.stepId, p.faculty.id, p.faculty.version, p]);
    await rejects("set local role anon; select * from faculty_versions");
    const old = await current();
    await rejects("insert into faculty_versions(tenant_id,faculty_id,version,definition,digest) values($1,$2,$3,$4,$5)", [fixtureId, old.id, old.version+2, { ...old, version: old.version+2 }, capabilityDigest(old)]);
  });
});
