import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE, compose, holdRuntime, migrate, until } from "./support/local.js";
import { deliverRows } from "../services/kernel/src/alerting/delivery-worker.js";
import { RecordingNotifier } from "../services/kernel/src/alerting/notifier.js";
import { PgNotificationOutboxStore } from "../services/kernel/src/alerting/pg-outbox-store.js";
import { PgInboxStore } from "../services/kernel/src/channel/telegram/pg-inbox-store.js";
import { pollOnce, type OperatorDeps } from "../services/kernel/src/channel/telegram/operator.js";
import { PgStatusReader } from "../services/kernel/src/channel/telegram/status.js";
import { createMemoryPort, type MemoryPort } from "../services/kernel/src/channel/telegram/memory-port.js";
import { CanonicalMemory } from "../services/memory/src/canonical/service.js";
import { FakeDoor, FakeSource, LIMITS, NOW, msg } from "./support/telegram-fixture.js";

/**
 * KJ-P5 Telegram memory commands against a real Postgres: the real inbox, outbox and canonical memory service. Only
 * Telegram itself (the update source) and the transport that would send the reply are doubles. This is the design
 * of the first live memory proof, run against persisted rows.
 */
const name = `kj_p5_tg_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
let pool: pg.Pool;
let memory: CanonicalMemory;
let releaseRuntime = () => {};

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
  await admin.query(`create database ${name}`);
  pool = new pg.Pool({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`), max: 6 });
  pool.on("error", () => {});
  await migrate(pool);
  memory = new CanonicalMemory(pool);
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

beforeEach(async () => {
  await pool.query("truncate kernel_private.telegram_inbox");
  await pool.query("update kernel_private.telegram_operator_state set next_offset = 0, unauthorised_total = 0");
});

let counter = 5000;
const uid = (): number => (counter += 10);
const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
const n = async (sql: string, args: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(sql, args))[0]!.n);
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/** A fresh tenant and operator for every test, so counts never depend on what an earlier test wrote. */
async function fresh() {
  const tenantId = randomUUID();
  const principalId = randomUUID();
  await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principalId]);
  await pool.query("insert into tenants(id,name) values($1,'tg-mem')", [tenantId]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'operator')", [tenantId, principalId]);
  const ctx = { tenantId, principal: { id: principalId, kind: "HUMAN" as const } };
  const c = (table: string) => n(`select count(*)::text n from ${table} where tenant_id=$1`, [tenantId]);
  return { tenantId, principalId, ctx, c };
}

function build(ctx: { tenantId: string; principal: { id: string; kind: "HUMAN" } }, port: MemoryPort | null = createMemoryPort(memory, ctx)) {
  const source = new FakeSource();
  const outbox = new PgNotificationOutboxStore(pool);
  const notifier = new RecordingNotifier();
  const deps: OperatorDeps = {
    limits: { ...LIMITS },
    source,
    inbox: new PgInboxStore(pool),
    door: new FakeDoor(),
    status: new PgStatusReader(pool),
    outbox,
    deliver: async (ids) => {
      await deliverRows({ outbox, notifier, transport: "telegram", now: () => new Date(NOW) }, ids);
    },
    deliverDue: async () => {},
    now: () => new Date(NOW),
    ...(port ? { memory: port } : {}),
  };
  const say = async (text: string): Promise<{ id: number; reply: string }> => {
    const id = uid();
    source.updates = [msg(id, text)];
    await pollOnce(deps);
    const sent = notifier.sent.filter((p) => p.checkId === `OPERATOR.reply.${id}`);
    return { id, reply: sent.at(-1)?.message ?? "" };
  };
  return { deps, source, notifier, say };
}

const PREF = "I prefer concise deployment summaries unless I explicitly ask for detail";

describe("KJ-P5 the first live memory proof, against persisted rows", () => {
  it("/remember creates one candidate, one governed promotion and one canonical memory, with provenance to the Telegram update", async () => {
    const t = await fresh();
    const h = build(t.ctx);
    const { id, reply } = await h.say(`/remember ${PREF}`);
    expect(reply).toContain("Remembered as PREFERENCE");
    expect(await n("select count(*)::text n from kernel_private.telegram_inbox where update_id=$1 and state='DONE' and command='REMEMBER'", [id])).toBe(1);
    const cands = await q<{ id: string; origin: string; idempotency_key: string; state: string; content: string; evidence: Array<{ type: string; ref: string; digest: string }>; submitted_by: string }>(
      "select id, origin, idempotency_key, state, content, evidence, submitted_by from memory_candidates where tenant_id=$1",
      [t.tenantId],
    );
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ origin: "OPERATOR_INSTRUCTION", idempotency_key: `telegram:upd:${id}`, state: "PROMOTED", content: PREF, submitted_by: t.principalId });
    expect(cands[0]!.evidence).toEqual([{ type: "TELEGRAM_UPDATE", ref: `update:${id}`, digest: sha256(PREF) }]);
    const promos = await q<{ decision: string; promoted_by_kind: string; rule_id: string }>("select decision, promoted_by_kind, rule_id from memory_promotions where tenant_id=$1", [t.tenantId]);
    expect(promos).toEqual([{ decision: "ALLOW", promoted_by_kind: "POLICY_ENGINE", rule_id: "operator-instruction" }]);
    const versions = await q<{ class: string; trust_class: string; candidate_id: string; evidence: unknown; provenance: { origin: string; candidateId: string } }>(
      "select class, trust_class, candidate_id, evidence, provenance from memory_versions where tenant_id=$1",
      [t.tenantId],
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ class: "PREFERENCE", trust_class: "USER_AUTHORED", candidate_id: cands[0]!.id });
    expect(versions[0]!.evidence).toEqual(cands[0]!.evidence);
    expect(versions[0]!.provenance).toMatchObject({ origin: "OPERATOR_INSTRUCTION", candidateId: cands[0]!.id });
    // The reply says what happened using closed-vocabulary fields only.
    expect(reply).toMatch(/memory [0-9a-f]{8} v1/);
  });

  it("does not duplicate anything when the same update is delivered again", async () => {
    const t = await fresh();
    const h = build(t.ctx);
    const id = uid();
    h.source.updates = [msg(id, `/remember ${PREF}`)];
    await pollOnce(h.deps);
    const counts = async () => [await t.c("memory_candidates"), await t.c("memory_promotions"), await t.c("memory_versions")];
    expect(await counts()).toEqual([1, 1, 1]);
    // Telegram redelivers the batch (the offset was lost): the inbox row is DONE, so nothing is handled again.
    await pool.query("update kernel_private.telegram_operator_state set next_offset = 0");
    await pollOnce(h.deps);
    expect(await counts()).toEqual([1, 1, 1]);
    expect(h.notifier.sent.filter((p) => p.checkId === `OPERATOR.reply.${id}`)).toHaveLength(1);
    // A crash after the memory write but before the inbox row closed: the port is called again with the same update.
    const again = await createMemoryPort(memory, t.ctx).remember({ updateId: id, text: PREF });
    expect(again).toMatchObject({ state: "PROMOTED", replayed: true });
    expect(await counts()).toEqual([1, 1, 1]);
  });

  it("/memories and /memory show the memory with its provenance", async () => {
    const t = await fresh();
    const h = build(t.ctx);
    const first = await h.say(`/remember ${PREF}`);
    const memoryId = (await q<{ memory_id: string }>("select memory_id from memory_versions where tenant_id=$1", [t.tenantId]))[0]!.memory_id;
    const list = await h.say("/memories");
    expect(list.reply).toContain("Current memories (1)");
    expect(list.reply).toContain(memoryId.slice(0, 8));
    expect(list.reply).toContain(PREF);
    const one = await h.say(`/memory ${memoryId.slice(0, 8)}`);
    expect(one.reply).toContain("PREFERENCE");
    expect(one.reply).toContain("CURRENT");
    expect(one.reply).toContain(`TELEGRAM_UPDATE:update:${first.id}`);
    expect((await h.say("/memory 00000000")).reply).toContain("No memory with that id");
  });

  it("/forget retracts without erasing: history stays, the memory leaves the list, and forgetting twice is harmless", async () => {
    const t = await fresh();
    const h = build(t.ctx);
    await h.say(`/remember ${PREF}`);
    const memoryId = (await q<{ memory_id: string }>("select memory_id from memory_versions where tenant_id=$1", [t.tenantId]))[0]!.memory_id;
    const gone = await h.say(`/forget ${memoryId.slice(0, 8)}`);
    expect(gone.reply).toContain("Forgotten");
    expect(gone.reply).toContain("history is kept");
    expect(await n("select count(*)::text n from memory_versions where memory_id=$1", [memoryId])).toBe(2);
    expect(await n("select count(*)::text n from memory_versions where memory_id=$1 and version=1 and content=$2", [memoryId, PREF])).toBe(1);
    expect((await h.say("/memories")).reply).toContain("No current memories");
    const view = await h.say(`/memory ${memoryId.slice(0, 8)}`);
    expect(view.reply).toContain("RETRACTED");
    expect(view.reply).toContain("retracted");
    expect((await h.say(`/forget ${memoryId.slice(0, 8)}`)).reply).toContain("already retracted");
    expect(await n("select count(*)::text n from memory_versions where memory_id=$1", [memoryId])).toBe(2);
    // Real deletion is not a path this channel has.
    expect(await n("select count(*)::text n from memory_candidates where tenant_id=$1", [t.tenantId])).toBe(3);
  });

  it("a corrected preference is what /memories shows, and the older version stays on record", async () => {
    const t = await fresh();
    const h = build(t.ctx);
    await h.say("/remember I prefer detailed deployment summaries");
    const memoryId = (await q<{ memory_id: string }>("select memory_id from memory_versions where tenant_id=$1", [t.tenantId]))[0]!.memory_id;
    const fix = await memory.submitOperatorInstruction(t.ctx, {
      idempotencyKey: `correct-${randomUUID()}`,
      class: "PREFERENCE",
      content: "I now prefer concise deployment summaries",
      subject: { kind: "PRINCIPAL", ref: t.principalId },
      evidence: [{ type: "TELEGRAM_UPDATE", ref: "update:correction" }],
      reason: "correction",
      intent: "CORRECT",
      targetMemoryId: memoryId,
    });
    expect(fix).toMatchObject({ state: "PROMOTED", version: 2 });
    const list = await h.say("/memories");
    expect(list.reply).toContain("I now prefer concise deployment summaries");
    expect(list.reply).not.toContain("I prefer detailed deployment summaries");
    const one = await h.say(`/memory ${memoryId.slice(0, 8)}`);
    expect(one.reply).toContain("v1 asserted");
    expect(one.reply).toContain("I prefer detailed deployment summaries");
    expect(one.reply).toContain("v2 asserted");
  });

  it("refuses a credential without storing it, and never echoes it in the reply", async () => {
    const t = await fresh();
    const h = build(t.ctx);
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const { reply } = await h.say(`/remember my api key is ${secret}`);
    expect(reply).toContain("Not remembered (no-secrets)");
    expect(reply).not.toContain(secret);
    expect(await t.c("memory_versions")).toBe(0);
    const rows = await q("select * from memory_candidates where tenant_id=$1", [t.tenantId]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0]).toMatchObject({ state: "REFUSED" });
  });

  it("answers 'not switched on' and records nothing when memory is not configured", async () => {
    const t = await fresh();
    const h = build(t.ctx, null);
    const { reply } = await h.say(`/remember ${PREF}`);
    expect(reply).toContain("Memory is not switched on");
    expect(await t.c("memory_candidates")).toBe(0);
    expect((await h.say("/memories")).reply).toContain("not switched on");
  });

  it("answers with a fixed reply that carries no error text when memory fails", async () => {
    const t = await fresh();
    const broken: MemoryPort = {
      remember: async () => {
        throw new Error("connection string postgres://user:hunter2@db/x refused");
      },
      list: async () => {
        throw new Error("boom");
      },
      show: async () => {
        throw new Error("boom");
      },
      forget: async () => {
        throw new Error("boom");
      },
    };
    const h = build(t.ctx, broken);
    const { id, reply } = await h.say(`/remember ${PREF}`);
    expect(reply).toContain("I could not reach memory");
    expect(reply).not.toContain("hunter2");
    expect(await n("select count(*)::text n from kernel_private.telegram_inbox where update_id=$1 and state='DONE'", [id])).toBe(1);
  });

  it("holds a protected memory instead of promoting it when no approver is configured", async () => {
    const t = await fresh();
    const h = build(t.ctx);
    const { reply } = await h.say("/remember relationship: Sam is my accountant");
    expect(reply).toContain("Kept as a candidate only");
    expect(await t.c("memory_versions")).toBe(0);
    expect(await n("select count(*)::text n from memory_candidates where tenant_id=$1 and state='HELD'", [t.tenantId])).toBe(1);
  });

  it("the remembered preference is what the assembler selects for a later mission-style query, with the digest recorded", async () => {
    const t = await fresh();
    const h = build(t.ctx);
    await h.say(`/remember ${PREF}`);
    const request = { purpose: "summarise the deployment for the team", allowedClasses: ["PREFERENCE" as const, "FACT" as const], budget: { maxItems: 5, maxTokens: 400 } };
    const a = await memory.assemble(t.ctx, request);
    const b = await memory.assemble(t.ctx, request);
    expect(a.items.map((i) => i.content)).toEqual([PREF]);
    expect(a.digest).toBe(b.digest);
    expect(a.items[0]!.provenance.evidence[0]).toMatchObject({ type: "TELEGRAM_UPDATE" });
    expect(await n("select count(*)::text n from memory_context_assemblies where tenant_id=$1 and digest=$2", [t.tenantId, a.digest])).toBe(1);
  });
});
