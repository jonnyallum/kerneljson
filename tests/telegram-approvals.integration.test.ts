import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import pg from "pg";
import { ADMIN, DATABASE, INGRESS, compose, holdRuntime, migrate, until } from "./support/local.js";
import { createRestateControls } from "../apps/gateway/src/index.js";
import { createGateway, createRestateDispatch, bearerAuthenticator } from "../apps/gateway/src/server.js";
import { buildDoorHandler, loadDoorConfig } from "../apps/gateway/src/main.js";
import { Outcome, type Task } from "../packages/contracts/src/index.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { kernelSubmission } from "../evals/fixtures/kernel.js";
import { task as fixture } from "../evals/fixtures/contracts.js";
import { PgNotificationOutboxStore } from "../services/kernel/src/alerting/pg-outbox-store.js";
import { createApprovalsPort } from "../services/kernel/src/channel/telegram/approvals.js";
import { HttpDoorClient } from "../services/kernel/src/channel/telegram/door-client.js";
import { pollOnce, type OperatorDeps } from "../services/kernel/src/channel/telegram/operator.js";
import { PgCardStore } from "../services/kernel/src/channel/telegram/pg-card-store.js";
import { PgInboxStore } from "../services/kernel/src/channel/telegram/pg-inbox-store.js";
import { PgStatusReader } from "../services/kernel/src/channel/telegram/status.js";
import { FakeBot, callbackUpdate, dataFor } from "./support/approval-fixture.js";
import { CHAT, FakeSource, LIMITS } from "./support/telegram-fixture.js";

/**
 * KJ-P4B end to end, on the disposable validation stack: a REAL Restate, the REAL golden workflow
 * (its real policy, approval store, durable promise and `approve` handler), a REAL Postgres ledger and
 * the REAL admission-door control route. Only Telegram itself (the update source and the bot) is a double.
 *
 * The test worker's golden workflow uses the same synthetic identities as the earlier approval tests:
 * `test-owner` owns the task, `test-reviewer` is the named approver, the deadline is 30 seconds. The
 * door here authenticates the approver (its one bearer maps to the reviewer) and presents the
 * reviewer's credential to the workflow, standing in for the production control token. This proves the
 * Telegram interface drives the existing machinery and can do nothing that machinery would not allow.
 */
const pool = new pg.Pool({ connectionString: DATABASE });
const owner = fixture.principal.id;
const reviewer = "70000000-0000-4000-8000-000000000002";
const DOOR_BEARER = `p4b-door-${randomUUID()}${randomUUID()}`;
const context = { tenantId: fixture.tenant.id, principal: { id: reviewer, kind: "HUMAN" as const } };

let releaseRuntime = () => {};
let server: Server;
let doorBase = "";
let deps: OperatorDeps;
const source = new FakeSource();
const bot = new FakeBot();
const cards = new PgCardStore(pool);

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  // Only this dedicated disposable validation stack is reset; never use remote URLs.
  compose("down", "--volumes");
  compose("up", "-d", "--build");
  await until(() => pool.query("select 1"), (r) => r.rowCount === 1);
  await migrate(pool);
  await pool.query("insert into principals(id,kind) values($1,$2)", [owner, fixture.principal.kind]);
  await pool.query("insert into tenants(id,name) values($1,$2)", [fixture.tenant.id, "p4b-test"]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')", [fixture.tenant.id, owner]);
  await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [reviewer]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'reviewer')", [fixture.tenant.id, reviewer]);
  await until(() => fetch(`${ADMIN}/health`), (r) => r.ok);
  const registration = await until(
    () =>
      fetch(`${ADMIN}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri: "http://worker:9080", force: true }),
      }),
    (r) => r.ok,
  );
  expect(registration.ok, await registration.text()).toBe(true);

  // The real door, real control route. Its one bearer is the approver's; the workflow hop carries the
  // approver's credential (production: the shared control token).
  const controls = createRestateControls(INGRESS, async () => ({ authorization: "Bearer test-reviewer" }), { pool });
  const dispatch = createRestateDispatch(INGRESS, async () => ({ authorization: "Bearer test-owner" }));
  server = createServer(
    createGateway({
      pool,
      releaseId: "p4b-test",
      authenticate: bearerAuthenticator(async (token) => (token === DOOR_BEARER ? context : null)),
      admit: async () => true,
      controls,
      dispatch,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  doorBase = `http://127.0.0.1:${address.port}`;

  const door = new HttpDoorClient(doorBase, `Bearer ${DOOR_BEARER}`);
  deps = {
    limits: LIMITS,
    source,
    inbox: new PgInboxStore(pool),
    door,
    status: new PgStatusReader(pool),
    outbox: new PgNotificationOutboxStore(pool),
    deliver: async () => {},
    deliverDue: async () => {},
    now: () => new Date(),
    approvals: createApprovalsPort({ tenantId: fixture.tenant.id, approverId: reviewer, cards, bot, door, now: () => new Date() }),
  };
}, 300000);

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  releaseRuntime();
});

// ---------------------------------------------------------------------------------------------
const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
const n = async (sql: string, args: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(sql, args))[0]!.n);

async function post(path: string, body: unknown, actor?: string): Promise<Response> {
  return fetch(`${INGRESS}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(actor ? { authorization: `Bearer ${actor}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

/** Start a golden `uppercase/v1` task through Restate as its owner and wait until it asks for approval. */
async function startWaiting(objective?: string): Promise<{ task: Task; objective: string }> {
  const intent = { ...kernelSubmission.intent, id: randomUUID(), ...(objective ? { objective } : {}) };
  const submission = { ...kernelSubmission, recipe: "uppercase/v1", intent };
  const { task } = compileIntent(submission);
  const started = await post(`/GoldenTaskWorkflowV1/${task.id}/run/send`, submission, "test-owner");
  expect(started.ok).toBe(true);
  await status(task, "APPROVAL_REQUIRED");
  return { task, objective: task.objective };
}

async function status(task: Task, want: string, timeout = 60000): Promise<void> {
  await until(
    async () => (await q<{ status: string }>("select status from tasks where id=$1", [task.id]))[0]?.status,
    (s) => s === want,
    timeout,
  );
}

let updateCounter = 100_000_000;
const uid = (): number => (updateCounter += 1);

async function poll(updates: ReturnType<typeof callbackUpdate>[] = []) {
  source.updates = updates;
  return pollOnce(deps);
}

/** Poll until this task's card has been shown, then return its message id and handles. */
async function cardFor(task: Task) {
  let row: { message_id: string | null } | undefined;
  for (let i = 0; i < 40; i++) {
    row = (await q<{ message_id: string | null }>("select message_id from kernel_private.telegram_approval_cards where approval_id = $1", [task.id]))[0];
    if (row?.message_id) break;
    await poll();
  }
  expect(row?.message_id, "the card was never shown").toBeTruthy();
  const handles = await q<{ handle: string; decision: string }>("select handle, decision from kernel_private.telegram_approval_handles where approval_id = $1", [task.id]);
  return {
    messageId: Number(row!.message_id),
    granted: handles.find((h) => h.decision === "GRANTED")!.handle,
    denied: handles.find((h) => h.decision === "DENIED")!.handle,
  };
}

const press = (handle: string, messageId: number, o = {}) => poll([callbackUpdate(uid(), dataFor(handle), { messageId, ...o })]);
const approvalStatus = async (task: Task) => (await q<{ status: string }>("select status from approvals where id = $1", [task.id]))[0]?.status;
const controlEvents = (task: Task) => n("select count(*) n from kernel_private.control_events where task_id = $1", [task.id]);
const outcomes = (task: Task) => n("select count(*) n from outcomes where task_id = $1", [task.id]);
const capabilityRuns = (task: Task) => n("select count(*) n from capability_runs where task_id = $1", [task.id]);
const lastToast = () => bot.answers.at(-1)?.text;
const lastClosed = () => bot.closed.at(-1)?.text.split("\n")[0];

describe("KJ-P4B approve: the durable workflow resumes, once, through the existing machinery", () => {
  it("shows one card, and an APPROVE press completes the SAME workflow with a single audit chain", async () => {
    const { task, objective } = await startWaiting();
    const shown = await cardFor(task);
    // One concise card, no raw objective, no full digest, two opaque buttons.
    const card = bot.cards.find((c) => c.messageId === shown.messageId)!;
    expect(card.text).toContain(`Task: ${task.id.slice(0, 8)}`);
    expect(card.text).not.toContain(objective);
    expect(card.text).not.toMatch(/[a-f0-9]{64}/);
    expect(card.keyboard.inline_keyboard[0]!.map((b) => b.text)).toEqual(["APPROVE", "REJECT"]);
    expect(bot.cards.filter((c) => c.text.includes(`Task: ${task.id.slice(0, 8)}`))).toHaveLength(1);
    // Nothing has run, and nothing has been decided.
    expect(await approvalStatus(task)).toBe("PENDING");
    expect(await outcomes(task)).toBe(0);
    expect(await capabilityRuns(task)).toBe(0);

    const s = await press(shown.granted, shown.messageId);
    expect(s).toMatchObject({ callbacks: 1, unauthorised: 0 });
    await status(task, "COMPLETED");

    expect(await approvalStatus(task)).toBe("GRANTED");
    expect(lastToast()).toBe("Approved. The task will continue.");
    // The same workflow instance ran to the end: one creation, one completion, one capability run, one outcome.
    expect(await n("select count(*) n from task_events where task_id=$1 and type='TASK_CREATED'", [task.id])).toBe(1);
    expect(await n("select count(*) n from task_events where task_id=$1 and type='TASK_COMPLETED'", [task.id])).toBe(1);
    expect(await capabilityRuns(task)).toBe(1);
    expect(await outcomes(task)).toBe(1);
    const [row] = await q<{ contract: unknown }>("select contract from outcomes where task_id=$1", [task.id]);
    expect(Outcome.parse(row!.contract).summary).toBe(objective.toUpperCase());
    // The decision is human evidence recorded by the ApprovalStore, and the door recorded the control.
    expect(await n("select count(*) n from evidence where task_id=$1 and source='kerneljson:approval/v1'", [task.id])).toBe(1);
    expect(await controlEvents(task)).toBe(2); // REQUESTED, ACCEPTED
    // The workflow cannot be run a second time.
    const again = await post(`/GoldenTaskWorkflowV1/${task.id}/run`, { ...kernelSubmission, recipe: "uppercase/v1" }, "test-owner");
    expect(again.ok).toBe(false);
    // And the card's buttons are gone.
    await poll();
    expect(lastClosed()).toBe("Approved");
    expect((await q<{ state: string }>("select state from kernel_private.telegram_approval_cards where approval_id=$1", [task.id]))[0]?.state).toBe("RESOLVED");
  }, 180000);

  it("a duplicate press and a Telegram redelivery do not resume it twice", async () => {
    const { task } = await startWaiting();
    const shown = await cardFor(task);
    const first = uid();
    await poll([callbackUpdate(first, dataFor(shown.granted), { messageId: shown.messageId })]);
    await status(task, "COMPLETED");
    const evidence = await n("select count(*) n from evidence where task_id=$1", [task.id]);
    const controls = await controlEvents(task);

    // Telegram redelivers the very same update (the offset was not kept).
    await pool.query("update kernel_private.telegram_operator_state set next_offset = 0");
    const redelivered = await poll([callbackUpdate(first, dataFor(shown.granted), { messageId: shown.messageId })]);
    expect(redelivered).toMatchObject({ duplicates: 1, callbacks: 0 });
    // A fresh press of the same button, then of the other one.
    await press(shown.granted, shown.messageId);
    expect(lastToast()).toBe("Already approved. Your approve changed nothing.");
    await press(shown.denied, shown.messageId);
    expect(lastToast()).toBe("Already approved. Your reject changed nothing.");

    expect(await approvalStatus(task)).toBe("GRANTED");
    expect(await outcomes(task)).toBe(1);
    expect(await capabilityRuns(task)).toBe(1);
    expect(await n("select count(*) n from evidence where task_id=$1", [task.id])).toBe(evidence);
    expect(await controlEvents(task)).toBe(controls);
    expect(await n("select count(*) n from task_events where task_id=$1 and type='TASK_COMPLETED'", [task.id])).toBe(1);
  }, 180000);
});

describe("KJ-P4B reject: the workflow ends the step and the capability never runs", () => {
  it("a REJECT press records DENIED, fails the task with evidence, and runs nothing", async () => {
    const { task } = await startWaiting();
    const shown = await cardFor(task);
    await press(shown.denied, shown.messageId);
    await status(task, "FAILED");
    expect(await approvalStatus(task)).toBe("DENIED");
    expect(lastToast()).toBe("Rejected. The task will not run this action.");
    expect(await capabilityRuns(task)).toBe(0);
    expect(await outcomes(task)).toBe(0);
    expect(await n("select count(*) n from evidence where task_id=$1 and source='kerneljson:approval/v1'", [task.id])).toBe(1);
    await poll();
    expect(lastClosed()).toBe("Rejected");
    // A later APPROVE cannot undo it.
    await press(shown.granted, shown.messageId);
    expect(lastToast()).toBe("Already rejected. Your approve changed nothing.");
    expect(await approvalStatus(task)).toBe("DENIED");
    expect(await capabilityRuns(task)).toBe(0);
  }, 180000);
});

describe("KJ-P4B binding: an approval for one action can never approve another", () => {
  it("wrong digest: refused by the door and the ledger, the task keeps waiting, and the right digest still works", async () => {
    const { task } = await startWaiting();
    const shown = await cardFor(task);
    const scope_digest = (await q<{ scope_digest: string }>("select scope_digest from kernel_private.telegram_approval_cards where approval_id=$1", [task.id]))[0]!.scope_digest;
    await pool.query("update kernel_private.telegram_approval_cards set scope_digest = $2 where approval_id = $1", [task.id, "0".repeat(64)]);
    await press(shown.granted, shown.messageId);
    expect(lastToast()).toBe("KernelJSON refused that answer. Nothing was changed.");
    expect(await approvalStatus(task)).toBe("PENDING");
    expect((await q<{ status: string }>("select status from tasks where id=$1", [task.id]))[0]?.status).toBe("APPROVAL_REQUIRED");
    expect(await capabilityRuns(task)).toBe(0);
    // The ledger's own digest, restored, is the only one that ever worked.
    await pool.query("update kernel_private.telegram_approval_cards set scope_digest = $2 where approval_id = $1", [task.id, scope_digest]);
    await press(shown.granted, shown.messageId);
    await status(task, "COMPLETED");
    expect(await approvalStatus(task)).toBe("GRANTED");
  }, 180000);

  it("wrong task: another task's approval is not approved by this card, and neither task moves", async () => {
    const a = await startWaiting();
    const b = await startWaiting();
    const shownA = await cardFor(a.task);
    await cardFor(b.task);
    await pool.query("update kernel_private.telegram_approval_cards set task_id = $2 where approval_id = $1", [a.task.id, b.task.id]);
    await press(shownA.granted, shownA.messageId);
    expect(lastToast()).toBe("KernelJSON refused that answer. Nothing was changed.");
    expect(await approvalStatus(a.task)).toBe("PENDING");
    expect(await approvalStatus(b.task)).toBe("PENDING");
    expect(await capabilityRuns(a.task)).toBe(0);
    expect(await capabilityRuns(b.task)).toBe(0);
    // Tidy: end both through the owner's cancel so they do not linger.
    for (const t of [a.task, b.task]) await post(`/GoldenTaskWorkflowV1/${t.id}/cancel`, {}, "test-owner");
  }, 180000);
});

describe("KJ-P4B who and what can reach an approval", () => {
  it("a press from another user, another chat, or a forged button reaches nothing", async () => {
    const { task } = await startWaiting();
    const shown = await cardFor(task);
    const before = { controls: await controlEvents(task), unauthorised: Number((await q<{ n: string }>("select unauthorised_total::text n from kernel_private.telegram_operator_state"))[0]!.n) };
    const answers = bot.answers.length;

    const stranger = await press(shown.granted, shown.messageId, { fromId: Number(CHAT) + 1 });
    const group = await press(shown.granted, shown.messageId, { chatId: -100123, chatType: "supergroup" });
    const bots = await press(shown.granted, shown.messageId, { isBot: true });
    expect([stranger.unauthorised, group.unauthorised, bots.unauthorised]).toEqual([1, 1, 1]);
    // Forged data from the RIGHT user: unknown handle, a task id in the clear, an edited real handle.
    for (const data of [`kj1:${"A".repeat(22)}`, `approve:${task.id}`, `kj1:${shown.granted.slice(0, 21)}x`]) {
      await poll([callbackUpdate(uid(), data, { messageId: shown.messageId })]);
      expect(lastToast()).toBe("That button is not recognised. Nothing was changed.");
    }
    // A real handle pressed from a different message.
    await poll([callbackUpdate(uid(), dataFor(shown.granted), { messageId: shown.messageId + 1 })]);

    expect(await approvalStatus(task)).toBe("PENDING");
    expect(await controlEvents(task)).toBe(before.controls);
    expect(await capabilityRuns(task)).toBe(0);
    // Only the four the allow-listed user actually pressed were answered; strangers get nothing.
    expect(bot.answers.length - answers).toBe(4);
    expect(Number((await q<{ n: string }>("select unauthorised_total::text n from kernel_private.telegram_operator_state"))[0]!.n)).toBe(before.unauthorised + 3);
    await post(`/GoldenTaskWorkflowV1/${task.id}/cancel`, {}, "test-owner");
  }, 180000);

  it("the door refuses a caller that is not the approver, and the workflow refuses an unauthenticated or wrong-principal approve", async () => {
    const { task } = await startWaiting();
    const shown = await cardFor(task);
    const scope_digest = (await q<{ scope_digest: string }>("select scope_digest from kernel_private.telegram_approval_cards where approval_id=$1", [task.id]))[0]!.scope_digest;
    // Wrong door bearer: never reaches the workflow.
    expect(await new HttpDoorClient(doorBase, "Bearer not-the-door-bearer").approve({ taskId: task.id, scopeDigest: scope_digest, decision: "GRANTED", updateId: 1 })).toBe("REFUSED");
    // Straight at the workflow, as anything but the named approver: no credential, and the task's own owner.
    const answer = { scopeDigest: scope_digest, decision: "GRANTED" };
    expect((await post(`/GoldenTaskWorkflowV1/${task.id}/approve`, answer)).status).toBe(401);
    expect((await post(`/GoldenTaskWorkflowV1/${task.id}/approve`, answer, "test-owner")).status).toBe(403);
    expect((await post(`/GoldenTaskWorkflowV1/${task.id}/approve`, answer, "test-forged")).status).toBe(401);
    expect(await approvalStatus(task)).toBe("PENDING");
    expect(await capabilityRuns(task)).toBe(0);
    // The named approver, with the right digest, is what works: the card is an interface, not the authority.
    await press(shown.granted, shown.messageId);
    await status(task, "COMPLETED");
  }, 180000);

  it("a cancelled task's card cannot resurrect it: the stale press changes nothing", async () => {
    const { task } = await startWaiting();
    const shown = await cardFor(task);
    expect((await post(`/GoldenTaskWorkflowV1/${task.id}/cancel`, {}, "test-owner")).ok).toBe(true);
    await status(task, "CANCELLED");
    await press(shown.granted, shown.messageId);
    expect(lastToast()).toMatch(/^Already (rejected|expired)\./);
    expect((await q<{ status: string }>("select status from tasks where id=$1", [task.id]))[0]?.status).toBe("CANCELLED");
    expect(await capabilityRuns(task)).toBe(0);
    expect(await outcomes(task)).toBe(0);
  }, 180000);
});

describe("KJ-P4B expiry: an expired approval cannot resume work", () => {
  it("after the deadline the workflow has failed the task, and a late APPROVE changes nothing", async () => {
    const { task } = await startWaiting();
    const shown = await cardFor(task);
    // The synthetic policy's deadline is 30 seconds; the workflow's own timer settles it.
    await status(task, "FAILED", 90000);
    expect(await approvalStatus(task)).toBe("EXPIRED");
    await press(shown.granted, shown.messageId);
    expect(lastToast()).toBe("Already expired. Your approve changed nothing.");
    expect(await approvalStatus(task)).toBe("EXPIRED");
    expect(await capabilityRuns(task)).toBe(0);
    expect(await outcomes(task)).toBe(0);
    await poll();
    expect(lastClosed()).toBe("Expired");
  }, 240000);
});

describe("KJ-P4B the door's internal hop carries the control token, and only the control token", () => {
  it("presents `Authorization: Bearer <control token>` to the workflow endpoint, never the admission bearer", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const fake = createServer((req, res) => {
      seen.push({ ...req.headers });
      req.resume();
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const CONTROL = `p4b-control-${randomUUID()}${randomUUID()}`;
    const DOOR = `p4b-door-bearer-${randomUUID()}${randomUUID()}`;
    const env = {
      DATABASE_URL: DATABASE,
      KJ_ADMISSION_BEARER: DOOR,
      KJ_ADMISSION_TENANT_ID: fixture.tenant.id,
      KJ_ADMISSION_PRINCIPAL_ID: owner,
      KJ_ADMISSION_PRINCIPAL_KIND: "HUMAN",
      KJ_RESTATE_INGRESS_URL: `http://127.0.0.1:${address.port}`,
    };
    const submit = async (over: Record<string, string>) => {
      const handler = buildDoorHandler(pool, loadDoorConfig({ ...env, ...over }));
      const door = createServer((req, res) => handler(req, res));
      await new Promise<void>((resolve) => door.listen(0, "127.0.0.1", resolve));
      const a = door.address();
      if (!a || typeof a === "string") throw new Error("no address");
      try {
        return await fetch(`http://127.0.0.1:${a.port}/v1/tasks`, {
          method: "POST",
          headers: { authorization: `Bearer ${DOOR}`, "content-type": "application/json", "idempotency-key": randomUUID() },
          body: JSON.stringify({ recipe: "uppercase/v1", objective: "door hop check" }),
        });
      } finally {
        door.closeAllConnections();
        await new Promise<void>((resolve) => door.close(() => resolve()));
      }
    };
    try {
      expect((await submit({ KJ_CONTROL_TOKEN: CONTROL })).status).toBe(202);
      const withToken = seen.at(-1)!;
      expect(withToken["authorization"]).toBe(`Bearer ${CONTROL}`);
      expect(JSON.stringify(withToken)).not.toContain(DOOR);
      // Negative control: with no control token configured, no credential is sent at all, as before.
      seen.length = 0;
      expect((await submit({})).status).toBe(202);
      expect(seen.at(-1)!["authorization"]).toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain(DOOR);
    } finally {
      fake.closeAllConnections();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  }, 120000);
});
