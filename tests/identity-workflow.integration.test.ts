import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ADMIN, DATABASE, INGRESS, compose, holdRuntime, migrate, until } from "./support/local.js";
import { policyOwner, policyReviewer } from "./support/golden-probe.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { IDENTITY_CHANGE_RECIPE } from "../packages/contracts/src/index.js";

/**
 * KJ-P7A - IdentityChangeWorkflowV1 end to end, through a real Restate durable execution (not the
 * raw-DB trigger tests in tests/identity-migration.integration.test.ts, and not a mock). This is the
 * only place the workflow's own ctx.run/ctx.promise sequencing, event emission and D8 ordering
 * (complete-task strictly before activate-identity) are actually exercised by running the code, as
 * opposed to being traced by hand. Mirrors tests/recovery.test.ts's golden-workflow test shape.
 */
const pool = new pg.Pool({ connectionString: DATABASE });

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
function doc(id: string, tenantId: string, sections: Record<string, unknown> = {}) {
  return {
    id,
    tenantId,
    sections: {
      classA: classA(),
      classC: { persona: "warm, direct", communication: "plain", behaviour: "cautious", presentation: "concise" },
      classD: { objectives: ["ship KJ-P7"], vision: "A trustworthy operator partner." },
      ...sections,
    },
  };
}
function submission(intentId: string, objective: unknown) {
  return {
    recipe: IDENTITY_CHANGE_RECIPE,
    intent: {
      id: intentId,
      principal: { id: policyOwner, kind: "HUMAN" as const },
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
async function send(taskId: string, handler: string, body: unknown, actor: "test-owner" | "test-reviewer" = "test-owner") {
  return fetch(`${INGRESS}/IdentityChangeWorkflowV1/${taskId}/${handler}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${actor}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
async function status(taskId: string, expected: string): Promise<void> {
  await until(
    async () => (await pool.query<{ status: string }>("select status from tasks where id=$1", [taskId])).rows[0]?.status,
    (s) => s === expected,
    60000,
  );
}
/** D8: complete-task and activate-identity are separate, sequential ctx.run steps - `tasks.status`
 *  can observably reach COMPLETED a moment before the version/activation rows commit. Poll for the
 *  version actually existing, rather than assuming the two are visible atomically to an outside
 *  reader (the orphan detector's own grace period, services/kernel/src/health/evaluate.ts, exists
 *  precisely because this window is real, not a bug to paper over here). */
async function waitForVersion(identityId: string, version: number): Promise<{ governance_class: string; version: number }> {
  const row = await until(
    async () => (await pool.query<{ governance_class: string; version: number }>("select governance_class, version from identity_versions where identity_id=$1 and version=$2", [identityId, version])).rows[0] ?? null,
    (r) => r !== null,
    30000,
  );
  return row!;
}
async function submit(objective: unknown) {
  const body = submission(randomUUID(), objective);
  const { task } = compileIntent(body);
  const response = await send(task.id, "run/send", body);
  expect(response.ok, await response.text()).toBe(true);
  return task;
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
// path has a matching rule to find. Both mean this whole file shares ONE bootstrapped identity
// across its tests, in file order (vitest runs a file's tests sequentially by default), the same
// way tests/recovery.test.ts's tests build on each other's DB state.
let identityId: string;

it("bootstraps a Primary Identity end to end: BOOTSTRAP needs no approval, completes, and activates version 1", async () => {
  identityId = randomUUID();
  const task = await submit({ kind: "PROPOSE", document: doc(identityId, policyOwner), reason: "bootstrap" });
  await status(task.id, "COMPLETED");
  const version = await waitForVersion(identityId, 1);
  expect(version).toMatchObject({ governance_class: "BOOTSTRAP", version: 1 });
  const current = await pool.query("select version from identity_current where identity_id=$1", [identityId]);
  expect(current.rows[0].version).toBe(1);
  const profile = await pool.query("select owner_principal_id from identity_profiles where id=$1", [identityId]);
  expect(profile.rows[0].owner_principal_id).toBe(policyOwner);
}, 60000);

it("a Class A change waits for approval, then activates once granted - the ctx.promise/approval-wait path", async () => {
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
  await waitForVersion(identityId, 2);

  const activations = await pool.query<{ governance_class: string; approval_id: string | null; version: number }>(
    "select governance_class, approval_id, version from identity_activations where identity_id=$1 order by seq",
    [identityId],
  );
  expect(activations.rows.map((r) => r.governance_class)).toEqual(["BOOTSTRAP", "A"]);
  expect(activations.rows[0]!.approval_id).toBeNull();
  expect(activations.rows[1]!.approval_id).not.toBeNull();
  expect(activations.rows[1]!.version).toBe(2);

  const current = await pool.query("select version from identity_current where identity_id=$1", [identityId]);
  expect(current.rows[0].version).toBe(2);
}, 90000);

it("rejects a Class A change when the approver denies", async () => {
  // Runs after the previous test's Class A change activated version 2; the denied change here
  // must leave that version 2 as identity_current, not silently revert or advance it.
  const before = await pool.query("select version from identity_current where identity_id=$1", [identityId]);
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

  const current = await pool.query("select version from identity_current where identity_id=$1", [identityId]);
  expect(current.rows[0].version).toBe(before.rows[0].version); // unchanged - the denied change never activated
  const candidate = await pool.query("select state from identity_candidates where identity_id=$1 order by created_at desc limit 1", [identityId]);
  expect(candidate.rows[0].state).toBe("REJECTED");
}, 90000);
