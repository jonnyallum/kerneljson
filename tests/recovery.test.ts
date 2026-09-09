import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createServer } from "node:http";
import { MissionControlStore } from "../apps/mission-control/src/store.js";
import { createMissionControl } from "../apps/mission-control/src/server.js";
import { createRestateControls } from "../apps/gateway/src/index.js";
import { createGateway, createRestateDispatch, bearerAuthenticator } from "../apps/gateway/src/server.js";
import { readRouteObservations } from "../services/kernel/src/routing.js";
import { compileSchedule } from "../services/kernel/src/schedule.js";
import {
  DATABASE,
  INGRESS,
  ADMIN,
  compose,
  migrate,
  until,
  post,
  holdRuntime,
} from "./support/local.js";
import { task as fixture } from "../evals/fixtures/contracts.js";
import { Outcome, Task } from "../packages/contracts/src/index.js";
import { stepB, stepA } from "../services/kernel/src/deterministic.js";
import { TaskClient } from "../services/kernel/src/client.js";
import { KernelClient } from "../services/kernel/src/compiler/client.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { planTask } from "../services/kernel/src/planner/index.js";
import { kernelSubmission } from "../evals/fixtures/kernel.js";
import { digest } from "../services/kernel/src/deterministic.js";
import { VerificationStore } from "../services/kernel/src/verification-store.js";
import { criteria } from "../services/kernel/src/compiler/index.js";
import {
  ExecutionPlan,
  type RecipeId,
  ModelCallResult,
  ModelCallReceipt,
  CapabilityResult,
} from "../packages/contracts/src/index.js";
const pool = new pg.Pool({ connectionString: DATABASE });
const client = new TaskClient(INGRESS);
const kernel = new KernelClient(INGRESS);
const reviewer = "70000000-0000-4000-8000-000000000002";
const scheduleConfig = {
  enabled: true,
  version: "test-schedule/1",
  maxIterations: 3,
  maxBudgetUnits: 3,
  minIntervalMs: 1000,
  maxIntervalMs: 30000,
};
async function submitSchedule(intervalMs = 8000) {
  const input = {
    intent: { ...kernelSubmission.intent, id: randomUUID() },
    iterations: 2,
    intervalMs,
    budgetUnits: 2,
  };
  const plan = compileSchedule(input, scheduleConfig, input.intent.principal);
  expect(
    (
      await policyPost(
        plan.task.id,
        "run/send",
        input,
        "test-owner",
        "BoundedScheduleWorkflowV1",
      )
    ).ok,
  ).toBe(true);
  return { input, plan, task: plan.task };
}
it("Phase 15 resumes a bounded schedule timer and recovers its final evidence commit", async () => {
  const { task, plan, input } = await submitSchedule(12000);
  await status(task, "WAITING");
  expect(
    (await pool.query("select 1 from tasks where parent_task_id=$1", [task.id]))
      .rowCount,
  ).toBe(1);
  compose(
    "exec",
    "-T",
    "worker",
    "touch",
    "/tmp/kerneljson-schedule-crash-once",
  );
  compose("kill", "-s", "SIGKILL", "worker", "restate");
  compose("start", "restate", "worker");
  await until(
    () => fetch(`${ADMIN}/health`),
    (r) => r.ok,
  );
  await status(task, "COMPLETED");
  await until(
    async () => compose("ps", "-a", "--format", "json", "worker"),
    (s) => s.includes("exited"),
  );
  compose("start", "worker");
  const response = await fetch(
    `${INGRESS}/restate/workflow/BoundedScheduleWorkflowV1/${task.id}/attach`,
    { signal: AbortSignal.timeout(30000) },
  );
  expect(response.ok).toBe(true);
  const outcome = Outcome.parse(await response.json());
  expect(outcome.status).toBe("COMPLETED");
  expect(
    (
      await policyPost(
        task.id,
        "run",
        input,
        "test-owner",
        "BoundedScheduleWorkflowV1",
      )
    ).status,
  ).toBe(409);
  const children = await pool.query<{ id: string; status: string }>(
    "select id,status from tasks where parent_task_id=$1 order by id",
    [task.id],
  );
  expect(children.rows.map((r) => r.id)).toEqual(
    plan.children.map((c) => compileIntent(c).task.id).sort(),
  );
  expect(children.rows.every((c) => c.status === "COMPLETED")).toBe(true);
  expect(
    (await pool.query("select 1 from outcomes where task_id=$1", [task.id]))
      .rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "select 1 from evidence where task_id=$1 and source='kerneljson:bounded-schedule/v1'",
        [task.id],
      )
    ).rowCount,
  ).toBe(1);
});
it.each(["cancel", "revoke"] as const)(
  "Phase 15 %s stops future child work at its durable wait",
  async (mode) => {
    const { task } = await submitSchedule();
    await status(task, "WAITING");
    if (mode === "cancel") {
      expect(
        (
          await policyPost(
            task.id,
            "cancel",
            {},
            "test-reviewer",
            "BoundedScheduleWorkflowV1",
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await policyPost(
            task.id,
            "cancel",
            {},
            "test-owner",
            "BoundedScheduleWorkflowV1",
          )
        ).ok,
      ).toBe(true);
    } else
      compose(
        "exec",
        "-T",
        "worker",
        "touch",
        "/tmp/kerneljson-revoke-schedule",
      );
    try {
      await status(task, "CANCELLED");
      expect(
        (
          await pool.query("select 1 from tasks where parent_task_id=$1", [
            task.id,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (await pool.query("select 1 from outcomes where task_id=$1", [task.id]))
          .rowCount,
      ).toBe(0);
    } finally {
      if (mode === "revoke")
        compose(
          "exec",
          "-T",
          "worker",
          "rm",
          "-f",
          "/tmp/kerneljson-revoke-schedule",
        );
    }
  },
);
it("Phase 15 rejects unauthorized schedules and orphan child execution", async () => {
  const input = {
    intent: { ...kernelSubmission.intent, id: randomUUID() },
    iterations: 2,
    intervalMs: 1000,
    budgetUnits: 2,
  };
  const plan = compileSchedule(input, scheduleConfig, input.intent.principal);
  expect(
    (
      await policyPost(
        plan.task.id,
        "run",
        { ...input, iterations: 4, budgetUnits: 4 },
        "test-owner",
        "BoundedScheduleWorkflowV1",
      )
    ).status,
  ).toBe(403);
  expect(
    (await pool.query("select 1 from tasks where id=$1", [plan.task.id]))
      .rowCount,
  ).toBe(0);
  const submission = plan.children[0]!,
    child = compileIntent(submission).task;
  expect(
    (
      await policyPost(
        child.id,
        "run",
        { parentTaskId: randomUUID(), submission },
        "test-owner",
        "AutonomousChildTaskWorkflowV1",
      )
    ).status,
  ).toBe(403);
  expect(
    (await pool.query("select 1 from tasks where id=$1", [child.id])).rowCount,
  ).toBe(0);
});
it("Phase 14 journals route selection across its database commit and worker recovery", async () => {
  const task = Task.parse({
    ...fixture,
    id: randomUUID(),
    traceId: randomUUID(),
  });
  compose(
    "exec",
    "-T",
    "worker",
    "touch",
    "/tmp/kerneljson-routing-crash-once",
  );
  expect((await post(`/RoutingProbeV1/${task.id}/run/send`, task)).ok).toBe(
    true,
  );
  await until(
    () =>
      pool.query(
        "select 1 from task_events where task_id=$1 and event_key='routing-selection'",
        [task.id],
      ),
    (r) => r.rowCount === 1,
  );
  await until(
    async () => compose("ps", "-a", "--format", "json", "worker"),
    (s) => s.includes("exited"),
  );
  compose("start", "worker");
  const response = await fetch(
    `${INGRESS}/restate/workflow/RoutingProbeV1/${task.id}/attach`,
    { signal: AbortSignal.timeout(30000) },
  );
  expect(response.ok).toBe(true);
  CapabilityResult.parse(await response.json());
  expect(
    compose(
      "exec",
      "-T",
      "worker",
      "cat",
      `/tmp/routing-${task.id}-reads`,
    ).trim(),
  ).toBe("snapshot");
  expect(
    (
      await pool.query("select 1 from capability_runs where task_id=$1", [
        task.id,
      ])
    ).rowCount,
  ).toBe(1);
});
it.each(["approve", "cancel"] as const)(
  "Phase 13 Mission Control %s routes an authenticated human action through the golden workflow",
  async (action) => {
    const submission = {
      ...kernelSubmission,
      recipe: "uppercase/v1",
      intent: { ...kernelSubmission.intent, id: randomUUID() },
    };
    const { task } = compileIntent(submission);
    expect(
      (
        await policyPost(
          task.id,
          "run/send",
          submission,
          "test-owner",
          "GoldenTaskWorkflowV1",
        )
      ).ok,
    ).toBe(true);
    await status(task, "APPROVAL_REQUIRED");
    let handler: ReturnType<typeof createMissionControl>;
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test address");
    const origin = `http://127.0.0.1:${address.port}`;
    const actor = action === "approve" ? reviewer : task.principal.id;
    const store = new MissionControlStore(pool);
    handler = createMissionControl({
      store,
      origin,
      authenticate: async (headers) => {
        if (headers.authorization !== "Bearer browser-test")
          throw new Error("Unauthenticated");
        return {
          tenantId: task.tenant.id,
          principal: { id: actor, kind: "HUMAN" },
        };
      },
      controls: createRestateControls(INGRESS, async (context) => ({
        authorization: `Bearer ${context.principal.id === reviewer ? "test-reviewer" : "test-owner"}`,
      }), { pool }),
    });
    try {
      const view = await store.task(
        { tenantId: task.tenant.id, principal: { id: actor, kind: "HUMAN" } },
        task.id,
      );
      const page = await fetch(`${origin}/tasks/${task.id}`, {
        headers: { authorization: "Bearer browser-test" },
      });
      expect(await page.text()).toContain(
        action === "approve" ? ">Approve<" : ">Cancel task<",
      );
      const body =
        action === "approve"
          ? new URLSearchParams({
              decision: "GRANTED",
              scopeDigest: view!.pending!.evaluation.scopeDigest,
            }).toString()
          : "";
      const response = await fetch(`${origin}/tasks/${task.id}/${action}`, {
        method: "POST",
        headers: {
          authorization: "Bearer browser-test",
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      await status(task, action === "approve" ? "COMPLETED" : "CANCELLED");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
async function policyPost(
  taskId: string,
  handler: string,
  body: unknown,
  actor = "test-owner",
  workflow = "PolicyCapabilityWorkflowV1",
) {
  return fetch(`${INGRESS}/${workflow}/${taskId}/${handler}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${actor}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
it("Phase 9 golden intent recovers approval and outcome commit with one complete audit chain", async () => {
  const submission = {
    ...kernelSubmission,
    recipe: "uppercase/v1",
    intent: { ...kernelSubmission.intent, id: randomUUID() },
  };
  const { task } = compileIntent(submission);
  const send = (handler: string, body: unknown, actor = "test-owner") =>
    policyPost(task.id, handler, body, actor, "GoldenTaskWorkflowV1");
  expect((await send("run/send", submission)).ok).toBe(true);
  await status(task, "APPROVAL_REQUIRED");
  compose("kill", "-s", "SIGKILL", "worker", "restate");
  compose("start", "restate", "worker");
  await until(
    () => fetch(`${ADMIN}/health`),
    (r) => r.ok,
  );
  const rows = await pool.query<{
    payload: { evaluation: { scopeDigest: string } };
  }>("select payload from task_events where task_id=$1 and event_key=$2", [
    task.id,
    `policy-approval:${task.id}`,
  ]);
  compose(
    "exec",
    "-T",
    "worker",
    "touch",
    "/tmp/kerneljson-outcome-crash-once",
  );
  expect(
    (
      await send(
        "approve",
        {
          scopeDigest: rows.rows[0]!.payload.evaluation.scopeDigest,
          decision: "GRANTED",
        },
        "test-reviewer",
      )
    ).ok,
  ).toBe(true);
  await status(task, "COMPLETED");
  await until(
    async () => compose("ps", "-a", "--format", "json", "worker"),
    (s) => s.includes("exited"),
  );
  compose("start", "worker");
  const response = await fetch(
    `${INGRESS}/restate/workflow/GoldenTaskWorkflowV1/${task.id}/attach`,
    { signal: AbortSignal.timeout(30000) },
  );
  expect(response.ok).toBe(true);
  const outcome = Outcome.parse(await response.json());
  expect(outcome.status).toBe("COMPLETED");
  expect(outcome.summary).toBe(task.objective.toUpperCase());
  expect(outcome.evidenceRefs).toHaveLength(2);
  const observations = await readRouteObservations(pool, {
    tenantId: task.tenant.id,
    principal: task.principal,
  });
  expect(
    observations.some(
      (o) =>
        o.taskId === task.id &&
        o.success &&
        o.latencyMs >= 0 &&
        o.costUnits === 1,
    ),
  ).toBe(true);
  expect((await send("run", submission)).status).toBe(409);
  expect(
    await (
      await fetch(
        `${INGRESS}/restate/workflow/GoldenTaskWorkflowV1/${task.id}/output`,
      )
    ).json(),
  ).toEqual(outcome);
  for (const table of ["capability_runs", "outcomes"])
    expect(
      (await pool.query(`select 1 from ${table} where task_id=$1`, [task.id]))
        .rowCount,
    ).toBe(1);
  const events = await pool.query<{ type: string }>(
    "select type from task_events where task_id=$1",
    [task.id],
  );
  for (const type of [
    "TASK_CREATED",
    "PLAN_COMPILED",
    "POLICY_CHECKED",
    "APPROVAL_GRANTED",
    "TOOL_CALLED",
    "TASK_COMPLETED",
  ])
    expect(events.rows.filter((r) => r.type === type)).toHaveLength(1);
});
it("Phase 9 rejects unsupported recipes and spoofed intent ownership before persistence", async () => {
  for (const recipe of ["uppercase-reverse/v1", "uppercase/v1"] as const) {
    const submission = {
      ...kernelSubmission,
      recipe,
      intent: { ...kernelSubmission.intent, id: randomUUID() },
    };
    const { task } = compileIntent(submission);
    const response = await policyPost(
      task.id,
      "run",
      submission,
      "test-reviewer",
      "GoldenTaskWorkflowV1",
    );
    expect(response.status).toBe(recipe === "uppercase/v1" ? 403 : 400);
    expect(
      (await pool.query("select 1 from tasks where id=$1", [task.id])).rowCount,
    ).toBe(0);
  }
});
async function policyTask(acceptanceCriteria = fixture.acceptanceCriteria) {
  const task = Task.parse({
    ...fixture,
    id: randomUUID(),
    traceId: randomUUID(),
    acceptanceCriteria,
  });
  expect((await policyPost(task.id, "run/send", task)).ok).toBe(true);
  await status(task, "APPROVAL_REQUIRED");
  const rows = await pool.query<{
    payload: { evaluation: { scopeDigest: string } };
  }>("select payload from task_events where task_id=$1 and event_key=$2", [
    task.id,
    `policy-approval:${task.id}`,
  ]);
  return { task, scopeDigest: rows.rows[0]!.payload.evaluation.scopeDigest };
}
it.each([true, false])(
  "Phase 8 verifies persisted approved execution before terminal outcome (matching criteria=%s)",
  async (supported) => {
    const { task, scopeDigest } = await policyTask(
      supported ? [criteria["uppercase/v1"]] : fixture.acceptanceCriteria,
    );
    expect(
      (
        await policyPost(
          task.id,
          "approve",
          { scopeDigest, decision: "GRANTED" },
          "test-reviewer",
        )
      ).ok,
    ).toBe(true);
    await status(task, "VERIFYING");
    const store = new VerificationStore(pool);
    const outcomes = await Promise.all(
      Array.from({ length: 3 }, () =>
        store.finish(task.id, {
          eventId: randomUUID(),
          verificationEventId: randomUUID(),
          at: new Date().toISOString(),
        }),
      ),
    );
    expect(outcomes[0]?.status).toBe(supported ? "COMPLETED" : "FAILED");
    expect(
      outcomes.every((o) => JSON.stringify(o) === JSON.stringify(outcomes[0])),
    ).toBe(true);
    await status(task, supported ? "COMPLETED" : "FAILED");
    expect(
      (await pool.query("select 1 from outcomes where task_id=$1", [task.id]))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "select 1 from task_events where task_id=$1 and type='TASK_COMPLETED'",
          [task.id],
        )
      ).rowCount,
    ).toBe(supported ? 1 : 0);
    if (supported) expect(outcomes[0]?.evidenceRefs).toHaveLength(2);
  },
);

it("Phase 7 waits durably, rejects spoofed approval and executes only after an authenticated grant", async () => {
  const { task, scopeDigest } = await policyTask();
  expect(
    (
      await pool.query("select 1 from capability_runs where task_id=$1", [
        task.id,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (await policyPost(task.id, "approve", { scopeDigest, decision: "GRANTED" }))
      .status,
  ).toBe(403);
  expect(
    (
      await policyPost(
        task.id,
        "approve",
        {
          scopeDigest,
          decision: "GRANTED",
          actor: { id: reviewer, kind: "HUMAN" },
        },
        "test-reviewer",
      )
    ).status,
  ).toBe(400);
  compose("kill", "-s", "SIGKILL", "worker", "restate");
  compose("start", "restate", "worker");
  await until(
    () => fetch(`${ADMIN}/health`),
    (r) => r.ok,
  );
  const answers = await Promise.all(
    Array.from({ length: 3 }, () =>
      policyPost(
        task.id,
        "approve",
        { scopeDigest, decision: "GRANTED" },
        "test-reviewer",
      ),
    ),
  );
  for (const answer of answers)
    expect(answer.ok, await answer.text()).toBe(true);
  await status(task, "VERIFYING");
  expect(
    (
      await pool.query("select 1 from capability_runs where task_id=$1", [
        task.id,
      ])
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "select 1 from task_events where task_id=$1 and type='APPROVAL_GRANTED'",
        [task.id],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await pool.query("select 1 from outcomes where task_id=$1", [task.id]))
      .rowCount,
  ).toBe(0);
});
it.each(["DENIED", "CANCEL"] as const)(
  "Phase 7 %s prevents execution and a late grant cannot reverse it",
  async (decision) => {
    const { task, scopeDigest } = await policyTask();
    const answer =
      decision === "CANCEL"
        ? await policyPost(task.id, "cancel", {})
        : await policyPost(
            task.id,
            "approve",
            { scopeDigest, decision },
            "test-reviewer",
          );
    expect(answer.ok).toBe(true);
    await status(task, decision === "CANCEL" ? "CANCELLED" : "FAILED");
    const late = await policyPost(
      task.id,
      "approve",
      { scopeDigest, decision: "GRANTED" },
      "test-reviewer",
    );
    expect(await late.json()).toMatchObject({ status: "DENIED" });
    expect(
      (
        await pool.query("select 1 from capability_runs where task_id=$1", [
          task.id,
        ])
      ).rowCount,
    ).toBe(0);
  },
);
it("Phase 7 expires its durable approval wait without executing the capability", async () => {
  const { task } = await policyTask();
  await status(task, "FAILED");
  expect(
    (
      await pool.query<{ status: string }>(
        "select status from approvals where id=$1",
        [task.id],
      )
    ).rows[0]?.status,
  ).toBe("EXPIRED");
  expect(
    (
      await pool.query("select 1 from capability_runs where task_id=$1", [
        task.id,
      ])
    ).rowCount,
  ).toBe(0);
});
it("Phase 6 recovers capability receipt commit before acknowledgement without repeating execution", async () => {
  const task = Task.parse({
    ...fixture,
    id: randomUUID(),
    traceId: randomUUID(),
  });
  compose(
    "exec",
    "-T",
    "worker",
    "touch",
    "/tmp/kerneljson-capability-crash-once",
  );
  expect((await post(`/CapabilityProbeV1/${task.id}/run/send`, task)).ok).toBe(
    true,
  );
  await until(
    () =>
      pool.query("select 1 from capability_runs where task_id=$1", [task.id]),
    (r) => r.rowCount === 1,
  );
  await until(
    async () => compose("ps", "-a", "--format", "json", "worker"),
    (s) => s.includes("exited"),
  );
  compose("kill", "-s", "SIGKILL", "restate");
  compose("start", "restate", "worker");
  await until(
    () => fetch(`${ADMIN}/health`),
    (r) => r.ok,
  );
  const raw = await until(
    async () =>
      (
        await post(`/CapabilityProbeV1/${task.id}/result`, {})
      ).json() as Promise<unknown>,
    (r) => CapabilityResult.safeParse(r).success,
  );
  const result = CapabilityResult.parse(raw);
  expect(result.output).toEqual({ text: task.objective.trim().toUpperCase() });
  expect(
    compose(
      "exec",
      "-T",
      "worker",
      "cat",
      `/tmp/capability-${task.id}-calls`,
    ).trim(),
  ).toBe("attempt");
  await post(`/CapabilityProbeV1/${task.id}/run/send`, task);
  const runs = await pool.query<{ result: unknown }>(
    "select result from capability_runs where task_id=$1",
    [task.id],
  );
  expect(runs.rowCount).toBe(1);
  expect(CapabilityResult.parse(runs.rows[0]?.result)).toEqual(result);
  expect(
    (await pool.query("select 1 from evidence where task_id=$1", [task.id]))
      .rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "select 1 from task_events where task_id=$1 and type='TOOL_CALLED'",
        [task.id],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await pool.query("select 1 from outcomes where task_id=$1", [task.id]))
      .rowCount,
  ).toBe(0);
});
let releaseRuntime = () => {};
beforeAll(async () => {
  releaseRuntime = holdRuntime();
  // Only this dedicated disposable validation stack is reset; never use remote URLs.
  compose("down", "--volumes");
  compose("up", "-d", "--build");
  await until(
    () => pool.query("select 1"),
    (r) => r.rowCount === 1,
  );
  await migrate(pool);
  await pool.query("insert into principals(id,kind) values($1,$2)", [
    fixture.principal.id,
    fixture.principal.kind,
  ]);
  await pool.query("insert into tenants(id,name) values($1,$2)", [
    fixture.tenant.id,
    "recovery-test",
  ]);
  await pool.query(
    "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,$3)",
    [fixture.tenant.id, fixture.principal.id, "owner"],
  );
  await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [
    reviewer,
  ]);
  await pool.query(
    "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'reviewer')",
    [fixture.tenant.id, reviewer],
  );
  await until(
    () => fetch(`${ADMIN}/health`),
    (r) => r.ok,
  );
  // Let Restate negotiate HTTP/2 discovery with the worker.
  const registration = await until(
    () =>
      fetch(`${ADMIN}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri: "http://worker:9080", force: true }),
      }),
    (response) => response.ok,
  );
  expect(registration.ok, await registration.text()).toBe(true);
}, 300000);
afterAll(async () => {
  await pool.end();
  releaseRuntime();
});
async function submit(): Promise<Task> {
  const task = Task.parse({
    ...fixture,
    id: randomUUID(),
    traceId: randomUUID(),
  });
  await client.submit(task);
  return task;
}
async function status(task: Task, status: string): Promise<void> {
  await until(
    async () => {
      const r = await pool.query<{ status: string }>(
        "select status from tasks where id=$1",
        [task.id],
      );
      return r.rows[0]?.status;
    },
    (s) => s === status,
  );
}
async function assertCompleted(task: Task): Promise<void> {
  await status(task, "COMPLETED");
  const result = await pool.query<{ contract: unknown }>(
    "select contract from outcomes where task_id=$1",
    [task.id],
  );
  const outcome = Outcome.parse(result.rows[0]?.contract);
  expect(outcome.summary).toBe(stepB(stepA(task.objective)));
  const events = await pool.query<{ event_key: string }>(
    "select event_key from task_events where task_id=$1",
    [task.id],
  );
  expect(events.rows.map((r) => r.event_key).sort()).toEqual(
    [
      "create",
      "compile",
      "ready",
      "start",
      "a-start",
      "a-complete",
      "wait",
      "resume",
      "b-start",
      "b-complete",
      "evidence",
      "verify",
      "complete",
    ].sort(),
  );
  expect(
    (await pool.query("select * from evidence where task_id=$1", [task.id]))
      .rowCount,
  ).toBe(1);
  expect(
    (await pool.query("select * from task_steps where task_id=$1", [task.id]))
      .rowCount,
  ).toBe(2);
  expect((await client.status(task.id))?.status).toBe("COMPLETED");
}
it("survives worker and Restate restart at durable wait; duplicate signal/submission is safe", async () => {
  const task = await submit();
  await status(task, "WAITING");
  compose("kill", "-s", "SIGKILL", "worker", "restate");
  compose("start", "restate", "worker");
  await until(
    () => fetch(`${ADMIN}/health`),
    (r) => r.ok,
  );
  const signals = await Promise.all(
    Array.from({ length: 4 }, () => client.signal(task.id)),
  );
  for (const signal of signals) expect(signal.decision.action).toBe("RESUME");
  await assertCompleted(task);
  // Same workflow key cannot execute a second time, regardless of caller retry key.
  await post(`/TaskWorkflow/${task.id}/run/send`, task);
  await assertCompleted(task);
});
it("replays after database commit but before Restate acknowledgement without duplicate effects", async () => {
  const task = await submit();
  await status(task, "WAITING");
  compose("exec", "-T", "worker", "touch", "/tmp/kerneljson-crash-once");
  expect(
    (await post(`/TaskWorkflow/${task.id}/signal`, { action: "RESUME" })).ok,
  ).toBe(true);
  await until(
    async () =>
      pool.query(
        "select 1 from task_events where task_id=$1 and event_key=$2",
        [task.id, "b-complete"],
      ),
    (r) => r.rowCount === 1,
  );
  await until(
    async () => compose("ps", "-a", "--format", "json", "worker"),
    (s) => s.includes("exited"),
  );
  compose("start", "worker");
  await assertCompleted(task);
});
it("cancels a waiting task durably; a late resume cannot execute step B", async () => {
  const task = await submit();
  await status(task, "WAITING");
  const cancel = await client.cancel(task.id);
  expect(cancel.decision.action).toBe("CANCEL");
  await status(task, "CANCELLED");
  const late = await post(`/TaskWorkflow/${task.id}/signal`, {
    action: "RESUME",
  });
  expect(await late.json()).toMatchObject({ decision: { action: "CANCEL" } });
  expect(
    (
      await pool.query(
        "select * from task_events where task_id=$1 and event_key=$2",
        [task.id, "b-start"],
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (await pool.query("select * from outcomes where task_id=$1", [task.id]))
      .rowCount,
  ).toBe(1);
});
it("rejects unsupported recipe requests without creating a task projection", async () => {
  const id = randomUUID();
  const response = await fetch(`${INGRESS}/TaskWorkflow/${id}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...fixture,
      id,
      acceptanceCriteria: ["Send an email"],
    }),
  });
  expect(response.status).toBe(400);
  expect(
    (await pool.query("select * from tasks where id=$1", [id])).rowCount,
  ).toBe(0);
});
async function submitKernel(recipe: RecipeId = "uppercase-reverse/v1") {
  const submission = {
    ...kernelSubmission,
    recipe,
    intent: { ...kernelSubmission.intent, id: randomUUID() },
  };
  const { task } = compileIntent(submission);
  expect(await kernel.submit(submission)).toEqual({ taskId: task.id });
  return { task, submission, plan: planTask(task, recipe) };
}
async function assertKernelCompleted(task: Task, expectedPlan: ExecutionPlan) {
  await status(task, "COMPLETED");
  const result = await pool.query<{ contract: unknown }>(
    "select contract from outcomes where task_id=$1",
    [task.id],
  );
  const outcome = Outcome.parse(result.rows[0]?.contract);
  expect(outcome.summary).toBe(
    expectedPlan.recipe === "uppercase/v1"
      ? task.objective.toUpperCase()
      : stepB(stepA(task.objective)),
  );
  const stored = await pool.query<{
    payload: { plan: unknown; planDigest: string };
  }>(
    "select payload from task_events where task_id=$1 and type='PLAN_COMPILED'",
    [task.id],
  );
  expect(stored.rowCount).toBe(1);
  expect(ExecutionPlan.parse(stored.rows[0]?.payload.plan)).toEqual(
    expectedPlan,
  );
  expect(stored.rows[0]?.payload.planDigest).toBe(digest(expectedPlan));
  const steps = await pool.query<{ id: string; status: string }>(
    "select id,status from task_steps where task_id=$1",
    [task.id],
  );
  expect(steps.rows.map((s) => s.id).sort()).toEqual(
    expectedPlan.steps.map((s) => s.id).sort(),
  );
  expect(steps.rows.every((s) => s.status === "COMPLETED")).toBe(true);
  for (const type of ["STEP_STARTED", "STEP_COMPLETED"])
    expect(
      (
        await pool.query(
          "select 1 from task_events where task_id=$1 and type=$2",
          [task.id, type],
        )
      ).rowCount,
    ).toBe(expectedPlan.steps.length);
  expect(
    (await pool.query("select 1 from evidence where task_id=$1", [task.id]))
      .rowCount,
  ).toBe(1);
  expect((await kernel.status(task.id))?.status).toBe("COMPLETED");
}
it("Phase 4 compiles an intent and executes a one-step plan without a wait", async () => {
  const { task, submission, plan } = await submitKernel("uppercase/v1");
  await assertKernelCompleted(task, plan);
  await kernel.submit(submission);
  await assertKernelCompleted(task, plan);
  const event = await pool.query<{ payload: { intent: { id: string } } }>(
    "select payload from task_events where task_id=$1 and type='TASK_CREATED'",
    [task.id],
  );
  expect(event.rows[0]?.payload.intent.id).toBe(submission.intent.id);
});
it("Phase 4 executes the persisted DAG across Restate/worker restart and duplicate signals", async () => {
  const { task, plan } = await submitKernel();
  await status(task, "WAITING");
  const wait = plan.steps.find((s) => s.operation === "WAIT_FOR_EVENT")!;
  expect(
    (
      await pool.query<{ status: string }>(
        "select status from task_steps where id=$1",
        [wait.id],
      )
    ).rows[0]?.status,
  ).toBe("WAITING");
  compose("kill", "-s", "SIGKILL", "worker", "restate");
  compose("start", "worker", "restate");
  await until(
    () => fetch(`${ADMIN}/health`),
    (r) => r.ok,
  );
  await Promise.all([
    kernel.signal(task.id),
    kernel.signal(task.id),
    kernel.signal(task.id),
  ]);
  await assertKernelCompleted(task, plan);
});
it("Phase 4 recovers after a graph step commit before Restate acknowledgement", async () => {
  const { task, plan } = await submitKernel();
  await status(task, "WAITING");
  const wait = plan.steps.find((s) => s.operation === "WAIT_FOR_EVENT")!;
  compose("exec", "-T", "worker", "touch", "/tmp/kerneljson-crash-once");
  await kernel.signal(task.id);
  await until(
    () =>
      pool.query(
        "select 1 from task_events where task_id=$1 and event_key=$2",
        [task.id, `step:${wait.id}:complete`],
      ),
    (r) => r.rowCount === 1,
  );
  await until(
    async () => compose("ps", "-a", "--format", "json", "worker"),
    (s) => s.includes("exited"),
  );
  compose("start", "worker");
  await assertKernelCompleted(task, plan);
});
it("Phase 4 cancels a waiting graph without executing downstream work", async () => {
  const { task, plan } = await submitKernel();
  await status(task, "WAITING");
  await kernel.cancel(task.id);
  await status(task, "CANCELLED");
  await kernel.signal(task.id);
  const steps = await pool.query<{ id: string; status: string }>(
    "select id,status from task_steps where task_id=$1",
    [task.id],
  );
  expect(steps.rows.find((s) => s.id === plan.resultStepId)?.status).toBe(
    "READY",
  );
  expect(
    steps.rows.some((s) => s.status === "RUNNING" || s.status === "WAITING"),
  ).toBe(false);
  expect(
    (await pool.query("select 1 from evidence where task_id=$1", [task.id]))
      .rowCount,
  ).toBe(0);
});
it("Phase 4 rejects graph injection at the workflow boundary before persistence", async () => {
  const submission = {
    ...kernelSubmission,
    intent: { ...kernelSubmission.intent, id: randomUUID() },
  };
  const { task } = compileIntent(submission);
  const response = await post(`/KernelWorkflowV1/${task.id}/run`, {
    ...submission,
    plan: { operation: "SHELL" },
  });
  expect(response.status).toBe(400);
  expect(
    (await pool.query("select 1 from tasks where id=$1", [task.id])).rowCount,
  ).toBe(0);
});

it.each([200, 429] as const)(
  "Phase 5 journals model HTTP %i results across a receipt commit/acknowledgement crash",
  async (providerStatus) => {
    const task = Task.parse({
      ...fixture,
      id: randomUUID(),
      traceId: randomUUID(),
    });
    compose(
      "exec",
      "-T",
      "worker",
      "touch",
      "/tmp/kerneljson-model-crash-once",
    );
    expect(
      (
        await post(`/ModelProbeV1/${task.id}/run/send`, {
          task,
          providerStatus,
        })
      ).ok,
    ).toBe(true);
    await until(
      () =>
        pool.query(
          "select 1 from task_events where task_id=$1 and type='MODEL_CALLED'",
          [task.id],
        ),
      (r) => r.rowCount === 1,
    );
    await until(
      async () => compose("ps", "-a", "--format", "json", "worker"),
      (s) => s.includes("exited"),
    );
    compose("kill", "-s", "SIGKILL", "restate");
    compose("start", "restate", "worker");
    await until(
      () => fetch(`${ADMIN}/health`),
      (r) => r.ok,
    );
    const raw = await until(
      async () =>
        (
          await post(`/ModelProbeV1/${task.id}/result`, {})
        ).json() as Promise<unknown>,
      (r) => ModelCallResult.safeParse(r).success,
    );
    const result = ModelCallResult.parse(raw);
    expect(result.status).toBe(providerStatus === 200 ? "SUCCEEDED" : "FAILED");
    const rows = await pool.query<{ payload: unknown }>(
      "select payload from task_events where task_id=$1 and type='MODEL_CALLED'",
      [task.id],
    );
    expect(rows.rowCount).toBe(1);
    expect(ModelCallReceipt.parse(rows.rows[0]?.payload)).toEqual(
      result.receipt,
    );
    expect(
      compose(
        "exec",
        "-T",
        "worker",
        "cat",
        `/tmp/model-${task.id}-calls`,
      ).trim(),
    ).toBe("attempt");
    expect(result.receipt.taskId).toBe(task.id);
    expect(JSON.stringify(result.receipt)).not.toContain(
      "private recovery test prompt",
    );
    expect(
      (await pool.query("select 1 from outcomes where task_id=$1", [task.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query<{ status: string }>(
          "select status from tasks where id=$1",
          [task.id],
        )
      ).rows[0]?.status,
    ).toBe("RECEIVED");
  },
);

it("Gate 1 gateway retries a lost dispatch acknowledgement and resumes its bound workflow after restart", async()=>{
 const context={tenantId:fixture.tenant.id,principal:fixture.principal};
 const controls=createRestateControls(INGRESS,async()=>({'authorization':'Bearer test-owner'}),{pool});
 const dispatch=createRestateDispatch(INGRESS,async()=>({'authorization':'Bearer test-owner'}));
 let loseAck=true;
 const server=createServer(createGateway({pool,releaseId:process.env['KERNELJSON_RELEASE_ID']??'unreleased-development',authenticate:bearerAuthenticator(async token=>token==='test-owner'?context:null),admit:async()=>true,controls,dispatch:async(...args)=>{const result=await dispatch(...args);if(loseAck){loseAck=false;throw new Error('Lost acknowledgement');}return result;}}));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Missing server');
 const base=`http://127.0.0.1:${address.port}`;
 const headers={'authorization':'Bearer test-owner','content-type':'application/json','idempotency-key':randomUUID()};
 const send=()=>fetch(`${base}/v1/tasks`,{method:'POST',headers,body:JSON.stringify({recipe:'uppercase-reverse/v1',objective:'gateway recovery'})});
 try{
  const first=await send();expect(first.status).toBe(202);
  const receipt=await first.json() as {taskId:string;dispatch:string};expect(receipt.dispatch).toBe('UNRESOLVED');
  await until(()=>pool.query<{contract:Task}>('select contract from tasks where id=$1',[receipt.taskId]),r=>r.rows[0]?.contract.status==='WAITING');
  compose('kill','-s','SIGKILL','worker','restate');compose('start','restate','worker');
  await until(()=>fetch(`${ADMIN}/health`),r=>r.ok);
  const retry=await send();expect(retry.status).toBe(202);expect((await retry.json() as {taskId:string}).taskId).toBe(receipt.taskId);
  const signal=()=>fetch(`${base}/v1/tasks/${receipt.taskId}/signal`,{method:'POST',headers,body:JSON.stringify({action:'RESUME'})});
  expect([202,409]).toContain((await signal()).status);
  const completed=await until(async()=>{const r=await fetch(`${base}/v1/tasks/${receipt.taskId}`,{headers});return r.json() as Promise<{status:string;outcome:unknown}>;},r=>r.status==='COMPLETED');
  expect(Outcome.parse(completed.outcome).evidenceRefs.length).toBeGreaterThan(0);
  expect((await signal()).status).toBe(409);
  expect((await pool.query("select 1 from task_events where task_id=$1 and type='TASK_CREATED'",[receipt.taskId])).rowCount).toBe(1);
  expect((await pool.query("select 1 from task_events where task_id=$1 and type='TASK_COMPLETED'",[receipt.taskId])).rowCount).toBe(1);
  expect((await pool.query('select 1 from kernel_private.task_admissions where task_id=$1',[receipt.taskId])).rowCount).toBe(1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.each(['TaskWorkflow','KernelWorkflowV1'] as const)('Gate 1 cancellation resolves %s binding and retains a terminal result',async family=>{
 const task=family==='TaskWorkflow'?await submit():await (async()=>{const submission={...kernelSubmission,intent:{...kernelSubmission.intent,id:randomUUID()}};const compiled=compileIntent(submission);await post(`/KernelWorkflowV1/${compiled.task.id}/run/send`,submission);return compiled.task;})();
 await status(task,'WAITING');
 const controls=createRestateControls(INGRESS,async()=>({}),{pool});
 expect(['ACCEPTED','COMPLETED']).toContain((await controls.cancel({tenantId:task.tenant.id,principal:task.principal},task.id))?.status);
 await status(task,'CANCELLED');
 expect((await controls.cancel({tenantId:task.tenant.id,principal:task.principal},task.id))?.status).toBe('COMPLETED');
 expect((await pool.query('select 1 from kernel_private.terminal_results where task_id=$1',[task.id])).rowCount).toBe(1);
});

it('Gate 1 permanent verification failure survives a failure-outcome commit acknowledgement crash',async()=>{
 const task=await submit();await status(task,'WAITING');
 compose('exec','-T','worker','touch','/tmp/kerneljson-corrupt-step-once','/tmp/kerneljson-failed-crash-once');
 await client.signal(task.id);
 await status(task,'FAILED');
 await until(async()=>compose('ps','-a','--format','json','worker'),s=>s.includes('exited'));
 compose('start','worker');
 const response=await fetch(`${INGRESS}/restate/workflow/TaskWorkflow/${task.id}/attach`,{signal:AbortSignal.timeout(30000)});
 expect(response.ok).toBe(true);expect(Outcome.parse(await response.json()).status).toBe('FAILED');
 expect((await pool.query("select 1 from task_events where task_id=$1 and type='TASK_COMPLETED'",[task.id])).rowCount).toBe(0);
 expect((await pool.query("select 1 from task_events where task_id=$1 and type='TASK_FAILED'",[task.id])).rowCount).toBe(1);
});
