import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { ADMIN, INGRESS, compose, until, useStackDatabase } from "./support/local.js";
import { testDatabase, type TestDatabase } from "./support/database.js";
import { principal } from "../evals/fixtures/contracts.js";
import { MISSION_RECIPE, type IdentityDocument } from "../packages/contracts/src/index.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { coreTeamTemplates } from "../services/kernel/src/faculty/templates.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";
import { identityCoreDigestV1 } from "../services/kernel/src/identity/canonical.js";
import { REPO } from "./support/mission-fixture.js";

// Real production KernelWorkflowV1 + real Restate 1.7.9 journal + real Postgres. Only provider/GitHub I/O is fake.
// ADR-0023 27.12.15: the plan database kj_identity_cognition_restate; the stack's worker connects to it (kj_worker in stage T, the owner in
// lane A). This file never creates, migrates or drops a database.
let database: TestDatabase;
let pool: pg.Pool;
const corpus = JSON.parse(readFileSync("tests/fixtures/identity-core-v1.vectors.json", "utf8")) as {
  vectors: Array<{ name: string; inputJson: string }>;
};
const identity = JSON.parse(corpus.vectors.find(v => v.name === "kernel-v1-activated")!.inputJson) as IdentityDocument;

beforeAll(async () => {
  compose("down", "--volumes");
  database = await testDatabase("kj_identity_cognition_restate");
  pool = new pg.Pool({ connectionString: database.url });
  useStackDatabase(database.name);
  compose("up", "-d", "--build");
  await until(() => pool.query("select 1"), r => r.rowCount === 1);
  await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [principal.id]);
  await pool.query("insert into tenants(id,name) values($1,'cognition-restate')", [identity.tenantId]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')", [identity.tenantId, principal.id]);
  for (const f of coreTeamTemplates(identity.tenantId, "test:p7b-restate"))
    await pool.query("insert into faculty_versions(tenant_id,faculty_id,version,definition,digest) values($1,$2,$3,$4,$5)",
      [identity.tenantId, f.id, f.version, f, capabilityDigest(f)]);

  // Fixture seeding only, in this disposable local database. P7A's real bootstrap is covered separately.
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role=replica");
    await db.query("insert into identity_profiles(id,tenant_id,owner_principal_id,name) values($1,$2,$3,'Kernel')", [identity.id, identity.tenantId, principal.id]);
    const candidate = randomUUID();
    const { version: _version, ...draft } = identity;
    await db.query(`insert into identity_candidates(id,identity_id,tenant_id,document,proposed_digest,origin,governance_class,state,base_version,base_identity_core_digest)
      values($1,$2,$3,$4,$5,'MODEL_PROPOSAL','C','HELD',1,$5)`, [candidate, identity.id, identity.tenantId, draft, identityCoreDigestV1(draft)]);
    await db.query(`insert into identity_versions(id,identity_id,tenant_id,version,document,identity_core_digest,class_a_digest,governance_class,candidate_id,created_by_task)
      values($1,$2,$3,1,$4,$5,$6,'C',$7,$8)`, [randomUUID(), identity.id, identity.tenantId, identity,
      identityCoreDigestV1(identity), identityCoreDigestV1(identity.sections.classA), candidate, randomUUID()]);
    await db.query(`insert into identity_activations(id,identity_id,tenant_id,version,governance_class,candidate_id,request_task_id)
      values($1,$2,$3,1,'C',$4,$5)`, [randomUUID(), identity.id, identity.tenantId, candidate, randomUUID()]);
    await db.query("commit");
  } catch (error) { await db.query("rollback"); throw error; }
  finally { db.release(); }
  await until(() => fetch(`${ADMIN}/health`), r => r.ok);
  const registration = await until(() => fetch(`${ADMIN}/deployments`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri: "http://worker:9080", force: true }),
  }), r => r.ok);
  expect(registration.ok, await registration.text()).toBe(true);
}, 300000);
afterAll(async () => { await pool?.end(); await database?.close(); });

async function submit() {
  const body = { recipe: MISSION_RECIPE, intent: {
    id: randomUUID(), principal, tenant: { id: identity.tenantId }, source: "test",
    objective: `${REPO} What are the biggest risks?`, attachments: [], contextRefs: [],
    receivedAt: new Date(Date.now() - 1000).toISOString(), trace: { traceId: randomUUID(), correlationId: randomUUID() },
  } };
  const { task } = compileIntent(body);
  const r = await fetch(`${INGRESS}/KernelWorkflowV1/${task.id}/run/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  expect(r.ok, await r.text()).toBe(true);
  return { taskId: task.id };
}
async function completed(taskId: string) {
  const r = await fetch(`${INGRESS}/restate/workflow/KernelWorkflowV1/${taskId}/attach`, { signal: AbortSignal.timeout(60000) });
  expect(r.ok, await r.clone().text()).toBe(true);
  expect(await r.json()).toMatchObject({ status: "COMPLETED" });
  expect((await pool.query("select status from tasks where id=$1", [taskId])).rows).toEqual([{ status: "COMPLETED" }]);
}
function calls(taskId: string): Array<{ role: string; assemblyDigest: string }> {
  return compose("exec", "-T", "worker", "cat", "/tmp/kerneljson-cognition-calls.jsonl")
    .trim().split("\n").map(line => JSON.parse(line)).filter(row => row.taskId === taskId)
    .map(row => ({ role: row.role, assemblyDigest: row.assemblyDigest }));
}
async function assertContract(taskId: string, mode: "NONE" | "REQUIRED") {
  expect((await pool.query("select mode from kernel_private.identity_cognition_latches where task_id=$1", [taskId])).rows).toEqual([{ mode }]);
  expect((await pool.query("select pin from identity_pins where task_id=$1", [taskId])).rows).toHaveLength(mode === "REQUIRED" ? 1 : 0);
  const events = (await pool.query("select payload from task_events where task_id=$1 and type='MODEL_CALLED'", [taskId])).rows;
  expect(events).toHaveLength(1);
  expect(events[0].payload.binding).toMatchObject({ identity_cognition_mode: mode, status: "SUCCEEDED" });
  expect(events[0].payload.binding.assembly_digest).toBe(calls(taskId).find(c => c.role === "analyst")!.assemblyDigest);
  const evidence = (await pool.query("select source,metadata from evidence where task_id=$1 and source like 'kerneljson:runtime/%'", [taskId])).rows;
  expect(evidence).toHaveLength(2);
  expect(evidence.find(e => e.source.endsWith("analyst"))!.metadata.assembly_digest).toBe(events[0].payload.binding.assembly_digest);
  expect(evidence.find(e => e.source.endsWith("analyst"))!.metadata.identity).toEqual(mode === "NONE" ? null : expect.objectContaining({ identity_id: identity.id, identity_version: 1 }));
  const reviewer = evidence.find(e => e.source.endsWith("reviewer"))!.metadata;
  expect(reviewer).toMatchObject({ identity_cognition_mode: "NONE" });
  expect(reviewer).not.toHaveProperty("identity");
  expect(calls(taskId).map(c => c.role).sort()).toEqual(["analyst", "reviewer"]);
}
async function restartAfterCrash() {
  await until(async () => compose("ps", "-a", "--format", "{{.State}}", "worker").trim(), state => state === "exited");
  compose("start", "worker");
}

it("real Restate preserves legacy/OFF request bytes and emits the contract NONE binding", async () => {
  const legacy = await submit();
  await completed(legacy.taskId);
  expect((await pool.query("select * from kernel_private.identity_cognition_latches where task_id=$1", [legacy.taskId])).rows).toHaveLength(0);
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select kernel_private.activate_release($1,$2,0,$3)", [randomUUID(), process.env["KERNELJSON_RELEASE_ID"] ?? "unreleased-development", { test: "restate" }]);
    await db.query("insert into kernel_private.identity_cognition_contract_v1(contract,first_release_epoch) values('kerneljson:identity-cognition/v1',1)");
    await db.query("commit");
  } catch (error) { await db.query("rollback"); throw error; }
  finally { db.release(); }
  const off = await submit();
  await completed(off.taskId);
  await assertContract(off.taskId, "NONE");
  expect(calls(off.taskId)).toEqual(calls(legacy.taskId));
});

it("a committed REQUIRED latch survives a real worker crash before journal acknowledgement and an OFF flip", async () => {
  compose("exec", "-T", "worker", "touch", "/tmp/kerneljson-cognition-enabled", "/tmp/kerneljson-cognition-latch-crash");
  const mission = await submit();
  await restartAfterCrash();
  await completed(mission.taskId);
  await assertContract(mission.taskId, "REQUIRED");
  expect(compose("exec", "-T", "worker", "sh", "-c", "test ! -e /tmp/kerneljson-cognition-enabled && printf OFF")).toBe("OFF");
});

it("a MODEL_CALLED commit survives a real receipt-journal crash with one binding and no repeated provider call", async () => {
  compose("exec", "-T", "worker", "touch", "/tmp/kerneljson-cognition-enabled", "/tmp/kerneljson-cognition-receipt-crash");
  const mission = await submit();
  await restartAfterCrash();
  // The record was committed before the process exited; restart must acknowledge the same record.
  expect((await pool.query("select id from task_events where task_id=$1 and type='MODEL_CALLED'", [mission.taskId])).rows).toHaveLength(1);
  await completed(mission.taskId);
  await assertContract(mission.taskId, "REQUIRED");
  // Re-attach to the completed invocation; never attempt to mint a second workflow with this key.
  await completed(mission.taskId);
  await assertContract(mission.taskId, "REQUIRED");
});
