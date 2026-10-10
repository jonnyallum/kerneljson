import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { completeAndActivateIdentity, completeIdentityTaskTx, type IdentityApply } from "../services/kernel/src/identity/complete.js";
import { IdentityRefusal } from "../services/kernel/src/identity/store.js";
import { identityCoreDigestV1 } from "../services/kernel/src/identity/canonical.js";
import { fetchIdentityOrphans, fetchIncompleteBootstraps } from "../services/kernel/src/health/collect.js";
import { IDENTITY_APPLY_A, IDENTITY_APPLY_BOOTSTRAP, IDENTITY_APPLY_C, IDENTITY_APPLY_D, IDENTITY_APPLY_ROLLBACK, capabilityDigest } from "../packages/capabilities/src/index.js";

/**
 * KJ-P7A - the primary identity migration (ADR-0021) against real Postgres. Exercises the DB
 * triggers directly with raw SQL, independent of IdentityChangeWorkflowV1, so a bug in the
 * database's own enforcement can never hide behind a correct workflow - but reuses the REAL
 * completeIdentityTaskTx (identity/complete.ts) for task completion rather than a hand-rolled
 * approximation, which is exactly what caught a real bug live: a raw `status='COMPLETED'` insert
 * with an empty evidenceRefs array looked fine until check_task_completion()
 * (20260905153704_intelligence_metadata.sql) refused it - and so would every real call to
 * completeIdentityTaskTx have, before that function was fixed to write a real evidence row first.
 *
 * The raw-SQL helpers below deliberately complete a task and THEN insert its version/activation as
 * separate statements, to reach each trigger on its own. Production never does that: it goes
 * through completeAndActivateIdentity (one transaction), exercised in the "D8" block at the end.
 *
 * Mirrors tests/memory-canonical.integration.test.ts's "against a real Postgres. Every refusal
 * below that says 'in the database' is the schema refusing, with the application bypassed"
 * discipline.
 */

let db: Awaited<ReturnType<typeof knowledgeDatabase>>;

beforeAll(async () => {
  db = await knowledgeDatabase("kj_identity_migration_integration");
});
afterAll(async () => {
  await db?.close();
});

async function mkTenant(): Promise<string> {
  const id = randomUUID();
  await db.pool.query("insert into tenants(id,name) values($1,'identity-test')", [id]);
  return id;
}
async function mkPrincipal(tenantId: string, kind: "HUMAN" | "SERVICE" = "HUMAN"): Promise<string> {
  const id = randomUUID();
  await db.pool.query("insert into principals(id,kind) values($1,$2)", [id, kind]);
  await db.pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'member')", [tenantId, id]);
  return id;
}
/** identity_candidates.proposed_by_task needs a real task id before the task completes - a
 *  candidate is always proposed while its owning task is still running. */
async function mkVerifyingTask(tenantId: string, principalId: string): Promise<string> {
  const id = randomUUID(),
    traceId = randomUUID(),
    createdAt = new Date(Date.now() - 60_000).toISOString();
  const contract = {
    id,
    principal: { id: principalId, kind: "HUMAN" },
    tenant: { id: tenantId },
    objective: "identity change",
    acceptanceCriteria: ["identity change criterion"],
    constraints: [],
    riskClass: "LOW",
    status: "VERIFYING",
    traceId,
    createdAt,
  };
  await db.pool.query(
    "insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'VERIFYING',$5,$6)",
    [id, tenantId, principalId, traceId, contract, createdAt],
  );
  return id;
}
/** A task that is neither VERIFYING nor COMPLETED - proves identity_version_guard()'s D8 ordering check. */
async function mkRunningTask(tenantId: string, principalId: string): Promise<string> {
  const id = randomUUID(),
    traceId = randomUUID(),
    createdAt = new Date().toISOString();
  const contract = {
    id,
    principal: { id: principalId, kind: "HUMAN" },
    tenant: { id: tenantId },
    objective: "identity change",
    acceptanceCriteria: ["identity change criterion"],
    constraints: [],
    riskClass: "LOW",
    status: "RUNNING",
    traceId,
    createdAt,
  };
  await db.pool.query(
    "insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'RUNNING',$5,$6)",
    [id, tenantId, principalId, traceId, contract, createdAt],
  );
  return id;
}
/** Runs the REAL completeIdentityTaskTx against an existing VERIFYING task, committed on its own. */
async function completeExistingTask(taskId: string): Promise<void> {
  const proofMetadata = { probe: randomUUID() };
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [taskId]);
    await completeIdentityTaskTx(
      client,
      taskId,
      "identity change applied",
      { evidenceId: randomUUID(), digest: capabilityDigest(proofMetadata), metadata: proofMetadata },
      { eventId: randomUUID(), at: new Date().toISOString() },
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
async function mkApproval(taskId: string, approverId: string, status: "PENDING" | "GRANTED" | "DENIED" | "EXPIRED" = "GRANTED"): Promise<string> {
  const id = randomUUID(),
    requestedAt = new Date(Date.now() - 5_000).toISOString();
  if (status === "PENDING") {
    await db.pool.query("insert into approvals(id,task_id,requested_from,requested_at,status) values($1,$2,$3,$4,'PENDING')", [id, taskId, approverId, requestedAt]);
    return id;
  }
  const evidenceId = randomUUID(),
    resolvedAt = new Date().toISOString();
  await db.pool.query(
    "insert into evidence(id,task_id,type,source,digest,captured_at,metadata) values($1,$2,'HUMAN_DECISION','kerneljson:approval/v1',$3,$4,'{}'::jsonb)",
    [evidenceId, taskId, "a".repeat(64), resolvedAt],
  );
  await db.pool.query(
    "insert into approvals(id,task_id,requested_from,requested_at,status,resolved_at,evidence_id) values($1,$2,$3,$4,$5,$6,$7)",
    [id, taskId, approverId, requestedAt, status, resolvedAt, evidenceId],
  );
  return id;
}
/** Writes the immutable POLICY_CHECKED event ApprovalStore.record() writes for an identity approval:
 *  it is what binds the approval to one candidate and one proposed document (ADR-0021 D5), and
 *  identity_activation_guard() requires it. `overrides` forges one field, to prove each is checked. */
type PolicyOverrides = { candidateId?: string; digest?: string; capabilityId?: string; decision?: string };
async function bindApproval(taskId: string, approvalId: string, candidateId: string, overrides: PolicyOverrides = {}) {
  await writePolicyEvent(taskId, approvalId, candidateId, { decision: "APPROVAL_REQUIRED", capabilityId: IDENTITY_APPLY_A.id, ...overrides });
}
/** The POLICY_CHECKED event for a Class C/D change policy ALLOWed (ADR-0021 D6): with no approval,
 *  identity_activation_guard() requires exactly this for the candidate, its digest and its class gate. */
async function allowPolicy(taskId: string, candidateId: string, overrides: PolicyOverrides = {}) {
  await writePolicyEvent(taskId, randomUUID(), candidateId, { decision: "ALLOW", capabilityId: IDENTITY_APPLY_C.id, ...overrides });
}
/** The identity gate capability for each governance class (packages/capabilities IDENTITY_APPLY_*). */
function gateFor(governanceClass: string): string {
  return { BOOTSTRAP: IDENTITY_APPLY_BOOTSTRAP.id, A: IDENTITY_APPLY_A.id, ROLLBACK: IDENTITY_APPLY_ROLLBACK.id, C: IDENTITY_APPLY_C.id, D: IDENTITY_APPLY_D.id }[governanceClass]!;
}
/** A GRANTED HUMAN approval on `taskId`, bound (D5) to this candidate under this class's gate, with the
 *  candidate moved to APPROVED - everything a BOOTSTRAP / Class A / ROLLBACK activation requires. */
async function approveFor(tenantId: string, taskId: string, candidateId: string, governanceClass: string): Promise<string> {
  const approverId = await mkPrincipal(tenantId, "HUMAN");
  const approvalId = await mkApproval(taskId, approverId, "GRANTED");
  await bindApproval(taskId, approvalId, candidateId, { capabilityId: gateFor(governanceClass) });
  await db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [candidateId]);
  return approvalId;
}
async function writePolicyEvent(taskId: string, approvalId: string, candidateId: string, overrides: PolicyOverrides & { decision: string; capabilityId: string }) {
  const task = await db.pool.query<{ principal_id: string; trace_id: string }>("select principal_id, trace_id from tasks where id=$1", [taskId]);
  const candidate = await db.pool.query<{ proposed_digest: string }>("select proposed_digest from identity_candidates where id=$1", [candidateId]);
  const payload = {
    approvalId,
    evaluation: { decision: { decision: overrides.decision } },
    invocation: {
      capability: { id: overrides.capabilityId, version: "1.0.0" },
      input: { candidateId: overrides.candidateId ?? candidateId, identityCoreDigest: overrides.digest ?? candidate.rows[0]!.proposed_digest },
    },
  };
  await db.pool.query(
    "insert into task_events(id,task_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,$3,$4,'POLICY_CHECKED',$5,$6,$7,$8)",
    [randomUUID(), taskId, `policy-approval:${approvalId}`, capabilityDigest(payload), new Date().toISOString(), task.rows[0]!.principal_id, task.rows[0]!.trace_id, JSON.stringify(payload)],
  );
}

function doc(identityId: string, tenantId: string, sections: Record<string, unknown> = {}) {
  return {
    id: identityId,
    tenantId,
    sections: {
      classA: { name: "Jai" },
      classC: {},
      classD: {},
      ...sections,
    },
  };
}
function withVersion(d: ReturnType<typeof doc>, version: number) {
  return { ...d, version };
}

async function mkProfile(tenantId: string, ownerId: string, identityId = randomUUID()): Promise<string> {
  await db.pool.query("insert into identity_profiles(id,tenant_id,owner_principal_id,name) values($1,$2,$3,'Primary')", [identityId, tenantId, ownerId]);
  return identityId;
}

/** Runs `fn` on one connection inside a transaction that is always rolled back - for proving one
 *  protection layer on its own by removing another (DDL is transactional in Postgres), without ever
 *  leaving the schema changed for the tests that follow. */
async function inRolledBackTransaction(fn: (client: import("pg").PoolClient) => Promise<void>): Promise<void> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await fn(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

const H = () => "a".repeat(64); // Shape-only candidate/proof fixtures; persisted versions below use real P7B digests.

async function proposeOn(tenantId: string, identityId: string, taskId: string, document: unknown, governanceClass: string, origin: "OPERATOR_INSTRUCTION" | "MODEL_PROPOSAL" | "SHARED_BRAIN" = "OPERATOR_INSTRUCTION") {
  const candidateId = randomUUID();
  await db.pool.query(
    `insert into identity_candidates(id,identity_id,tenant_id,document,proposed_digest,origin,governance_class,proposed_by_task)
     values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [candidateId, identityId, tenantId, document, H(), origin, governanceClass, origin === "OPERATOR_INSTRUCTION" ? taskId : null],
  );
  return candidateId;
}
async function insertVersion(tenantId: string, identityId: string, version: number, document: unknown, candidateId: string, taskId: string) {
  const versionId = randomUUID();
  await db.pool.query(
    `insert into identity_versions(id,identity_id,tenant_id,version,document,identity_core_digest,class_a_digest,governance_class,candidate_id,created_by_task)
     values($1,$2,$3,$4,$5,$6,$7,'IGNORED',$8,$9)`,
    [versionId, identityId, tenantId, version, document, identityCoreDigestV1(document),
      identityCoreDigestV1((document as { sections: { classA: unknown } }).sections.classA), candidateId, taskId],
  );
  return versionId;
}
async function insertActivation(tenantId: string, identityId: string, version: number, candidateId: string, approvalId: string | null, taskId: string) {
  const activationId = randomUUID();
  await db.pool.query(
    `insert into identity_activations(id,identity_id,tenant_id,version,governance_class,candidate_id,approval_id,request_task_id)
     values($1,$2,$3,$4,'IGNORED',$5,$6,$7)`,
    [activationId, identityId, tenantId, version, candidateId, approvalId, taskId],
  );
  return activationId;
}

/** The full, realistic candidate -> (approve) -> complete-task -> version -> activation chain, in
 *  the exact order IdentityChangeWorkflowV1 uses it (D8: task completes strictly before the version
 *  exists). Class A/ROLLBACK need `approverId`; BOOTSTRAP/C/D do not. */
async function change(
  tenantId: string,
  ownerId: string,
  identityId: string,
  document: ReturnType<typeof doc>,
  governanceClass: string,
  opts: { approverId?: string } = {},
) {
  const taskId = await mkVerifyingTask(tenantId, ownerId);
  const candidateId = await proposeOn(tenantId, identityId, taskId, document, governanceClass);
  if (governanceClass === "C" || governanceClass === "D") await allowPolicy(taskId, candidateId, { capabilityId: governanceClass === "C" ? IDENTITY_APPLY_C.id : IDENTITY_APPLY_D.id });
  let approvalId: string | null = null;
  // BOOTSTRAP always needs a GRANTED HUMAN approval, like Class A / ROLLBACK (P7 gate).
  const approverId = opts.approverId ?? (governanceClass === "BOOTSTRAP" ? await mkPrincipal(tenantId, "HUMAN") : undefined);
  if (approverId) {
    approvalId = await mkApproval(taskId, approverId, "GRANTED");
    await bindApproval(taskId, approvalId, candidateId, { capabilityId: gateFor(governanceClass) });
    await db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [candidateId]);
  }
  await completeExistingTask(taskId);
  const head = await db.pool.query("select version from public.identity_head where identity_id=$1", [identityId]);
  const version = (head.rows[0]?.version ?? 0) + 1;
  await insertVersion(tenantId, identityId, version, withVersion(document, version), candidateId, taskId);
  const activationId = await insertActivation(tenantId, identityId, version, candidateId, approvalId, taskId);
  return { identityId, taskId, candidateId, activationId, version };
}

/** ADR-0021 D7: Class C/D is frozen by default once an identity exists. Every test that exercises a
 *  C/D change opens a disposable test-only change window explicitly. P7B G13 never unfreezes production. */
async function openTestChangeWindow(identityId: string) {
  await db.pool.query("select kernel_private.set_identity_freeze($1,false,'test: explicitly authorised C/D change window')", [identityId]);
}
async function bootstrap(tenantId: string, ownerId: string, opts: { keepFrozen?: boolean } = {}) {
  const identityId = await mkProfile(tenantId, ownerId);
  const result = await change(tenantId, ownerId, identityId, doc(identityId, tenantId), "BOOTSTRAP");
  if (!opts.keepFrozen) await openTestChangeWindow(identityId);
  return { identityId, taskId: result.taskId };
}

describe("identity_profiles: bootstrap ownership guard", () => {
  it("accepts an ACTIVE HUMAN owner", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    await expect(mkProfile(tenantId, ownerId)).resolves.toBeTruthy();
  });

  it("rejects a SERVICE principal as owner", async () => {
    const tenantId = await mkTenant(),
      serviceId = await mkPrincipal(tenantId, "SERVICE");
    await expect(mkProfile(tenantId, serviceId)).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an owner who is not a member of the tenant at all", async () => {
    const tenantId = await mkTenant(),
      otherTenant = await mkTenant(),
      strangerId = await mkPrincipal(otherTenant, "HUMAN");
    await expect(mkProfile(tenantId, strangerId)).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces one identity per tenant (unique tenant_id)", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    await mkProfile(tenantId, ownerId);
    await expect(mkProfile(tenantId, ownerId)).rejects.toMatchObject({ code: "23505" });
  });

  it("is immutable: UPDATE and DELETE are both refused", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      identityId = await mkProfile(tenantId, ownerId);
    await expect(db.pool.query("update identity_profiles set name='x' where id=$1", [identityId])).rejects.toBeTruthy();
    await expect(db.pool.query("delete from identity_profiles where id=$1", [identityId])).rejects.toBeTruthy();
    await expect(db.pool.query("truncate identity_profiles")).rejects.toBeTruthy();
  });
});

describe("cross-tenant references are refused, not merely self-consistency-checked", () => {
  it("refuses a candidate whose tenant_id does not actually own the identity_id it names", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      identityId = await mkProfile(tenantId, ownerId);
    const otherTenantId = await mkTenant();
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    // The document's own tenantId is self-consistent with the (forged) tenant_id column, so only the
    // (identity_id, tenant_id) -> identity_profiles(id, tenant_id) FK can catch this.
    await expect(proposeOn(otherTenantId, identityId, taskId, doc(identityId, otherTenantId), "BOOTSTRAP")).rejects.toMatchObject({ code: "23503" });
  });

  // identity_versions/identity_activations also carry the same (identity_id, tenant_id) FK, but it is
  // unreachable in isolation there: a version's document must match its candidate's document exactly
  // (identity_version_guard's own check), and the document's embedded tenantId is itself checked
  // against the tenant_id column, so any tenant mismatch is already caught one step earlier, before
  // the FK is ever consulted. The FK remains as defense-in-depth for a future change to that ordering.
});

describe("identity_candidate_classify: governance class is derived, never trusted from the caller", () => {
  it("BOOTSTRAP: the first candidate for an identity must assert BOOTSTRAP, and only BOOTSTRAP", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      identityId = await mkProfile(tenantId, ownerId),
      taskId = await mkVerifyingTask(tenantId, ownerId);
    await expect(proposeOn(tenantId, identityId, taskId, doc(identityId, tenantId), "A")).rejects.toMatchObject({ code: "23514" });
  });

  it("a caller cannot mislabel a Class A change as C: the trigger overwrites it", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changedA = doc(identityId, tenantId, { classA: { name: "A different name entirely" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changedA, "C");
    const row = await db.pool.query("select governance_class from identity_candidates where id=$1", [candidateId]);
    expect(row.rows[0].governance_class).toBe("A");
  });

  it("a caller cannot over-report a Class C change as A: the trigger overwrites it too", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changedC = doc(identityId, tenantId, { classC: { persona: "different" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changedC, "A");
    const row = await db.pool.query("select governance_class from identity_candidates where id=$1", [candidateId]);
    expect(row.rows[0].governance_class).toBe("C");
  });

  it("a candidate identical to the current head is refused: nothing to propose", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    await expect(proposeOn(tenantId, identityId, taskId, doc(identityId, tenantId), "C")).rejects.toMatchObject({ code: "23514" });
  });

  it("ROLLBACK (regression proof): a candidate reproducing an existing version's document exactly is accepted - the fixed 'document - version' comparison", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    // version 1's persisted document embeds version:1; a rollback candidate never does (see
    // identity_version_guard's own comment) - this is exactly the shape the original bug produced.
    const rollbackDoc = doc(identityId, tenantId);
    const candidateId = await proposeOn(tenantId, identityId, taskId, rollbackDoc, "ROLLBACK");
    const row = await db.pool.query("select governance_class from identity_candidates where id=$1", [candidateId]);
    expect(row.rows[0].governance_class).toBe("ROLLBACK");
  });

  it("ROLLBACK: a candidate that does NOT reproduce any existing version's document is refused", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const notAVersion = doc(identityId, tenantId, { classA: { name: "never persisted" } });
    await expect(proposeOn(tenantId, identityId, taskId, notAVersion, "ROLLBACK")).rejects.toMatchObject({ code: "23514" });
  });
});

describe("identity_candidates: origin ceiling — model/Shared Brain candidates can never reach APPROVED or APPLIED", () => {
  it("a MODEL_PROPOSAL candidate can be HELD or REJECTED, never APPROVED or APPLIED", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const candidateId = await proposeOn(tenantId, identityId, taskId, doc(identityId, tenantId, { classC: { persona: "model-suggested" } }), "C", "MODEL_PROPOSAL");
    await expect(db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [candidateId])).rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query("update identity_candidates set state='REJECTED', resolved_at=now() where id=$1", [candidateId])).resolves.toBeTruthy();
  });

  it("state transitions only ever go HELD -> resolved, never back, and nothing but state/resolved_at may change", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const candidateId = await proposeOn(tenantId, identityId, taskId, doc(identityId, tenantId, { classC: { persona: "x" } }), "C");
    await db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [candidateId]);
    await expect(db.pool.query("update identity_candidates set state='REJECTED', resolved_at=now() where id=$1", [candidateId])).rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query("update identity_candidates set document='{}'::jsonb where id=$1", [candidateId])).rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query("delete from identity_candidates where id=$1", [candidateId])).rejects.toBeTruthy();
  });

  it("a HELD candidate's document cannot be swapped in place (only state/resolved_at may ever change)", async () => {
    // The document swap must be attempted on a HELD candidate with a well-formed replacement: an
    // already-resolved candidate is refused by the "already resolved" check, and a malformed document
    // by the table CHECKs, so neither would ever reach the document-immutability condition itself.
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const candidateId = await proposeOn(tenantId, identityId, taskId, doc(identityId, tenantId, { classC: { persona: "proposed" } }), "C");
    const swapped = doc(identityId, tenantId, { classC: { persona: "swapped after proposal" } });
    await expect(db.pool.query("update identity_candidates set document=$2 where id=$1", [candidateId, swapped])).rejects.toMatchObject({ code: "23514" });
    const stored = await db.pool.query("select document from identity_candidates where id=$1", [candidateId]);
    expect(stored.rows[0].document.sections.classC.persona).toBe("proposed");
  });
});

describe("identity_activation_guard: the origin-check regression proof (KJ-P7A fix)", () => {
  it("a MODEL_PROPOSAL BOOTSTRAP candidate, HELD, cannot self-activate with no human involved", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      identityId = await mkProfile(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const candidateId = await proposeOn(tenantId, identityId, taskId, doc(identityId, tenantId), "BOOTSTRAP", "MODEL_PROPOSAL");
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 1, withVersion(doc(identityId, tenantId), 1), candidateId, taskId);
    await expect(insertActivation(tenantId, identityId, 1, candidateId, null, taskId)).rejects.toMatchObject({ code: "23514" });
  });

  // BOOTSTRAP now needs an approval (refused above before the origin check is reached), so the origin
  // ceiling itself is proven on the one class that is still exempt from approval when HELD: Class C/D.
  // Everything else about this model candidate is valid - policy ALLOW, window open, task completed.
  it("a MODEL_PROPOSAL Class C candidate, HELD and policy-ALLOWed, still cannot self-activate: the origin ceiling", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changed = doc(identityId, tenantId, { classC: { persona: "model-suggested" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changed, "C", "MODEL_PROPOSAL");
    await allowPolicy(taskId, candidateId);
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 2, withVersion(changed, 2), candidateId, taskId);
    await expect(insertActivation(tenantId, identityId, 2, candidateId, null, taskId)).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("APPROVED candidate"),
    });
  });

  it("an OPERATOR_INSTRUCTION BOOTSTRAP candidate with a bound GRANTED approval activates cleanly (the real path)", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    await expect(bootstrap(tenantId, ownerId)).resolves.toBeTruthy();
  });

  it("Class A activation without approval_id is refused, even for an APPROVED OPERATOR_INSTRUCTION candidate", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changedA = doc(identityId, tenantId, { classA: { name: "new constitutional name" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changedA, "A");
    await db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [candidateId]);
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 2, withVersion(changedA, 2), candidateId, taskId);
    await expect(insertActivation(tenantId, identityId, 2, candidateId, null, taskId)).rejects.toMatchObject({ code: "23514" });
  });

  // The approval requirement is enforced twice: identity_activation_guard() and the table's own CHECK.
  // Either alone refuses the insert above, so that test cannot tell whether both still exist. These two
  // prove each layer on its own, by removing the other inside a rolled-back transaction.
  async function approvedClassAWithVersion() {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changedA = doc(identityId, tenantId, { classA: { name: "layered approval proof" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changedA, "A");
    await db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [candidateId]);
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 2, withVersion(changedA, 2), candidateId, taskId);
    return { tenantId, identityId, candidateId, taskId };
  }
  const activationSql = `insert into identity_activations(id,identity_id,tenant_id,version,governance_class,candidate_id,approval_id,request_task_id)
     values($1,$2,$3,2,$4,$5,null,$6)`;

  it("the trigger alone refuses a Class A activation without approval (table CHECK dropped)", async () => {
    const { tenantId, identityId, candidateId, taskId } = await approvedClassAWithVersion();
    await inRolledBackTransaction(async (client) => {
      const checks = await client.query(
        "select conname from pg_constraint where conrelid='public.identity_activations'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%approval_id IS NOT NULL%'",
      );
      expect(checks.rowCount).toBe(1); // the lookup itself must find the CHECK, or this test proves nothing.
      await client.query(`alter table public.identity_activations drop constraint "${checks.rows[0].conname}"`);
      await expect(client.query(activationSql, [randomUUID(), identityId, tenantId, "IGNORED", candidateId, taskId])).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("require a granted approval"),
      });
    });
  });

  it("the table CHECK alone refuses a Class A activation without approval (triggers disabled)", async () => {
    const { tenantId, identityId, candidateId, taskId } = await approvedClassAWithVersion();
    await inRolledBackTransaction(async (client) => {
      await client.query("set local session_replication_role = replica"); // user triggers do not fire
      await expect(client.query(activationSql, [randomUUID(), identityId, tenantId, "A", candidateId, taskId])).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("identity_activations"),
      });
    });
  });
});

describe("identity_version_guard: D8 - a version requires its owning task to already be COMPLETED", () => {
  it("refuses a version whose created_by_task is not COMPLETED", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      identityId = await mkProfile(tenantId, ownerId);
    const runningTaskId = await mkRunningTask(tenantId, ownerId);
    const candidateId = await proposeOn(tenantId, identityId, runningTaskId, doc(identityId, tenantId), "BOOTSTRAP");
    await expect(insertVersion(tenantId, identityId, 1, withVersion(doc(identityId, tenantId), 1), candidateId, runningTaskId)).rejects.toMatchObject({ code: "23514" });
  });

  it("requires consecutive version numbers", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changed = doc(identityId, tenantId, { classC: { persona: "x" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changed, "C");
    await completeExistingTask(taskId);
    await expect(insertVersion(tenantId, identityId, 3, withVersion(changed, 3), candidateId, taskId)).rejects.toMatchObject({ code: "23514" });
  });

  it("a version document must match its candidate's document exactly aside from the version number", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      identityId = await mkProfile(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const candidateId = await proposeOn(tenantId, identityId, taskId, doc(identityId, tenantId), "BOOTSTRAP");
    await completeExistingTask(taskId);
    const tampered = withVersion(doc(identityId, tenantId, { classA: { name: "tampered after proposal" } }), 1);
    await expect(insertVersion(tenantId, identityId, 1, tampered, candidateId, taskId)).rejects.toMatchObject({ code: "23514" });
  });

  it("is immutable: UPDATE and DELETE are both refused", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    await expect(db.pool.query("update identity_versions set version=99 where identity_id=$1", [identityId])).rejects.toBeTruthy();
    // 55000 is reject_ledger_mutation()'s own code. Accepting any error let this pass on the version
    // CHECK / the FK from identity_activations alone, with the immutability trigger removed. A no-op
    // UPDATE of a non-key column reaches only the trigger; the BEFORE DELETE trigger fires ahead of the
    // (AFTER) FK check, so its code is the one reported while it exists.
    await expect(db.pool.query("update identity_versions set document=document where identity_id=$1", [identityId])).rejects.toMatchObject({ code: "55000" });
    await expect(db.pool.query("delete from identity_versions where identity_id=$1", [identityId])).rejects.toMatchObject({ code: "55000" });
    await expect(db.pool.query("truncate identity_versions")).rejects.toBeTruthy();
  });

  it("TRUNCATE is refused by the table's own trigger, not only by the FKs that reference it", async () => {
    // Postgres refuses to TRUNCATE a table another table's FK references before any trigger runs
    // (0A000), so with the FKs in place the no-truncate triggers on identity_versions/identity_profiles
    // are unreachable and a bare "truncate rejects" assertion cannot see them. Drop the referencing FKs
    // inside a rolled-back transaction and require the trigger's own refusal.
    for (const table of ["identity_versions", "identity_profiles"]) {
      await expect(db.pool.query(`truncate ${table}`)).rejects.toMatchObject({ code: "0A000" });
      await inRolledBackTransaction(async (client) => {
        const fks = await client.query("select conrelid::regclass::text as rel, conname from pg_constraint where contype='f' and confrelid=$1::regclass", [
          `public.${table}`,
        ]);
        expect(fks.rowCount).toBeGreaterThan(0);
        for (const fk of fks.rows) await client.query(`alter table ${fk.rel} drop constraint "${fk.conname}"`);
        await expect(client.query(`truncate public.${table}`)).rejects.toMatchObject({ code: "55000" });
      });
    }
  });
});

describe("identity_activations: rate cap, freeze, and identity_current", () => {
  it("enforces the 3-per-rolling-24h Class C/D cap: a 4th activation within the window is refused", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    await change(tenantId, ownerId, identityId, doc(identityId, tenantId, { classC: { persona: "one" } }), "C");
    await change(tenantId, ownerId, identityId, doc(identityId, tenantId, { classC: { persona: "two" } }), "C");
    await change(tenantId, ownerId, identityId, doc(identityId, tenantId, { classC: { persona: "three" } }), "C");

    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changed = doc(identityId, tenantId, { classC: { persona: "four" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changed, "C");
    await allowPolicy(taskId, candidateId);
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 5, withVersion(changed, 5), candidateId, taskId);
    await expect(insertActivation(tenantId, identityId, 5, candidateId, null, taskId)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("rate cap") });
  });

  it("kernel_private.set_identity_freeze blocks a subsequent Class C/D activation, but not a Class A one with approval", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    await db.pool.query("select kernel_private.set_identity_freeze($1,true,'P7A: frozen pending P7B G13')", [identityId]);

    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changed = doc(identityId, tenantId, { classC: { persona: "should be frozen" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changed, "C");
    await allowPolicy(taskId, candidateId);
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 2, withVersion(changed, 2), candidateId, taskId);
    await expect(insertActivation(tenantId, identityId, 2, candidateId, null, taskId)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("frozen") });

    // Class A, with a granted approval, still goes through despite the freeze (D7: emergency
    // HUMAN-approved constitutional change remains available throughout).
    const approverId = await mkPrincipal(tenantId, "HUMAN");
    const changedA = doc(identityId, tenantId, { classA: { name: "emergency constitutional fix" } });
    await expect(change(tenantId, ownerId, identityId, changedA, "A", { approverId })).resolves.toBeTruthy();
  });

  it("identity_current tracks the most recently activated version by insertion order (seq), not activated_at, which can tie within one transaction", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const { version } = await change(tenantId, ownerId, identityId, doc(identityId, tenantId, { classC: { persona: "second" } }), "C");
    const current = await db.pool.query("select version from public.identity_current where identity_id=$1", [identityId]);
    expect(current.rows[0].version).toBe(version);
  });

  it("is append-only: UPDATE and DELETE are both refused", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    await expect(db.pool.query("update identity_activations set version=99 where identity_id=$1", [identityId])).rejects.toBeTruthy();
    await expect(db.pool.query("delete from identity_activations where identity_id=$1", [identityId])).rejects.toBeTruthy();
    await expect(db.pool.query("truncate identity_activations")).rejects.toBeTruthy();
  });

  it("double activation: the same candidate cannot be activated twice", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      identityId = await mkProfile(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const candidateId = await proposeOn(tenantId, identityId, taskId, doc(identityId, tenantId), "BOOTSTRAP");
    const approvalId = await approveFor(tenantId, taskId, candidateId, "BOOTSTRAP");
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 1, withVersion(doc(identityId, tenantId), 1), candidateId, taskId);
    await insertActivation(tenantId, identityId, 1, candidateId, approvalId, taskId);
    // A second activation for the exact same candidate - a distinct row, a distinct request_task_id
    // (so that unique constraint alone would not catch it), but the same candidate_id.
    const secondTaskId = await mkVerifyingTask(tenantId, ownerId);
    await completeExistingTask(secondTaskId);
    // Two layers refuse this: identity_activation_guard() (the activation must be requested by the
    // task that created the version, 23514) and unique(candidate_id) (23505). Either alone satisfies
    // the black-box property, so prove the UNIQUE on its own too, with triggers disabled.
    await expect(insertActivation(tenantId, identityId, 1, candidateId, null, secondTaskId)).rejects.toMatchObject({ code: "23514" });
    await inRolledBackTransaction(async (client) => {
      await client.query("set local session_replication_role = replica"); // user triggers do not fire
      await expect(
        client.query(
          "insert into identity_activations(id,identity_id,tenant_id,version,governance_class,candidate_id,approval_id,request_task_id) values($1,$2,$3,1,'BOOTSTRAP',$4,$5,$6)",
          [randomUUID(), identityId, tenantId, candidateId, approvalId, secondTaskId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  it("concurrent activation: two simultaneous Class C proposals on the same identity serialize rather than both succeeding at the same version", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);

    // Both racers target the SAME next version number deliberately (read once, up front, and shared)
    // rather than each reading identity_head independently - that would let Node's event-loop
    // interleaving accidentally serialize them into two DIFFERENT valid versions, which proves
    // nothing about the advisory lock. Forcing an identical target version is what actually exercises
    // identity_version_guard()'s consecutiveness check under real concurrency.
    const head = await db.pool.query("select version from public.identity_head where identity_id=$1", [identityId]);
    const targetVersion = (head.rows[0]?.version ?? 0) + 1;
    async function attempt(label: string) {
      const taskId = await mkVerifyingTask(tenantId, ownerId);
      const changed = doc(identityId, tenantId, { classC: { persona: label } });
      const candidateId = await proposeOn(tenantId, identityId, taskId, changed, "C");
      await allowPolicy(taskId, candidateId);
      await completeExistingTask(taskId);
      await insertVersion(tenantId, identityId, targetVersion, withVersion(changed, targetVersion), candidateId, taskId);
      return insertActivation(tenantId, identityId, targetVersion, candidateId, null, taskId);
    }
    const results = await Promise.allSettled([attempt("racer-a"), attempt("racer-b")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // Exactly one wins the identical target version; the loser hits identity_versions' primary key
    // (identity_id,version) - the advisory lock in identity_version_guard() serializes them, it does
    // not silently let a second writer overwrite or duplicate the same version slot.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const activationVersions = (await db.pool.query("select version from identity_activations where identity_id=$1", [identityId])).rows.map((r) => r.version);
    expect(new Set(activationVersions).size).toBe(activationVersions.length); // no two activations ever share a version number
    expect(activationVersions).toContain(targetVersion);
  });
});

describe("RLS: anon and authenticated have no access to any identity table", () => {
  it("anon cannot select from identity_profiles", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("set role anon");
      await expect(client.query("select 1 from public.identity_profiles limit 1")).rejects.toBeTruthy();
    } finally {
      await client.query("reset role");
      client.release();
    }
  });

  it("authenticated cannot select from identity_activations", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("set role authenticated");
      await expect(client.query("select 1 from public.identity_activations limit 1")).rejects.toBeTruthy();
    } finally {
      await client.query("reset role");
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// KJ-P7A pre-hostile review fixes. Everything below goes through the production apply path,
// completeAndActivateIdentity (identity/complete.ts), not the raw two-step helpers above.
// ---------------------------------------------------------------------------------------------------

function fullDoc(identityId: string, tenantId: string, persona = "warm, direct") {
  return {
    id: identityId,
    tenantId,
    sections: {
      classA: {
        name: "Jai",
        constitution: "Serve the operator honestly and rigorously.",
        values: ["rigour"],
        operatorRelationship: "Reports to the operator.",
        facultyFraming: "Frames whichever faculty the kernel selected.",
        memoryPolicy: "May narrow canonical memory, never widen it.",
      },
      classC: { persona, communication: "plain", behaviour: "cautious", presentation: "concise" },
      classD: { objectives: ["ship KJ-P7"], vision: "A trustworthy operator partner." },
    },
  };
}
function applyInput(tenantId: string, identityId: string, taskId: string, candidateId: string, draft: ReturnType<typeof fullDoc>, approvalId: string | null = null): IdentityApply {
  const metadata = { candidateId };
  return {
    taskId,
    summary: "identity change applied",
    proof: { evidenceId: randomUUID(), digest: capabilityDigest(metadata), metadata },
    audit: { eventId: randomUUID(), at: new Date().toISOString() },
    identityId,
    tenantId,
    draftDocument: draft,
    candidateId,
    versionId: randomUUID(),
    activationId: randomUUID(),
    approvalId,
  };
}
/** Proposes `draft` on a fresh VERIFYING task owned by `ownerId`; `apply` runs the atomic apply. */
async function proposeAndApply(tenantId: string, ownerId: string, identityId: string, draft: ReturnType<typeof fullDoc>, requested: string) {
  const taskId = await mkVerifyingTask(tenantId, ownerId);
  const candidateId = await proposeOn(tenantId, identityId, taskId, draft, requested);
  if (requested === "C" || requested === "D") await allowPolicy(taskId, candidateId, { capabilityId: requested === "C" ? IDENTITY_APPLY_C.id : IDENTITY_APPLY_D.id });
  const approvalId = requested === "BOOTSTRAP" ? await approveFor(tenantId, taskId, candidateId, "BOOTSTRAP") : null;
  const input = applyInput(tenantId, identityId, taskId, candidateId, draft, approvalId);
  return { taskId, candidateId, input, apply: () => completeAndActivateIdentity(db.pool, input) };
}
/** Everything a completion or an activation could have left behind for one task. */
async function footprint(taskId: string) {
  const r = await db.pool.query(
    `select (select status from tasks where id=$1) as status,
            (select count(*)::int from outcomes where task_id=$1) as outcomes,
            (select count(*)::int from evidence where task_id=$1) as evidence,
            (select count(*)::int from task_events where task_id=$1 and type='TASK_COMPLETED') as completed_events,
            (select count(*)::int from identity_versions where created_by_task=$1) as versions,
            (select count(*)::int from identity_activations where request_task_id=$1) as activations`,
    [taskId],
  );
  return r.rows[0] as { status: string; outcomes: number; evidence: number; completed_events: number; versions: number; activations: number };
}
const NOTHING_COMMITTED = { status: "VERIFYING", outcomes: 0, evidence: 0, completed_events: 0, versions: 0, activations: 0 };
async function bootstrapAtomically(tenantId: string, ownerId: string, opts: { keepFrozen?: boolean } = {}) {
  const identityId = await mkProfile(tenantId, ownerId);
  const boot = await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId), "BOOTSTRAP");
  await boot.apply();
  if (!opts.keepFrozen) await openTestChangeWindow(identityId);
  return identityId;
}

describe("D8: completion, version and activation are one transaction (finding 1)", () => {
  it("a frozen Class C/D change never yields COMPLETED-without-activation: the refusal rolls the completion back", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    await db.pool.query("select kernel_private.set_identity_freeze($1,true,'P7A: frozen pending P7B')", [identityId]);
    const change = await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "frozen persona"), "C");
    const refused = await change.apply().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IdentityRefusal);
    expect(String((refused as Error).message)).toContain("frozen");
    expect(await footprint(change.taskId)).toEqual(NOTHING_COMMITTED);
    expect((await fetchIdentityOrphans(db.pool, new Date())).map((o) => o.taskId)).not.toContain(change.taskId);
  });

  it("a rate-capped Class C/D change never yields COMPLETED-without-activation", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    for (const persona of ["one", "two", "three"]) await (await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, persona), "C")).apply();
    const fourth = await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "four"), "C");
    const refused = await fourth.apply().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IdentityRefusal);
    expect(String((refused as Error).message)).toContain("rate cap");
    expect(await footprint(fourth.taskId)).toEqual(NOTHING_COMMITTED);
  });

  it("a simulated transient activation failure rolls back completion/evidence/outcome, and retry converges to exactly one of each", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    const change = await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "retried persona"), "C");
    // Fail the activation insert - the LAST write in the transaction, after completion and version -
    // with a serialization failure (40001), which is transient: it must propagate unwrapped (so
    // Restate retries it), never be turned into a governance refusal that would FAIL the task.
    await db.pool.query("create table if not exists public.p7a_fail_activation(task_id uuid primary key)");
    await db.pool.query(
      // KJ-P8 B1: test sabotage reads a test-only table, so it runs with the owner's rights, not kj_worker's.
      "create or replace function public.p7a_fail_activation() returns trigger language plpgsql security definer set search_path = '' as $f$ " +
        "begin if exists (select 1 from public.p7a_fail_activation where task_id = new.request_task_id) then " +
        "raise exception 'simulated transient activation failure' using errcode = '40001'; end if; return new; end $f$",
    );
    await db.pool.query("create trigger p7a_fail_activation before insert on public.identity_activations for each row execute function public.p7a_fail_activation()");
    try {
      await db.pool.query("insert into public.p7a_fail_activation(task_id) values($1)", [change.taskId]);
      const failed = await change.apply().catch((error: unknown) => error);
      expect(failed).not.toBeInstanceOf(IdentityRefusal);
      expect(failed).toMatchObject({ code: "40001" });
      expect(await footprint(change.taskId)).toEqual(NOTHING_COMMITTED);

      await db.pool.query("delete from public.p7a_fail_activation where task_id=$1", [change.taskId]);
      const first = await change.apply();
      expect(first.replayed).toBe(false);
      // A retry after a COMMIT whose journal entry was lost: same inputs, same answer, nothing new.
      const again = await change.apply();
      expect(again.replayed).toBe(true);
      expect(again.activation.id).toBe(first.activation.id);
      expect(again.version.version).toBe(first.version.version);
      expect(await footprint(change.taskId)).toEqual({ status: "COMPLETED", outcomes: 1, evidence: 1, completed_events: 1, versions: 1, activations: 1 });
    } finally {
      await db.pool.query("drop trigger if exists p7a_fail_activation on public.identity_activations");
      await db.pool.query("drop function if exists public.p7a_fail_activation()");
      await db.pool.query("drop table if exists public.p7a_fail_activation");
    }
  });

  it("refuses to report success for a task that is COMPLETED without an activation (written outside this path)", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    const change = await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "orphaned"), "C");
    await completeExistingTask(change.taskId); // the old, non-atomic shape: completed, never activated
    await expect(change.apply()).rejects.toThrow(/no activation/);
  });
});

describe("a version/activation is bound to the task that proposed its candidate", () => {
  it("refuses a version created by any task other than the candidate's own proposing task", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const proposingTask = await mkVerifyingTask(tenantId, ownerId);
    const draft = doc(identityId, tenantId, { classC: { persona: "borrowed completion" } });
    const candidateId = await proposeOn(tenantId, identityId, proposingTask, draft, "C");
    const otherTask = await mkVerifyingTask(tenantId, ownerId);
    await completeExistingTask(otherTask);
    await expect(insertVersion(tenantId, identityId, 2, withVersion(draft, 2), candidateId, otherTask)).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("the task that proposed its candidate"),
    });
  });

  it("refuses an activation requested by a task other than the one that created its version", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const draft = doc(identityId, tenantId, { classC: { persona: "borrowed activation" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, draft, "C");
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 2, withVersion(draft, 2), candidateId, taskId);
    const otherTask = await mkVerifyingTask(tenantId, ownerId);
    await expect(insertActivation(tenantId, identityId, 2, candidateId, null, otherTask)).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("the task that created its version"),
    });
  });
});

describe("only the identity's owner may propose an operator change (finding 4, database layer)", () => {
  it("a second ACTIVE HUMAN member of the same tenant is refused before any candidate is written; the owner is not", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      secondHuman = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    const before = await db.pool.query("select count(*)::int as n from identity_candidates where identity_id=$1", [identityId]);
    const intruderTask = await mkVerifyingTask(tenantId, secondHuman);
    await expect(proposeOn(tenantId, identityId, intruderTask, fullDoc(identityId, tenantId, "not yours"), "C")).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("only the identity owner"),
    });
    const after = await db.pool.query("select count(*)::int as n from identity_candidates where identity_id=$1", [identityId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    await expect((await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "mine"), "C")).apply()).resolves.toBeTruthy();
  });
});

describe("an interrupted bootstrap (profile without an activated identity) is detectable and recoverable (finding 3)", () => {
  it("reproduces the interrupted state, surfaces it, and recovers it into the SAME profile with a new BOOTSTRAP", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    // The interruption: the profile and the first BOOTSTRAP candidate committed, then the bootstrap
    // task was refused and ended FAILED - nothing was ever activated.
    const identityId = await mkProfile(tenantId, ownerId);
    const firstTask = await mkVerifyingTask(tenantId, ownerId);
    const firstCandidate = await proposeOn(tenantId, identityId, firstTask, fullDoc(identityId, tenantId), "BOOTSTRAP");
    await db.pool.query("update identity_candidates set state='REJECTED', resolved_at=now() where id=$1", [firstCandidate]);
    await db.pool.query(`update tasks set status='FAILED', contract=jsonb_set(contract,'{status}','"FAILED"') where id=$1`, [firstTask]);

    // Surfaced by the health collector (past its grace period), and not mistaken for a D8 orphan.
    const later = new Date(Date.now() + 60 * 60_000);
    expect((await fetchIncompleteBootstraps(db.pool, later)).map((r) => r.identityId)).toContain(identityId);
    expect((await fetchIdentityOrphans(db.pool, later)).map((o) => o.taskId)).not.toContain(firstTask);

    // The pre-fix workflow chose Class "A" because a profile existed; the database requires BOOTSTRAP
    // while there is no head, so that request was refused and the identity was stuck for good.
    const wrongTask = await mkVerifyingTask(tenantId, ownerId);
    await expect(proposeOn(tenantId, identityId, wrongTask, fullDoc(identityId, tenantId), "A")).rejects.toMatchObject({ code: "23514" });

    // Recovery: a new BOOTSTRAP on the same profile, applied atomically.
    const recovery = await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId), "BOOTSTRAP");
    const { version } = await recovery.apply();
    expect(version).toMatchObject({ version: 1, governanceClass: "BOOTSTRAP" });
    const current = await db.pool.query("select version from identity_current where identity_id=$1", [identityId]);
    expect(current.rows[0].version).toBe(1);
    const profiles = await db.pool.query("select count(*)::int as n from identity_profiles where tenant_id=$1", [tenantId]);
    expect(profiles.rows[0].n).toBe(1);
    expect((await fetchIncompleteBootstraps(db.pool, later)).map((r) => r.identityId)).not.toContain(identityId);
  });
});

// ---------------------------------------------------------------------------------------------------
// KJ-P7A delta review (1df2d52): stale candidates (compare-and-swap) and approval binding.
// ---------------------------------------------------------------------------------------------------

async function currentDocument(identityId: string) {
  const r = await db.pool.query<{ version: number; document: ReturnType<typeof fullDoc> }>("select version, document from identity_current where identity_id=$1", [identityId]);
  return r.rows[0]!;
}

describe("a candidate may only apply onto the exact head it was proposed against (compare-and-swap)", () => {
  it("two candidates proposed against the same head: the first applies, the second is refused STALE and changes nothing", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    const first = await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "persona A"), "C");
    const second = await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "persona B"), "C");
    const bases = await db.pool.query("select base_version from identity_candidates where id = any($1::uuid[])", [[first.candidateId, second.candidateId]]);
    expect(bases.rows.map((r) => r.base_version)).toEqual([1, 1]);

    await first.apply();
    const refused = await second.apply().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IdentityRefusal);
    expect(String((refused as Error).message)).toContain("IDENTITY_CANDIDATE_STALE");
    expect(await footprint(second.taskId)).toEqual(NOTHING_COMMITTED);
    const current = await currentDocument(identityId);
    expect(current.version).toBe(2);
    expect(current.document.sections.classC.persona).toBe("persona A"); // A was not silently reverted
  });

  it("an approved Class A candidate is refused STALE if a Class C/D change landed underneath it while it waited for approval", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      approverId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    const constitutional = fullDoc(identityId, tenantId);
    constitutional.sections.classA.constitution = "A constitutional change that waited for approval.";
    const waiting = await proposeAndApply(tenantId, ownerId, identityId, constitutional, "A");
    const approvalId = await mkApproval(waiting.taskId, approverId, "GRANTED");
    await bindApproval(waiting.taskId, approvalId, waiting.candidateId);
    await db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [waiting.candidateId]);

    await (await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "landed underneath"), "C")).apply();

    // The approval's own HUMAN_DECISION evidence already exists; the refused apply must add nothing.
    const before = await footprint(waiting.taskId);
    expect(before).toEqual({ ...NOTHING_COMMITTED, evidence: 1 });
    const refused = await completeAndActivateIdentity(db.pool, { ...waiting.input, approvalId }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IdentityRefusal);
    expect(String((refused as Error).message)).toContain("IDENTITY_CANDIDATE_STALE");
    expect(await footprint(waiting.taskId)).toEqual(before);
    expect((await currentDocument(identityId)).document.sections.classC.persona).toBe("landed underneath");
  });

  it("the base token is derived by the database, never taken from the caller, and cannot be changed afterwards", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    const head = await db.pool.query<{ identity_core_digest: string }>("select identity_core_digest from identity_head where identity_id=$1", [identityId]);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const candidateId = randomUUID();
    await db.pool.query(
      `insert into identity_candidates(id,identity_id,tenant_id,document,proposed_digest,origin,governance_class,proposed_by_task,base_version,base_identity_core_digest)
       values($1,$2,$3,$4,$5,'OPERATOR_INSTRUCTION','C',$6,99,$7)`,
      [candidateId, identityId, tenantId, fullDoc(identityId, tenantId, "forged base"), H(), taskId, "b".repeat(64)],
    );
    const stored = await db.pool.query("select base_version, base_identity_core_digest from identity_candidates where id=$1", [candidateId]);
    expect(stored.rows[0]).toEqual({ base_version: 1, base_identity_core_digest: head.rows[0]!.identity_core_digest });
    await expect(db.pool.query("update identity_candidates set base_version=2 where id=$1", [candidateId])).rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query("update identity_candidates set base_identity_core_digest=$2 where id=$1", [candidateId, "c".repeat(64)])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("a Class A/ROLLBACK activation requires a GRANTED approval bound to this exact candidate and document (ADR-0021 D5)", () => {
  /** An APPROVED Class A candidate with its version already written - only the activation remains. */
  async function classAReadyToActivate() {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      approverId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changedA = doc(identityId, tenantId, { classA: { name: "approval-bound constitutional change" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changedA, "A");
    await db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [candidateId]);
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 2, withVersion(changedA, 2), candidateId, taskId);
    return { tenantId, ownerId, approverId, identityId, taskId, candidateId };
  }
  const activate = (s: Awaited<ReturnType<typeof classAReadyToActivate>>, approvalId: string) => insertActivation(s.tenantId, s.identityId, 2, s.candidateId, approvalId, s.taskId);

  it("PENDING same-task approval -> refused", async () => {
    const s = await classAReadyToActivate();
    const approvalId = await mkApproval(s.taskId, s.approverId, "PENDING");
    await bindApproval(s.taskId, approvalId, s.candidateId);
    await expect(activate(s, approvalId)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("GRANTED approval") });
  });

  it("DENIED same-task approval -> refused", async () => {
    const s = await classAReadyToActivate();
    const approvalId = await mkApproval(s.taskId, s.approverId, "DENIED");
    await bindApproval(s.taskId, approvalId, s.candidateId);
    await expect(activate(s, approvalId)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("GRANTED approval") });
  });

  it("GRANTED approval belonging to a different task -> refused", async () => {
    const s = await classAReadyToActivate();
    const otherTask = await mkVerifyingTask(s.tenantId, s.ownerId);
    const approvalId = await mkApproval(otherTask, s.approverId, "GRANTED");
    await expect(activate(s, approvalId)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("request task") });
  });

  it("GRANTED same-task approval with no binding, or bound to another candidate, another document or the wrong gate -> refused", async () => {
    const s = await classAReadyToActivate();
    const unbound = await mkApproval(s.taskId, s.approverId, "GRANTED");
    await expect(activate(s, unbound)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("not bound") });
    // Each forges exactly one field of the binding event; the decision must have been APPROVAL_REQUIRED.
    for (const forged of [{ candidateId: randomUUID() }, { digest: "d".repeat(64) }, { capabilityId: IDENTITY_APPLY_ROLLBACK.id }, { decision: "ALLOW" }, { decision: "DENY" }]) {
      const approvalId = await mkApproval(s.taskId, s.approverId, "GRANTED");
      await bindApproval(s.taskId, approvalId, s.candidateId, forged);
      await expect(activate(s, approvalId)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("not bound") });
    }
  });

  it("GRANTED same-task approval bound to this candidate and document -> accepted", async () => {
    const s = await classAReadyToActivate();
    const approvalId = await mkApproval(s.taskId, s.approverId, "GRANTED");
    await bindApproval(s.taskId, approvalId, s.candidateId);
    await expect(activate(s, approvalId)).resolves.toBeTruthy();
    const current = await db.pool.query("select version from identity_current where identity_id=$1", [s.identityId]);
    expect(current.rows[0].version).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------
// KJ-P7A hostile seal pass (04fd7bb): D7 default freeze and D6 policy on every Class C/D change.
// ---------------------------------------------------------------------------------------------------

/** A C/D (or other) candidate on a fresh task with NO policy decision written - the caller decides. */
async function proposeUnpolicied(tenantId: string, ownerId: string, identityId: string, draft: ReturnType<typeof fullDoc>, requested: string) {
  const taskId = await mkVerifyingTask(tenantId, ownerId);
  const candidateId = await proposeOn(tenantId, identityId, taskId, draft, requested);
  const input = applyInput(tenantId, identityId, taskId, candidateId, draft);
  return { taskId, candidateId, input, apply: (approvalId: string | null = null) => completeAndActivateIdentity(db.pool, { ...input, approvalId }) };
}
function withVision(identityId: string, tenantId: string, vision: string) {
  const d = fullDoc(identityId, tenantId);
  d.sections.classD.vision = vision;
  return d;
}

describe("ADR-0021 D7: Class C/D is frozen by default after bootstrap - no manual freeze call needed", () => {
  it("BOOTSTRAP then an immediate Class C and Class D change are both refused with no governance-state row at all; opening the window is the only thing that lets the same candidate apply", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId, { keepFrozen: true });
    const state = await db.pool.query("select count(*)::int as n from kernel_private.identity_governance_state where identity_id=$1", [identityId]);
    expect(state.rows[0].n).toBe(0); // nobody called set_identity_freeze

    const persona = await proposeAndApply(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "right after bootstrap"), "C");
    const refusedC = await persona.apply().catch((error: unknown) => error);
    expect(refusedC).toBeInstanceOf(IdentityRefusal);
    expect(String((refusedC as Error).message)).toContain("frozen");
    expect(await footprint(persona.taskId)).toEqual(NOTHING_COMMITTED);

    const vision = await proposeAndApply(tenantId, ownerId, identityId, withVision(identityId, tenantId, "right after bootstrap"), "D");
    const refusedD = await vision.apply().catch((error: unknown) => error);
    expect(refusedD).toBeInstanceOf(IdentityRefusal);
    expect(String((refusedD as Error).message)).toContain("frozen");
    expect(await footprint(vision.taskId)).toEqual(NOTHING_COMMITTED);

    await openTestChangeWindow(identityId); // explicit disposable test-only change window
    await expect(persona.apply()).resolves.toMatchObject({ version: { version: 2, governanceClass: "C" } });
  });

  it("an approved Class A change remains available under the default freeze", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      approverId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId, { keepFrozen: true });
    const constitutional = fullDoc(identityId, tenantId);
    constitutional.sections.classA.constitution = "An approved constitutional change during the default freeze.";
    const change = await proposeUnpolicied(tenantId, ownerId, identityId, constitutional, "A");
    const approvalId = await mkApproval(change.taskId, approverId, "GRANTED");
    await bindApproval(change.taskId, approvalId, change.candidateId);
    await db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [change.candidateId]);
    await expect(change.apply(approvalId)).resolves.toMatchObject({ version: { version: 2, governanceClass: "A" } });
  });

  it("an emergency HUMAN-approved rollback to an already-activated version remains available under the default freeze", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      approverId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId, { keepFrozen: true });
    const approve = async (c: Awaited<ReturnType<typeof proposeUnpolicied>>, gate: string) => {
      const approvalId = await mkApproval(c.taskId, approverId, "GRANTED");
      await bindApproval(c.taskId, approvalId, c.candidateId, { capabilityId: gate });
      await db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [c.candidateId]);
      return approvalId;
    };
    const constitutional = fullDoc(identityId, tenantId);
    constitutional.sections.classA.constitution = "A change the operator will need to revert.";
    const forward = await proposeUnpolicied(tenantId, ownerId, identityId, constitutional, "A");
    await forward.apply(await approve(forward, IDENTITY_APPLY_A.id));

    const revert = await proposeUnpolicied(tenantId, ownerId, identityId, fullDoc(identityId, tenantId), "ROLLBACK");
    await expect(revert.apply(await approve(revert, IDENTITY_APPLY_ROLLBACK.id))).resolves.toMatchObject({ version: { version: 3, governanceClass: "ROLLBACK" } });
    const current = await currentDocument(identityId);
    expect(current.document.sections.classA.constitution).toBe(fullDoc(identityId, tenantId).sections.classA.constitution);
  });
});

describe("ADR-0021 D6: every Class C/D change needs a persisted ALLOW policy decision bound to it", () => {
  it("refuses a Class C/D activation with no policy decision at all", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    const change = await proposeUnpolicied(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "never went through policy"), "C");
    const refused = await change.apply().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IdentityRefusal);
    expect(String((refused as Error).message)).toContain("ALLOW policy decision");
    expect(await footprint(change.taskId)).toEqual(NOTHING_COMMITTED);
  });

  it("refuses a DENY decision, and an ALLOW bound to another candidate, another document or another class's gate", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    const forgeries: PolicyOverrides[] = [
      { decision: "DENY" },
      { candidateId: randomUUID() },
      { digest: "e".repeat(64) },
      { capabilityId: IDENTITY_APPLY_D.id }, // a Class D rule must never authorise a Class C change
      { capabilityId: IDENTITY_APPLY_A.id },
    ];
    for (const [i, forged] of forgeries.entries()) {
      const change = await proposeUnpolicied(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, `forged policy ${i}`), "C");
      await allowPolicy(change.taskId, change.candidateId, forged);
      const refused = await change.apply().catch((error: unknown) => error);
      expect(refused, JSON.stringify(forged)).toBeInstanceOf(IdentityRefusal);
      expect(String((refused as Error).message)).toContain("ALLOW policy decision");
      expect(await footprint(change.taskId)).toEqual(NOTHING_COMMITTED);
    }
  });

  it("accepts a Class C change and a Class D change each ALLOWed under its own gate", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const identityId = await bootstrapAtomically(tenantId, ownerId);
    const persona = await proposeUnpolicied(tenantId, ownerId, identityId, fullDoc(identityId, tenantId, "allowed persona"), "C");
    await allowPolicy(persona.taskId, persona.candidateId, { capabilityId: IDENTITY_APPLY_C.id });
    await expect(persona.apply()).resolves.toMatchObject({ version: { version: 2, governanceClass: "C" } });
    const current = await currentDocument(identityId);
    const { version: _drop, ...draft } = current.document as ReturnType<typeof fullDoc> & { version: number };
    draft.sections.classD.vision = "allowed vision";
    const vision = await proposeUnpolicied(tenantId, ownerId, identityId, draft, "D");
    await allowPolicy(vision.taskId, vision.candidateId, { capabilityId: IDENTITY_APPLY_D.id });
    await expect(vision.apply()).resolves.toMatchObject({ version: { version: 3, governanceClass: "D" } });
  });
});

describe("ADR-0021 D6: a Class C/D version must leave the Class A bytes identical", () => {
  it("refuses a Class C version whose class_a_digest differs from the head's", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changed = doc(identityId, tenantId, { classC: { persona: "claims to be C" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changed, "C");
    await completeExistingTask(taskId);
    // Everything else about this version is valid; only its Class A digest disagrees with the head's.
    await expect(
      db.pool.query(
        `insert into identity_versions(id,identity_id,tenant_id,version,document,identity_core_digest,class_a_digest,governance_class,candidate_id,created_by_task)
         values($1,$2,$3,2,$4,$5,$6,'IGNORED',$7,$8)`,
        [randomUUID(), identityId, tenantId, withVersion(changed, 2), identityCoreDigestV1(withVersion(changed, 2)), "f".repeat(64), candidateId, taskId],
      ),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("Class A bytes identical") });
  });
});

// ---------------------------------------------------------------------------------------------------
// KJ-P7A final seal (aa53db5): BOOTSTRAP only via a COMPLETED change task + a GRANTED HUMAN approval,
// bound to the exact candidate, proposed digest and task under IDENTITY_APPLY_BOOTSTRAP.
// ---------------------------------------------------------------------------------------------------

describe("BOOTSTRAP requires a GRANTED HUMAN approval bound to this candidate, document and task under IDENTITY_APPLY_BOOTSTRAP", () => {
  /** A HELD BOOTSTRAP candidate with its task COMPLETED and version 1 written - only the activation remains. */
  async function bootstrapReadyToActivate() {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN"),
      approverId = await mkPrincipal(tenantId, "HUMAN"),
      identityId = await mkProfile(tenantId, ownerId);
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const candidateId = await proposeOn(tenantId, identityId, taskId, doc(identityId, tenantId), "BOOTSTRAP");
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 1, withVersion(doc(identityId, tenantId), 1), candidateId, taskId);
    return { tenantId, ownerId, approverId, identityId, taskId, candidateId };
  }
  type Ready = Awaited<ReturnType<typeof bootstrapReadyToActivate>>;
  const activate = (s: Ready, approvalId: string | null) => insertActivation(s.tenantId, s.identityId, 1, s.candidateId, approvalId, s.taskId);
  const markApproved = (s: Ready) => db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [s.candidateId]);
  const activations = async (s: Ready) => (await db.pool.query("select count(*)::int as n from identity_activations where identity_id=$1", [s.identityId])).rows[0].n;

  it("refuses a BOOTSTRAP activation with no approval at all", async () => {
    const s = await bootstrapReadyToActivate();
    await markApproved(s);
    await expect(activate(s, null)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("require a granted approval") });
  });

  it("refuses a HELD (not APPROVED) BOOTSTRAP candidate even with a bound GRANTED approval - no HELD exception for BOOTSTRAP", async () => {
    const s = await bootstrapReadyToActivate();
    const approvalId = await mkApproval(s.taskId, s.approverId, "GRANTED");
    await bindApproval(s.taskId, approvalId, s.candidateId, { capabilityId: IDENTITY_APPLY_BOOTSTRAP.id });
    await expect(activate(s, approvalId)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("APPROVED candidate") });
  });

  it("refuses PENDING, DENIED and EXPIRED approvals", async () => {
    const s = await bootstrapReadyToActivate();
    await markApproved(s);
    for (const status of ["PENDING", "DENIED", "EXPIRED"] as const) {
      const approvalId = await mkApproval(s.taskId, s.approverId, status);
      await bindApproval(s.taskId, approvalId, s.candidateId, { capabilityId: IDENTITY_APPLY_BOOTSTRAP.id });
      await expect(activate(s, approvalId), status).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("GRANTED approval") });
    }
    expect(await activations(s)).toBe(0);
  });

  it("refuses a GRANTED approval belonging to another task", async () => {
    const s = await bootstrapReadyToActivate();
    await markApproved(s);
    const otherTask = await mkVerifyingTask(s.tenantId, s.ownerId);
    const approvalId = await mkApproval(otherTask, s.approverId, "GRANTED");
    await expect(activate(s, approvalId)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("request task") });
  });

  it("refuses a GRANTED same-task approval bound to another candidate, another document, the Class A gate, or with a non-APPROVAL_REQUIRED decision", async () => {
    const s = await bootstrapReadyToActivate();
    await markApproved(s);
    const forgeries: PolicyOverrides[] = [
      { capabilityId: IDENTITY_APPLY_BOOTSTRAP.id, candidateId: randomUUID() },
      { capabilityId: IDENTITY_APPLY_BOOTSTRAP.id, digest: "d".repeat(64) },
      { capabilityId: IDENTITY_APPLY_A.id }, // Class A's gate must never authorise a bootstrap
      { capabilityId: IDENTITY_APPLY_BOOTSTRAP.id, decision: "ALLOW" },
    ];
    for (const forged of forgeries) {
      const approvalId = await mkApproval(s.taskId, s.approverId, "GRANTED");
      await bindApproval(s.taskId, approvalId, s.candidateId, forged);
      await expect(activate(s, approvalId), JSON.stringify(forged)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("not bound") });
    }
    expect(await activations(s)).toBe(0);
  });

  it("accepts a GRANTED approval bound to this candidate and document under the BOOTSTRAP gate: exactly one v1 activation", async () => {
    const s = await bootstrapReadyToActivate();
    await markApproved(s);
    const approvalId = await mkApproval(s.taskId, s.approverId, "GRANTED");
    await bindApproval(s.taskId, approvalId, s.candidateId, { capabilityId: IDENTITY_APPLY_BOOTSTRAP.id });
    await expect(activate(s, approvalId)).resolves.toBeTruthy();
    const rows = await db.pool.query("select version, governance_class, approval_id from identity_activations where identity_id=$1", [s.identityId]);
    expect(rows.rows).toEqual([{ version: 1, governance_class: "BOOTSTRAP", approval_id: approvalId }]);
  });

  it("the approval requirement holds in two independent layers: the trigger alone (CHECK dropped) and the CHECK alone (triggers disabled)", async () => {
    const s = await bootstrapReadyToActivate();
    await markApproved(s);
    const sql = `insert into identity_activations(id,identity_id,tenant_id,version,governance_class,candidate_id,approval_id,request_task_id) values($1,$2,$3,1,'BOOTSTRAP',$4,null,$5)`;
    await inRolledBackTransaction(async (client) => {
      const checks = await client.query(
        "select conname from pg_constraint where conrelid='public.identity_activations'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%approval_id IS NOT NULL%'",
      );
      expect(checks.rowCount).toBe(1);
      await client.query(`alter table public.identity_activations drop constraint "${checks.rows[0].conname}"`);
      await expect(client.query(sql, [randomUUID(), s.identityId, s.tenantId, s.candidateId, s.taskId])).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("require a granted approval"),
      });
    });
    await inRolledBackTransaction(async (client) => {
      await client.query("set local session_replication_role = replica"); // user triggers do not fire
      await expect(client.query(sql, [randomUUID(), s.identityId, s.tenantId, s.candidateId, s.taskId])).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("identity_activations"),
      });
    });
  });
});

describe("a second bootstrap is still refused once an identity exists", () => {
  it("refuses a second profile for the tenant, and a BOOTSTRAP-requested candidate is reclassified, never BOOTSTRAP", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    await expect(mkProfile(tenantId, ownerId)).rejects.toMatchObject({ code: "23505" });
    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const candidateId = await proposeOn(tenantId, identityId, taskId, doc(identityId, tenantId, { classA: { name: "a second bootstrap" } }), "BOOTSTRAP");
    const stored = await db.pool.query("select governance_class from identity_candidates where id=$1", [candidateId]);
    expect(stored.rows[0].governance_class).toBe("A"); // derived from the diff against the head
    const versions = await db.pool.query("select count(*)::int as n from identity_versions where identity_id=$1 and governance_class='BOOTSTRAP'", [identityId]);
    expect(versions.rows[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------
// KJ-P7A production pre-commit qualification (2026-09-28): the production Supabase database carries
// default privileges in schema `public` (postgres-owned relations: anon/authenticated `Dxtm`), so every
// relation the migration creates is born WITH grants unless the migration revokes them. The disposable
// test Postgres has no such default ACL, which is how the two views shipped without a revoke and still
// passed. This block reproduces that condition - a Supabase-style default ACL granting ALL on tables
// (a superset of production's Dxtm, so a privilege Supabase adds later is caught too) - in its own
// fresh database BEFORE the migrations run, then inspects the ACL catalog directly.
// ---------------------------------------------------------------------------------------------------

