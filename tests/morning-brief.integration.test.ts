import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Context } from "@restatedev/restate-sdk";
import { DATABASE, compose, migrate, until, holdRuntime } from "./support/local.js";
import { BRIEF_RECIPE, KernelSubmission, Task, TaskEvent, type Outcome } from "../packages/contracts/src/index.js";
import { Ledger } from "../services/kernel/src/ledger.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { planTask, projectStep } from "../services/kernel/src/planner/index.js";
import { digest } from "../services/kernel/src/deterministic.js";
import type { Emit } from "../services/kernel/src/mission/run.js";
import { runMorningBriefMission, type BriefDeps } from "../services/kernel/src/mission/run-brief.js";
import { enqueueBriefNotice } from "../services/kernel/src/mission/notify.js";
import { createKernelStateReader } from "../services/kernel/src/mission/kernel-state.js";
import { PgNotificationOutboxStore } from "../services/kernel/src/alerting/pg-outbox-store.js";
import { id as fixtureId, principal } from "../evals/fixtures/contracts.js";
import { activityResult, fakeBriefAnalyst, fakeBriefReviewer, makeActivity } from "./support/brief-fixture.js";

/**
 * The morning brief end to end against a REAL Postgres ledger, the REAL completion verifier, the real
 * outbox and the real kernel-state reader. Only GitHub and the two model runtimes are doubles.
 */
const name = `kj_brief_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
  pool.on("error", () => {});
  await migrate(pool);
  await pool.query("insert into principals(id,kind) values($1,$2)", [principal.id, principal.kind]);
  await pool.query("insert into tenants(id,name) values($1,$2)", [fixtureId, "fixture"]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,$3)", [fixtureId, principal.id, "owner"]);
  ledger = new Ledger(pool);
  outbox = new PgNotificationOutboxStore(pool);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await until(
    () => admin.query("select count(*)::int as n from pg_stat_activity where datname = $1", [name]),
    (r) => r.rows[0].n === 0,
    15000,
  );
  await admin.query(`drop database if exists ${name}`);
  await admin.end();
  releaseRuntime();
});

async function runBrief(over: Partial<BriefDeps> = {}): Promise<{ outcome: Outcome; taskId: string }> {
  const createdMs = Date.now() - 120_000;
  const trace = randomUUID();
  const submission = KernelSubmission.parse({
    recipe: BRIEF_RECIPE,
    intent: {
      id: randomUUID(), principal, tenant: { id: fixtureId }, source: "test", objective: "morning brief 2026-10-20T07:00",
      attachments: [], contextRefs: [], receivedAt: new Date(createdMs).toISOString(), trace: { traceId: trace, correlationId: trace },
    },
  });
  const compiled = compileIntent(submission);
  const plan = planTask(compiled.task, BRIEF_RECIPE);
  let task = compiled.task;
  let t = 0;
  const now = async () => new Date(createdMs + 10_000 + 1000 * ++t).toISOString();
  const emit: Emit = async (key, type, status, extra = {}, payload = {}) => {
    const occurredAt = await now();
    task = Task.parse({ ...task, status, ...(key === "start" ? { startedAt: occurredAt } : {}), ...(status === "COMPLETED" ? { completedAt: occurredAt } : {}) });
    const event = TaskEvent.parse({
      id: randomUUID(), taskId: task.id, type, occurredAt, actor: task.principal, traceId: task.traceId,
      ...(extra.step ? { stepId: extra.step.id } : {}), payload: { status, ...payload },
    });
    if (status === "COMPLETED") return ledger.finish({ key, task, event, ...extra });
    await ledger.write({ key, task, event, ...extra });
  };
  await emit("create", "TASK_CREATED", "RECEIVED", {}, { intent: submission.intent, recipe: plan.recipe, compilerVersion: 1 });
  await emit("intent", "INTENT_RESOLVED", "RECEIVED", {}, { intentId: submission.intent.id, correlationId: trace });
  await emit("compile", "PLAN_COMPILED", "COMPILED", { steps: plan.steps.map(projectStep) }, { plan, planDigest: digest(plan) });
  await emit("ready", "TASK_READY", "READY");
  await emit("start", "TASK_STARTED", "RUNNING");
  const ctx = { run: async (_n: string, action: () => unknown) => action() } as unknown as Pick<Context, "run">;
  // The activity window must end inside the task's lifetime, as it does in production.
  const windowed = async ({ windowEnd }: { windowEnd: string }) =>
    activityResult(makeActivity({ windowEnd, windowStart: new Date(Date.parse(windowEnd) - 86_400_000).toISOString() }));
  const outcome = await runMorningBriefMission({
    ctx, task, plan, emit, now, uuid: randomUUID,
    githubActivity: windowed,
    kernelState: createKernelStateReader(pool),
    analyst: fakeBriefAnalyst(),
    reviewer: fakeBriefReviewer(),
    notify: async (n) => { await enqueueBriefNotice(outbox, n); },
    ...over,
  });
  return { outcome, taskId: task.id };
}

const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
const noticesOf = (id: string) =>
  q<{ check_id: string; severity: string; status: string; message: string }>(
    "select check_id, severity, status, message from kernel_private.notification_outbox where check_id like $1",
    [`MISSION.morningBrief.${id.slice(0, 8)}.%`],
  );

describe("morning-brief/v1 against a real ledger", () => {
  it("commits COMPLETED through the ledger's own verifier, with four evidence rows and the brief queued in the outbox", async () => {
    const { outcome, taskId } = await runBrief();
    expect(outcome.status).toBe("COMPLETED");
    expect((await q<{ status: string }>("select status::text from public.tasks where id=$1", [taskId]))[0]!.status).toBe("COMPLETED");
    const ev = await q<{ source: string }>("select source from public.evidence where task_id=$1 order by captured_at", [taskId]);
    expect(ev.map((e) => e.source)).toEqual([
      "kerneljson:github-activity/v1", "kerneljson:runtime/analyst", "kerneljson:runtime/reviewer", "kerneljson:brief-reconcile/v1",
    ]);
    const notices = await noticesOf(taskId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ check_id: `MISSION.morningBrief.${taskId.slice(0, 8)}.completed`, severity: "P3", status: "PENDING" });
    expect(notices[0]!.message).toMatch(/^Morning brief, /);
  });

  it("reads the kernel's own state, excluding the brief itself", async () => {
    const { taskId } = await runBrief();
    const facts = (await q<{ metadata: { facts: { kernel: { tasks: Array<{ recipe: string; status: string; count: number }> } } } }>(
      "select metadata from public.evidence where task_id=$1 and source='kerneljson:github-activity/v1'", [taskId]))[0]!.metadata.facts;
    // Earlier briefs in this database are visible and COMPLETED; this one (RUNNING when read) is not counted.
    expect(facts.kernel.tasks.filter((t) => t.status === "RUNNING")).toEqual([]);
    expect(facts.kernel.tasks.find((t) => t.recipe === BRIEF_RECIPE && t.status === "COMPLETED")?.count).toBeGreaterThanOrEqual(1);
  });

  it("negative control: a rejected brief commits FAILED and queues only the redacted P2 notice", async () => {
    const { outcome, taskId } = await runBrief({ reviewer: fakeBriefReviewer({ unsupported: [0] }) });
    expect(outcome.status).toBe("FAILED");
    expect((await q<{ status: string }>("select status::text from public.tasks where id=$1", [taskId]))[0]!.status).toBe("FAILED");
    expect(await noticesOf(taskId)).toEqual([
      { check_id: `MISSION.morningBrief.${taskId.slice(0, 8)}.failed`, severity: "P2", status: "PENDING", message: "Morning brief FAILED" },
    ]);
  });

  it("negative control: an analyst citing a commit outside the evidence cannot complete", async () => {
    const { outcome } = await runBrief({ analyst: fakeBriefAnalyst({ items: [{ refs: [`commit:jonnyallum/kerneljson@${"f".repeat(12)}`] }] }) });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.summary).toContain("brief_refs_exist_in_evidence");
  });
});
