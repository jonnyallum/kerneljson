import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { kernelSubmission } from "../evals/fixtures/kernel.js";
import { compileSchedule } from "../services/kernel/src/schedule.js";
import {
  compileIntent,
  stableId,
} from "../services/kernel/src/compiler/index.js";
import { finishSchedule } from "../services/kernel/src/schedule-store.js";
import { Task, TaskStep } from "../packages/contracts/src/index.js";
let fixture: Awaited<ReturnType<typeof knowledgeDatabase>>;
beforeAll(async () => {
  fixture = await knowledgeDatabase();
});
afterAll(async () => {
  await fixture?.close();
});
it.each([false, true])(
  "rejects schedule completion with unverified children (asserted outcome=%s)",
  async (assertedOutcome) => {
    const input = {
      intent: {
        ...kernelSubmission.intent,
        id: randomUUID(),
        tenant: { id: fixture.context.tenantId },
        principal: fixture.context.principal,
      },
      iterations: 1,
      intervalMs: 1000,
      budgetUnits: 1,
    };
    const plan = compileSchedule(
      input,
      {
        enabled: true,
        version: "db-test/1",
        maxIterations: 1,
        maxBudgetUnits: 1,
        minIntervalMs: 1000,
        maxIntervalMs: 1000,
      },
      input.intent.principal,
    );
    const task = Task.parse({ ...plan.task, status: "VERIFYING" });
    const step = TaskStep.parse({
      id: stableId(["schedule-step/v1", task.id]),
      taskId: task.id,
      kind: "SCHEDULE",
      status: "COMPLETED",
      dependencies: [],
      requiredCapabilities: [],
      riskClass: "LOW",
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      input: plan,
    });
    const db = fixture.pool;
    await db.query(
      "insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'VERIFYING',$5,$6)",
      [
        task.id,
        task.tenant.id,
        task.principal.id,
        task.traceId,
        task,
        task.createdAt,
      ],
    );
    await db.query(
      "insert into task_steps(id,task_id,status,contract) values($1,$2,'COMPLETED',$3)",
      [step.id, task.id, step],
    );
    await db.query(
      "insert into task_events(id,task_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,'plan',repeat('a',64),'PLAN_COMPILED',$3,$4,$5,$6)",
      [
        randomUUID(),
        task.id,
        task.createdAt,
        task.principal.id,
        task.traceId,
        { schedule: plan },
      ],
    );
    if (assertedOutcome) {
      const child = Task.parse({
        ...compileIntent(plan.children[0]!).task,
        parentTaskId: task.id,
        status: "VERIFYING",
      });
      const evidenceId = randomUUID(),
        at = new Date().toISOString();
      const outcome = {
        taskId: child.id,
        status: "COMPLETED",
        acceptanceResults: child.acceptanceCriteria.map((criterion) => ({
          criterion,
          passed: true,
          evidenceRefs: [evidenceId],
        })),
        evidenceRefs: [evidenceId],
        summary: child.objective.trim().toUpperCase(),
        completedAt: at,
      };
      const tx = await db.connect();
      try {
        await tx.query("begin");
        await tx.query(
          "insert into tasks(id,tenant_id,principal_id,parent_task_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,$5,'VERIFYING',$6,$7)",
          [
            child.id,
            child.tenant.id,
            child.principal.id,
            task.id,
            child.traceId,
            child,
            child.createdAt,
          ],
        );
        await tx.query(
          "insert into evidence(id,task_id,type,source,digest,captured_at,metadata) values($1,$2,'DETERMINISTIC_RESULT','unverified-test',repeat('b',64),$3,'{}')",
          [evidenceId, child.id, at],
        );
        await tx.query(
          "insert into outcomes(id,task_id,status,contract,completed_at) values($1,$2,'COMPLETED',$3,$4)",
          [randomUUID(), child.id, outcome, at],
        );
        await tx.query(
          "insert into task_events(id,task_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,'complete',repeat('a',64),'TASK_COMPLETED',$3,$4,$5,'{}')",
          [randomUUID(), child.id, at, child.principal.id, child.traceId],
        );
        await tx.query(
          "update tasks set status='COMPLETED',contract=$2 where id=$1",
          [child.id, { ...child, status: "COMPLETED", completedAt: at }],
        );
        await tx.query("commit");
      } catch (error) {
        await tx.query("rollback");
        throw error;
      } finally {
        tx.release();
      }
    }
    await expect(
      finishSchedule(db, task.id, {
        eventId: randomUUID(),
        evidenceId: randomUUID(),
        at: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    expect(
      (await db.query("select status from tasks where id=$1", [task.id]))
        .rows[0].status,
    ).toBe("VERIFYING");
    expect(
      (await db.query("select 1 from outcomes where task_id=$1", [task.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (await db.query("select 1 from evidence where task_id=$1", [task.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await db.query(
          "select 1 from task_events where task_id=$1 and type='TASK_COMPLETED'",
          [task.id],
        )
      ).rowCount,
    ).toBe(0);
  },
);
