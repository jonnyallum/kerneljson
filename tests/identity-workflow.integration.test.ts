import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ADMIN, DATABASE, INGRESS, compose, holdRuntime, migrate, until } from "./support/local.js";
import { policyOwner, policyReviewer } from "./support/golden-probe.js";
import { secondHuman } from "./support/identity-probe.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { fetchIdentityOrphans, fetchIncompleteBootstraps } from "../services/kernel/src/health/collect.js";
import { IDENTITY_CHANGE_RECIPE } from "../packages/contracts/src/index.js";

/**
 * KJ-P7A - IdentityChangeWorkflowV1 end to end, through a real Restate durable execution (not the
 * raw-DB trigger tests in tests/identity-migration.integration.test.ts, and not a mock). This is the
 * only place the workflow's own ctx.run/ctx.promise sequencing, event emission and refusal handling
 * are actually exercised by running the code. Mirrors tests/recovery.test.ts's golden-workflow shape.
 *
 * Every refusal below waits for the invocation to actually finish (Restate `attach`) and then asserts
 * the canonical end state - never a fixed sleep, and never a task left RECEIVED/COMPILED/VERIFYING.
 */
const pool = new pg.Pool({ connectionString: DATABASE });
const NON_TERMINAL = ["RECEIVED", "COMPILED", "READY", "RUNNING", "WAITING", "APPROVAL_REQUIRED", "VERIFYING"];

function classA(overrides: Record<string, unknown> = {}) {
  return {
    name: "Jai",
    constitution: "Serve the operator honestly and rigorously.",
    values: ["rigour"],
    operatorRelationship: "Reports to the operator.",
    facultyFraming: "Frames whichever faculty the kernel selected.",
    memoryPolicy: "May narrow canonical memory, never widen it.",
    ...overrides,
  };
}
function classC(persona = "warm, direct") {
  return { persona, communication: "plain", behaviour: "cautious", presentation: "concise" };
}
function doc(id: string, tenantId: string, sections: Record<string, unknown> = {}) {
  return {
    id,
    tenantId,
    sections: {
      classA: classA(),
      classC: classC(),
      classD: { objectives: ["ship KJ-P7"], vision: "A trustworthy operator partner." },
      ...sections,
    },
  };
}
type Actor = "test-owner" | "test-reviewer" | "test-second-human";
const principalOf: Record<Actor, string> = { "test-owner": policyOwner, "test-reviewer": policyReviewer, "test-second-human": secondHuman };
function submission(intentId: string, objective: unknown, actor: Actor) {
  return {
    recipe: IDENTITY_CHANGE_RECIPE,
    intent: {
      id: intentId,
      principal: { id: principalOf[actor], kind: "HUMAN" as const },
      tenant: { id: policyOwner },
      source: "kerneljson:test/v1",
      objective: JSON.stringify(objective),
      attachments: [],
      contextRefs: [],
      receivedAt: new Date().toISOString(),
      trace: { traceId: randomUUID(), correlationId: randomUUID() },
    },
  };
}
async function send(taskId: string, handler: string, body: unknown, actor: Actor = "test-owner") {
  return fetch(`${INGRESS}/IdentityChangeWorkflowV1/${taskId}/${handler}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${actor}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
/** Blocks until the workflow invocation has finished, successfully or not, and returns its result. */
async function finished(taskId: string): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(`${INGRESS}/restate/workflow/IdentityChangeWorkflowV1/${taskId}/attach`, { signal: AbortSignal.timeout(60000) });
  return { ok: response.ok, status: response.status, body: await response.text() };
}
async function taskStatus(taskId: string): Promise<string | undefined> {
  return (await pool.query<{ status: string }>("select status from tasks where id=$1", [taskId])).rows[0]?.status;
}
async function status(taskId: string, expected: string): Promise<void> {
  await until(() => taskStatus(taskId), (s) => s === expected, 60000);
}
/** Answers the task's pending approval as the named HUMAN approver, via the real signed-control path. */
async function answer(taskId: string, decision: "GRANTED" | "DENIED") {
  const events = await pool.query<{ payload: { evaluation: { scopeDigest: string } } }>("select payload from task_events where task_id=$1 and event_key=$2", [taskId, `policy-approval:${taskId}`]);
  const response = await send(taskId, "approve", { scopeDigest: events.rows[0]!.payload.evaluation.scopeDigest, decision }, "test-reviewer");
  expect(response.ok, await response.text()).toBe(true);
}
async function submit(objective: unknown, actor: Actor = "test-owner") {
  const body = submission(randomUUID(), objective, actor);
  const { task } = compileIntent(body);
  const response = await send(task.id, "run/send", body, actor);
  expect(response.ok, await response.text()).toBe(true);
  return task;
}
async function count(sql: string, params: unknown[] = []): Promise<number> {
  return (await pool.query<{ n: number }>(sql, params)).rows[0]!.n;
}
const candidatesOf = (identityId: string) => count("select count(*)::int as n from identity_candidates where identity_id=$1", [identityId]);
const versionsOf = (identityId: string) => count("select count(*)::int as n from identity_versions where identity_id=$1", [identityId]);
async function currentVersion(identityId: string): Promise<number> {
  return (await pool.query<{ version: number }>("select version from identity_current where identity_id=$1", [identityId])).rows[0]!.version;
}
/** One owner Class C change built from the CURRENT head (so Class A is byte-identical and the
 *  database classifies it C, never A), used to move the head forward. */
async function ownerChange(identityId: string, persona: string) {
  const head = await pool.query<{ document: { sections: Record<string, unknown> } & Record<string, unknown> }>("select document from identity_current where identity_id=$1", [identityId]);
  const { version: _drop, ...current } = head.rows[0]!.document;
  const document = { ...current, sections: { ...current.sections, classC: classC(persona) } };
  const task = await submit({ kind: "PROPOSE", document, reason: persona });
  return { task, result: await finished(task.id) };
}

let releaseRuntime = () => {};
beforeAll(async () => {
  releaseRuntime = holdRuntime();
  compose("down", "--volumes");
  compose("up", "-d", "--build");
  await until(() => pool.query("select 1"), (r) => r.rowCount === 1);
  await migrate(pool);
  await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [policyOwner]);
  await pool.query("insert into tenants(id,name) values($1,'identity-e2e')", [policyOwner]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$1,'owner')", [policyOwner]);
  await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [policyReviewer]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'reviewer')", [policyOwner, policyReviewer]);
  // 'member' may submit tasks (packages/identity permissions.submit) - so any refusal below is the
  // identity owner rule, not a missing submit permission.
  await pool.query("insert into principals(id,kind) values($1,'HUMAN')", [secondHuman]);
  await pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'member')", [policyOwner, secondHuman]);
  await until(() => fetch(`${ADMIN}/health`), (r) => r.ok);
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

// identity_profiles.tenant_id is UNIQUE (ADR-0021 D6: one tenant -> one identity), and the test
// policy rule (identity-probe.ts) is pinned to one tenant (policyOwner) so the approval-required
// path has a matching rule to find. Both mean this whole file shares ONE identity across its tests,
// in file order, the same way tests/recovery.test.ts's tests build on each other's DB state.
let identityId: string;

it("an interrupted bootstrap ends its task FAILED, is surfaced by health, and the owner's next bootstrap recovers the same profile (findings 2, 3)", async () => {
  identityId = randomUUID();
  // The interruption: refuse the first BOOTSTRAP candidate once, AFTER the workflow has committed the
  // profile - exactly the state a bootstrap refused or crashed part-way leaves behind.
  await pool.query("create table public.p7a_refuse_candidate(identity_id uuid primary key)");
  await pool.query(
    // KJ-P8 B1: test sabotage reads a test-only table, so it runs with the owner's rights, not kj_worker's.
    "create function public.p7a_refuse_candidate() returns trigger language plpgsql security definer set search_path = '' as $f$ begin " +
      "if exists (select 1 from public.p7a_refuse_candidate where identity_id = new.identity_id) then " +
      "raise exception 'simulated bootstrap interruption' using errcode = '23514'; end if; return new; end $f$",
  );
  await pool.query("create trigger p7a_refuse_candidate before insert on public.identity_candidates for each row execute function public.p7a_refuse_candidate()");
  try {
    await pool.query("insert into public.p7a_refuse_candidate(identity_id) values($1)", [identityId]);
    const interrupted = await submit({ kind: "PROPOSE", document: doc(identityId, policyOwner), reason: "bootstrap" });
    await finished(interrupted.id);
    expect(await taskStatus(interrupted.id)).toBe("FAILED"); // canonical terminal state, not a zombie
    expect(await count("select count(*)::int as n from identity_profiles where id=$1", [identityId])).toBe(1);
    expect(await versionsOf(identityId)).toBe(0);
    const later = new Date(Date.now() + 60 * 60_000);
    expect((await fetchIncompleteBootstraps(pool, later)).map((r) => r.identityId)).toContain(identityId);
  } finally {
    await pool.query("drop trigger if exists p7a_refuse_candidate on public.identity_candidates");
    await pool.query("drop function if exists public.p7a_refuse_candidate()");
    await pool.query("drop table if exists public.p7a_refuse_candidate");
  }

}, 120000);

it("a resumed bootstrap goes through policy to APPROVAL_REQUIRED under IDENTITY_APPLY_BOOTSTRAP; DENY ends it FAILED with no version, profile kept for the owner", async () => {
  // Bootstrap is chosen by "no head", not "no profile": the interrupted profile is resumed, never duplicated.
  const denied = await submit({ kind: "PROPOSE", document: doc(identityId, policyOwner), reason: "bootstrap, resumed then denied" });
  await status(denied.id, "APPROVAL_REQUIRED");
  const gate = await pool.query<{ capability: string; decision: string }>(
    "select payload->'invocation'->'capability'->>'id' as capability, payload->'evaluation'->'decision'->>'decision' as decision from task_events where task_id=$1 and type='POLICY_CHECKED'",
    [denied.id],
  );
  expect(gate.rows).toEqual([{ capability: "70000000-0000-4000-8000-000000000005", decision: "APPROVAL_REQUIRED" }]);
  await answer(denied.id, "DENIED");
  await status(denied.id, "FAILED");
  expect(await versionsOf(identityId)).toBe(0);
  expect(await count("select count(*)::int as n from identity_activations where identity_id=$1", [identityId])).toBe(0);
  const candidate = await pool.query("select state from identity_candidates where proposed_by_task=$1", [denied.id]);
  expect(candidate.rows[0].state).toBe("REJECTED");
  expect(await count("select count(*)::int as n from identity_profiles where tenant_id=$1", [policyOwner])).toBe(1);
  expect((await fetchIncompleteBootstraps(pool, new Date(Date.now() + 60 * 60_000))).map((r) => r.identityId)).toContain(identityId);
}, 120000);

it("the same owner resumes it again: APPROVAL_REQUIRED -> GRANTED -> exactly one v1 activation, carrying the approval, and the task COMPLETED", async () => {
  const granted = await submit({ kind: "PROPOSE", document: doc(identityId, policyOwner), reason: "bootstrap, resumed and granted" });
  await status(granted.id, "APPROVAL_REQUIRED");
  await answer(granted.id, "GRANTED");
  const result = await finished(granted.id);
  expect(result.ok, result.body).toBe(true);
  expect(await taskStatus(granted.id)).toBe("COMPLETED");
  const activations = await pool.query("select version, governance_class, approval_id, request_task_id from identity_activations where identity_id=$1", [identityId]);
  expect(activations.rows).toEqual([{ version: 1, governance_class: "BOOTSTRAP", approval_id: granted.id, request_task_id: granted.id }]);
  expect(await currentVersion(identityId)).toBe(1);
  expect(await count("select count(*)::int as n from identity_profiles where tenant_id=$1", [policyOwner])).toBe(1);
  const profile = await pool.query("select owner_principal_id from identity_profiles where id=$1", [identityId]);
  expect(profile.rows[0].owner_principal_id).toBe(policyOwner);
  expect((await fetchIncompleteBootstraps(pool, new Date(Date.now() + 60 * 60_000))).map((r) => r.identityId)).not.toContain(identityId);
}, 120000);

it("a second bootstrap is refused once the identity exists: another document id never creates a task, a candidate or a profile", async () => {
  const priorCandidates = await candidatesOf(identityId);
  const second = await submit({ kind: "PROPOSE", document: doc(randomUUID(), policyOwner), reason: "a second bootstrap" });
  const result = await finished(second.id);
  expect(result.ok).toBe(false);
  expect(await taskStatus(second.id)).toBeUndefined();
  expect(await candidatesOf(identityId)).toBe(priorCandidates);
  expect(await count("select count(*)::int as n from identity_profiles where tenant_id=$1", [policyOwner])).toBe(1);
}, 60000);

it("ADR-0021 D7: right after bootstrap, Class C/D is frozen by DEFAULT - an owner's Class C change ends FAILED with no freeze call ever made", async () => {
  const state = await count("select count(*)::int as n from kernel_private.identity_governance_state where identity_id=$1", [identityId]);
  expect(state).toBe(0); // nobody called set_identity_freeze
  const priorVersions = await versionsOf(identityId);
  const { task, result } = await ownerChange(identityId, "right after bootstrap");
  expect(result.ok, result.body).toBe(true);
  expect(result.body).toContain("frozen");
  expect(await taskStatus(task.id)).toBe("FAILED");
  expect(await versionsOf(identityId)).toBe(priorVersions);
  // Deployment authority opens the window, as it would for P7B G13. Every C/D test below relies on it.
  await pool.query("select kernel_private.set_identity_freeze($1,false,'P7A E2E: P7B G13 window opened')", [identityId]);
}, 90000);

it("a Class A change waits for approval, then activates once granted - completion and activation land together", async () => {
  const changed = doc(identityId, policyOwner, { classA: classA({ constitution: "Serve the operator honestly, rigorously, and with a new clause." }) });
  const task = await submit({ kind: "PROPOSE", document: changed, reason: "constitutional update" });
  await status(task.id, "APPROVAL_REQUIRED");

  const events = await pool.query<{ payload: { evaluation: { scopeDigest: string } } }>(
    "select payload from task_events where task_id=$1 and event_key=$2",
    [task.id, `policy-approval:${task.id}`],
  );
  const scopeDigest = events.rows[0]!.payload.evaluation.scopeDigest;
  const approved = await send(task.id, "approve", { scopeDigest, decision: "GRANTED" }, "test-reviewer");
  expect(approved.ok, await approved.text()).toBe(true);
  await status(task.id, "COMPLETED");
  // One transaction: once the task reads COMPLETED, its activation is already visible - no polling.
  const activations = await pool.query<{ governance_class: string; approval_id: string | null; version: number }>(
    "select governance_class, approval_id, version from identity_activations where identity_id=$1 order by seq",
    [identityId],
  );
  expect(activations.rows.map((r) => r.governance_class)).toEqual(["BOOTSTRAP", "A"]);
  expect(activations.rows[0]!.approval_id).not.toBeNull(); // BOOTSTRAP is approval-gated too
  expect(activations.rows[1]!.approval_id).not.toBeNull();
  expect(activations.rows[1]!.version).toBe(2);
  expect(await currentVersion(identityId)).toBe(2);
}, 90000);

it("rejects a Class A change when the approver denies", async () => {
  const before = await currentVersion(identityId);
  const changed = doc(identityId, policyOwner, { classA: classA({ constitution: "A rejected constitutional change." }) });
  const task = await submit({ kind: "PROPOSE", document: changed, reason: "should be denied" });
  await status(task.id, "APPROVAL_REQUIRED");

  const events = await pool.query<{ payload: { evaluation: { scopeDigest: string } } }>(
    "select payload from task_events where task_id=$1 and event_key=$2",
    [task.id, `policy-approval:${task.id}`],
  );
  const scopeDigest = events.rows[0]!.payload.evaluation.scopeDigest;
  const denied = await send(task.id, "approve", { scopeDigest, decision: "DENIED" }, "test-reviewer");
  expect(denied.ok, await denied.text()).toBe(true);
  await status(task.id, "FAILED");
  expect(await currentVersion(identityId)).toBe(before);
  const candidate = await pool.query("select state from identity_candidates where identity_id=$1 order by created_at desc limit 1", [identityId]);
  expect(candidate.rows[0].state).toBe("REJECTED");
}, 90000);

it("refuses secret-shaped content before any task or candidate exists - nothing is left RECEIVED (finding 2)", async () => {
  const priorCandidates = await candidatesOf(identityId);
  const withSecret = doc(identityId, policyOwner, { classD: { objectives: ["ship KJ-P7", "rotate sk-abcdefghijklmnopqrstuvwxyz0123456789"], vision: "trustworthy" } });
  const task = await submit({ kind: "PROPOSE", document: withSecret, reason: "should be refused before any write" });
  const result = await finished(task.id);
  expect(result.ok).toBe(false);
  expect(result.body).toContain("looks like a credential");
  expect(await taskStatus(task.id)).toBeUndefined();
  expect(await candidatesOf(identityId)).toBe(priorCandidates);
}, 60000);

it("a ROLLBACK to a version that does not exist is refused before any task exists (finding 2)", async () => {
  const task = await submit({ kind: "ROLLBACK", toVersion: 99, reason: "no such version" });
  const result = await finished(task.id);
  expect(result.ok).toBe(false);
  expect(await taskStatus(task.id)).toBeUndefined();
}, 60000);

it("a refusal discovered after the task exists (a document identical to the head) ends the task FAILED (finding 2)", async () => {
  const head = await pool.query<{ document: Record<string, unknown> }>("select document from identity_current where identity_id=$1", [identityId]);
  const { version: _drop, ...identical } = head.rows[0]!.document;
  const priorCandidates = await candidatesOf(identityId);
  const task = await submit({ kind: "PROPOSE", document: identical, reason: "nothing to change" });
  const result = await finished(task.id);
  expect(result.ok, result.body).toBe(true); // the workflow ended deliberately, with the task FAILED
  expect(await taskStatus(task.id)).toBe("FAILED");
  expect(await candidatesOf(identityId)).toBe(priorCandidates);
}, 60000);

it("only the identity's owner may change it: a second ACTIVE HUMAN member is refused before any task or candidate; the owner is not (finding 4)", async () => {
  const priorCandidates = await candidatesOf(identityId),
    priorVersions = await versionsOf(identityId);
  const intruder = await submit({ kind: "PROPOSE", document: doc(identityId, policyOwner, { classC: classC("hijacked persona") }), reason: "not mine" }, "test-second-human");
  const refused = await finished(intruder.id);
  expect(refused.ok).toBe(false);
  expect(refused.body).toContain("owner");
  expect(await taskStatus(intruder.id)).toBeUndefined();
  expect(await candidatesOf(identityId)).toBe(priorCandidates);

  const rollback = await submit({ kind: "ROLLBACK", toVersion: 1, reason: "not mine either" }, "test-second-human");
  expect((await finished(rollback.id)).ok).toBe(false);
  expect(await taskStatus(rollback.id)).toBeUndefined();
  expect(await candidatesOf(identityId)).toBe(priorCandidates);

  const { task, result } = await ownerChange(identityId, "owner's own persona");
  expect(result.ok, result.body).toBe(true);
  expect(await taskStatus(task.id)).toBe("COMPLETED");
  expect(await versionsOf(identityId)).toBe(priorVersions + 1);
}, 90000);

it("a Class A change approved AFTER a Class C change landed underneath it is refused STALE: task FAILED, the newer identity is not reverted", async () => {
  const head = await pool.query<{ version: number; document: { sections: { classA: Record<string, unknown> } } & Record<string, unknown> }>("select version, document from identity_current where identity_id=$1", [identityId]);
  const { version: baseVersion, document } = head.rows[0]!;
  const { version: _drop, ...current } = document;
  const constitutional = { ...current, sections: { ...current.sections, classA: { ...current.sections.classA, constitution: "A constitutional change that waited while the identity moved on." } } };
  const waiting = await submit({ kind: "PROPOSE", document: constitutional, reason: "waits for approval" });
  await status(waiting.id, "APPROVAL_REQUIRED");

  const underneath = await ownerChange(identityId, "landed underneath the pending Class A");
  expect(underneath.result.ok, underneath.result.body).toBe(true);
  expect(await currentVersion(identityId)).toBe(baseVersion + 1);

  const events = await pool.query<{ payload: { evaluation: { scopeDigest: string } } }>("select payload from task_events where task_id=$1 and event_key=$2", [waiting.id, `policy-approval:${waiting.id}`]);
  const approved = await send(waiting.id, "approve", { scopeDigest: events.rows[0]!.payload.evaluation.scopeDigest, decision: "GRANTED" }, "test-reviewer");
  expect(approved.ok, await approved.text()).toBe(true);
  const result = await finished(waiting.id);
  expect(result.ok, result.body).toBe(true);
  expect(result.body).toContain("IDENTITY_CANDIDATE_STALE");
  expect(await taskStatus(waiting.id)).toBe("FAILED");
  expect(await count("select count(*)::int as n from identity_activations where request_task_id=$1", [waiting.id])).toBe(0);
  const now = await pool.query<{ version: number; document: { sections: { classC: { persona: string } } } }>("select version, document from identity_current where identity_id=$1", [identityId]);
  expect(now.rows[0]!.version).toBe(baseVersion + 1);
  expect(now.rows[0]!.document.sections.classC.persona).toBe("landed underneath the pending Class A");
}, 120000);

it("ADR-0021 D6: an ALLOWed Class C change carries its persisted ALLOW decision under the Class C gate", async () => {
  const { task, result } = await ownerChange(identityId, "allowed and recorded");
  expect(result.ok, result.body).toBe(true);
  expect(await taskStatus(task.id)).toBe("COMPLETED");
  const decision = await pool.query<{ decision: string; capability: string }>(
    "select payload->'evaluation'->'decision'->>'decision' as decision, payload->'invocation'->'capability'->>'id' as capability from task_events where task_id=$1 and type='POLICY_CHECKED'",
    [task.id],
  );
  expect(decision.rows).toEqual([{ decision: "ALLOW", capability: "70000000-0000-4000-8000-000000000003" }]);
}, 90000);

it("a frozen Class C/D change ends FAILED with no version and no COMPLETED-without-activation (findings 1, 2)", async () => {
  const priorVersions = await versionsOf(identityId);
  await pool.query("select kernel_private.set_identity_freeze($1,true,'P7A: frozen pending P7B')", [identityId]);
  try {
    const { task, result } = await ownerChange(identityId, "frozen persona");
    expect(result.ok, result.body).toBe(true);
    expect(await taskStatus(task.id)).toBe("FAILED");
    expect(await count("select count(*)::int as n from outcomes where task_id=$1", [task.id])).toBe(0);
    expect(await count("select count(*)::int as n from identity_activations where request_task_id=$1", [task.id])).toBe(0);
    const candidate = await pool.query("select state from identity_candidates where proposed_by_task=$1", [task.id]);
    expect(candidate.rows[0].state).toBe("REJECTED");
    expect(await versionsOf(identityId)).toBe(priorVersions);
  } finally {
    await pool.query("select kernel_private.set_identity_freeze($1,false,'P7A test: unfrozen')", [identityId]);
  }
}, 90000);

it("a rate-capped Class C/D change ends FAILED with no version and no COMPLETED-without-activation (findings 1, 2)", async () => {
  // Fill the rolling-24h C/D window to exactly 3, then one more must be refused.
  const used = await count(
    "select count(*)::int as n from identity_activations where identity_id=$1 and governance_class in ('C','D') and activated_at > now() - interval '24 hours'",
    [identityId],
  );
  for (let i = used; i < 3; i++) expect((await ownerChange(identityId, `within cap ${i}`)).result.ok).toBe(true);
  const priorVersions = await versionsOf(identityId);
  const { task, result } = await ownerChange(identityId, "over the cap");
  expect(result.ok, result.body).toBe(true);
  expect(await taskStatus(task.id)).toBe("FAILED");
  expect(await count("select count(*)::int as n from outcomes where task_id=$1", [task.id])).toBe(0);
  expect(await versionsOf(identityId)).toBe(priorVersions);
  const candidate = await pool.query("select state from identity_candidates where proposed_by_task=$1", [task.id]);
  expect(candidate.rows[0].state).toBe("REJECTED");
}, 180000);

it("ADR-0021 D6: every Class C/D change goes through policy - a Class D change with no ALLOW rule is DENIED, persisted, and ends FAILED", async () => {
  const head = await pool.query<{ document: { sections: { classD: Record<string, unknown> } } & Record<string, unknown> }>("select document from identity_current where identity_id=$1", [identityId]);
  const { version: _drop, ...current } = head.rows[0]!.document;
  const document = { ...current, sections: { ...current.sections, classD: { ...current.sections.classD, vision: "a vision no policy allows" } } };
  const priorVersions = await versionsOf(identityId);
  const task = await submit({ kind: "PROPOSE", document, reason: "class D, no rule" });
  const result = await finished(task.id);
  expect(result.ok, result.body).toBe(true);
  expect(result.body).toContain("refused by policy: DENY");
  expect(await taskStatus(task.id)).toBe("FAILED");
  expect(await versionsOf(identityId)).toBe(priorVersions);
  const decision = await pool.query<{ decision: string; capability: string }>(
    "select payload->'evaluation'->'decision'->>'decision' as decision, payload->'invocation'->'capability'->>'id' as capability from task_events where task_id=$1 and type='POLICY_CHECKED'",
    [task.id],
  );
  expect(decision.rows).toEqual([{ decision: "DENY", capability: "70000000-0000-4000-8000-000000000004" }]);
  const candidate = await pool.query("select state from identity_candidates where proposed_by_task=$1", [task.id]);
  expect(candidate.rows[0].state).toBe("REJECTED");
}, 90000);

it("leaves no identity-change task non-terminal and no COMPLETED task without an activation, across every path above", async () => {
  const lingering = await pool.query(
    "select t.id, t.status from tasks t join task_events e on e.task_id=t.id and e.type='TASK_CREATED' where t.tenant_id=$1 and t.status::text = any($2::text[])",
    [policyOwner, NON_TERMINAL],
  );
  expect(lingering.rows).toEqual([]);
  expect(await fetchIdentityOrphans(pool, new Date())).toEqual([]);
}, 30000);
