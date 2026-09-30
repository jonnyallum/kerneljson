import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { Context } from "@restatedev/restate-sdk";
import { DATABASE, compose, migrate, until, holdRuntime } from "./support/local.js";
import {
  IdentityCognitionPin,
  KernelSubmission,
  MISSION_RECIPE,
  ModelCallBinding,
  Task,
  TaskEvent,
  type IdentityDocument,
  type Outcome,
  type ModelRequest,
} from "../packages/contracts/src/index.js";
import type { FacultyPin } from "../packages/contracts/src/faculty.js";
import { Ledger } from "../services/kernel/src/ledger.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { orderedSteps, planTask, projectStep } from "../services/kernel/src/planner/index.js";
import { digest } from "../services/kernel/src/deterministic.js";
import { runRepoAnalysisMission, type Emit } from "../services/kernel/src/mission/run.js";
import { modelCalledEventId } from "../services/kernel/src/executor/workflow.js";
import { PgFacultyRegistry } from "../services/kernel/src/faculty/registry.js";
import { coreTeamTemplates } from "../services/kernel/src/faculty/templates.js";
import { identityFramingCeiling } from "../services/kernel/src/faculty/identity-ceiling.js";
import { PgIdentityCognition } from "../services/kernel/src/identity/cognition-binding.js";
import { countIdentityBlocks, projectIdentity, projectionBytes, projectionDigest } from "../services/kernel/src/identity/projection.js";
import { identityCoreDigestV1 } from "../services/kernel/src/identity/canonical.js";
import { provenanceOf } from "../services/kernel/src/identity/evidence-verify.js";
import { assemblyDigestOf } from "../services/kernel/src/mission/cognition-digests.js";
import { fetchIdentityCognition } from "../services/kernel/src/health/collect.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";
import type { ModelPort } from "../packages/models/src/index.js";
import type { MissionMemoryPort } from "../services/kernel/src/mission/memory-port.js";
import { modelDigest } from "../packages/models/src/digest.js";
import { CanonicalMemory } from "../services/memory/src/canonical/service.js";
import { createMissionMemoryPort } from "../services/memory/src/canonical/mission-port.js";
import { principal } from "../evals/fixtures/contracts.js";
import { REPO, fakeClaude, fakeGrok, githubResult } from "./support/mission-fixture.js";

/**
 * KJ-P7B-1 against a REAL Postgres ledger (ADR-0022, D1 erratum). Model runtimes and GitHub are doubles. Restate is
 * simulated exactly as the P6 suite does it: `ctx.run` returns a journaled value when present (replay) and runs the
 * action otherwise, so replay, lost-journal and journal/database disagreement are all exercised deterministically.
 */
const P7B_MIGRATION = "20260929120000_identity_cognition_binding.sql";
const corpus = JSON.parse(readFileSync("tests/fixtures/identity-core-v1.vectors.json", "utf8")) as {
  vectors: Array<{ name: string; inputJson: string; canonical?: string; sha256?: string; classASha256?: string; refuse?: string }>;
};
const KERNEL_V1 = JSON.parse(corpus.vectors.find((v) => v.name === "kernel-v1-activated")!.inputJson) as IdentityDocument;
const KERNEL_TENANT = KERNEL_V1.tenantId;
const KERNEL_VERSION_ROW = "08be5e20-2606-4809-b81f-11552bb67502";
const ROUTES = { analyst: { provider: "openrouter" as const, model: "anthropic/claude-test" }, reviewer: { provider: "openrouter" as const, model: "x-ai/grok-test" } };

const admin = new pg.Pool({ connectionString: DATABASE, max: 1 });
const databases: string[] = [];
let releaseRuntime = () => {};
async function freshDatabase(prefix: string): Promise<pg.Pool> {
  const name = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.query(`create database ${name}`);
  databases.push(name);
  const pool = new pg.Pool({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`), max: 4 });
  pool.on("error", () => {});
  return pool;
}
async function ensureRoles(pool: pg.Pool) {
  await pool.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$`);
}
/** Every migration before P7B, then (optionally) P7B, each in its own transaction exactly like `migrate`. */
async function migrateBefore(pool: pg.Pool): Promise<void> {
  await ensureRoles(pool);
  for (const file of (await readdir("supabase/migrations")).filter((f) => f.endsWith(".sql") && f < P7B_MIGRATION).sort()) await applyFile(pool, file);
}
async function applyFile(pool: pg.Pool, file: string): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(await readFile(`supabase/migrations/${file}`, "utf8"));
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

/** Seeds an activated identity with triggers bypassed (disposable test DBs only). Digests are always the true v1 ones
 *  unless `storedCore` overrides them, which is how a corrupt row is simulated. */
async function seedIdentity(pool: pg.Pool, doc: IdentityDocument, opts: { versionRowId?: string; storedCore?: string; profile?: boolean } = {}) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    if (opts.profile !== false)
      await c.query("insert into public.identity_profiles(id,tenant_id,owner_principal_id,name) values($1,$2,$3,'Kernel') on conflict do nothing", [doc.id, doc.tenantId, principal.id]);
    const candidate = randomUUID();
    const { version: _v, ...draft } = doc;
    await c.query(`insert into public.identity_candidates(id,identity_id,tenant_id,document,proposed_digest,origin,governance_class,state,base_version,base_identity_core_digest)
      values($1,$2,$3,$4,$5,'MODEL_PROPOSAL','C','HELD',1,$5)`, [candidate, doc.id, doc.tenantId, draft, identityCoreDigestV1(draft)]);
    await c.query(`insert into public.identity_versions(id,identity_id,tenant_id,version,document,identity_core_digest,class_a_digest,governance_class,candidate_id,created_by_task)
      values($1,$2,$3,$4,$5,$6,$7,'C',$8,$9)`, [opts.versionRowId ?? randomUUID(), doc.id, doc.tenantId, doc.version, doc,
      opts.storedCore ?? identityCoreDigestV1(doc), identityCoreDigestV1(doc.sections.classA), candidate, randomUUID()]);
    await c.query(`insert into public.identity_activations(id,identity_id,tenant_id,version,governance_class,candidate_id,request_task_id)
      values($1,$2,$3,$4,'C',$5,$6)`, [randomUUID(), doc.id, doc.tenantId, doc.version, candidate, randomUUID()]);
    await c.query("commit");
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("up", "-d", "db");
  await until(() => admin.query("select 1"), (r) => r.rowCount === 1);
});
afterAll(async () => {
  for (const name of databases) {
    await until(() => admin.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname=$1", [name]), (r) => r.rows[0]!.n === 0, 15_000).catch(() => undefined);
    await admin.query(`drop database if exists ${name} with (force)`);
  }
  await admin.end();
  releaseRuntime();
});

// ---------------------------------------------------------------------------------------------------------------
describe("the migration's pre-COMMIT qualification refuses bad production states (and applies on the true one)", () => {
  const outcome = async (seed: (pool: pg.Pool) => Promise<void>) => {
    const pool = await freshDatabase("p7b_pre");
    try {
      await migrateBefore(pool);
      await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principal.id]);
      await pool.query("insert into tenants(id,name) values($1,'kernel')", [KERNEL_TENANT]);
      await seed(pool);
      await applyFile(pool, P7B_MIGRATION);
      return "APPLIED";
    } catch (error) {
      return (error as Error).message;
    } finally {
      await pool.end();
    }
  };
  it("applies with the exact production Kernel v1 row present", async () => {
    expect(await outcome((p) => seedIdentity(p, KERNEL_V1, { versionRowId: KERNEL_VERSION_ROW }))).toBe("APPLIED");
  });
  it("refuses when the persisted Kernel v1 row is not the approved document, even with self-consistent digests", async () => {
    const tampered = structuredClone(KERNEL_V1);
    tampered.sections.classC.persona += " (tampered)";
    expect(await outcome((p) => seedIdentity(p, tampered, { versionRowId: KERNEL_VERSION_ROW }))).toContain("persisted Kernel v1 differs");
  });
  it("refuses when any existing version fails digest parity", async () => {
    const other = { ...structuredClone(KERNEL_V1), id: randomUUID() };
    expect(await outcome((p) => seedIdentity(p, other, { storedCore: "0".repeat(64) }))).toContain("fail digest parity");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("least privilege under a Supabase-style default ACL (PR #47 harness), including service_role", () => {
  let acl: pg.Pool;
  beforeAll(async () => {
    acl = await freshDatabase("p7b_acl");
    await ensureRoles(acl);
    await acl.query("alter default privileges in schema public grant all on tables to public, anon, authenticated, service_role");
    await acl.query("alter default privileges in schema public grant all on sequences to public, anon, authenticated, service_role");
    await acl.query("alter default privileges in schema public grant all on functions to public, anon, authenticated, service_role");
    await migrate(acl);
  });
  afterAll(async () => acl?.end());
  const has = async (role: string, rel: string, priv: string) =>
    (await acl.query<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, rel, priv])).rows[0]!.ok;
  it("the reproduced default ACL is real (negative control)", async () => {
    const c = await acl.connect();
    try {
      await c.query("begin");
      await c.query("create function public.p7b_probe() returns int language sql as 'select 1'");
      expect((await c.query("select has_function_privilege('anon','public.p7b_probe()','EXECUTE') ok")).rows[0].ok).toBe(true);
    } finally { await c.query("rollback"); c.release(); }
  });
  it("latch: PUBLIC/anon/authenticated nothing; service_role SELECT+INSERT only", async () => {
    const rel = "kernel_private.identity_cognition_latches";
    for (const role of ["public", "anon", "authenticated"])
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) expect(await has(role, rel, priv), `${role} ${priv}`).toBe(false);
    expect(await has("service_role", rel, "SELECT")).toBe(true);
    expect(await has("service_role", rel, "INSERT")).toBe(true);
    for (const priv of ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) expect(await has("service_role", rel, priv), priv).toBe(false);
  });
  it("contract marker: service_role SELECT only; nobody else anything", async () => {
    const rel = "kernel_private.identity_cognition_contract_v1";
    for (const role of ["public", "anon", "authenticated"]) expect(await has(role, rel, "SELECT")).toBe(false);
    expect(await has("service_role", rel, "SELECT")).toBe(true);
    for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) expect(await has("service_role", rel, priv), priv).toBe(false);
  });
  it("the new USAGE on kernel_private exposes no other private relation, sequence or function to service_role", async () => {
    const exposed = await acl.query(`
      select 'relation ' || c.relname as obj from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'kernel_private' and c.relkind in ('r','v','m','S','p','f')
          and c.relname not in ('identity_cognition_latches','identity_cognition_contract_v1')
          and has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      union all
      select 'function ' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'kernel_private' and has_function_privilege('service_role', p.oid, 'EXECUTE')`);
    expect(exposed.rows).toEqual([]);
    const inventory = await acl.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='kernel_private'");
    expect(inventory.rows[0].n).toBeGreaterThan(15); // the inventory really ran over the whole private schema
  });
  it("no new function is EXECUTE-able by PUBLIC, anon, authenticated or service_role", async () => {
    const fns = ["kernel_private.identity_json_string_v1(text)", "kernel_private.identity_core_canonical_v1(jsonb)", "kernel_private.identity_core_digest_v1(jsonb)",
      "kernel_private.identity_cognition_source_v1(uuid,uuid,integer)", "public.identity_version_digest_parity_v1()", "public.identity_pin_guard_v1()"];
    for (const fn of fns) for (const role of ["public", "anon", "authenticated", "service_role"])
      expect((await acl.query("select has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).rows[0].ok, `${role} ${fn}`).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The main database: legacy epoch 1, then the contract activated atomically at epoch 2.
let pool: pg.Pool;
let ledger: Ledger;
let faculties: PgFacultyRegistry;
let enabled = false;
let envReads = 0;
let identity: PgIdentityCognition;
const RELEASE = "p7b-test-release";
let legacyTask: string;
/** A task bound in the pre-contract epoch whose mission only runs AFTER the contract is activated. */
const lateLegacy: Scenario = { seed: randomUUID(), intentId: randomUUID(), createdMs: Date.now() - 400_000 };

function deterministic(seed: string, startMs: number) {
  let n = 0, t = 0;
  return {
    uuid: () => {
      const h = createHash("sha256").update(`${seed}:${n++}`).digest("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
    now: async () => new Date(startMs + 1000 * ++t).toISOString(),
  };
}
const activate = async (db: Pick<pg.PoolClient, "query">, expected: number, marker: boolean) => {
  const epoch = Number((await db.query("select kernel_private.activate_release($1,$2,$3,$4) as e", [randomUUID(), RELEASE, expected, { test: "p7b" }])).rows[0].e);
  if (marker) await db.query("insert into kernel_private.identity_cognition_contract_v1(contract, first_release_epoch) values('kerneljson:identity-cognition/v1', $1)", [epoch]);
  return epoch;
};

interface Scenario {
  analyst?: ModelPort;
  reviewer?: ModelPort;
  faculties?: PgFacultyRegistry;
  memory?: MissionMemoryPort;
  identity?: PgIdentityCognition | null;
  journal?: Map<string, unknown>;
  seed?: string;
  intentId?: string;
  createdMs?: number;
  stopBeforeMission?: boolean;
  mutateCognitionEvidence?: Record<string, string>;
  tenant?: string;
}
async function runMission(s: Scenario = {}): Promise<{ outcome: Outcome | null; taskId: string; analystStep: string; reviewerStep: string }> {
  const createdMs = s.createdMs ?? Date.now() - 120_000;
  const seed = s.seed ?? randomUUID();
  const th = createHash("sha256").update(`${seed}:trace`).digest("hex");
  const trace = `${th.slice(0, 8)}-${th.slice(8, 12)}-4${th.slice(13, 16)}-a${th.slice(17, 20)}-${th.slice(20, 32)}`;
  const submission = KernelSubmission.parse({
    recipe: MISSION_RECIPE,
    intent: { id: s.intentId ?? randomUUID(), principal, tenant: { id: s.tenant ?? KERNEL_TENANT }, source: "test",
      objective: `${REPO} What are the biggest risks?`, attachments: [], contextRefs: [], receivedAt: new Date(createdMs).toISOString(),
      trace: { traceId: trace, correlationId: trace } },
  });
  const compiled = compileIntent(submission);
  const plan = planTask(compiled.task, MISSION_RECIPE);
  const [, analystNode, reviewerNode] = orderedSteps(plan);
  let task = compiled.task;
  const det = deterministic(seed, createdMs + 10_000);
  const emit: Emit = async (key, type, status, extra = {}, payload = {}) => {
    if (s.mutateCognitionEvidence && extra.evidence?.source === "kerneljson:runtime/analyst" && "assembly_digest" in extra.evidence.metadata)
      extra.evidence = { ...extra.evidence, metadata: { ...extra.evidence.metadata, ...s.mutateCognitionEvidence } };
    const occurredAt = await det.now();
    task = Task.parse({ ...task, status, ...(key === "start" ? { startedAt: occurredAt } : {}), ...(status === "COMPLETED" ? { completedAt: occurredAt } : {}) });
    const event = TaskEvent.parse({ id: det.uuid(), taskId: task.id, type, occurredAt, actor: task.principal, traceId: task.traceId,
      ...(extra.step ? { stepId: extra.step.id } : {}), payload: { status, ...payload } });
    if (status === "COMPLETED") return ledger.finish({ key, task, event, ...extra });
    await ledger.write({ key, task, event, ...extra });
  };
  await emit("create", "TASK_CREATED", "RECEIVED", {}, { intent: submission.intent, recipe: plan.recipe, compilerVersion: 1 });
  await emit("intent", "INTENT_RESOLVED", "RECEIVED", {}, { intentId: submission.intent.id, correlationId: trace });
  await emit("compile", "PLAN_COMPILED", "COMPILED", { steps: plan.steps.map(projectStep) }, { plan, planDigest: digest(plan) });
  await emit("ready", "TASK_READY", "READY");
  await emit("start", "TASK_STARTED", "RUNNING");
  if (s.stopBeforeMission) return { outcome: null, taskId: task.id, analystStep: analystNode!.id, reviewerStep: reviewerNode!.id };
  const ctx = { run: async (n: string, action: () => unknown) => {
    if (s.journal?.has(n)) return structuredClone(s.journal.get(n));
    const result = await action();
    s.journal?.set(n, structuredClone(result));
    return result;
  } } as unknown as Pick<Context, "run">;
  const port = s.identity === undefined ? identity : s.identity;
  const outcome = await runRepoAnalysisMission({
    ctx, task, plan, emit, now: det.now, uuid: det.uuid,
    githubRead: async () => githubResult(), analyst: s.analyst ?? fakeClaude(), reviewer: s.reviewer ?? fakeGrok(),
    ...(s.memory ? { memory: s.memory } : {}), faculties: s.faculties ?? faculties, ...(port ? { identity: port } : {}),
    // Exactly the workflow's recorder: a direct ledger write, idempotent by call id, never emit().
    recordModelCall: async (binding, occurredAt) => {
      const event = TaskEvent.parse({ id: modelCalledEventId(binding.call_id), taskId: task.id, type: "MODEL_CALLED", occurredAt,
        actor: task.principal, traceId: task.traceId, stepId: binding.step_id, payload: { status: "RUNNING", binding } });
      await ledger.write({ key: `model:${binding.call_id}:called`, task, event });
    },
    notify: async () => {},
  });
  return { outcome, taskId: task.id, analystStep: analystNode!.id, reviewerStep: reviewerNode!.id };
}
const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;
const latchOf = async (taskId: string) => (await q("select mode, release_epoch from kernel_private.identity_cognition_latches where task_id=$1", [taskId]))[0];
const pinOf = async (taskId: string) => (await q("select pin from public.identity_pins where task_id=$1", [taskId]))[0]?.pin;
const callsOf = async (taskId: string) => (await q("select payload, step_id, event_key from public.task_events where task_id=$1 and type='MODEL_CALLED'", [taskId]));
const runtimeEvidence = async (taskId: string, role: "analyst" | "reviewer") =>
  (await q("select metadata from public.evidence where task_id=$1 and source=$2", [taskId, `kerneljson:runtime/${role}`]))[0]?.metadata as Record<string, unknown> | undefined;
const spy = (inner: ModelPort, seen: ModelRequest[]): ModelPort => ({ generate: async (r) => { seen.push(r); return inner.generate(r); } });
async function facultyPinFor(taskId: string, stepId: string): Promise<FacultyPin> {
  return faculties.pin({ tenantId: KERNEL_TENANT, taskId, stepId });
}
function buildPin(taskId: string, stepId: string, f: FacultyPin, doc: IdentityDocument = KERNEL_V1, versionRowId = KERNEL_VERSION_ROW): IdentityCognitionPin {
  const projection = projectIdentity(doc, "ANALYST_INTELLIGENCE_V1", identityFramingCeiling("intelligence", "faculty-routing/v1"));
  return IdentityCognitionPin.parse({ tenantId: doc.tenantId, taskId, stepId, identityId: doc.id, identityVersionId: versionRowId, identityVersion: doc.version,
    identityCoreDigest: identityCoreDigestV1(doc), classADigest: identityCoreDigestV1(doc.sections.classA), digestContract: "kerneljson:identity-core/v1",
    projectionSchema: "kerneljson:identity-projection/v1", projectionProfile: "ANALYST_INTELLIGENCE_V1", projection, projectionBytes: projectionBytes(projection),
    projectionDigest: projectionDigest(projection), facultyId: "intelligence", facultyVersion: f.faculty.version, facultyDigest: f.facultyDigest, mode: "REQUIRED" });
}
/** Runs statements in one transaction and reports how COMMIT (or the statements) ended. */
async function tx(statements: Array<[string, unknown[]?]>): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    for (const [sql, args] of statements) await c.query(sql, args ?? []);
    await c.query("commit");
    return "COMMITTED";
  } catch (error) {
    await c.query("rollback").catch(() => undefined);
    return `${(error as { code?: string }).code ?? "?"} ${(error as Error).message}`;
  } finally {
    c.release();
  }
}
const insertLatch = (taskId: string, stepId: string, mode: string, epoch: number, tenant = KERNEL_TENANT): [string, unknown[]] =>
  ["insert into kernel_private.identity_cognition_latches(tenant_id,task_id,step_id,mode,release_epoch) values($1,$2,$3,$4,$5)", [tenant, taskId, stepId, mode, epoch]];
const insertPin = (p: IdentityCognitionPin, tenant = KERNEL_TENANT): [string, unknown[]] =>
  ["insert into public.identity_pins(tenant_id,task_id,step_id,identity_id,identity_version,pin) values($1,$2,$3,$4,$5,$6)", [tenant, p.taskId, p.stepId, p.identityId, p.identityVersion, p]];

describe("KJ-P7B-1 against the real ledger", () => {
  let contractEpoch: number;
  beforeAll(async () => {
    pool = await freshDatabase("p7b_main");
    await migrate(pool);
    await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principal.id]);
    await pool.query("insert into tenants(id,name) values($1,'kernel')", [KERNEL_TENANT]);
    await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')", [KERNEL_TENANT, principal.id]);
    for (const f of coreTeamTemplates(KERNEL_TENANT, "test:p7b"))
      await pool.query("insert into faculty_versions(tenant_id,faculty_id,version,definition,digest) values($1,$2,$3,$4,$5)", [KERNEL_TENANT, f.id, f.version, f, capabilityDigest(f)]);
    await seedIdentity(pool, KERNEL_V1, { versionRowId: KERNEL_VERSION_ROW });
    ledger = new Ledger(pool, undefined, "KernelWorkflowV1", RELEASE);
    faculties = new PgFacultyRegistry(pool, ROUTES);
    identity = new PgIdentityCognition(pool, () => { envReads++; return enabled; });
    await activate(pool, 0, false); // epoch 1: the pre-P7B release
    legacyTask = (await runMission()).taskId;
    await runMission({ ...lateLegacy, stopBeforeMission: true });
  });
  afterAll(async () => pool?.end());

  describe("the SQL twin reproduces the shared corpus", () => {
    for (const v of corpus.vectors)
      it(v.refuse ? `refuses ${v.name}` : `reproduces ${v.name}`, async () => {
        if (v.refuse) {
          await expect(pool.query("select kernel_private.identity_core_canonical_v1($1::jsonb)", [v.inputJson])).rejects.toThrow(v.refuse);
          return;
        }
        const r = (await pool.query("select kernel_private.identity_core_canonical_v1($1::jsonb) c, kernel_private.identity_core_digest_v1($1::jsonb) d, kernel_private.identity_core_digest_v1(($1::jsonb)->'sections'->'classA') a", [v.inputJson])).rows[0];
        expect(r.c).toBe(v.canonical);
        expect(r.d).toBe(v.sha256);
        if (v.classASha256) expect(r.a).toBe(v.classASha256);
      });
  });

  describe("the digest parity trigger and the contract marker", () => {
    it("refuses a future identity version whose stored digest is not the SQL v1 digest", async () => {
      const doc = { ...structuredClone(KERNEL_V1), version: 7 };
      const insert = (core: string): [string, unknown[]] => [`insert into public.identity_versions(id,identity_id,tenant_id,version,document,identity_core_digest,class_a_digest,governance_class,candidate_id,created_by_task)
        values($1,$2,$3,7,$4,$5,$6,'C',(select candidate_id from public.identity_versions where id=$7),$8)`, [randomUUID(), doc.id, doc.tenantId, doc, core, identityCoreDigestV1(doc.sections.classA), KERNEL_VERSION_ROW, randomUUID()]];
      // Only the P7A sequencing guard is set aside, inside a rolled-back test transaction, so parity is what decides.
      const off: [string] = ["alter table public.identity_versions disable trigger identity_version_sequence"];
      expect(await tx([off, insert("0".repeat(64)), ["rollback"]])).toContain("IDENTITY_DIGEST_PARITY");
      const ok = await tx([off, insert(identityCoreDigestV1(doc)), ["select 1"]]);
      expect(ok === "COMMITTED" || ok.includes("duplicate")).toBe(true);
    });
    it("the migration created the marker EMPTY, and the legacy task was never latched", async () => {
      expect(await q("select * from kernel_private.identity_cognition_contract_v1")).toEqual([]);
      expect(await latchOf(legacyTask)).toBeUndefined();
      expect(await callsOf(legacyTask)).toEqual([]);
      expect(Object.keys((await runtimeEvidence(legacyTask, "analyst"))!)).not.toContain("assembly_digest");
      expect((await q("select status from tasks where id=$1", [legacyTask]))[0].status).toBe("COMPLETED");
    });
    it("refuses a backdated marker, and rolls the release activation back with it", async () => {
      const before = (await q("select epoch from kernel_private.release_epoch"))[0].epoch;
      const r = await tx([["select kernel_private.activate_release($1,$2,$3,$4)", [randomUUID(), RELEASE, 1, { test: "backdate" }]],
        ["insert into kernel_private.identity_cognition_contract_v1(contract, first_release_epoch) values('kerneljson:identity-cognition/v1', 1)"]]);
      expect(r).toContain("IDENTITY_CONTRACT_BACKDATED");
      expect((await q("select epoch from kernel_private.release_epoch"))[0].epoch).toBe(before);
      expect(await q("select * from kernel_private.identity_cognition_contract_v1")).toEqual([]);
    });
    it("activates atomically: activate_release + marker in ONE transaction; singleton and immutable afterwards", async () => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        contractEpoch = await activate(c, 1, true);
        await c.query("commit");
      } finally { c.release(); }
      expect(contractEpoch).toBe(2);
      expect((await q("select first_release_epoch::int e from kernel_private.identity_cognition_contract_v1"))[0].e).toBe(2);
      expect((await q("select release_id from kernel_private.release_activations where epoch=$1", [contractEpoch]))[0].release_id).toBe(RELEASE);
      expect(await tx([["insert into kernel_private.identity_cognition_contract_v1(contract, first_release_epoch) values('kerneljson:identity-cognition/v1', 2)"]])).toContain("23505");
      expect(await tx([["update kernel_private.identity_cognition_contract_v1 set created_at=now()"]])).not.toBe("COMMITTED");
      expect(await tx([["delete from kernel_private.identity_cognition_contract_v1"]])).not.toBe("COMMITTED");
      expect(await tx([["truncate kernel_private.identity_cognition_contract_v1"]])).not.toBe("COMMITTED");
    });
  });

  describe("latch table: tenant FK, release epoch FK, guards, immutability, and the COMMIT-time latch/pin invariant", () => {
    const prepared = async () => {
      const t = await runMission({ stopBeforeMission: true });
      const f = await facultyPinFor(t.taskId, t.analystStep);
      return { ...t, f };
    };
    it("migration objects exist (so no negative below can pass on a missing object)", async () => {
      const names = (await q("select tgname from pg_trigger where tgname like 'identity_%' order by 1")).map((r) => r.tgname);
      for (const n of ["identity_cognition_latches_pin_invariant", "identity_pins_latch_invariant", "identity_cognition_latch_guard", "identity_pins_guard_v1", "identity_versions_digest_parity_v1", "identity_cognition_contract_guard"])
        expect(names).toContain(n);
    });
    it("REQUIRED + pin commits; NONE + no pin commits", async () => {
      const a = await prepared();
      expect(await tx([insertLatch(a.taskId, a.analystStep, "REQUIRED", contractEpoch), insertPin(buildPin(a.taskId, a.analystStep, a.f))])).toBe("COMMITTED");
      const b = await prepared();
      expect(await tx([insertLatch(b.taskId, b.analystStep, "NONE", contractEpoch)])).toBe("COMMITTED");
      // Latch and pin may be written in either order inside the transaction.
      const c = await prepared();
      expect(await tx([insertPin(buildPin(c.taskId, c.analystStep, c.f)), insertLatch(c.taskId, c.analystStep, "REQUIRED", contractEpoch)])).toBe("COMMITTED");
    });
    it("REQUIRED + no pin, NONE + pin, and a pin with no latch all fail AT COMMIT from the invariant", async () => {
      const a = await prepared();
      expect(await tx([insertLatch(a.taskId, a.analystStep, "REQUIRED", contractEpoch)])).toMatch(/^23514 IDENTITY_LATCH_PIN_INVARIANT: a REQUIRED latch needs exactly one identity pin/);
      const b = await prepared();
      expect(await tx([insertLatch(b.taskId, b.analystStep, "NONE", contractEpoch), insertPin(buildPin(b.taskId, b.analystStep, b.f))])).toMatch(/^23514 IDENTITY_LATCH_PIN_INVARIANT: a NONE latch must have no identity pin/);
      const c = await prepared();
      expect(await tx([insertPin(buildPin(c.taskId, c.analystStep, c.f))])).toMatch(/^23514 IDENTITY_LATCH_PIN_INVARIANT: an identity pin exists without a cognition latch/);
      // Each insert above succeeded until COMMIT: prove the deferral by checking the rows are simply absent now.
      for (const t of [a, b, c]) expect(await latchOf(t.taskId)).toBeUndefined();
    });
    it("refuses the correct task and step under another tenant (tenant FK), and a cross-tenant latch/pin pair", async () => {
      const a = await prepared();
      const other = randomUUID();
      await pool.query("insert into tenants(id,name) values($1,'other')", [other]);
      expect(await tx([insertLatch(a.taskId, a.analystStep, "NONE", contractEpoch, other)])).toMatch(/^23503 .*identity_cognition_latches_task_tenant/);
      expect(await tx([insertLatch(a.taskId, a.analystStep, "REQUIRED", contractEpoch), insertPin(buildPin(a.taskId, a.analystStep, a.f), other)])).toMatch(/^23503|^23514/);
    });
    it("refuses a legacy task, a non-analyst step, and an epoch other than the task's own binding", async () => {
      const legacySteps = (await q("select id from task_steps where task_id=$1", [legacyTask])).map((r) => r.id);
      expect(await tx([insertLatch(legacyTask, legacySteps[1], "NONE", 1)])).toContain("IDENTITY_LATCH_PRE_CONTRACT");
      const a = await prepared();
      await facultyPinFor(a.taskId, a.reviewerStep);
      expect(await tx([insertLatch(a.taskId, a.reviewerStep, "NONE", contractEpoch)])).toContain("IDENTITY_LATCH_NOT_ANALYST");
      const c = await pool.connect();
      let later: number;
      try { await c.query("begin"); later = await activate(c, contractEpoch, false); await c.query("rollback"); } finally { c.release(); }
      // A higher epoch that really exists but is not the task's binding epoch: refused by the (task, tenant, epoch) FK.
      const e3 = await tx([["select kernel_private.activate_release($1,$2,$3,$4)", [randomUUID(), RELEASE, contractEpoch, { test: "e3" }]], insertLatch(a.taskId, a.analystStep, "NONE", later!)]);
      expect(e3).toMatch(/^23503 .*identity_cognition_latches_binding_epoch/);
    });
    it("the widened pin contract and the database-side pin guard refuse malformed or unfaithful pins", async () => {
      const a = await prepared();
      const good = buildPin(a.taskId, a.analystStep, a.f);
      const bad = async (pin: Record<string, unknown>) => tx([insertLatch(a.taskId, a.analystStep, "REQUIRED", contractEpoch), insertPin(pin as IdentityCognitionPin)]);
      // Keys the database guard does not read, so the widened CHECK is what refuses them.
      const { projectionSchema: _drop, ...missingKey } = good;
      expect(await bad(missingKey)).toMatch(/^23514 .*identity_pins_cognition_v1/);
      expect(await bad({ ...good, mode: "NONE" })).toMatch(/^23514 .*identity_pins_cognition_v1/);
      expect(await bad({ ...good, digestContract: "kerneljson:identity-core/v2" })).toMatch(/^23514 .*identity_pins_cognition_v1/);
      // Over 16 KiB with a self-consistent digest and byte count: only the CHECK's cap can refuse it.
      const huge = { ...good.projection, padding: "x".repeat(17000) };
      const hugeBytes = Buffer.byteLength(JSON.stringify(huge).length ? (await pool.query("select kernel_private.identity_core_canonical_v1($1::jsonb) c", [huge])).rows[0].c : "", "utf8");
      const hugeDigest = (await pool.query("select kernel_private.identity_core_digest_v1($1::jsonb) d", [huge])).rows[0].d;
      expect(await bad({ ...good, projection: huge, projectionBytes: hugeBytes, projectionDigest: hugeDigest })).toMatch(/^23514 .*identity_pins_cognition_v1/);
      expect(await bad({ ...good, identityVersionId: randomUUID() })).toContain("IDENTITY_PIN_VERSION_MISMATCH");
      expect(await bad({ ...good, identityCoreDigest: "0".repeat(64) })).toContain("IDENTITY_DIGEST_MISMATCH");
      expect(await bad({ ...good, projectionDigest: "0".repeat(64) })).toContain("IDENTITY_PROJECTION_DIGEST_MISMATCH");
      expect(await bad({ ...good, projectionBytes: good.projectionBytes - 1 })).toContain("IDENTITY_PROJECTION_DIGEST_MISMATCH");
      expect(await bad({ ...good, facultyDigest: "0".repeat(64) })).toContain("IDENTITY_PIN_FACULTY_MISMATCH");
      expect(await bad(good)).toBe("COMMITTED");
    });
    it("latches are immutable to every role", async () => {
      expect(await tx([["update kernel_private.identity_cognition_latches set mode='NONE'"]])).not.toBe("COMMITTED");
      expect(await tx([["delete from kernel_private.identity_cognition_latches"]])).not.toBe("COMMITTED");
      expect(await tx([["truncate kernel_private.identity_cognition_latches"]])).not.toBe("COMMITTED");
    });
  });

  describe("missions under the contract (journal-simulated Restate)", () => {
    it("a task bound BEFORE the contract still completes as legacy after it: the binding epoch decides, not the current release", async () => {
      enabled = true;
      envReads = 0;
      const r = await runMission(lateLegacy);
      expect(r.outcome!.status).toBe("COMPLETED");
      expect(await latchOf(r.taskId)).toBeUndefined();
      expect(await callsOf(r.taskId)).toEqual([]);
      expect(envReads).toBe(0);
      expect(Number((await q("select release_epoch from kernel_private.execution_bindings where task_id=$1", [r.taskId]))[0].release_epoch)).toBeLessThan(contractEpoch);
    });
    it("OFF: a contract task latches NONE, sends exactly the pre-P7B prompt, binds MODEL_CALLED, and completes", async () => {
      enabled = false;
      const seenLegacy: ModelRequest[] = [], seenOff: ModelRequest[] = [];
      const seedA = randomUUID(), createdMs = Date.now() - 200_000;
      const off = await runMission({ analyst: spy(fakeClaude(), seenOff), seed: seedA, createdMs });
      expect(off.outcome!.status).toBe("COMPLETED");
      expect(await latchOf(off.taskId)).toEqual({ mode: "NONE", release_epoch: String(contractEpoch) });
      expect(await pinOf(off.taskId)).toBeUndefined();
      // The same inputs through the legacy path (no identity port at all) produce the identical system/user bytes.
      const legacyRun = await runMission({ analyst: spy(fakeClaude(), seenLegacy), identity: null, seed: randomUUID(), createdMs });
      expect(legacyRun.outcome!.status).toBe("FAILED"); // a contract task without a latch cannot complete
      expect(JSON.stringify(seenOff[0]!.messages.map((m) => m.content.replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "ID"))))
        .toBe(JSON.stringify(seenLegacy[0]!.messages.map((m) => m.content.replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "ID"))));
      expect(countIdentityBlocks(JSON.stringify(seenOff[0]))).toBe(0);
      const calls = await callsOf(off.taskId);
      expect(calls).toHaveLength(1);
      const binding = ModelCallBinding.parse(calls[0].payload.binding);
      expect(binding).toMatchObject({ step_id: off.analystStep, identity_cognition_mode: "NONE", status: "SUCCEEDED" });
      expect(binding.assembly_digest).toBe(assemblyDigestOf(seenOff[0]!));
      const ev = (await runtimeEvidence(off.taskId, "analyst"))!;
      expect(ev).toMatchObject({ identity: null, identity_cognition_mode: "NONE", assembly_digest: binding.assembly_digest,
        continuity_digest: binding.continuity_digest, request_digest: binding.request_digest, call_id: binding.call_id });
      expect(await runtimeEvidence(off.taskId, "reviewer")).toMatchObject({ identity_cognition_mode: "NONE" });
      expect(await runtimeEvidence(off.taskId, "reviewer")).not.toHaveProperty("identity");
    });
    it("REQUIRED: one pinned block in the analyst system message, none for the reviewer, evidence == pin == MODEL_CALLED", async () => {
      enabled = true;
      const seenA: ModelRequest[] = [], seenR: ModelRequest[] = [];
      const r = await runMission({ analyst: spy(fakeClaude(), seenA), reviewer: spy(fakeGrok(), seenR) });
      expect(r.outcome!.status).toBe("COMPLETED");
      const pin = IdentityCognitionPin.parse(await pinOf(r.taskId));
      expect(pin).toMatchObject({ identityVersionId: KERNEL_VERSION_ROW, identityVersion: 1, identityCoreDigest: "4f6dc581f06701c207d5cdf8bc1ced59fa0741c15bab18c30537d0b17a7bf9ed",
        classADigest: "c1e3d107616db8ebf4586121d62eb2c6dd966351e2e11de3949a253ce6158dc6", mode: "REQUIRED" });
      expect(await latchOf(r.taskId)).toEqual({ mode: "REQUIRED", release_epoch: String(contractEpoch) });
      expect(countIdentityBlocks(seenA[0]!.messages[0]!.content)).toBe(1);
      expect(countIdentityBlocks(seenA[0]!.messages[1]!.content)).toBe(0);
      expect(seenA[0]!.messages[0]!.content.indexOf("Kernel faculty:")).toBe(0);
      expect(seenA[0]!.messages[0]!.content.indexOf("BEGIN KERNELJSON IDENTITY PROJECTION")).toBeLessThan(seenA[0]!.messages[0]!.content.indexOf("You are the analyst runtime"));
      expect(countIdentityBlocks(JSON.stringify(seenR))).toBe(0);
      const ev = (await runtimeEvidence(r.taskId, "analyst"))!;
      expect(ev["identity"]).toEqual(provenanceOf(pin));
      const binding = ModelCallBinding.parse((await callsOf(r.taskId))[0].payload.binding);
      expect(binding.assembly_digest).toBe(assemblyDigestOf(seenA[0]!));
      expect(ev["assembly_digest"]).toBe(binding.assembly_digest);
      expect(await runtimeEvidence(r.taskId, "reviewer")).not.toHaveProperty("identity");
    });
    it("D1 authorizes the exact provider request and binds its validated full-request receipt", async () => {
      enabled = true;
      const authorize = vi.spyOn(identity, "authorize");
      const seen: ModelRequest[] = [];
      try {
        const r = await runMission({ analyst: spy(fakeClaude(), seen) });
        expect(r.outcome!.status).toBe("COMPLETED");
        expect(authorize).toHaveBeenCalledTimes(1);
        expect(seen).toHaveLength(1);
        expect(authorize.mock.calls[0]![2]).toBe(seen[0]);
        expect(authorize.mock.calls[0]![3]).toBe(assemblyDigestOf(seen[0]!));
        const binding = ModelCallBinding.parse((await callsOf(r.taskId))[0].payload.binding);
        expect(binding.assembly_digest).toBe(authorize.mock.calls[0]![3]);
        expect(binding.request_digest).toBe(modelDigest({ provider: binding.provider, model: binding.model, request: seen[0] }));
      } finally {
        authorize.mockRestore();
      }
    });
    it("D1 refuses a receipt for another full request before recording MODEL_CALLED", async () => {
      enabled = true;
      let taskId = "";
      const inner = fakeClaude();
      await expect(runMission({ analyst: { generate: async (request) => {
        taskId = request.taskId;
        const result = await inner.generate(request);
        const other = { ...request, maxOutputTokens: request.maxOutputTokens - 1 };
        result.receipt.requestDigest = modelDigest({ provider: result.receipt.provider, model: result.receipt.model, request: other });
        return result;
      } } })).rejects.toThrow("ModelPort failed its result contract");
      expect(taskId).not.toBe("");
      expect(await callsOf(taskId)).toEqual([]);
      expect(await runtimeEvidence(taskId, "analyst")).toBeUndefined();
    });
    it("G5: two fresh missions on different fake providers preserve the full stable comparison set", async () => {
      enabled = true;
      const deepseek = new PgFacultyRegistry(pool, { ...ROUTES, analyst: { provider: "deepseek", model: "deepseek-v4-flash" } });
      const first = await runMission({ faculties: deepseek, analyst: fakeClaude({ provider: "deepseek", model: "deepseek-v4-flash" }) });
      const second = await runMission(); // config-only route change back to the OpenRouter route
      expect(first.outcome!.status).toBe("COMPLETED");
      expect(second.outcome!.status).toBe("COMPLETED");
      const { taskId: taskA, stepId: stepA, ...pinA } = IdentityCognitionPin.parse(await pinOf(first.taskId));
      const { taskId: taskB, stepId: stepB, ...pinB } = IdentityCognitionPin.parse(await pinOf(second.taskId));
      expect(taskA).not.toBe(taskB);
      expect(stepA).not.toBe(stepB);
      expect(pinA).toEqual(pinB);
      const facultyA = (await q("select pin from faculty_pins where task_id=$1 and step_id=$2", [first.taskId, first.analystStep]))[0].pin;
      const facultyB = (await q("select pin from faculty_pins where task_id=$1 and step_id=$2", [second.taskId, second.analystStep]))[0].pin;
      for (const field of ["faculty", "facultyDigest", "policyVersion", "operation", "routingReason"])
        expect(facultyA[field], field).toEqual(facultyB[field]);
      const callA = ModelCallBinding.parse((await callsOf(first.taskId))[0].payload.binding);
      const callB = ModelCallBinding.parse((await callsOf(second.taskId))[0].payload.binding);
      expect(callA.provider).not.toBe(callB.provider);
      expect(callA.model).not.toBe(callB.model);
      expect(callA.request_digest).not.toBe(callB.request_digest);
      expect(callA.assembly_digest).toBe(callB.assembly_digest);
      expect(callA.continuity_digest).toBe(callB.continuity_digest);
    });
    it("the env is read once per step: a flip, a replay, or a lost journal never relatches", async () => {
      enabled = true;
      envReads = 0;
      const s: Scenario = { journal: new Map(), seed: randomUUID(), intentId: randomUUID(), createdMs: Date.now() - 150_000 };
      const first = await runMission(s);
      expect(first.outcome!.status).toBe("COMPLETED");
      expect(envReads).toBe(1);
      enabled = false; // flip
      const replay = await runMission(s); // journal replay
      expect(replay.outcome).toEqual(first.outcome);
      expect(envReads).toBe(1);
      // Receipt DB commit succeeded but its journal acknowledgement was lost: re-record the same binding.
      const calls = await callsOf(first.taskId);
      for (const key of s.journal!.keys()) if (key.startsWith("model:") && key.endsWith(":receipt")) s.journal!.delete(key);
      expect((await runMission(s)).outcome).toEqual(first.outcome);
      expect(await callsOf(first.taskId)).toEqual(calls);
      expect(envReads).toBe(1);
      // Lost journal: the latch body re-executes, finds the DB row, and still does not read the env.
      const state = await identity.latch({ tenantId: KERNEL_TENANT, taskId: first.taskId, stepId: first.analystStep, facultyPin: await facultyPinFor(first.taskId, first.analystStep) });
      expect(state).toMatchObject({ kind: "CONTRACT", latch: { mode: "REQUIRED" } });
      expect(envReads).toBe(1);
      expect(await latchOf(first.taskId)).toEqual({ mode: "REQUIRED", release_epoch: String(contractEpoch) });
    });
    it("journal and database disagreeing fails closed before the provider is called", async () => {
      enabled = true;
      const t = await runMission({ stopBeforeMission: true });
      const f = await facultyPinFor(t.taskId, t.analystStep);
      const state = await identity.latch({ tenantId: KERNEL_TENANT, taskId: t.taskId, stepId: t.analystStep, facultyPin: f });
      expect(state.kind === "CONTRACT" && state.latch.mode).toBe("REQUIRED");
      const forged = { ...state, latch: { ...(state as Extract<typeof state, { kind: "CONTRACT" }>).latch, mode: "NONE" as const }, pin: null };
      const req = { callId: randomUUID(), taskId: t.taskId, stepId: t.analystStep, trace: { traceId: randomUUID(), correlationId: t.taskId }, messages: [{ role: "system" as const, content: "x" }], maxOutputTokens: 10 };
      await expect(identity.authorize(forged, f, req, assemblyDigestOf(req))).rejects.toThrow("IDENTITY_JOURNAL_DB_MISMATCH");
      await expect(identity.authorize({ kind: "LEGACY", taskId: t.taskId, stepId: t.analystStep, releaseEpoch: contractEpoch }, f, req, assemblyDigestOf(req))).rejects.toThrow("IDENTITY_JOURNAL_DB_MISMATCH");
      await expect(identity.authorize(state, f, req, "0".repeat(64))).rejects.toThrow("IDENTITY_ASSEMBLY_MISMATCH");
      // And through the mission: a journaled NONE against a DB REQUIRED never reaches the provider.
      let called = false;
      const s: Scenario = { journal: new Map(), seed: randomUUID(), intentId: randomUUID(), createdMs: Date.now() - 140_000, analyst: { generate: async () => { called = true; throw new Error("must not run"); } } };
      const prep = await runMission({ ...s, stopBeforeMission: true });
      const pinned = await identity.latch({ tenantId: KERNEL_TENANT, taskId: prep.taskId, stepId: prep.analystStep, facultyPin: await facultyPinFor(prep.taskId, prep.analystStep) });
      s.journal!.set(`identity:${prep.analystStep}:latch`, { state: { ...pinned, latch: { ...(pinned as Extract<typeof pinned, { kind: "CONTRACT" }>).latch, mode: "NONE" }, pin: null }, error: null });
      const r = await runMission(s);
      expect(r.outcome!.status).toBe("FAILED");
      expect(r.outcome!.summary).toContain("REQUEST_REJECTED");
      expect(called).toBe(false);
    });
    it("completion refuses a contract task with no latch, and evidence that differs from the MODEL_CALLED binding", async () => {
      expect((await runMission({ identity: null })).outcome!.summary).toBe("Persisted completion verification failed");
      for (const field of ["assembly_digest", "continuity_digest", "request_digest", "call_id"]) {
        enabled = false;
        const value = field === "call_id" ? randomUUID() : "0".repeat(64);
        const r = await runMission({ mutateCognitionEvidence: { [field]: value } });
        expect(r.outcome!.summary, field).toBe("Persisted completion verification failed");
      }
    });
    it("no prompt, message or memory text is durable: MODEL_CALLED and evidence carry digests only", async () => {
      enabled = true;
      const marker = `memory-marker-${randomUUID()}`;
      const memory: MissionMemoryPort = { assemble: async () => ({ status: "ASSEMBLED", assemblyId: randomUUID(), digest: "e".repeat(64),
        text: `OPERATOR MEMORY (canonical KernelJSON memory)\n- [PREFERENCE] ${marker}`, memories: [], externalCount: 0, usedTokens: 10 }) };
      const seen: ModelRequest[] = [];
      const r = await runMission({ memory, analyst: spy(fakeClaude(), seen) });
      expect(r.outcome!.status).toBe("COMPLETED");
      expect(JSON.stringify(seen)).toContain(marker); // the model was given it...
      const durable = JSON.stringify([...(await q("select payload from task_events where task_id=$1", [r.taskId])), ...(await q("select metadata from evidence where task_id=$1", [r.taskId]))]);
      expect(durable).not.toContain(marker); // ...and nothing immutable holds it, so a P5 retraction needs no mutation here
      expect(durable).not.toContain("You are the analyst runtime");
      expect(durable).not.toContain("BEGIN KERNELJSON IDENTITY PROJECTION");
      const binding = (await callsOf(r.taskId))[0].payload.binding;
      expect(Object.keys(binding).sort()).toEqual(["assembly_digest", "call_id", "continuity_digest", "contract", "identity_cognition_mode", "model", "provider", "request_digest", "status", "step_id", "task_id"]);
    });
    it("P5 retraction removes memory from new requests without changing immutable call evidence", async () => {
      enabled = true;
      const memory = new CanonicalMemory(pool);
      const owner = { tenantId: KERNEL_TENANT, principal };
      const content = `Prefer concise repository risk summaries ${randomUUID()}`;
      const submission = {
        idempotencyKey: randomUUID(), class: "PREFERENCE", content,
        subject: { kind: "PRINCIPAL", ref: principal.id },
        evidence: [{ type: "TELEGRAM_UPDATE", ref: `update:${randomUUID()}` }],
        reason: "operator asked to remember",
      };
      const promoted = await memory.submitOperatorInstruction(owner, submission);
      expect(promoted.state).toBe("PROMOTED");
      const port = createMissionMemoryPort(memory);
      const before: ModelRequest[] = [];
      const first = await runMission({ memory: port, analyst: spy(fakeClaude(), before) });
      expect(first.outcome!.status).toBe("COMPLETED");
      expect(JSON.stringify(before)).toContain(content);
      const calls = await callsOf(first.taskId);
      const evidence = await runtimeEvidence(first.taskId, "analyst");
      expect(JSON.stringify([calls, evidence])).not.toContain(content);
      const retracted = await memory.submitOperatorInstruction(owner, {
        ...submission, idempotencyKey: randomUUID(), intent: "RETRACT", targetMemoryId: promoted.memoryId,
        content: "", reason: "operator asked to forget",
      });
      expect(retracted).toMatchObject({ state: "PROMOTED", version: 2 });
      expect((await memory.find(owner, promoted.memoryId!))?.status).toBe("RETRACTED");
      const after: ModelRequest[] = [];
      const second = await runMission({ memory: port, analyst: spy(fakeClaude(), after) });
      expect(second.outcome!.status).toBe("COMPLETED");
      expect(JSON.stringify(after)).not.toContain(content);
      expect(await callsOf(first.taskId)).toEqual(calls);
      expect(await runtimeEvidence(first.taskId, "analyst")).toEqual(evidence);
    });
    it("health reads the real database: parity, bound REQUIRED runs, isolation", async () => {
      const snap = await fetchIdentityCognition(pool);
      expect(snap).toMatchObject({ digestParityFailures: [], tenantsWithMultipleCurrent: [], headCurrentMismatches: [], contractActive: true, unboundRequired: [], isolationViolations: [] });
      expect((snap as { requiredLatches: number }).requiredLatches).toBeGreaterThan(0);
    });
    it("over the 16 KiB cap fails before the provider is called and leaves no latch", async () => {
      enabled = true;
      const big = { ...structuredClone(KERNEL_V1), id: randomUUID(), tenantId: randomUUID() };
      big.sections.classA.constitution = "é".repeat(4000);
      big.sections.classA.operatorRelationship = "€".repeat(3000);
      await pool.query("insert into tenants(id,name) values($1,'big')", [big.tenantId]);
      await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')", [big.tenantId, principal.id]);
      for (const f of coreTeamTemplates(big.tenantId, "test:p7b"))
        await pool.query("insert into faculty_versions(tenant_id,faculty_id,version,definition,digest) values($1,$2,$3,$4,$5)", [big.tenantId, f.id, f.version, f, capabilityDigest(f)]);
      await seedIdentity(pool, big);
      let called = false;
      const r = await runMission({ tenant: big.tenantId, analyst: { generate: async () => { called = true; throw new Error("must not run"); } } });
      expect(r.outcome!.status).toBe("FAILED");
      expect(r.outcome!.summary).toContain("IDENTITY_PROJECTION_TOO_LARGE");
      expect(called).toBe(false);
      expect(await latchOf(r.taskId)).toBeUndefined();
    });
    it("Kernel v2 activating mid-mission never alters a pinned v1; new work pins v2", async () => {
      enabled = true;
      const t = await runMission({ stopBeforeMission: true });
      const f = await facultyPinFor(t.taskId, t.analystStep);
      const pinned = await identity.latch({ tenantId: KERNEL_TENANT, taskId: t.taskId, stepId: t.analystStep, facultyPin: f });
      const v2 = { ...structuredClone(KERNEL_V1), version: 2 };
      v2.sections.classC.persona += " Version two.";
      await seedIdentity(pool, v2, { profile: false });
      const pin = (pinned as Extract<typeof pinned, { kind: "CONTRACT" }>).pin!;
      expect(pin.identityVersion).toBe(1);
      const { renderIdentityBlock } = await import("../services/kernel/src/identity/projection.js");
      const req = { callId: randomUUID(), taskId: t.taskId, stepId: t.analystStep, trace: { traceId: randomUUID(), correlationId: t.taskId },
        messages: [{ role: "system" as const, content: renderIdentityBlock(pin.projection, pin.projectionDigest) + "analyst" }], maxOutputTokens: 10 };
      await expect(identity.authorize(pinned, f, req, assemblyDigestOf(req))).resolves.toBeUndefined();
      // A block that is not byte-for-byte the pinned one is refused, even with a matching assembly digest.
      const tampered = { ...req, messages: [{ role: "system" as const, content: req.messages[0]!.content.replace("Kernel", "Kernal") }] };
      await expect(identity.authorize(pinned, f, tampered, assemblyDigestOf(tampered))).rejects.toThrow("IDENTITY_BLOCK_MISMATCH");
      const noBlock = { ...req, messages: [{ role: "system" as const, content: "analyst" }] };
      await expect(identity.authorize(pinned, f, noBlock, assemblyDigestOf(noBlock))).rejects.toThrow("IDENTITY_BLOCK_MISMATCH");
      const next = await runMission({});
      expect(next.outcome!.status).toBe("COMPLETED");
      expect(IdentityCognitionPin.parse(await pinOf(next.taskId)).identityVersion).toBe(2);
    });
    it("a corrupt or unavailable pinned version fails closed (the latest HEAD is never substituted)", async () => {
      enabled = true;
      const t = await runMission({ stopBeforeMission: true });
      const f = await facultyPinFor(t.taskId, t.analystStep);
      const pinned = await identity.latch({ tenantId: KERNEL_TENANT, taskId: t.taskId, stepId: t.analystStep, facultyPin: f });
      const pin = (pinned as Extract<typeof pinned, { kind: "CONTRACT" }>).pin!;
      const { renderIdentityBlock } = await import("../services/kernel/src/identity/projection.js");
      const req = { callId: randomUUID(), taskId: t.taskId, stepId: t.analystStep, trace: { traceId: randomUUID(), correlationId: t.taskId },
        messages: [{ role: "system" as const, content: renderIdentityBlock(pin.projection, pin.projectionDigest) + "analyst" }], maxOutputTokens: 10 };
      const corrupt = async (sql: string, args: unknown[]) => {
        const c = await pool.connect();
        try { await c.query("begin"); await c.query("set local session_replication_role = replica"); await c.query(sql, args); await c.query("commit"); } finally { c.release(); }
      };
      const versionRow = pin.identityVersionId;
      await corrupt("update public.identity_versions set document = jsonb_set(document, '{sections,classC,persona}', '\"corrupted\"') where id=$1", [versionRow]);
      try {
        await expect(identity.authorize(pinned, f, req, assemblyDigestOf(req))).rejects.toThrow("IDENTITY_DIGEST_MISMATCH");
      } finally {
        await corrupt("update public.identity_versions set document = $2 where id=$1", [versionRow, pin.identityVersion === 1 ? KERNEL_V1 : { ...KERNEL_V1, version: 2 }]);
      }
    });
  });
});
