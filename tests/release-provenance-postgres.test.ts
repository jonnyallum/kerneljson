import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type pg from "pg";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { until } from "./support/local.js";
import { bindingFor, persistBinding, workflowTargets } from "../services/kernel/src/execution-binding.js";
import { Task } from "../packages/contracts/src/index.js";
import { collectBindingProvenance, bindingProvenanceVerdict } from "../services/kernel/src/health/release-provenance.js";

let f: Awaited<ReturnType<typeof knowledgeDatabase>>;
beforeEach(async () => { f = await knowledgeDatabase(); });
afterEach(async () => { await f?.close(); });
const evidence = { qualification: "disposable test only" };
async function activate(db: Pick<pg.PoolClient, "query">, release: string, previous = "0", request = randomUUID()) {
  return (await db.query("select kernel_private.activate_release($1,$2,$3,$4) as epoch", [request, release, previous, evidence])).rows[0].epoch as string;
}
function binding(release: string) {
  return bindingFor(Task.parse({ ...f.task, id: randomUUID(), status: "RECEIVED" }), workflowTargets.TaskWorkflow, release);
}
async function insert(db: pg.PoolClient, release: string) {
  const b = binding(release);
  await persistBinding(db, b);
  return b;
}
async function row(taskId: string) {
  return (await f.pool.query("select release_epoch,persisted_at from kernel_private.execution_bindings where task_id=$1", [taskId])).rows[0];
}
async function blocked(pid: number) {
  await until(() => f.pool.query("select cardinality(pg_blocking_pids($1)) as n", [pid]), r => r.rows[0].n > 0, 10000);
}

it("multiple historical releases, current release, and replay preserve epochs without task projections", async () => {
  const db = await f.pool.connect();
  try {
    const legacy = await insert(db, "legacy-a");
    await insert(db, "legacy-b");
    expect(await activate(db, "old")).toBe("1");
    await insert(db, "old");
    expect(await activate(db, "new", "1")).toBe("2");
    await insert(db, "new");
    const before = await row(legacy.taskId);
    await persistBinding(db, { ...legacy, releaseId: "new" });
    expect(await row(legacy.taskId)).toEqual(before);
    const p = await collectBindingProvenance(f.pool);
    expect(p).toMatchObject({ activeEpoch: "2", currentBindingCount: 1, legacyBindingCount: 2, mismatchedBindingCount: 0 });
    expect(bindingProvenanceVerdict(p, "new").status).toBe("HEALTHY");
  } finally { db.release(); }
});

it("overlapping old writer after activation is stamped into new epoch and CRITICAL, never excused by receipt time", async () => {
  const db = await f.pool.connect();
  try {
    await activate(db, "new");
    const bad = await insert(db, "old");
    expect((await row(bad.taskId)).release_epoch).toBe("1");
    expect(bindingProvenanceVerdict(await collectBindingProvenance(f.pool), "new").status).toBe("CRITICAL");
    await activate(db, "later", "1");
    await insert(db, "later");
    expect(bindingProvenanceVerdict(await collectBindingProvenance(f.pool), "later").status).toBe("CRITICAL");
  } finally { db.release(); }
});

it("activation waits for pre-boundary binding transaction commit; next writer waits for activation commit", async () => {
  const a = await f.pool.connect(), b = await f.pool.connect(), c = await f.pool.connect();
  try {
    const bp = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
    const cp = (await c.query("select pg_backend_pid() as pid")).rows[0].pid;
    await a.query("begin");
    const old = await insert(a, "old");
    await b.query("begin");
    const activation = activate(b, "new");
    await blocked(bp);
    await a.query("commit");
    await activation;
    await c.query("begin");
    const next = insert(c, "new");
    await blocked(cp);
    // The uncommitted activation and next binding are invisible to observers.
    expect((await collectBindingProvenance(f.pool))?.activeEpoch).toBe("0");
    await b.query("commit");
    const fresh = await next;
    await c.query("commit");
    expect((await row(old.taskId)).release_epoch).toBe("0");
    expect((await row(fresh.taskId)).release_epoch).toBe("1");
  } finally {
    await Promise.all([a,b,c].map(async db => { await db.query("rollback"); db.release(); }));
  }
});

it.each(["repeatable read", "serializable"])("stale %s writer must abort and retry against current epoch", async isolation => {
  const a = await f.pool.connect(), b = await f.pool.connect();
  try {
    await a.query(`begin isolation level ${isolation}`);
    await a.query("select * from kernel_private.release_epoch");
    await activate(b, "new");
    await expect(insert(a, "old")).rejects.toMatchObject({ code: "40001" });
    await a.query("rollback");
    const retried = await insert(a, "old");
    expect((await row(retried.taskId)).release_epoch).toBe("1");
  } finally { await a.query("rollback"); a.release(); b.release(); }
});

it("aborted activation creates no boundary; retries are idempotent and stale requests cannot reactivate history", async () => {
  const db = await f.pool.connect();
  const request = randomUUID();
  try {
    const counts = () => f.pool.query("select (select count(*) from public.tasks) tasks,(select count(*) from kernel_private.task_admissions) admissions,(select count(*) from public.schedule_fires) fires");
    const before = (await counts()).rows;
    await db.query("begin"); await activate(db, "new", "0", request); await db.query("rollback");
    expect((await collectBindingProvenance(f.pool))?.activeEpoch).toBe("0");
    expect(await activate(db, "new", "0", request)).toBe("1");
    expect(await activate(db, "new", "0", request)).toBe("1");
    await activate(db, "later", "1");
    expect(await activate(db, "new", "0", request)).toBe("1");
    expect((await collectBindingProvenance(f.pool))?.activeEpoch).toBe("2");
    await expect(activate(db, "wrong", "0", request)).rejects.toThrow("Activation request conflict");
    await expect(activate(db, "wrong", "0")).rejects.toThrow("Stale release epoch");
    expect((await f.pool.query("select * from kernel_private.release_activations")).rowCount).toBe(2);
    expect((await counts()).rows).toEqual(before);
  } finally { db.release(); }
});

it("concurrent identical activation retries create one epoch", async () => {
  const request = randomUUID();
  expect(await Promise.all([activate(f.pool, "new", "0", request), activate(f.pool, "new", "0", request)])).toEqual(["1", "1"]);
  expect((await f.pool.query("select count(*)::int as n from kernel_private.release_activations")).rows[0].n).toBe(1);
});

it("activation is immutable, public roles cannot activate, and direct SQL cannot spoof binding provenance", async () => {
  const db = await f.pool.connect();
  try {
    await activate(db, "new");
    for (const sql of ["update kernel_private.release_activations set release_id='fake'", "delete from kernel_private.release_activations", "truncate kernel_private.release_activations"]) {
      await expect(db.query(sql)).rejects.toThrow();
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await db.query("select has_function_privilege($1,'kernel_private.activate_release(uuid,text,bigint,jsonb)','execute') as allowed", [role])).rows[0].allowed).toBe(false);
    }
    const b = binding("new");
    await db.query("insert into kernel_private.execution_bindings(task_id,tenant_id,principal_id,contract,release_epoch,persisted_at) values($1,$2,$3,$4,0,'2000-01-01')", [b.taskId,b.tenantId,b.principal.id,b]);
    expect((await row(b.taskId)).release_epoch).toBe("1");
    expect((await row(b.taskId)).persisted_at.getUTCFullYear()).not.toBe(2000);
    await expect(db.query("update kernel_private.execution_bindings set release_epoch=0 where task_id=$1", [b.taskId])).rejects.toThrow();
  } finally { db.release(); }
});

it("missing activation and no current observations are explicitly UNKNOWN", async () => {
  expect(bindingProvenanceVerdict(await collectBindingProvenance(f.pool)).status).toBe("UNKNOWN");
  await activate(f.pool, "new");
  expect(bindingProvenanceVerdict(await collectBindingProvenance(f.pool)).message).toContain("NO_OBSERVATION");
});

it("migration baselines preexisting immutable bindings without inventing their insertion time", async () => {
  // Reconstruct the immediately preceding schema in this disposable database.
  await f.pool.query(`drop trigger execution_bindings_provenance on kernel_private.execution_bindings;
    drop function kernel_private.stamp_binding_provenance();
    drop function kernel_private.activate_release(uuid,text,bigint,jsonb);
    drop table kernel_private.release_epoch, kernel_private.release_activations;
    alter table kernel_private.execution_bindings drop column release_epoch, drop column persisted_at;`);
  const db = await f.pool.connect();
  try {
    const old = await insert(db, "5a2335b41d8fe525ff940a3bd86912c98dae68af");
    await insert(db, "earlier-history");
    expect(await collectBindingProvenance(f.pool)).toBeNull();
    await db.query("begin");
    await db.query(await readFile("supabase/migrations/20260916205049_release_provenance.sql", "utf8"));
    await db.query("commit");
    expect(await row(old.taskId)).toEqual({ release_epoch: "0", persisted_at: null });
    const target = "d5abf22ec176d16932af5cfcd77a8ce3098027bc";
    await activate(db, target);
    expect(bindingProvenanceVerdict(await collectBindingProvenance(f.pool), target).status).toBe("UNKNOWN");
    await insert(db, target);
    expect(bindingProvenanceVerdict(await collectBindingProvenance(f.pool), target).status).toBe("HEALTHY");
    expect((await db.query("select contract from kernel_private.execution_bindings where task_id=$1", [old.taskId])).rows[0].contract).toEqual(old);
  } finally { await db.query("rollback"); db.release(); }
});

it("read-committed transaction begun before activation still receives the committed new epoch", async () => {
  const a = await f.pool.connect(), b = await f.pool.connect();
  try {
    await a.query("begin");
    await a.query("select * from kernel_private.release_epoch");
    await activate(b, "new");
    const late = await insert(a, "old");
    await a.query("commit");
    expect((await row(late.taskId)).release_epoch).toBe("1");
  } finally { await a.query("rollback"); a.release(); b.release(); }
});

it("aborted binding is absent and activation can then commit", async () => {
  const a = await f.pool.connect(), b = await f.pool.connect();
  try {
    const pid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
    await a.query("begin");
    const aborted = await insert(a, "old");
    const activation = activate(b, "new");
    await blocked(pid);
    await a.query("rollback");
    await activation;
    expect(await row(aborted.taskId)).toBeUndefined();
    expect((await collectBindingProvenance(f.pool))?.activeEpoch).toBe("1");
  } finally { await a.query("rollback"); a.release(); b.release(); }
});

it("all application binding inserts go through the canonical helper", async () => {
  const matches: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts") && /insert\s+into\s+kernel_private\.execution_bindings/i.test(await readFile(path,"utf8"))) matches.push(path);
    }
  }
  for (const dir of ["apps", "services", "packages"]) await walk(dir);
  expect(matches).toEqual(["services/kernel/src/execution-binding.ts"]);
});
