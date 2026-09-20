import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import pg from "pg";
import { ADMIN, DATABASE, INGRESS, compose, holdRuntime, migrate, until } from "./support/local.js";
import { buildDoorHandler, loadDoorConfig } from "../apps/gateway/src/main.js";
import { ControlAuthError, InMemoryReplayStore, createControlSigner, createControlVerifier } from "../services/kernel/src/control-signing.js";
import { CONTROL_OTHER_KEY, CONTROL_TEST_KEY, CONTROL_TEST_KEY_ID } from "./support/control-test-key.js";
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
 * door here is the PRODUCTION door: it authenticates the approver (its one bearer maps to the reviewer)
 * and signs every request to the workflow with an HMAC assertion (KJ-P4B.1), which the worker verifies
 * with the production verifier and Postgres replay store. This proves the Telegram interface drives the
 * existing machinery and can do nothing that machinery would not allow, and (KJ-P4B.1) that what Restate
 * journals on that hop is assertions, never the long-lived key.
 */
const pool = new pg.Pool({ connectionString: DATABASE });

const owner = fixture.principal.id;
const reviewer = "70000000-0000-4000-8000-000000000002";
const DOOR_BEARER = `p4b-door-${randomUUID()}${randomUUID()}`;
/** The REAL production door configuration, signing every request to the workflow with the synthetic key. */
const doorConfig = (principal: string, bearer: string) =>
  loadDoorConfig({
    DATABASE_URL: DATABASE,
    KJ_ADMISSION_BEARER: bearer,
    KJ_ADMISSION_TENANT_ID: fixture.tenant.id,
    KJ_ADMISSION_PRINCIPAL_ID: principal,
    KJ_ADMISSION_PRINCIPAL_KIND: "HUMAN",
    KJ_RESTATE_INGRESS_URL: INGRESS,
    KJ_CONTROL_SIGNING_KEY: CONTROL_TEST_KEY,
    KJ_CONTROL_KEY_ID: CONTROL_TEST_KEY_ID,
  });

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

  // The real production door (buildDoorHandler). Its one bearer is the approver's. Every request it makes to
  // the workflow is a signed assertion (KJ-P4B.1): nothing else crosses Restate.
  const handler = buildDoorHandler(pool, doorConfig(reviewer, DOOR_BEARER));
  server = createServer((req, res) => handler(req, res));
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

// ---------------------------------------------------------------------------------------------
// KJ-P4B.1: signed control assertions against the REAL Restate and the REAL golden workflow. The
// earlier tests already drive the whole approval path through the production door, which now signs
// every request to the workflow; these add the attacks and the proof about what Restate stores.

/** Sign a request exactly as the door would, as the approver (the reviewer). */
const signAs = (principal: string, r: { service?: string; handler: string; key: string; body: string }, o: { key?: string; nonce?: string; nowSeconds?: number } = {}) =>
  createControlSigner({
    keyId: CONTROL_TEST_KEY_ID,
    key: o.key ?? CONTROL_TEST_KEY,
    ...(o.nonce ? { nonce: () => o.nonce! } : {}),
    ...(o.nowSeconds !== undefined ? { now: () => o.nowSeconds! * 1000 } : {}),
  })({ service: r.service ?? "GoldenTaskWorkflowV1", handler: r.handler, key: r.key, body: r.body, tenantId: fixture.tenant.id, principalId: principal });

/** Post a body to a workflow handler through the real ingress with exactly the given headers. */
const postWith = (path: string, body: string, headers: Record<string, string>) =>
  fetch(`${INGRESS}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(15000) });

async function ledgerDigest(task: Task): Promise<string> {
  return (await q<{ d: string }>("select scope_digest as d from kernel_private.telegram_approval_cards where approval_id=$1", [task.id]))[0]?.d
    ?? (await q<{ d: string }>("select payload->'evaluation'->>'scopeDigest' as d from task_events where task_id=$1 and event_key=$2", [task.id, `policy-approval:${task.id}`]))[0]!.d;
}
const answer = (digest: string, decision = "GRANTED"): string => JSON.stringify({ scopeDigest: digest, decision });

describe("KJ-P4B.1 signed assertions on the real workflow: what verifies and what does not", () => {
  it("a signed approve from the approver is what resumes the workflow", async () => {
    const { task } = await startWaiting();
    const body = answer(await ledgerDigest(task));
    const res = await postWith(`/GoldenTaskWorkflowV1/${task.id}/approve`, body, signAs(reviewer, { handler: "approve", key: task.id, body }));
    expect(res.status).toBe(200);
    await status(task, "COMPLETED");
    expect(await approvalStatus(task)).toBe("GRANTED");
  }, 180000);

  it("an identical redelivery of the same signed request is accepted idempotently and resumes nothing twice", async () => {
    const { task } = await startWaiting();
    const body = answer(await ledgerDigest(task));
    const headers = signAs(reviewer, { handler: "approve", key: task.id, body });
    const first = await postWith(`/GoldenTaskWorkflowV1/${task.id}/approve`, body, headers);
    const second = await postWith(`/GoldenTaskWorkflowV1/${task.id}/approve`, body, headers);
    expect([first.status, second.status]).toEqual([200, 200]);
    await status(task, "COMPLETED");
    expect(await n("select count(*) n from evidence where task_id=$1 and source='kerneljson:approval/v1'", [task.id])).toBe(1);
    expect(await capabilityRuns(task)).toBe(1);
    expect(await n("select count(*) n from kernel_private.control_assertions where nonce=$1", [headers["x-kj-control-nonce"]])).toBe(1);
  }, 180000);

  it.each([
    ["no assertion at all", () => ({}) as Record<string, string>],
    ["a bearer in place of an assertion", () => ({ authorization: "Bearer not-an-assertion" })],
    // A key-LOOKALIKE, never the key: Restate journals whatever a caller sends, so the real one must not be planted here.
    ["a key-shaped bearer in Authorization", () => ({ authorization: `Bearer ${"NOT-THE-KEY-".padEnd(64, "x")}` })],
  ])("refuses %s, and the approval stays pending", async (_label, headers) => {
    const { task } = await startWaiting();
    const body = answer(await ledgerDigest(task));
    expect((await postWith(`/GoldenTaskWorkflowV1/${task.id}/approve`, body, headers())).status).toBe(401);
    expect(await approvalStatus(task)).toBe("PENDING");
    await post(`/GoldenTaskWorkflowV1/${task.id}/cancel`, {}, "test-owner");
  }, 180000);

  it("refuses an assertion tampered with in any way it is bound to, and each attempt leaves the approval pending", async () => {
    const { task } = await startWaiting();
    const other = await startWaiting("another task entirely");
    const digest = await ledgerDigest(task);
    const body = answer(digest);
    const good = signAs(reviewer, { handler: "approve", key: task.id, body });
    const at = `/GoldenTaskWorkflowV1/${task.id}/approve`;
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const attempts: Array<[string, Response]> = [];
    // decision changed after signing, with and without the body-hash header rewritten
    attempts.push(["decision changed", await postWith(at, answer(digest, "DENIED"), good)]);
    attempts.push(["decision changed, hash rewritten", await postWith(at, answer(digest, "DENIED"), { ...good, "x-kj-control-body-sha256": sha(answer(digest, "DENIED")) })]);
    // digest changed
    attempts.push(["digest changed", await postWith(at, answer("b".repeat(64)), { ...good, "x-kj-control-body-sha256": sha(answer("b".repeat(64))) })]);
    // the same assertion used against another task, and against another handler
    attempts.push(["another task", await postWith(`/GoldenTaskWorkflowV1/${other.task.id}/approve`, body, good)]);
    attempts.push(["another handler", await postWith(`/GoldenTaskWorkflowV1/${task.id}/cancel`, body, good)]);
    // tenant / principal: an assertion signed for the owner used where the verifier resolves the same key for both
    // principals still names the principal inside the signature, so a forged principal id in the payload fails
    attempts.push(["signed with the wrong key", await postWith(at, body, signAs(reviewer, { handler: "approve", key: task.id, body }, { key: CONTROL_OTHER_KEY }))]);
    attempts.push(["a different tenant", await postWith(at, body, createControlSigner({ keyId: CONTROL_TEST_KEY_ID, key: CONTROL_TEST_KEY })({ service: "GoldenTaskWorkflowV1", handler: "approve", key: task.id, body, tenantId: randomUUID(), principalId: reviewer }))]);
    attempts.push(["a stranger principal", await postWith(at, body, signAs(randomUUID(), { handler: "approve", key: task.id, body }))]);
    for (const [label, res] of attempts) expect(res.status, label).toBe(401);
    expect(await approvalStatus(task)).toBe("PENDING");
    expect(await approvalStatus(other.task)).toBe("PENDING");
    expect(await capabilityRuns(task)).toBe(0);
    for (const t of [task, other.task]) await post(`/GoldenTaskWorkflowV1/${t.id}/cancel`, {}, "test-owner");
  }, 240000);

  it("refuses a stale first-use assertion, however valid its signature", async () => {
    const { task } = await startWaiting();
    const body = answer(await ledgerDigest(task));
    const stale = signAs(reviewer, { handler: "approve", key: task.id, body }, { nowSeconds: Math.floor(Date.now() / 1000) - 900 });
    expect((await postWith(`/GoldenTaskWorkflowV1/${task.id}/approve`, body, stale)).status).toBe(401);
    const future = signAs(reviewer, { handler: "approve", key: task.id, body }, { nowSeconds: Math.floor(Date.now() / 1000) + 900 });
    expect((await postWith(`/GoldenTaskWorkflowV1/${task.id}/approve`, body, future)).status).toBe(401);
    expect(await n("select count(*) n from kernel_private.control_assertions where nonce=any($1)", [[stale["x-kj-control-nonce"], future["x-kj-control-nonce"]]])).toBe(0);
    expect(await approvalStatus(task)).toBe("PENDING");
    await post(`/GoldenTaskWorkflowV1/${task.id}/cancel`, {}, "test-owner");
  }, 180000);

  it("a replay store that cannot answer is retried, never turned into a refusal", async () => {
    const { task } = await startWaiting();
    const body = answer(await ledgerDigest(task));
    const headers = signAs(reviewer, { handler: "approve", key: task.id, body });
    // Make the nonce table unavailable (the ledger itself stays up), as a database fault would.
    await pool.query("alter table kernel_private.control_assertions rename to control_assertions_offline");
    try {
      // Restate accepts the one-way call; the worker then cannot decide and must retry rather than refuse.
      const sent = await postWith(`/GoldenTaskWorkflowV1/${task.id}/approve/send`, body, headers);
      expect(sent.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 6000));
      expect(await approvalStatus(task)).toBe("PENDING");
    } finally {
      await pool.query("alter table kernel_private.control_assertions_offline rename to control_assertions");
    }
    // If the fault had been turned into a 401 the invocation would be over and the approval would still be pending.
    await status(task, "COMPLETED", 120000);
    expect(await approvalStatus(task)).toBe("GRANTED");
    expect(await n("select count(*) n from kernel_private.control_assertions where nonce=$1", [headers["x-kj-control-nonce"]])).toBe(1);
  }, 300000);

  it("refuses the same nonce reused with a changed payload, and the original still stands", async () => {
    const { task } = await startWaiting();
    const digest = await ledgerDigest(task);
    const NONCE = "R".repeat(22);
    const reject = answer(digest, "DENIED");
    const approve = answer(digest, "GRANTED");
    const first = await postWith(`/GoldenTaskWorkflowV1/${task.id}/approve`, reject, signAs(reviewer, { handler: "approve", key: task.id, body: reject }, { nonce: NONCE }));
    expect(first.status).toBe(200);
    const reused = await postWith(`/GoldenTaskWorkflowV1/${task.id}/approve`, approve, signAs(reviewer, { handler: "approve", key: task.id, body: approve }, { nonce: NONCE }));
    expect(reused.status).toBe(401);
    expect(await approvalStatus(task)).toBe("DENIED");
    await status(task, "FAILED");
    expect(await capabilityRuns(task)).toBe(0);
  }, 180000);
});

describe("KJ-P4B.1 the whole path through the production door, signed end to end", () => {
  it("a task admitted through the owner's door runs the golden workflow on a signed dispatch, then a signed approve completes it", async () => {
    const OWNER_DOOR = `p4b1-owner-${randomUUID()}${randomUUID()}`;
    const owner = doorConfig(fixture.principal.id, OWNER_DOOR);
    const handler = buildDoorHandler(pool, owner);
    const ownerServer = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => ownerServer.listen(0, "127.0.0.1", resolve));
    const a = ownerServer.address();
    if (!a || typeof a === "string") throw new Error("no address");
    try {
      const res = await fetch(`http://127.0.0.1:${a.port}/v1/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${OWNER_DOOR}`, "content-type": "application/json", "idempotency-key": randomUUID() },
        body: JSON.stringify({ recipe: "uppercase/v1", objective: "signed dispatch check" }),
      });
      expect(res.status).toBe(202);
      const receipt = (await res.json()) as { taskId: string; dispatch: string };
      expect(receipt.dispatch).toBe("ACCEPTED");
      const task = { id: receipt.taskId } as Task;
      await status(task, "APPROVAL_REQUIRED");
      const shown = await cardFor(task);
      await press(shown.granted, shown.messageId);
      await status(task, "COMPLETED");
      expect(await approvalStatus(task)).toBe("GRANTED");
      const [row] = await q<{ contract: unknown }>("select contract from outcomes where task_id=$1", [task.id]);
      expect(Outcome.parse(row!.contract).summary).toBe("SIGNED DISPATCH CHECK");
      // Both hops, the dispatch and the approval, were signed assertions the worker recorded.
      expect(await n("select count(*) n from kernel_private.control_assertions where workflow_key=$1", [task.id])).toBeGreaterThanOrEqual(2);
      expect(await n("select count(*) n from kernel_private.control_assertions where workflow_key=$1 and handler='run'", [task.id])).toBe(1);
      expect(await n("select count(*) n from kernel_private.control_assertions where workflow_key=$1 and handler='approve'", [task.id])).toBe(1);
    } finally {
      ownerServer.closeAllConnections();
      await new Promise<void>((resolve) => ownerServer.close(() => resolve()));
    }
  }, 240000);
});

describe("KJ-P4B.1 the door's hop, seen from the boundary (a Restate-equivalent that records what it receives)", () => {
  it("receives a signed assertion that verifies for exactly that request, and never the key or any Authorization", async () => {
    const seen: Array<{ headers: Record<string, string | string[] | undefined>; body: string; url: string }> = [];
    const fake = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8"), url: req.url ?? "" });
        res.statusCode = 202;
        res.setHeader("content-type", "application/json");
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const DOOR = `p4b1-door-bearer-${randomUUID()}${randomUUID()}`;
    const config = loadDoorConfig({
      DATABASE_URL: DATABASE,
      KJ_ADMISSION_BEARER: DOOR,
      KJ_ADMISSION_TENANT_ID: fixture.tenant.id,
      KJ_ADMISSION_PRINCIPAL_ID: owner,
      KJ_ADMISSION_PRINCIPAL_KIND: "HUMAN",
      KJ_RESTATE_INGRESS_URL: `http://127.0.0.1:${address.port}`,
      KJ_CONTROL_SIGNING_KEY: CONTROL_TEST_KEY,
      KJ_CONTROL_KEY_ID: CONTROL_TEST_KEY_ID,
    });
    const handler = buildDoorHandler(pool, config);
    const door = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => door.listen(0, "127.0.0.1", resolve));
    const a = door.address();
    if (!a || typeof a === "string") throw new Error("no address");
    try {
      const res = await fetch(`http://127.0.0.1:${a.port}/v1/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${DOOR}`, "content-type": "application/json", "idempotency-key": randomUUID() },
        body: JSON.stringify({ recipe: "uppercase/v1", objective: "boundary check" }),
      });
      expect(res.status).toBe(202);
      expect(seen).toHaveLength(1);
      const got = seen[0]!;
      const wire = JSON.stringify(got.headers);
      // What crossed: assertion headers only.
      expect(Object.keys(got.headers).filter((k) => k.startsWith("x-kj-control-")).sort()).toEqual([
        "x-kj-control-body-sha256", "x-kj-control-key-id", "x-kj-control-nonce", "x-kj-control-signature", "x-kj-control-timestamp", "x-kj-control-version",
      ]);
      expect(got.headers["authorization"]).toBeUndefined();
      expect(wire).not.toContain(CONTROL_TEST_KEY);
      expect(wire).not.toContain(Buffer.from(CONTROL_TEST_KEY).toString("hex"));
      expect(wire).not.toContain(Buffer.from(CONTROL_TEST_KEY).toString("base64"));
      expect(wire + got.body).not.toContain(DOOR); // the public admission bearer never leaves the door either
      // And what crossed verifies, for exactly this request and no other.
      const m = /^\/([A-Za-z0-9]+)\/([^/]+)\/run\/send$/.exec(got.url);
      expect(m).not.toBeNull();
      const verify = createControlVerifier({
        keys: new Map([[CONTROL_TEST_KEY_ID, CONTROL_TEST_KEY]]),
        tenantId: fixture.tenant.id,
        principalId: owner,
        freshnessSeconds: 300,
        replay: new InMemoryReplayStore(),
      });
      const headers = new Map(Object.entries(got.headers).map(([k, v]) => [k, String(v)] as const));
      const request = { service: m![1]!, handler: "run", key: m![2]!, body: got.body };
      expect((await verify(headers, request)).id).toBe(owner);
      await expect(verify(headers, { ...request, key: randomUUID() })).rejects.toBeInstanceOf(ControlAuthError);
      await expect(verify(headers, { ...request, body: got.body + " " })).rejects.toBeInstanceOf(ControlAuthError);
    } finally {
      door.closeAllConnections();
      await new Promise<void>((resolve) => door.close(() => resolve()));
      fake.closeAllConnections();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  }, 120000);
});

describe("KJ-P4B.1 what Restate actually stored: assertions, never the long-lived key", () => {
  it("has journalled signed assertions for the door's requests, none with an Authorization header, and the key nowhere", async () => {
    const res = await fetch(`${ADMIN}/query`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        query: "select j.id as id, i.target_handler_name as handler, j.entry_json as ej from sys_journal j join sys_invocation i on i.id = j.id where j.index = 0 and i.target_service_name = 'GoldenTaskWorkflowV1'",
      }),
    });
    expect(res.ok).toBe(true);
    const rows = ((await res.json()) as { rows: Array<{ id: string; handler: string; ej: string }> }).rows;
    expect(rows.length).toBeGreaterThan(10);
    const forms = [CONTROL_TEST_KEY, Buffer.from(CONTROL_TEST_KEY).toString("hex"), Buffer.from(CONTROL_TEST_KEY).toString("base64"), Buffer.from(CONTROL_TEST_KEY).toString("base64url"), CONTROL_OTHER_KEY];
    // 1. The long-lived key is in no journal entry, in any form.
    for (const r of rows) for (const f of forms) expect(r.ej.includes(f), `${r.handler} ${r.id.slice(0, 12)}`).toBe(false);
    // 2. The door's requests are journalled as assertions.
    const signed = rows.filter((r) => r.ej.includes("x-kj-control-signature"));
    expect(signed.length).toBeGreaterThan(5);
    // (`cancel` appears because the tamper test replays an approve assertion at the cancel handler, which is refused.)
    const handlers = new Set(signed.map((r) => r.handler));
    expect(handlers.has("approve") && handlers.has("run")).toBe(true);
    // 3. A request that carries an assertion carries no Authorization header.
    for (const r of signed) expect(r.ej.toLowerCase().includes("authorization"), r.id).toBe(false);
    // 4. What the assertion headers hold is exactly the six non-secret fields.
    for (const r of signed) {
      const names = [...r.ej.matchAll(/"name":"(x-kj-control-[a-z0-9-]+)"/g)].map((m) => m[1]).sort();
      expect(names, r.id).toEqual(["x-kj-control-body-sha256", "x-kj-control-key-id", "x-kj-control-nonce", "x-kj-control-signature", "x-kj-control-timestamp", "x-kj-control-version"]);
    }
  }, 60000);

  it("appears in neither Restate's logs nor the worker's", () => {
    for (const service of ["restate", "worker"]) {
      const logs = compose("logs", "--no-color", service);
      expect(logs.includes(CONTROL_TEST_KEY), service).toBe(false);
      expect(logs.includes(CONTROL_OTHER_KEY), service).toBe(false);
    }
  }, 60000);
});
