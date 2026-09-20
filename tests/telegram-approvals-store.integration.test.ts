import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./support/local.js";
import { CapabilityInvocation, PolicyEvaluation, Task, TaskEvent, TaskStep, type PrincipalRef } from "../packages/contracts/src/index.js";
import { UPPERCASE, createBuiltinRegistry } from "../packages/capabilities/src/index.js";
import { ApprovalError, ApprovalStore } from "../services/kernel/src/approval-store.js";
import { Ledger } from "../services/kernel/src/ledger.js";
import { evaluatePolicy } from "../services/kernel/src/policy.js";
import { createApprovalsPort, handleCallback, serviceApprovals, type ApprovalsDeps } from "../services/kernel/src/channel/telegram/approvals.js";
import { dataFor, FakeBot } from "./support/approval-fixture.js";
import type { ApprovalDoor, ApproveAnswer } from "../services/kernel/src/channel/telegram/door-client.js";
import { PgCardStore } from "../services/kernel/src/channel/telegram/pg-card-store.js";
import { pollOnce } from "../services/kernel/src/channel/telegram/operator.js";
import { PgInboxStore } from "../services/kernel/src/channel/telegram/pg-inbox-store.js";
import { PgNotificationOutboxStore } from "../services/kernel/src/alerting/pg-outbox-store.js";
import { PgStatusReader } from "../services/kernel/src/channel/telegram/status.js";
import { FakeDoor, FakeSource, LIMITS } from "./support/telegram-fixture.js";
import { callbackUpdate } from "./support/approval-fixture.js";
import { task as fixture } from "../evals/fixtures/contracts.js";

/**
 * KJ-P4B against a real Postgres ledger: the card store's SQL, its constraints, and the adapter's
 * behaviour when the approval is a real ApprovalStore row. The door is a stand-in that hands the
 * answer straight to the real ApprovalStore as the named approver, exactly as the policy workflow
 * does, so every refusal below is the LEDGER refusing. The workflow and the real door are exercised
 * in telegram-approvals.integration.test.ts.
 */
const name = `kj_p4b_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
let pool: pg.Pool;
let ledger: Ledger;
let approvals: ApprovalStore;
let cards: PgCardStore;
let releaseRuntime = () => {};

const tenantId = randomUUID();
const owner: PrincipalRef = { id: randomUUID(), kind: "HUMAN" };
const reviewer: PrincipalRef = { id: randomUUID(), kind: "HUMAN" };
const stranger: PrincipalRef = { id: randomUUID(), kind: "HUMAN" };
const registry = createBuiltinRegistry();

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
  await admin.query(`create database ${name}`);
  pool = new pg.Pool({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`), max: 6 });
  pool.on("error", () => {});
  await migrate(pool);
  await pool.query("insert into tenants(id,name) values($1,'p4b')", [tenantId]);
  for (const [p, role] of [[owner, "owner"], [reviewer, "reviewer"], [stranger, "viewer"]] as const) {
    await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [p.id]);
    await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,$3)", [tenantId, p.id, role]);
  }
  ledger = new Ledger(pool);
  approvals = new ApprovalStore(pool);
  cards = new PgCardStore(pool);
});

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

const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;

interface Seeded {
  task: Task;
  approvalId: string;
  evaluation: PolicyEvaluation;
}

/** A real approval, recorded by the real ApprovalStore, on a task the workflow would be waiting on. */
async function seed(o: { ttlMs?: number; approver?: PrincipalRef; waiting?: boolean; text?: string } = {}): Promise<Seeded> {
  let task = Task.parse({
    ...fixture,
    id: randomUUID(),
    traceId: randomUUID(),
    tenant: { id: tenantId },
    principal: owner,
  });
  const request = CapabilityInvocation.parse({
    runId: randomUUID(),
    taskId: task.id,
    stepId: randomUUID(),
    trace: { traceId: task.traceId, correlationId: task.id },
    capability: UPPERCASE,
    idempotencyKey: "policy-uppercase-1",
    input: { text: o.text ?? "hello" },
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
  const emit = async (key: string, type: TaskEvent["type"], status: Task["status"], withStep = false) => {
    task = Task.parse({ ...task, status });
    await ledger.write({
      key,
      task,
      event: TaskEvent.parse({
        id: randomUUID(),
        taskId: task.id,
        type,
        occurredAt: new Date().toISOString(),
        actor: task.principal,
        traceId: task.traceId,
        payload: {},
      }),
      ...(withStep ? { step } : {}),
    });
  };
  await emit("create", "TASK_CREATED", "RECEIVED");
  await emit("compile", "PLAN_COMPILED", "COMPILED", true);
  const evaluation = evaluatePolicy(
    {
      version: "p4b-policy/1",
      rules: [
        {
          tenantId,
          principalId: owner.id,
          capability: UPPERCASE,
          effect: "APPROVAL_REQUIRED",
          approver: o.approver ?? reviewer,
          ttlMs: o.ttlMs ?? 600_000,
        },
      ],
    },
    task,
    step,
    request,
    registry.describe(UPPERCASE),
    randomUUID(),
    new Date().toISOString(),
  );
  const approvalId = randomUUID();
  await approvals.record(evaluation, request, approvalId);
  if (o.waiting !== false) await emit("approval-required", "APPROVAL_REQUESTED", "APPROVAL_REQUIRED");
  return { task, approvalId, evaluation };
}

const discover = (now = new Date().toISOString(), approverId = reviewer.id, tenant = tenantId) =>
  cards.discover({ tenantId: tenant, approverId, now, limit: 50 });
const cardRow = async (approvalId: string) =>
  (await q<{ state: string; message_id: string | null; scope_digest: string; invocation_digest: string; capability: string; expires_at: Date; attempt_count: number }>(
    "select state, message_id, scope_digest, invocation_digest, capability, expires_at, attempt_count from kernel_private.telegram_approval_cards where approval_id = $1",
    [approvalId],
  ))[0];

describe("KJ-P4B the card store against a real ledger", () => {
  it("creates one card and two handles per waiting approval, copying the ledger's own digest, capability and deadline", async () => {
    const s = await seed();
    await discover();
    const row = await cardRow(s.approvalId);
    expect(row).toMatchObject({
      state: "QUEUED",
      message_id: null,
      scope_digest: s.evaluation.scopeDigest,
      invocation_digest: s.evaluation.scope.invocationDigest,
      capability: UPPERCASE.id,
    });
    expect(row!.scope_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(row!.expires_at.toISOString()).toBe(new Date(s.evaluation.expiresAt!).toISOString());
    const handles = await q<{ handle: string; decision: string }>("select handle, decision from kernel_private.telegram_approval_handles where approval_id = $1 order by decision", [s.approvalId]);
    expect(handles.map((h) => h.decision)).toEqual(["DENIED", "GRANTED"]);
    for (const h of handles) expect(h.handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set(handles.map((h) => h.handle)).size).toBe(2);
  });

  it("is idempotent: discovering again creates nothing and mints no further handles", async () => {
    const s = await seed();
    expect(await discover()).toBeGreaterThanOrEqual(1);
    const before = await q("select handle from kernel_private.telegram_approval_handles where approval_id = $1", [s.approvalId]);
    expect(await discover()).toBe(0);
    expect(await q("select handle from kernel_private.telegram_approval_handles where approval_id = $1", [s.approvalId])).toEqual(before);
  });

  it("shows only approvals for the configured approver in the configured tenant", async () => {
    const other = await seed({ approver: owner });
    const s = await seed();
    await discover(new Date().toISOString(), stranger.id);
    expect(await cardRow(s.approvalId)).toBeUndefined();
    await discover(new Date().toISOString(), reviewer.id, randomUUID());
    expect(await cardRow(s.approvalId)).toBeUndefined();
    await discover(new Date().toISOString(), reviewer.id);
    expect(await cardRow(s.approvalId)).toBeDefined();
    // The approval that names someone else was never this approver's to be shown.
    expect(await cardRow(other.approvalId)).toBeUndefined();
  });

  it("shows nothing until the task is actually waiting for the answer", async () => {
    const s = await seed({ waiting: false });
    await discover();
    expect(await cardRow(s.approvalId)).toBeUndefined();
    await ledger.write({
      key: "approval-required",
      task: Task.parse({ ...s.task, status: "APPROVAL_REQUIRED" }),
      event: TaskEvent.parse({ id: randomUUID(), taskId: s.task.id, type: "APPROVAL_REQUESTED", occurredAt: new Date().toISOString(), actor: s.task.principal, traceId: s.task.traceId, payload: {} }),
    });
    await discover();
    expect(await cardRow(s.approvalId)).toBeDefined();
  });

  it("shows nothing for an approval that is already settled", async () => {
    const s = await seed();
    await approvals.resolve(s.approvalId, { scopeDigest: s.evaluation.scopeDigest, decision: "DENIED" }, reviewer, randomUUID(), randomUUID());
    await discover();
    expect(await cardRow(s.approvalId)).toBeUndefined();
  });

  it("claims each card for sending once, even from two pollers at the same instant", async () => {
    const s = await seed();
    await discover();
    const now = new Date().toISOString();
    const claims = await Promise.all([1, 2, 3].map(() => cards.claimToSend({ now, staleMs: 120_000, maxAttempts: 5, limit: 50 })));
    expect(claims.flat().filter((c) => c.card.approvalId === s.approvalId)).toHaveLength(1);
    expect((await cardRow(s.approvalId))?.state).toBe("SENDING");
    expect((await cardRow(s.approvalId))?.attempt_count).toBe(1);
  });

  it("re-claims a card stuck mid-send only after the stale window, and stops at the attempt limit", async () => {
    const s = await seed();
    await discover();
    const t0 = new Date();
    const claim = (now: Date, max = 5) => cards.claimToSend({ now: now.toISOString(), staleMs: 120_000, maxAttempts: max, limit: 50 });
    const mine = (r: Awaited<ReturnType<typeof claim>>) => r.filter((c) => c.card.approvalId === s.approvalId).length;
    expect(mine(await claim(t0))).toBe(1);
    expect(mine(await claim(new Date(t0.getTime() + 60_000)))).toBe(0);
    expect(mine(await claim(new Date(t0.getTime() + 121_000)))).toBe(1);
    expect(mine(await claim(new Date(t0.getTime() + 300_000), 2))).toBe(0); // already at 2 attempts
  });

  it("never claims a card whose deadline has passed", async () => {
    const s = await seed({ ttlMs: 30_000 });
    await discover();
    const later = new Date(Date.now() + 31_000).toISOString();
    const claimed = await cards.claimToSend({ now: later, staleMs: 120_000, maxAttempts: 5, limit: 50 });
    expect(claimed.filter((c) => c.card.approvalId === s.approvalId)).toHaveLength(0);
  });

  it("marks a claimed card sent with its message id, and hands a failed one back", async () => {
    const a = await seed();
    const b = await seed();
    await discover();
    const claimed = await cards.claimToSend({ now: new Date().toISOString(), staleMs: 120_000, maxAttempts: 5, limit: 50 });
    expect(claimed.map((c) => c.card.approvalId)).toEqual(expect.arrayContaining([a.approvalId, b.approvalId]));
    await cards.markSent(a.approvalId, 777, new Date().toISOString());
    await cards.releaseUnsent(b.approvalId);
    expect(await cardRow(a.approvalId)).toMatchObject({ state: "SENT", message_id: "777" });
    expect((await cardRow(b.approvalId))?.state).toBe("QUEUED");
  });

  it("lists a card to close once the ledger settles it, or its deadline passes, and not afterwards", async () => {
    const granted = await seed();
    const pendingShort = await seed({ ttlMs: 30_000 });
    const pendingLong = await seed();
    await discover();
    await approvals.resolve(granted.approvalId, { scopeDigest: granted.evaluation.scopeDigest, decision: "GRANTED" }, reviewer, randomUUID(), randomUUID());
    const now = new Date(Date.now() + 31_000).toISOString();
    const list = await cards.listToClose({ now, limit: 100 });
    const by = new Map(list.map((c) => [c.card.approvalId, c.status]));
    expect(by.get(granted.approvalId)).toBe("GRANTED");
    expect(by.get(pendingShort.approvalId)).toBe("EXPIRED");
    expect(by.has(pendingLong.approvalId)).toBe(false);
    await cards.markResolved(granted.approvalId, now);
    expect((await cards.listToClose({ now, limit: 100 })).some((c) => c.card.approvalId === granted.approvalId)).toBe(false);
  });

  it("maps a handle to its card and decision, and an unknown handle to nothing", async () => {
    const s = await seed();
    await discover();
    const [g] = await q<{ handle: string }>("select handle from kernel_private.telegram_approval_handles where approval_id = $1 and decision = 'GRANTED'", [s.approvalId]);
    const found = await cards.byHandle(g!.handle);
    expect(found?.decision).toBe("GRANTED");
    expect(found?.card.approvalId).toBe(s.approvalId);
    expect(await cards.byHandle("A".repeat(22))).toBeNull();
    expect(await cards.statusOf(s.approvalId)).toBe("PENDING");
    expect(await cards.statusOf(randomUUID())).toBeNull();
  });

  it("records a button press once by Telegram's update id", async () => {
    const id = 900_000 + Math.floor(Math.random() * 90_000);
    expect(await cards.claimCallback({ updateId: id, now: new Date().toISOString() })).toEqual({ state: "RECEIVED" });
    await cards.completeCallback({ updateId: id, disposition: "RESOLVED", approvalId: null, pressed: "GRANTED", now: new Date().toISOString() });
    expect(await cards.claimCallback({ updateId: id, now: new Date().toISOString() })).toEqual({ state: "DONE" });
    // Completing again changes nothing: the first outcome stands.
    await cards.completeCallback({ updateId: id, disposition: "UNKNOWN_HANDLE", approvalId: null, pressed: null, now: new Date().toISOString() });
    expect((await q<{ disposition: string }>("select disposition from kernel_private.telegram_callback_inbox where update_id = $1", [id]))[0]?.disposition).toBe("RESOLVED");
  });
});

describe("KJ-P4B the tables refuse impossible states themselves", () => {
  const bad = async (sql: string, args: unknown[]): Promise<string> => {
    try {
      await pool.query(sql, args);
    } catch (e) {
      return (e as { code?: string }).code ?? "ERR";
    }
    return "NO_ERROR";
  };

  it("a card cannot be SENT without a message id, and RESOLVED needs a resolution time", async () => {
    const s = await seed();
    await discover();
    expect(await bad("update kernel_private.telegram_approval_cards set state='SENT', message_id=null where approval_id=$1", [s.approvalId])).toBe("23514");
    expect(await bad("update kernel_private.telegram_approval_cards set state='RESOLVED' where approval_id=$1", [s.approvalId])).toBe("23514");
    expect(await bad("update kernel_private.telegram_approval_cards set scope_digest='abc' where approval_id=$1", [s.approvalId])).toBe("23514");
    expect(await bad("update kernel_private.telegram_approval_cards set capability='x y' where approval_id=$1", [s.approvalId])).toBe("23514");
  });

  it("a handle must be 22 URL-safe characters and each card has exactly one per decision", async () => {
    const s = await seed();
    await discover();
    expect(await bad("insert into kernel_private.telegram_approval_handles values ('short', $1, 'GRANTED')", [s.approvalId])).toBe("23514");
    expect(await bad("insert into kernel_private.telegram_approval_handles values ($2, $1, 'GRANTED')", [s.approvalId, "B".repeat(22)])).toBe("23505");
    expect(await bad("insert into kernel_private.telegram_approval_handles values ($2, $1, 'MAYBE')", [s.approvalId, "C".repeat(22)])).toBe("23514");
    expect(await bad("insert into kernel_private.telegram_approval_handles values ($2, $1, 'GRANTED')", [randomUUID(), "D".repeat(22)])).toBe("23503");
  });

  it("a callback row cannot be DONE without an outcome and a time", async () => {
    expect(await bad("insert into kernel_private.telegram_callback_inbox(update_id, received_at, state) values (1, now(), 'DONE')", [])).toBe("23514");
    expect(await bad("insert into kernel_private.telegram_callback_inbox(update_id, received_at, state, disposition, completed_at) values (2, now(), 'DONE', 'MAYBE', now())", [])).toBe("23514");
  });

  it("nothing but the service can read or write them", async () => {
    for (const table of ["telegram_approval_cards", "telegram_approval_handles", "telegram_callback_inbox"]) {
      const [r] = await q<{ anon: boolean; authed: boolean }>(
        "select has_table_privilege('anon', $1, 'select') as anon, has_table_privilege('authenticated', $1, 'select') as authed",
        [`kernel_private.${table}`],
      );
      expect(r, table).toEqual({ anon: false, authed: false });
    }
  });
});

/**
 * Hands the answer to the real ApprovalStore as the named approver, as the policy workflow does. It
 * finds the approval from the task id the adapter was given, which is all the door route carries.
 */
class LedgerDoor implements ApprovalDoor {
  calls: Array<{ taskId: string; scopeDigest: string; decision: "GRANTED" | "DENIED" }> = [];
  constructor(readonly actor: PrincipalRef) {}
  async approve(input: { taskId: string; scopeDigest: string; decision: "GRANTED" | "DENIED" }): Promise<ApproveAnswer> {
    const [a] = await q<{ id: string }>("select id from public.approvals where task_id = $1", [input.taskId]);
    if (!a) return "NOT_FOUND";
    this.calls.push({ ...input });
    try {
      await approvals.resolve(a.id, { scopeDigest: input.scopeDigest, decision: input.decision }, this.actor, randomUUID(), randomUUID());
      return "ACCEPTED";
    } catch (error) {
      if (error instanceof ApprovalError) return "REFUSED";
      throw error;
    }
  }
}

describe("KJ-P4B the adapter over real approvals, with the ledger refusing", () => {
  /** Discover, send and return the seeded approval's handles and message id. */
  async function shown(s: Seeded, b: { deps: ApprovalsDeps }) {
    // Earlier tests leave approvals waiting, and a pass sends only a few cards, so go on until this one is out.
    let row = await cardRow(s.approvalId);
    for (let pass = 0; pass < 60 && row?.message_id == null; pass++) {
      await serviceApprovals(b.deps);
      row = await cardRow(s.approvalId);
    }
    const handles = await q<{ handle: string; decision: string }>("select handle, decision from kernel_private.telegram_approval_handles where approval_id = $1", [s.approvalId]);
    return {
      messageId: Number(row!.message_id),
      granted: handles.find((h) => h.decision === "GRANTED")!.handle,
      denied: handles.find((h) => h.decision === "DENIED")!.handle,
    };
  }
  function rig(actor: PrincipalRef = reviewer, now: () => Date = () => new Date()) {
    const bot = new FakeBot();
    const door = new LedgerDoor(actor);
    const deps: ApprovalsDeps = { tenantId, approverId: reviewer.id, cards, bot, door, now };
    return { bot, door, deps };
  }
  const press = (deps: ApprovalsDeps, updateId: number, handle: string, messageId: number) =>
    handleCallback(deps, { updateId, queryId: `q${updateId}`, data: dataFor(handle), messageId });
  let updateCounter = 5_000_000;
  const uid = (): number => (updateCounter += 1);
  const statusOf = async (approvalId: string) => (await q<{ status: string }>("select status from public.approvals where id = $1", [approvalId]))[0]!.status;

  it("approve: the ledger records GRANTED once, with human-decision evidence, and the card is closed", async () => {
    const s = await seed();
    const r = rig();
    const h = await shown(s, r);
    expect(r.bot.cards.length).toBeGreaterThanOrEqual(1);
    expect(await press(r.deps, uid(), h.granted, h.messageId)).toBe("RESOLVED");
    expect(await statusOf(s.approvalId)).toBe("GRANTED");
    expect(await q("select 1 from public.evidence where task_id = $1 and source = 'kerneljson:approval/v1'", [s.task.id])).toHaveLength(1);
    await serviceApprovals(r.deps);
    expect(r.bot.closed.some((c) => c.text.startsWith("Approved"))).toBe(true);
    expect((await cardRow(s.approvalId))?.state).toBe("RESOLVED");
  });

  it("reject: the ledger records DENIED", async () => {
    const s = await seed();
    const r = rig();
    const h = await shown(s, r);
    expect(await press(r.deps, uid(), h.denied, h.messageId)).toBe("RESOLVED");
    expect(await statusOf(s.approvalId)).toBe("DENIED");
  });

  it("a duplicate press, in the same update or a new one, records nothing further", async () => {
    const s = await seed();
    const r = rig();
    const h = await shown(s, r);
    const first = uid();
    await press(r.deps, first, h.granted, h.messageId);
    expect(await press(r.deps, first, h.granted, h.messageId)).toBe("DUPLICATE");
    expect(await press(r.deps, uid(), h.granted, h.messageId)).toBe("ALREADY_RESOLVED");
    expect(await press(r.deps, uid(), h.denied, h.messageId)).toBe("ALREADY_RESOLVED");
    expect(r.door.calls).toHaveLength(1);
    expect(await statusOf(s.approvalId)).toBe("GRANTED");
    expect(await q("select 1 from public.evidence where task_id = $1 and source = 'kerneljson:approval/v1'", [s.task.id])).toHaveLength(1);
  });

  it("wrong digest: a card whose digest is not the ledger's is refused by the ledger, and nothing is granted", async () => {
    const s = await seed();
    const r = rig();
    const h = await shown(s, r);
    await pool.query("update kernel_private.telegram_approval_cards set scope_digest = $2 where approval_id = $1", [s.approvalId, "0".repeat(64)]);
    expect(await press(r.deps, uid(), h.granted, h.messageId)).toBe("DOOR_REFUSED");
    expect(await statusOf(s.approvalId)).toBe("PENDING");
    // Put the ledger's digest back and the same button now works: only the ledger's digest ever did.
    await pool.query("update kernel_private.telegram_approval_cards set scope_digest = $2 where approval_id = $1", [s.approvalId, s.evaluation.scopeDigest]);
    expect(await press(r.deps, uid(), h.granted, h.messageId)).toBe("RESOLVED");
    expect(await statusOf(s.approvalId)).toBe("GRANTED");
  });

  it("wrong task: a card pointed at another task's approval is refused, and neither approval is granted", async () => {
    const a = await seed();
    const b = await seed({ text: "another action" });
    const r = rig();
    const h = await shown(a, r);
    await shown(b, r);
    // Point A's card at B's task, keeping A's digest.
    await pool.query("update kernel_private.telegram_approval_cards set task_id = $2 where approval_id = $1", [a.approvalId, b.task.id]);
    expect(await press(r.deps, uid(), h.granted, h.messageId)).toBe("DOOR_REFUSED");
    expect(await statusOf(a.approvalId)).toBe("PENDING");
    expect(await statusOf(b.approvalId)).toBe("PENDING");
  });

  it("an approval for one action never approves another: each digest is bound to its own task and input", async () => {
    const a = await seed({ text: "same words" });
    const b = await seed({ text: "same words" });
    expect(a.evaluation.scopeDigest).not.toBe(b.evaluation.scopeDigest);
    const r = rig();
    await shown(a, r);
    const hb = await shown(b, r);
    // B's button, with A's digest forced onto B's card.
    await pool.query("update kernel_private.telegram_approval_cards set scope_digest = $2 where approval_id = $1", [b.approvalId, a.evaluation.scopeDigest]);
    expect(await press(r.deps, uid(), hb.granted, hb.messageId)).toBe("DOOR_REFUSED");
    expect(await statusOf(b.approvalId)).toBe("PENDING");
  });

  it("expired: the ledger's own clock refuses even when the adapter's clock still thinks there is time", async () => {
    const s = await seed({ ttlMs: 1500 });
    // The adapter believes it is an hour earlier than it is, so its courtesy check passes.
    const r = rig(reviewer, () => new Date(Date.now() - 3_600_000));
    const h = await shown(s, r);
    await new Promise((res) => setTimeout(res, 1800));
    // The adapter asks, and the LEDGER, on its own clock, records the approval as expired instead of granting it.
    expect(await press(r.deps, uid(), h.granted, h.messageId)).toBe("ALREADY_RESOLVED");
    expect(await statusOf(s.approvalId)).toBe("EXPIRED");
    expect(r.bot.answers.at(-1)?.text).toBe("Already expired. Your approve changed nothing.");
    expect(r.door.calls).toHaveLength(1);
  });

  it("expired: an honest adapter clock does not even ask, and the approval is closed as expired", async () => {
    const s = await seed({ ttlMs: 1500 });
    const r = rig();
    const h = await shown(s, r);
    await new Promise((res) => setTimeout(res, 1800));
    expect(await press(r.deps, uid(), h.granted, h.messageId)).toBe("EXPIRED");
    expect(r.door.calls).toHaveLength(0);
    await serviceApprovals(r.deps);
    expect(r.bot.closed.some((c) => c.text.startsWith("Expired"))).toBe(true);
  });

  it("not the named approver: the ledger refuses, whoever the door says it is", async () => {
    const s = await seed();
    const r = rig(stranger);
    const h = await shown(s, r);
    expect(await press(r.deps, uid(), h.granted, h.messageId)).toBe("DOOR_REFUSED");
    expect(await statusOf(s.approvalId)).toBe("PENDING");
    // The task's own owner is not the named approver either.
    const asOwner = rig(owner);
    expect(await press(asOwner.deps, uid(), h.granted, h.messageId)).toBe("DOOR_REFUSED");
    expect(await statusOf(s.approvalId)).toBe("PENDING");
  });

  it("the card store cannot make an approval valid: widening the card's deadline changes nothing at the ledger", async () => {
    const s = await seed({ ttlMs: 1500 });
    const r = rig(reviewer, () => new Date(Date.now() - 3_600_000));
    const h = await shown(s, r);
    await pool.query("update kernel_private.telegram_approval_cards set expires_at = now() + interval '1 day' where approval_id = $1", [s.approvalId]);
    await new Promise((res) => setTimeout(res, 1800));
    expect(await press(r.deps, uid(), h.granted, h.messageId)).toBe("ALREADY_RESOLVED");
    expect(await statusOf(s.approvalId)).toBe("EXPIRED");
  });

  it("forged and foreign handles do nothing at the ledger", async () => {
    const s = await seed();
    const other = await seed({ text: "other" });
    const r = rig();
    const h = await shown(s, r);
    const ho = await shown(other, r);
    expect(await handleCallback(r.deps, { updateId: uid(), queryId: "q", data: `kj1:${"A".repeat(22)}`, messageId: h.messageId })).toBe("UNKNOWN_HANDLE");
    expect(await handleCallback(r.deps, { updateId: uid(), queryId: "q", data: `approve:${s.task.id}`, messageId: h.messageId })).toBe("UNKNOWN_HANDLE");
    // Another card's real handle, pressed on this card's message.
    expect(await press(r.deps, uid(), ho.granted, h.messageId)).toBe("WRONG_MESSAGE");
    expect(await statusOf(s.approvalId)).toBe("PENDING");
    expect(await statusOf(other.approvalId)).toBe("PENDING");
    expect(r.door.calls).toHaveLength(0);
  });
});

describe("KJ-P4B the whole poll over a real ledger", () => {
  it("shows a card, takes a press from the allow-listed chat, and settles it; a stranger's press does nothing", async () => {
    const s = await seed();
    const bot = new FakeBot();
    // Approvals seeded by earlier tests are also waiting; this test only follows its own.
    const door = new LedgerDoor(reviewer);
    const port = createApprovalsPort({ tenantId, approverId: reviewer.id, cards, bot, door, now: () => new Date() });
    const source = new FakeSource();
    const deps = {
      limits: LIMITS,
      source,
      inbox: new PgInboxStore(pool),
      door: new FakeDoor(),
      status: new PgStatusReader(pool),
      outbox: new PgNotificationOutboxStore(pool),
      deliver: async () => {},
      deliverDue: async () => {},
      now: () => new Date(),
      approvals: port,
    };
    await pool.query("update kernel_private.telegram_operator_state set next_offset = 0");
    const first = await pollOnce(deps);
    expect(first.cardsSent).toBeGreaterThanOrEqual(1);
    const row = await cardRow(s.approvalId);
    const [g] = await q<{ handle: string }>("select handle from kernel_private.telegram_approval_handles where approval_id = $1 and decision = 'GRANTED'", [s.approvalId]);
    const messageId = Number(row!.message_id);
    const base = 7_000_000 + Math.floor(Math.random() * 1_000_000);
    source.updates = [
      callbackUpdate(base, dataFor(g!.handle), { messageId, fromId: Number(LIMITS.chatId) + 9 }),
      callbackUpdate(base + 1, dataFor(g!.handle), { messageId }),
    ];
    const second = await pollOnce(deps);
    expect(second).toMatchObject({ unauthorised: 1, callbacks: 1 });
    expect(door.calls).toHaveLength(1);
    expect((await q<{ status: string }>("select status from public.approvals where id = $1", [s.approvalId]))[0]?.status).toBe("GRANTED");
  });
});
