import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { completeIdentityTask } from "../services/kernel/src/identity/complete.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";

/**
 * KJ-P7A - the primary identity migration (ADR-0021) against real Postgres. Exercises the DB
 * triggers directly with raw SQL, independent of IdentityChangeWorkflowV1, so a bug in the
 * database's own enforcement can never hide behind a correct workflow - but reuses the REAL
 * completeIdentityTask (identity/complete.ts) for task completion rather than a hand-rolled
 * approximation, which is exactly what caught a real bug live: a raw `status='COMPLETED'` insert
 * with an empty evidenceRefs array looked fine until check_task_completion()
 * (20260905153704_intelligence_metadata.sql) refused it - and so would every real call to
 * completeIdentityTask have, before that function was fixed to write a real evidence row first.
 *
 * Mirrors tests/memory-canonical.integration.test.ts's "against a real Postgres. Every refusal
 * below that says 'in the database' is the schema refusing, with the application bypassed"
 * discipline.
 */

let db: Awaited<ReturnType<typeof knowledgeDatabase>>;

beforeAll(async () => {
  db = await knowledgeDatabase();
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
/** Runs the REAL completeIdentityTask against an existing VERIFYING task. */
async function completeExistingTask(taskId: string): Promise<void> {
  const proofMetadata = { probe: randomUUID() };
  await completeIdentityTask(
    db.pool,
    taskId,
    "identity change applied",
    { evidenceId: randomUUID(), digest: capabilityDigest(proofMetadata), metadata: proofMetadata },
    { eventId: randomUUID(), at: new Date().toISOString() },
  );
}
async function mkApproval(taskId: string, approverId: string, status: "PENDING" | "GRANTED" | "DENIED" = "GRANTED"): Promise<string> {
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

const H = () => "a".repeat(64); // a well-formed placeholder digest; the app layer computes the real one, the DB only checks shape.

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
     values($1,$2,$3,$4,$5,$6,$6,'IGNORED',$7,$8)`,
    [versionId, identityId, tenantId, version, document, H(), candidateId, taskId],
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
  let approvalId: string | null = null;
  if (opts.approverId) {
    approvalId = await mkApproval(taskId, opts.approverId, "GRANTED");
    await db.pool.query("update identity_candidates set state='APPROVED', resolved_at=now() where id=$1", [candidateId]);
  }
  await completeExistingTask(taskId);
  const head = await db.pool.query("select version from public.identity_head where identity_id=$1", [identityId]);
  const version = (head.rows[0]?.version ?? 0) + 1;
  await insertVersion(tenantId, identityId, version, withVersion(document, version), candidateId, taskId);
  const activationId = await insertActivation(tenantId, identityId, version, candidateId, approvalId, taskId);
  return { identityId, taskId, candidateId, activationId, version };
}

async function bootstrap(tenantId: string, ownerId: string) {
  const identityId = await mkProfile(tenantId, ownerId);
  const result = await change(tenantId, ownerId, identityId, doc(identityId, tenantId), "BOOTSTRAP");
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

  it("the equivalent OPERATOR_INSTRUCTION BOOTSTRAP candidate, HELD, activates cleanly (the fix does not break the real path)", async () => {
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
    await expect(db.pool.query("delete from identity_versions where identity_id=$1", [identityId])).rejects.toBeTruthy();
    await expect(db.pool.query("truncate identity_versions")).rejects.toBeTruthy();
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
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 5, withVersion(changed, 5), candidateId, taskId);
    await expect(insertActivation(tenantId, identityId, 5, candidateId, null, taskId)).rejects.toMatchObject({ code: "23514" });
  });

  it("kernel_private.set_identity_freeze blocks a subsequent Class C/D activation, but not a Class A one with approval", async () => {
    const tenantId = await mkTenant(),
      ownerId = await mkPrincipal(tenantId, "HUMAN");
    const { identityId } = await bootstrap(tenantId, ownerId);
    await db.pool.query("select kernel_private.set_identity_freeze($1,true,'P7A: frozen pending P7B G13')", [identityId]);

    const taskId = await mkVerifyingTask(tenantId, ownerId);
    const changed = doc(identityId, tenantId, { classC: { persona: "should be frozen" } });
    const candidateId = await proposeOn(tenantId, identityId, taskId, changed, "C");
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 2, withVersion(changed, 2), candidateId, taskId);
    await expect(insertActivation(tenantId, identityId, 2, candidateId, null, taskId)).rejects.toMatchObject({ code: "23514" });

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
    await completeExistingTask(taskId);
    await insertVersion(tenantId, identityId, 1, withVersion(doc(identityId, tenantId), 1), candidateId, taskId);
    await insertActivation(tenantId, identityId, 1, candidateId, null, taskId);
    // A second activation for the exact same candidate - a distinct row, a distinct request_task_id
    // (so that unique constraint alone would not catch it), but the same candidate_id.
    const secondTaskId = await mkVerifyingTask(tenantId, ownerId);
    await completeExistingTask(secondTaskId);
    await expect(insertActivation(tenantId, identityId, 1, candidateId, null, secondTaskId)).rejects.toMatchObject({ code: "23505" });
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
