import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  DATABASE,
  compose,
  migrate,
  until,
  holdRuntime,
} from "./support/local.js";
import { Ledger } from "../services/kernel/src/ledger.js";
import {
  Task,
  TaskEvent,
  TaskStep,
  CapabilityInvocation,
  CapabilityResult,
} from "../packages/contracts/src/index.js";
import {
  createBuiltinRegistry,
  capabilityDigest,
  UPPERCASE,
  REVERSE,
  CapabilityRegistry,
  TextInput,
  TextOutput,
} from "../packages/capabilities/src/index.js";
import { CapabilityStore } from "../services/kernel/src/capability-store.js";
import { ApprovalStore } from "../services/kernel/src/approval-store.js";
import { evaluatePolicy } from "../services/kernel/src/policy.js";
import { task as fixture, at } from "../evals/fixtures/contracts.js";
const admin = new pg.Pool({ connectionString: DATABASE });
const name = `test_${randomUUID().replaceAll("-", "")}`;
const pool = new pg.Pool({
  connectionString: DATABASE.replace("/kerneljson", `/${name}`),
});
const ledger = new Ledger(pool);
const task = Task.parse({ ...fixture, id: randomUUID() });
const event = TaskEvent.parse({
  id: randomUUID(),
  taskId: task.id,
  type: "TASK_CREATED",
  occurredAt: at,
  actor: task.principal,
  traceId: task.traceId,
  payload: {},
});
const write = { key: "create", task, event };
const capabilities = createBuiltinRegistry();
const capabilityStore = new CapabilityStore(pool, capabilities);
const approvalStore = new ApprovalStore(pool);
let releaseRuntime = () => {};
beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(
    () => admin.query("select 1"),
    (r) => r.rowCount === 1,
  );
  await admin.query(`create database ${name}`);
  await migrate(pool);
  await pool.query("insert into principals(id,kind) values($1,$2)", [
    task.principal.id,
    task.principal.kind,
  ]);
  await pool.query("insert into tenants(id,name) values($1,$2)", [
    task.tenant.id,
    "fixture",
  ]);
  await pool.query(
    "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,$3)",
    [task.tenant.id, task.principal.id, "owner"],
  );
  await ledger.write(write);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`drop database if exists ${name}`);
  await admin.end();
  releaseRuntime();
});

async function capabilityFixture() {
  let t = Task.parse({ ...fixture, id: randomUUID(), traceId: randomUUID() });
  const request = CapabilityInvocation.parse({
    runId: randomUUID(),
    taskId: t.id,
    stepId: randomUUID(),
    trace: { traceId: t.traceId, correlationId: randomUUID() },
    capability: UPPERCASE,
    idempotencyKey: "uppercase-1",
    input: { text: " hello " },
  });
  for (const [status, type] of [
    ["RECEIVED", "TASK_CREATED"],
    ["COMPILED", "PLAN_COMPILED"],
    ["READY", "TASK_READY"],
    ["RUNNING", "TASK_STARTED"],
  ] as const) {
    t = Task.parse({ ...t, status });
    await ledger.write({
      key: status,
      task: t,
      event: TaskEvent.parse({
        ...event,
        id: randomUUID(),
        taskId: t.id,
        traceId: t.traceId,
        type,
      }),
      ...(status === "RUNNING"
        ? {
            step: TaskStep.parse({
              id: request.stepId,
              taskId: t.id,
              kind: "DETERMINISTIC_FUNCTION",
              status: "RUNNING",
              dependencies: [],
              requiredCapabilities: [UPPERCASE],
              riskClass: "LOW",
              retryPolicy: { maxAttempts: 1, backoffMs: 0 },
              input: request.input,
              idempotencyKey: request.idempotencyKey,
            }),
          }
        : {}),
    });
  }
  return {
    request,
    result: capabilities.execute(request),
    audit: { evidenceId: randomUUID(), eventId: randomUUID(), recordedAt: at },
  };
}

it("Phase 6 atomically persists one capability run, evidence and event under concurrent retries", async () => {
  const { request, result, audit } = await capabilityFixture();
  await Promise.all(
    Array.from({ length: 3 }, () =>
      capabilityStore.record(request, result, audit),
    ),
  );
  const rows = await pool.query<{ result: unknown; digest: string }>(
    "select r.result,e.digest from capability_runs r join evidence e on e.id=r.evidence_id where r.task_id=$1",
    [request.taskId],
  );
  expect(rows.rowCount).toBe(1);
  expect(CapabilityResult.parse(rows.rows[0]?.result)).toEqual(result);
  expect(rows.rows[0]?.digest).toBe(capabilityDigest(result));
  expect(
    (
      await pool.query(
        "select 1 from task_events where task_id=$1 and type='TOOL_CALLED'",
        [request.taskId],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query("select 1 from outcomes where task_id=$1", [
        request.taskId,
      ])
    ).rowCount,
  ).toBe(0);
  for (const sql of [
    "update capability_runs set result='{}' where id=$1",
    "delete from capability_runs where id=$1",
  ])
    await expect(pool.query(sql, [request.runId])).rejects.toMatchObject({
      code: "55000",
    });
});
it("Phase 6 rejects idempotency conflicts without another evidence record", async () => {
  const { request, result, audit } = await capabilityFixture();
  await capabilityStore.record(request, result, audit);
  const other = { ...request, runId: randomUUID() };
  await expect(
    capabilityStore.record(other, capabilities.execute(other), audit),
  ).rejects.toThrow("idempotency conflict");
  expect(
    (
      await pool.query("select 1 from evidence where task_id=$1", [
        request.taskId,
      ])
    ).rowCount,
  ).toBe(1);
});
it("Phase 6 rejects wrong trace, step, input and capability bindings before persistence", async () => {
  const { request, audit } = await capabilityFixture();
  for (const change of [
    { stepId: randomUUID() },
    { input: { text: "other" } },
    { trace: { ...request.trace, traceId: randomUUID() } },
    { capability: REVERSE },
  ]) {
    const other = { ...request, ...change };
    await expect(
      capabilityStore.record(other, capabilities.execute(other), audit),
    ).rejects.toThrow();
  }
  expect(
    (
      await pool.query("select 1 from capability_runs where task_id=$1", [
        request.taskId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query("select 1 from evidence where task_id=$1", [
        request.taskId,
      ])
    ).rowCount,
  ).toBe(0);
});
it("Phase 6 rolls back evidence and event if capability run insertion fails", async () => {
  const first = await capabilityFixture();
  await capabilityStore.record(first.request, first.result, first.audit);
  const second = await capabilityFixture();
  const request = { ...second.request, runId: first.request.runId };
  await expect(
    capabilityStore.record(
      request,
      capabilities.execute(request),
      second.audit,
    ),
  ).rejects.toMatchObject({ code: "23505" });
  expect(
    (
      await pool.query("select 1 from evidence where task_id=$1", [
        request.taskId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "select 1 from task_events where task_id=$1 and type='TOOL_CALLED'",
        [request.taskId],
      )
    ).rowCount,
  ).toBe(0);
});
it("Phase 6 rejects forged output even when the attacker recomputes its digest", async () => {
  const { request, result, audit } = await capabilityFixture();
  const output = { text: "forged" };
  await expect(
    capabilityStore.record(
      request,
      { ...result, output, outputDigest: capabilityDigest(output) },
      audit,
    ),
  ).rejects.toThrow("VERIFICATION_FAILED");
  expect(
    (
      await pool.query("select 1 from evidence where task_id=$1", [
        request.taskId,
      ])
    ).rowCount,
  ).toBe(0);
});
it("Phase 6 refuses descriptor changes under an already-persisted version", async () => {
  const first = await capabilityFixture();
  await capabilityStore.record(first.request, first.result, first.audit);
  const changedRegistry = new CapabilityRegistry([
    {
      metadata: {
        ...capabilities.describe(UPPERCASE).metadata,
        description: "Changed without a version bump",
      },
      inputSchema: TextInput,
      outputSchema: TextOutput,
      execute: (input) => ({
        text: TextInput.parse(input).text.trim().toUpperCase(),
      }),
      verify: (input, output) =>
        TextOutput.parse(output).text ===
        TextInput.parse(input).text.trim().toUpperCase(),
    },
  ]);
  const next = await capabilityFixture();
  await expect(
    new CapabilityStore(pool, changedRegistry).record(
      next.request,
      changedRegistry.execute(next.request),
      next.audit,
    ),
  ).rejects.toThrow("version definition conflict");
  expect(
    (
      await pool.query("select 1 from evidence where task_id=$1", [
        next.request.taskId,
      ])
    ).rowCount,
  ).toBe(0);
});

it("Phase 6 refuses to persist new execution receipts for a waiting task", async () => {
  const { request, result, audit } = await capabilityFixture();
  const rows = await pool.query<{ contract: unknown }>(
    "select contract from tasks where id=$1",
    [request.taskId],
  );
  const task = Task.parse({
    ...Task.parse(rows.rows[0]?.contract),
    status: "WAITING",
  });
  await ledger.write({
    key: "wait",
    task,
    event: TaskEvent.parse({
      ...event,
      id: randomUUID(),
      taskId: task.id,
      traceId: task.traceId,
      type: "TASK_WAITING",
    }),
  });
  await expect(capabilityStore.record(request, result, audit)).rejects.toThrow(
    "running task step",
  );
  expect(
    (
      await pool.query("select 1 from capability_runs where task_id=$1", [
        task.id,
      ])
    ).rowCount,
  ).toBe(0);
});

async function approvalFixture(expired = false, reviewer?: Task["principal"]) {
  let task = Task.parse({
    ...fixture,
    id: randomUUID(),
    traceId: randomUUID(),
  });
  const request = CapabilityInvocation.parse({
    runId: randomUUID(),
    taskId: task.id,
    stepId: randomUUID(),
    trace: { traceId: task.traceId, correlationId: randomUUID() },
    capability: UPPERCASE,
    idempotencyKey: "approval-uppercase",
    input: { text: "hello" },
  });
  const step = TaskStep.parse({
    id: request.stepId,
    taskId: task.id,
    kind: "DETERMINISTIC_FUNCTION",
    status: "READY",
    dependencies: [],
    requiredCapabilities: [UPPERCASE],
    riskClass: "LOW",
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    input: request.input,
    idempotencyKey: request.idempotencyKey,
  });
  for (const [status, type] of [
    ["RECEIVED", "TASK_CREATED"],
    ["COMPILED", "PLAN_COMPILED"],
  ] as const) {
    task = Task.parse({ ...task, status });
    await ledger.write({
      key: status,
      task,
      event: TaskEvent.parse({
        ...event,
        id: randomUUID(),
        taskId: task.id,
        traceId: task.traceId,
        type,
      }),
      ...(status === "COMPILED" ? { step } : {}),
    });
  }
  const evaluatedAt = new Date(
    Date.now() - (expired ? 10000 : 0),
  ).toISOString();
  if (reviewer) {
    await pool.query("insert into principals(id,kind) values($1,$2)", [
      reviewer.id,
      reviewer.kind,
    ]);
    await pool.query(
      "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'reviewer')",
      [task.tenant.id, reviewer.id],
    );
  }
  const evaluation = evaluatePolicy(
    {
      version: "db-policy/1",
      rules: [
        {
          tenantId: task.tenant.id,
          principalId: task.principal.id,
          capability: UPPERCASE,
          effect: "APPROVAL_REQUIRED",
          approver: reviewer ?? task.principal,
          ttlMs: expired ? 100 : 60000,
        },
      ],
    },
    task,
    step,
    request,
    capabilities.describe(UPPERCASE),
    randomUUID(),
    evaluatedAt,
  );
  const approvalId = randomUUID();
  await approvalStore.record(evaluation, request, approvalId);
  return { task, request, evaluation, approvalId };
}
it("Phase 7 binds approvals to scope and authenticated identity, with first terminal decision winning", async () => {
  const { task, approvalId, evaluation, request } = await approvalFixture();
  await approvalStore.record(evaluation, request, approvalId);
  await expect(
    approvalStore.resolve(
      approvalId,
      { scopeDigest: "0".repeat(64), decision: "GRANTED" },
      task.principal,
      randomUUID(),
      randomUUID(),
    ),
  ).rejects.toThrow("scope mismatch");
  await expect(
    approvalStore.resolve(
      approvalId,
      { scopeDigest: evaluation.scopeDigest, decision: "GRANTED" },
      { id: randomUUID(), kind: "HUMAN" },
      randomUUID(),
      randomUUID(),
    ),
  ).rejects.toThrow("identity");
  const results = await Promise.all(
    ["GRANTED", "DENIED"].map((decision) =>
      approvalStore.resolve(
        approvalId,
        { scopeDigest: evaluation.scopeDigest, decision },
        task.principal,
        randomUUID(),
        randomUUID(),
      ),
    ),
  );
  expect(results[0]?.status).toBe(results[1]?.status);
  expect(
    (await pool.query("select 1 from evidence where task_id=$1", [task.id]))
      .rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "select 1 from task_events where task_id=$1 and event_key=$2",
        [task.id, `approval:${approvalId}:resolved`],
      )
    ).rowCount,
  ).toBe(1);
});
it("Phase 7 cannot grant an expired approval", async () => {
  const { task, evaluation, approvalId } = await approvalFixture(true);
  const result = await approvalStore.resolve(
    approvalId,
    { scopeDigest: evaluation.scopeDigest, decision: "GRANTED" },
    task.principal,
    randomUUID(),
    randomUUID(),
  );
  expect(result.status).toBe("EXPIRED");
});
it("Phase 7 rechecks tenant membership before granting", async () => {
  const reviewer = { id: randomUUID(), kind: "HUMAN" as const };
  const { task, evaluation, approvalId } = await approvalFixture(
    false,
    reviewer,
  );
  await pool.query(
    "delete from tenant_memberships where tenant_id=$1 and principal_id=$2",
    [task.tenant.id, reviewer.id],
  );
  await expect(
    approvalStore.resolve(
      approvalId,
      { scopeDigest: evaluation.scopeDigest, decision: "GRANTED" },
      reviewer,
      randomUUID(),
      randomUUID(),
    ),
  ).rejects.toThrow("member");
  expect((await approvalStore.read(approvalId)).status).toBe("PENDING");
});

it("applies all four migration groups with RLS and no public API grants", async () => {
  const r = await pool.query<{ tablename: string; rowsecurity: boolean }>(
    "select tablename,rowsecurity from pg_tables where schemaname='public'",
  );
  expect(r.rows).toHaveLength(19);
  expect(r.rows.every((t) => t.rowsecurity)).toBe(true);
  for (const role of ["anon", "authenticated"]) {
    const db = await pool.connect();
    try {
      await db.query(`set role ${role}`);
      await expect(db.query("select * from tasks")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await db.query("reset role");
      db.release();
    }
  }
});
it("rejects event UPDATE, DELETE and TRUNCATE even for the local owner", async () => {
  for (const sql of [
    "update task_events set type='TASK_COMPLETED'",
    "delete from task_events",
    "truncate task_events",
  ])
    await expect(pool.query(sql)).rejects.toMatchObject({ code: "55000" });
  expect(
    (await pool.query("select * from task_events where task_id=$1", [task.id]))
      .rows,
  ).toHaveLength(1);
});
it("retries ledger writes without duplicates and rejects changed input", async () => {
  await Promise.all([ledger.write(write), ledger.write(write)]);
  expect(
    (await pool.query("select * from task_events where task_id=$1", [task.id]))
      .rows,
  ).toHaveLength(1);
  await expect(
    ledger.write({ ...write, event: { ...event, payload: { changed: true } } }),
  ).rejects.toThrow("Idempotency");
  await expect(
    pool.query(
      "insert into task_events select $1,task_id,step_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload from task_events",
      [randomUUID()],
    ),
  ).rejects.toMatchObject({ code: "23505" });
});
it("rejects lifecycle skips and completion without evidence at the database boundary", async () => {
  await expect(
    pool.query(
      "update tasks set status='COMPLETED',contract=jsonb_set(contract,'{status}','\"COMPLETED\"') where id=$1",
      [task.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  for (const status of ["COMPILED", "READY", "RUNNING", "VERIFYING"])
    await pool.query(
      "update tasks set status=$2::text::task_status,contract=jsonb_set(contract,'{status}',to_jsonb($2::text)) where id=$1",
      [task.id, status],
    );
  await expect(
    pool.query(
      "update tasks set status='COMPLETED',contract=jsonb_set(contract,'{status}','\"COMPLETED\"') where id=$1",
      [task.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("enforces tenant ownership and provenance foreign keys", async () => {
  await expect(
    pool.query(
      "insert into observations(id,tenant_id,entity_id,task_id,evidence_id,source,value,observed_at,valid_from,confidence) values($1,$2,$3,$4,$5,$6,$7,$8,$8,1)",
      [
        randomUUID(),
        task.tenant.id,
        randomUUID(),
        task.id,
        randomUUID(),
        "test",
        {},
        at,
      ],
    ),
  ).rejects.toMatchObject({ code: "23503" });
});
it("enforces capability side-effect idempotency and immutable evidence", async () => {
  const stepId = randomUUID(),
    evidenceId = randomUUID(),
    capabilityId = randomUUID(),
    versionId = randomUUID();
  await pool.query(
    "insert into task_steps(id,task_id,status,contract) values($1,$2,$3,$4)",
    [
      stepId,
      task.id,
      "COMPLETED",
      { id: stepId, taskId: task.id, status: "COMPLETED" },
    ],
  );
  await pool.query(
    "insert into evidence(id,task_id,step_id,type,source,digest,captured_at,metadata) values($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      evidenceId,
      task.id,
      stepId,
      "TOOL_RECEIPT",
      "local-test",
      "a".repeat(64),
      at,
      {},
    ],
  );
  await pool.query("insert into capabilities(id,name) values($1,$2)", [
    capabilityId,
    "test-receipt",
  ]);
  await pool.query(
    "insert into capability_versions(id,capability_id,version,contract) values($1,$2,$3,$4)",
    [versionId, capabilityId, "1", {}],
  );
  const sql =
    "insert into capability_runs(id,task_id,step_id,capability_version_id,idempotency_key,request_digest,result,evidence_id,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)";
  const values = [
    task.id,
    stepId,
    versionId,
    "external-write-1",
    "b".repeat(64),
    { receipt: 1 },
    evidenceId,
    at,
  ];
  await pool.query(sql, [randomUUID(), ...values]);
  await expect(
    pool.query(sql, [randomUUID(), ...values]),
  ).rejects.toMatchObject({ code: "23505" });
  for (const sql of [
    "update evidence set source='changed'",
    "delete from evidence",
    "truncate evidence cascade",
  ])
    await expect(pool.query(sql)).rejects.toMatchObject({ code: "55000" });
  await expect(
    pool.query(
      "insert into approvals(id,task_id,requested_from,requested_at,status,evidence_id) values($1,$2,$3,$4,$5,$6)",
      [randomUUID(), task.id, task.principal.id, at, "GRANTED", evidenceId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("commits evidence-bound completion atomically and protects terminal records", async () => {
  const evidence = (
    await pool.query<{ id: string }>(
      "select id from evidence where task_id=$1",
      [task.id],
    )
  ).rows[0]!;
  const contract = {
    taskId: task.id,
    status: "COMPLETED",
    acceptanceResults: [
      {
        criterion: task.acceptanceCriteria[0],
        passed: true,
        evidenceRefs: [evidence.id],
      },
    ],
    evidenceRefs: [evidence.id],
    summary: "Receipt verified",
    completedAt: at,
  };
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(
      "insert into outcomes(id,task_id,status,contract,completed_at) values($1,$2,$3,$4,$5)",
      [randomUUID(), task.id, "COMPLETED", contract, at],
    );
    await db.query(
      "insert into task_events(id,task_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        randomUUID(),
        task.id,
        "complete",
        "c".repeat(64),
        "TASK_COMPLETED",
        at,
        task.principal.id,
        task.traceId,
        {},
      ],
    );
    await db.query("update tasks set status=$2,contract=$3 where id=$1", [
      task.id,
      "COMPLETED",
      { ...task, status: "COMPLETED", completedAt: at },
    ]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
  expect((await ledger.status(task.id))?.status).toBe("COMPLETED");
  await expect(
    pool.query("update tasks set updated_at=now() where id=$1", [task.id]),
  ).rejects.toMatchObject({ code: "23514" });
  for (const sql of [
    "update outcomes set contract='{}'",
    "delete from outcomes",
    "truncate outcomes cascade",
  ])
    await expect(pool.query(sql)).rejects.toMatchObject({ code: "55000" });
});
