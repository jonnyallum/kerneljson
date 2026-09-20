import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./support/local.js";
import { buildDoorHandler, loadDoorConfig } from "../apps/gateway/src/main.js";
import { KernelSubmission, MISSION_RECIPE, TaskEvent, parseMissionObjective } from "../packages/contracts/src/index.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { Ledger } from "../services/kernel/src/ledger.js";
import { deliverRows } from "../services/kernel/src/alerting/delivery-worker.js";
import { RecordingNotifier } from "../services/kernel/src/alerting/notifier.js";
import { PgNotificationOutboxStore } from "../services/kernel/src/alerting/pg-outbox-store.js";
import { HttpDoorClient, traceIdFor } from "../services/kernel/src/channel/telegram/door-client.js";
import { PgInboxStore } from "../services/kernel/src/channel/telegram/pg-inbox-store.js";
import { pollOnce, type OperatorDeps, type OperatorLimits } from "../services/kernel/src/channel/telegram/operator.js";
import { PgStatusReader } from "../services/kernel/src/channel/telegram/status.js";
import { FakeSource, LIMITS, NOW, msg } from "./support/telegram-fixture.js";

/**
 * KJ-P4A end to end: the REAL admission door and a REAL Postgres ledger, with the real inbox,
 * status reader and outbox. Only Telegram itself (the update source) and the transport that would
 * send the reply are doubles. This is where "a Telegram message becomes exactly one IntentEnvelope,
 * and nothing else can" is proven against persisted rows, not against a mock of the door.
 */
const name = `kj_p4a_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
const tenantId = randomUUID();
const principalId = randomUUID();
const BEARER = `tg-int-${randomUUID()}${randomUUID()}`;
let pool: pg.Pool;
let server: Server;
let base = "";
let releaseRuntime = () => {};

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
  await admin.query(`create database ${name}`);
  const url = DATABASE.replace(/\/kerneljson$/, `/${name}`);
  pool = new pg.Pool({ connectionString: url, max: 6 });
  pool.on("error", () => {});
  await migrate(pool);
  await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principalId]);
  await pool.query("insert into tenants(id,name) values($1,'tg-int')", [tenantId]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'operator')", [tenantId, principalId]);
  const config = loadDoorConfig({
    DATABASE_URL: url,
    KJ_ADMISSION_BEARER: BEARER,
    KJ_ADMISSION_TENANT_ID: tenantId,
    KJ_ADMISSION_PRINCIPAL_ID: principalId,
    KJ_ADMISSION_PRINCIPAL_KIND: "HUMAN",
    // No Restate ingress: admission persists, dispatch resolves UNRESOLVED. That is all these tests need.
  });
  const handler = buildDoorHandler(pool, config);
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
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

beforeEach(async () => {
  await pool.query("truncate kernel_private.telegram_inbox");
  await pool.query("update kernel_private.telegram_operator_state set next_offset = 0, unauthorised_total = 0");
});

let counter = 1000;
const uid = (): number => (counter += 10);
const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
const n = async (sql: string, args: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(sql, args))[0]!.n);

const LEDGER = [
  "public.tasks", "public.task_steps", "public.task_events", "public.evidence", "public.outcomes",
  "kernel_private.task_admissions", "kernel_private.execution_bindings",
];
const ledgerCounts = async () => Object.fromEntries(await Promise.all(LEDGER.map(async (t) => [t, await n(`select count(*)::text n from ${t}`)] as const)));

function build(over: Partial<OperatorLimits> = {}) {
  const source = new FakeSource();
  const inbox = new PgInboxStore(pool);
  const outbox = new PgNotificationOutboxStore(pool);
  const notifier = new RecordingNotifier();
  const clock = { now: new Date(NOW) };
  const deps: OperatorDeps = {
    limits: { ...LIMITS, ...over },
    source,
    inbox,
    door: new HttpDoorClient(base, `Bearer ${BEARER}`),
    status: new PgStatusReader(pool),
    outbox,
    deliver: async (ids) => {
      await deliverRows({ outbox, notifier, transport: "telegram", now: () => new Date(clock.now) }, ids);
    },
    deliverDue: async () => {},
    now: () => new Date(clock.now),
  };
  return { deps, source, inbox, outbox, notifier, clock, poll: () => pollOnce(deps) };
}

const inboxRow = async (updateId: number) =>
  (await q<{ state: string; disposition: string | null; mission: boolean; task_id: string | null; reply_notification_id: string | null; text_sha256: string }>(
    "select state, disposition, mission, task_id, reply_notification_id, text_sha256 from kernel_private.telegram_inbox where update_id = $1", [updateId]))[0];

/**
 * The door records an admission and a binding; the kernel WORKFLOW is what writes the task. With no
 * Restate in this test that write never happens, so where a test needs a real task to read, it does
 * exactly what the workflow's first step does, through the real Ledger.
 */
async function materialise(taskId: string): Promise<void> {
  const [adm] = await q<{ payload: unknown }>("select payload from kernel_private.task_admissions where task_id = $1", [taskId]);
  const submission = KernelSubmission.parse(adm!.payload);
  const { task } = compileIntent(submission);
  const event = TaskEvent.parse({
    id: randomUUID(), taskId: task.id, type: "TASK_CREATED", occurredAt: new Date().toISOString(),
    actor: task.principal, traceId: task.traceId,
    payload: { status: "RECEIVED", intent: submission.intent, recipe: submission.recipe, compilerVersion: 1 },
  });
  await new Ledger(pool).write({ key: "create", task, event });
}

describe("KJ-P4A a Telegram message becomes exactly one IntentEnvelope, through the real door", () => {
  it("persists the channel as source, the bearer's principal and tenant, and a deterministic trace", async () => {
    const h = build();
    const id = uid();
    h.source.updates = [msg(id, "/review jonnyallum/kerneljson findings=3")];
    const before = await ledgerCounts();
    const s = await h.poll();
    expect(s).toMatchObject({ result: "OK", admitted: 1 });

    const row = (await inboxRow(id))!;
    expect(row).toMatchObject({ state: "DONE", disposition: "ADMITTED", mission: true });
    const taskId = row.task_id!;
    interface PersistedIntent {
      source: string;
      objective: string;
      principal: { id: string };
      tenant: { id: string };
      trace: { traceId: string; correlationId: string };
    }
    const [adm] = await q<{ payload: { recipe: string; intent: PersistedIntent } }>(
      "select payload from kernel_private.task_admissions where task_id = $1", [taskId]);
    const { recipe, intent } = adm!.payload;
    expect(recipe).toBe(MISSION_RECIPE);
    expect(intent.source).toBe("kerneljson:channel/telegram/v1");
    expect(intent.principal.id).toBe(principalId);
    expect(intent.tenant.id).toBe(tenantId);
    expect(intent.trace).toEqual({ traceId: traceIdFor(id), correlationId: traceIdFor(id) });
    expect(parseMissionObjective(intent.objective)).toMatchObject({ repo: "jonnyallum/kerneljson", contract: { requestedFindings: 3 } });

    const after = await ledgerCounts();
    // The door records ONE admission and ONE binding. Neither it nor the adapter writes a task: only
    // the kernel workflow does, so the channel has no path to creating or completing one.
    expect(after["public.tasks"]).toBe(before["public.tasks"]);
    expect(after["kernel_private.task_admissions"]! - before["kernel_private.task_admissions"]!).toBe(1);
    expect(after["kernel_private.execution_bindings"]! - before["kernel_private.execution_bindings"]!).toBe(1);
    // The adapter admitted a task and nothing else: no evidence, no outcome, no completion.
    expect(after["public.evidence"]).toBe(before["public.evidence"]);
    expect(after["public.outcomes"]).toBe(before["public.outcomes"]);
  });

  it("a Telegram retry, a lost offset, even total loss of the adapter's own state, still yields ONE task", async () => {
    const h = build();
    const id = uid();
    h.source.updates = [msg(id, "/brief jonnyallum/kerneljson")];
    await h.poll();
    const first = (await inboxRow(id))!.task_id!;
    const admissions = await n("select count(*)::text n from kernel_private.task_admissions");

    // 1. The offset write is lost: Telegram redelivers, and the inbox makes it a no-op.
    await pool.query("update kernel_private.telegram_operator_state set next_offset = 0");
    expect(await h.poll()).toMatchObject({ received: 1, duplicates: 1, admitted: 0 });

    // 2. Everything the adapter remembers is gone. The door's idempotency key, derived from the
    //    update, still converges the replay onto the SAME task.
    await pool.query("truncate kernel_private.telegram_inbox");
    await pool.query("update kernel_private.telegram_operator_state set next_offset = 0");
    expect(await h.poll()).toMatchObject({ received: 1, admitted: 1 });
    expect((await inboxRow(id))!.task_id).toBe(first);
    expect(await n("select count(*)::text n from kernel_private.task_admissions")).toBe(admissions);
    expect(await n("select count(*)::text n from kernel_private.task_admissions where task_id = $1", [first])).toBe(1);
  });

  it("a crash after the door admitted but before the update was closed resumes onto the same task", async () => {
    const h = build();
    const id = uid();
    h.source.updates = [msg(id, "/review a/b")];
    const complete = h.inbox.complete.bind(h.inbox);
    let crash = true;
    h.inbox.complete = async (input) => {
      if (crash) {
        crash = false;
        throw new Error("process died here");
      }
      return complete(input);
    };
    const before = await ledgerCounts();
    await expect(h.poll()).rejects.toThrow("process died here");
    expect((await inboxRow(id))!.state).toBe("RECEIVED");
    expect(await n("select next_offset::text n from kernel_private.telegram_operator_state")).toBe(0);
    await h.poll();
    expect((await inboxRow(id))).toMatchObject({ state: "DONE", disposition: "ADMITTED" });
    expect((await ledgerCounts())["kernel_private.task_admissions"]! - before["kernel_private.task_admissions"]!).toBe(1);
    expect(await n("select count(*)::text n from kernel_private.notification_outbox where check_id = $1", [`OPERATOR.reply.${id}`])).toBe(1);
  });
});

describe("KJ-P4A refusals create nothing", () => {
  it("unauthorised and malformed messages admit nothing and leave the ledger untouched", async () => {
    const h = build();
    const id = uid();
    h.source.updates = [
      msg(id, "/brief jonnyallum/kerneljson", { chatId: 424242, fromId: 424242 }),
      msg(id + 1, "/brief jonnyallum/kerneljson", { chatType: "group", chatId: -1009 }),
      msg(id + 2, "/brief jonnyallum/kerneljson", { isBot: true }),
      msg(id + 3, "/brief o/r findings=99"),
      msg(id + 4, "do the thing"),
    ];
    const before = await ledgerCounts();
    const s = await h.poll();
    expect(s).toMatchObject({ unauthorised: 3, commands: 2, refused: 2, admitted: 0 });
    expect(await ledgerCounts()).toEqual(before);
    expect(await n("select unauthorised_total::text n from kernel_private.telegram_operator_state")).toBe(3);
    // Nobody unauthorised was recorded or answered; the two malformed ones got the fixed usage reply.
    expect(await n("select count(*)::text n from kernel_private.telegram_inbox")).toBe(2);
    expect(await n("select count(*)::text n from kernel_private.notification_outbox where check_id like 'OPERATOR.reply.%' and check_id in ($1,$2,$3)", [`OPERATOR.reply.${id}`, `OPERATOR.reply.${id + 1}`, `OPERATOR.reply.${id + 2}`])).toBe(0);
  });

  it("the daily cap refuses the mission over the limit, on the record, with no second task", async () => {
    const h = build({ dailyMissionCap: 1 });
    const id = uid();
    h.source.updates = [msg(id, "/brief a/b"), msg(id + 1, "/review c/d")];
    const before = await ledgerCounts();
    await h.poll();
    expect((await ledgerCounts())["kernel_private.task_admissions"]! - before["kernel_private.task_admissions"]!).toBe(1);
    expect(await inboxRow(id)).toMatchObject({ disposition: "ADMITTED", mission: true });
    expect(await inboxRow(id + 1)).toMatchObject({ disposition: "CAP_EXCEEDED", mission: false, task_id: null });
  });
});

describe("KJ-P4A /status and /task are read-only", () => {
  it("/status answers from the database and writes no ledger row", async () => {
    const h = build();
    const id = uid();
    h.source.updates = [msg(id, "/status")];
    const before = await ledgerCounts();
    await h.poll();
    expect(await ledgerCounts()).toEqual(before);
    expect(await inboxRow(id)).toMatchObject({ state: "DONE", disposition: "ANSWERED", mission: false, task_id: null });
    const text = h.notifier.sent.at(-1)!.message;
    expect(text).toContain("KernelJSON status as of");
    expect(text).toContain(`Tasks: ${before["public.tasks"]} total`);
    expect(text).toMatch(/Outbox: \d+ pending, 0 poison/);
  });

  it("/task reads status and evidence through the door's GET routes, and changes nothing", async () => {
    const h = build();
    const id = uid();
    h.source.updates = [msg(id, "/brief jonnyallum/kerneljson")];
    await h.poll();
    const taskId = (await inboxRow(id))!.task_id!;
    await materialise(taskId);

    const id2 = uid();
    h.source.updates = [msg(id2, `/task ${taskId}`), msg(id2 + 1, `/task ${randomUUID()}`)];
    const before = await ledgerCounts();
    await h.poll();
    expect(await ledgerCounts()).toEqual(before);
    const replies = h.notifier.sent.filter((p) => p.checkId === `OPERATOR.reply.${id2}` || p.checkId === `OPERATOR.reply.${id2 + 1}`).map((p) => p.message);
    expect(replies[0]).toContain(`Task ${taskId}`);
    expect(replies[0]).toContain("Status: RECEIVED");
    expect(replies[0]).toContain("Evidence: 0 rows");
    expect(replies[1]).toMatch(/^No task [0-9a-f-]{36} that I can see\.$/);
    expect(await inboxRow(id2)).toMatchObject({ disposition: "ANSWERED", mission: false });
  });

  it("a mixed batch creates tasks only for missions the door admitted", async () => {
    const h = build();
    const id = uid();
    h.source.updates = [msg(id, "/status"), msg(id + 1, "/brief a/b"), msg(id + 2, "hello"), msg(id + 3, "/status"), msg(id + 4, "/review c/d findings=2")];
    const before = await ledgerCounts();
    const s = await h.poll();
    expect(s).toMatchObject({ commands: 5, answered: 2, refused: 1, admitted: 2 });
    const after = await ledgerCounts();
    expect(after["public.tasks"]).toBe(before["public.tasks"]);
    // Only missions the door admitted left anything in the admission tables.
    expect(after["kernel_private.task_admissions"]! - before["kernel_private.task_admissions"]!).toBe(2);
    expect(after["public.evidence"]).toBe(before["public.evidence"]);
  });
});

describe("KJ-P4A replies use the existing durable outbox", () => {
  it("queues one OPERATOR.reply row per command and delivers it through the outbox worker path exactly once", async () => {
    const h = build();
    const id = uid();
    h.source.updates = [msg(id, "/status")];
    await h.poll();
    const [row] = await q<{ status: string; check_id: string; message: string; attempt_count: number }>(
      "select status, check_id, message, attempt_count from kernel_private.notification_outbox where check_id = $1", [`OPERATOR.reply.${id}`]);
    expect(row).toMatchObject({ status: "DELIVERED", attempt_count: 1 });
    expect(row!.message).toContain("KernelJSON status as of");
    const events = await q<{ outcome: string; transport: string }>(
      "select e.outcome, e.transport from kernel_private.notification_delivery_events e join kernel_private.notification_outbox o using (notification_id) where o.check_id = $1", [`OPERATOR.reply.${id}`]);
    expect(events).toEqual([{ outcome: "DELIVERED", transport: "telegram" }]);
    // The transport received the reply text as written, not the redacted alert summary.
    expect(h.notifier.sent.filter((p) => p.checkId === `OPERATOR.reply.${id}`)).toHaveLength(1);
    expect(h.notifier.sent.find((p) => p.checkId === `OPERATOR.reply.${id}`)!.message).toBe(row!.message);
  });

  it("a replayed update never queues or sends a second reply", async () => {
    const h = build();
    const id = uid();
    h.source.updates = [msg(id, "/status")];
    await h.poll();
    await pool.query("update kernel_private.telegram_operator_state set next_offset = 0");
    await h.poll();
    expect(await n("select count(*)::text n from kernel_private.notification_outbox where check_id = $1", [`OPERATOR.reply.${id}`])).toBe(1);
    expect(h.notifier.sent.filter((p) => p.checkId === `OPERATOR.reply.${id}`)).toHaveLength(1);
  });
});

describe("KJ-P4A durable inbox (Postgres)", () => {
  it("keeps only a digest of the message, never the text", async () => {
    const h = build();
    const id = uid();
    const text = "/brief jonnyallum/kerneljson";
    h.source.updates = [msg(id, text)];
    await h.poll();
    expect((await inboxRow(id))!.text_sha256).toBe(createHash("sha256").update(text).digest("hex"));
    const cols = await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema='kernel_private' and table_name='telegram_inbox'");
    expect(cols.map((c) => c.column_name).sort()).toEqual(
      ["command", "completed_at", "disposition", "mission", "received_at", "reply_notification_id", "state", "task_id", "text_sha256", "update_id"]);
  });

  it("the offset only moves forward, and unauthorised counts accumulate", async () => {
    const inbox = new PgInboxStore(pool);
    await inbox.advanceOffset(10, 2, new Date(NOW).toISOString());
    await inbox.advanceOffset(5, 1, new Date(NOW).toISOString());
    expect(await inbox.offset()).toBe(10);
    expect(await n("select unauthorised_total::text n from kernel_private.telegram_operator_state")).toBe(3);
  });

  it("claim is idempotent and returns the existing row", async () => {
    const inbox = new PgInboxStore(pool);
    const id = uid();
    const a = await inbox.claim({ updateId: id, now: NOW.toISOString(), textSha256: "a".repeat(64) });
    const b = await inbox.claim({ updateId: id, now: "2030-01-01T00:00:00.000Z", textSha256: "b".repeat(64) });
    expect(a).toMatchObject({ state: "RECEIVED", receivedAt: NOW.toISOString() });
    expect(b.receivedAt).toBe(a.receivedAt);
    expect(await n("select count(*)::text n from kernel_private.telegram_inbox where update_id = $1", [id])).toBe(1);
  });

  it("the schema itself refuses an admitted row with no task, a mission that was not admitted, and a half-closed row", async () => {
    const inbox = new PgInboxStore(pool);
    const id = uid();
    await inbox.claim({ updateId: id, now: NOW.toISOString(), textSha256: "a".repeat(64) });
    const base = { updateId: id, command: "MISSION" as const, replyNotificationId: null, now: NOW.toISOString() };
    await expect(inbox.complete({ ...base, disposition: "ADMITTED", mission: true, taskId: null })).rejects.toThrow();
    await expect(inbox.complete({ ...base, disposition: "CAP_EXCEEDED", mission: true, taskId: null })).rejects.toThrow();
    await expect(pool.query("update kernel_private.telegram_inbox set state='DONE' where update_id=$1", [id])).rejects.toThrow();
    // ...and a legitimate close still works, so the refusals above are the constraints and nothing else.
    await inbox.complete({ ...base, disposition: "CAP_EXCEEDED", mission: false, taskId: null });
    expect((await inboxRow(id))!.state).toBe("DONE");
  });

  it("refuses to close an update that was never claimed", async () => {
    await expect(new PgInboxStore(pool).complete({ updateId: 999999999, command: "STATUS", disposition: "ANSWERED", mission: false, taskId: null, replyNotificationId: null, now: NOW.toISOString() })).rejects.toThrow(/never claimed/);
  });

  it("is inaccessible to the public roles", async () => {
    for (const table of ["telegram_inbox", "telegram_operator_state"]) {
      const r = await q<{ ok: boolean }>("select has_table_privilege('anon', $1, 'select') as ok", [`kernel_private.${table}`]);
      expect(r[0]!.ok, table).toBe(false);
    }
  });
});

describe("KJ-P4A the door's channel attribution is an allow-list, not caller text", () => {
  const submit = (headers: Record<string, string>, body: unknown = { recipe: "uppercase/v1", objective: "hello" }) =>
    fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const sourceOf = async (taskId: string) =>
    (await q<{ payload: { intent: { source: string } } }>("select payload from kernel_private.task_admissions where task_id = $1", [taskId]))[0]!.payload.intent.source;

  it("an unknown channel is refused with 400 and admits nothing", async () => {
    const before = await n("select count(*)::text n from kernel_private.task_admissions");
    for (const channel of ["bogus", "telegram", "TELEGRAM/V1", "kerneljson:channel/telegram/v1", "", "telegram/v1,other"]) {
      const res = await submit({ "idempotency-key": `chan-${randomUUID()}`, "x-kj-channel": channel });
      expect(res.status, JSON.stringify(channel)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("INVALID_CHANNEL");
    }
    expect(await n("select count(*)::text n from kernel_private.task_admissions")).toBe(before);
  });

  it("no channel header keeps the door's original source, so every other client is unchanged", async () => {
    const res = await submit({ "idempotency-key": `chan-${randomUUID()}` });
    expect(res.status).toBe(202);
    expect(await sourceOf(((await res.json()) as { taskId: string }).taskId)).toBe("kerneljson:gateway/v1");
  });

  it("the allow-listed channel is recorded, and changes nothing about principal or tenant", async () => {
    const res = await submit({ "idempotency-key": `chan-${randomUUID()}`, "x-kj-channel": "telegram/v1" });
    expect(res.status).toBe(202);
    const taskId = ((await res.json()) as { taskId: string }).taskId;
    expect(await sourceOf(taskId)).toBe("kerneljson:channel/telegram/v1");
    const [t] = await q<{ tenant_id: string; principal_id: string }>("select tenant_id, principal_id from kernel_private.task_admissions where task_id = $1", [taskId]);
    expect(t).toEqual({ tenant_id: tenantId, principal_id: principalId });
  });

  it("the channel header is not a credential: without the bearer it admits nothing", async () => {
    const before = await n("select count(*)::text n from kernel_private.task_admissions");
    const res = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `chan-${randomUUID()}`, "x-kj-channel": "telegram/v1" },
      body: JSON.stringify({ recipe: "uppercase/v1", objective: "hello" }),
    });
    expect(res.status).toBe(401);
    expect(await n("select count(*)::text n from kernel_private.task_admissions")).toBe(before);
  });
});

