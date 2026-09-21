import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import type { PrincipalRef, TenantContext } from "../packages/contracts/src/index.js";
import { CanonicalMemory, MemoryError } from "../services/memory/src/canonical/service.js";
import { PgPromotionApprovals } from "../services/memory/src/canonical/approval-binding.js";
import { SharedBrainBoundary, type SharedBrainDocument } from "../services/memory/src/canonical/sharedbrain.js";
import { ApprovalStore } from "../services/kernel/src/approval-store.js";

/**
 * KJ-P5 against a real Postgres. Every refusal below that says "in the database" is the schema refusing, with the
 * application bypassed, because the authority rule must hold even if service code is wrong.
 */
let db: Awaited<ReturnType<typeof knowledgeDatabase>>;
let memory: CanonicalMemory;
let tenantId: string;
let owner: TenantContext;
let member: TenantContext;
let service: TenantContext;
let other: TenantContext;
let approver: PrincipalRef;
let clock = new Date();

const key = () => `test-key-${randomUUID()}`;
const evidence = (ref: string = randomUUID()) => [{ type: "TELEGRAM_UPDATE" as const, ref: `update:${ref}` }];
const submission = (o: Record<string, unknown> = {}) => ({
  idempotencyKey: key(),
  class: "PREFERENCE",
  content: "I prefer concise deployment summaries unless I explicitly ask for detail",
  subject: { kind: "PRINCIPAL", ref: owner.principal.id },
  evidence: evidence(),
  reason: "operator said remember this",
  ...o,
});
const count = async (table: string) => Number((await db.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n);
const rejects = async (sql: string, params: unknown[] = []) => {
  const c = await db.pool.connect();
  try {
    await c.query("begin");
    await c.query(sql, params);
    await c.query("commit");
    return null;
  } catch (error) {
    await c.query("rollback");
    return error as { code?: string; message: string };
  } finally {
    c.release();
  }
};

beforeAll(async () => {
  db = await knowledgeDatabase();
  tenantId = db.context.tenantId;
  const add = async (kind: "HUMAN" | "SERVICE", role: string, tenant = tenantId): Promise<TenantContext> => {
    const principal: PrincipalRef = { id: randomUUID(), kind };
    await db.pool.query("insert into principals(id,kind) values($1,$2)", [principal.id, kind]);
    await db.pool.query("insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,$3)", [tenant, principal.id, role]);
    return { tenantId: tenant, principal };
  };
  owner = await add("HUMAN", "owner");
  member = await add("HUMAN", "member");
  service = await add("SERVICE", "member");
  const approverCtx = await add("HUMAN", "reviewer");
  approver = approverCtx.principal;
  const otherTenant = randomUUID();
  await db.pool.query("insert into tenants(id,name) values($1,'other-tenant')", [otherTenant]);
  other = await add("HUMAN", "owner", otherTenant);
  memory = new CanonicalMemory(db.pool, {
    now: () => clock,
    approvals: new PgPromotionApprovals(db.pool, { approver, ttlMs: 60_000 }, () => clock),
  });
});
afterAll(async () => {
  await db?.close();
});

describe("candidate to canonical memory", () => {
  it("promotes an explicit operator instruction with full provenance", async () => {
    const ev = evidence("tg-1001");
    const r = await memory.submitOperatorInstruction(owner, submission({ evidence: ev }));
    expect(r).toMatchObject({ origin: "OPERATOR_INSTRUCTION", state: "PROMOTED", decision: "ALLOW", version: 1, replayed: false });
    const view = await memory.find(owner, r.memoryId as string);
    expect(view?.status).toBe("CURRENT");
    const v = view?.head;
    expect(v).toMatchObject({ class: "PREFERENCE", trustClass: "USER_AUTHORED", confidence: "STATED", candidateId: r.candidateId, supersedesVersion: null });
    expect(v?.evidence).toEqual(ev);
    expect(v?.provenance).toMatchObject({ origin: "OPERATOR_INSTRUCTION", submittedBy: owner.principal.id, candidateId: r.candidateId });
    expect(v?.policy).toMatchObject({ decision: "ALLOW", ruleId: "operator-instruction", approvalId: null });
    const promo = await db.pool.query("select * from memory_promotions where candidate_id=$1", [r.candidateId]);
    expect(promo.rows).toHaveLength(1);
    expect(promo.rows[0]).toMatchObject({ decision: "ALLOW", promoted_by_kind: "POLICY_ENGINE", promoted_by_principal: owner.principal.id, result_memory_id: r.memoryId, result_version: 1 });
    expect(promo.rows[0].evidence).toEqual(ev);
  });

  it("does not duplicate on replay, including concurrent replays", async () => {
    const s = submission({ idempotencyKey: "replay-key-1" });
    const before = [await count("memory_candidates"), await count("memory_promotions"), await count("memory_versions")];
    const results = await Promise.all(Array.from({ length: 6 }, () => memory.submitOperatorInstruction(owner, s)));
    expect(new Set(results.map((r) => `${r.candidateId}:${r.memoryId}:${r.version}`)).size).toBe(1);
    expect(results.filter((r) => !r.replayed).length).toBe(1);
    const after = [await count("memory_candidates"), await count("memory_promotions"), await count("memory_versions")];
    expect(after).toEqual(before.map((n) => n + 1));
    const again = await memory.submitOperatorInstruction(owner, s);
    expect(again.replayed).toBe(true);
    expect(await count("memory_versions")).toBe(after[2]);
  });

  it("refuses the same idempotency key with different content", async () => {
    const s = submission({ idempotencyKey: "conflict-key-1" });
    await memory.submitOperatorInstruction(owner, s);
    await expect(memory.submitOperatorInstruction(owner, { ...s, content: "something else entirely" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("requires a human for an operator instruction and a service for a verified outcome", async () => {
    await expect(async () => memory.submitOperatorInstruction(service, submission())).rejects.toBeInstanceOf(MemoryError);
    await expect(async () => memory.submitVerifiedOutcomeCandidate(owner, submission())).rejects.toBeInstanceOf(MemoryError);
  });

  it("refuses content that looks like a credential, whatever the origin", async () => {
    const r = await memory.submitOperatorInstruction(owner, submission({ content: "my key is sk-abcdefghijklmnopqrstuvwxyz0123456789" }));
    expect(r).toMatchObject({ state: "REFUSED", decision: "REFUSE", ruleId: "no-secrets", memoryId: null });
  });

  it("scopes personal memories to their own subject", async () => {
    const r = await memory.submitOperatorInstruction(member, submission({ subject: { kind: "PRINCIPAL", ref: owner.principal.id } }));
    expect(r).toMatchObject({ state: "REFUSED", ruleId: "subject-scope" });
  });
});

describe("models and the Shared Brain can only ever submit candidates", () => {
  it("holds a model candidate and creates no canonical memory", async () => {
    const versions = await count("memory_versions");
    const r = await memory.submitModelCandidate(service, submission({ subject: { kind: "TENANT", ref: tenantId }, content: "the model says the user likes tea" }));
    expect(r).toMatchObject({ origin: "MODEL_PROPOSAL", state: "HELD", decision: "HOLD", memoryId: null, version: null });
    expect(await count("memory_versions")).toBe(versions);
  });

  it("holds a model candidate that claims to be a correction, a retraction or a supersession", async () => {
    const base = await memory.submitOperatorInstruction(owner, submission());
    for (const intent of ["CORRECT", "SUPERSEDE", "RETRACT"] as const) {
      const r = await memory.submitModelCandidate(service, submission({ intent, targetMemoryId: base.memoryId, content: "changed by a model", subject: { kind: "PRINCIPAL", ref: owner.principal.id } }));
      expect(r.state).toBe("HELD");
    }
    expect((await memory.find(owner, base.memoryId as string))?.versions).toHaveLength(1);
  });

  it("keeps Shared Brain material as held candidates and as untrusted external context", async () => {
    const docs: SharedBrainDocument[] = [
      { ref: "doc-1", kind: "CANDIDATE_MEMORY", text: "Jonny always deploys on Fridays", proposedClass: "FACT" },
      { ref: "doc-2", kind: "KNOWLEDGE", text: "Restate journals request headers" },
    ];
    const boundary = new SharedBrainBoundary({ search: async () => docs }, memory);
    const versions = await count("memory_versions");
    const { submitted, skipped } = await boundary.proposeCandidates(owner, "deploy");
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ origin: "SHARED_BRAIN", state: "HELD", memoryId: null });
    expect(skipped).toBe(1);
    expect(await count("memory_versions")).toBe(versions);
    const external = await boundary.contextFor(owner, "deploy");
    expect(external.every((e) => e.trustClass === "UNTRUSTED_EXTERNAL" && e.ref.startsWith("shared-brain:"))).toBe(true);
  });

  it("refuses, in the database, every direct route from a model or Shared Brain candidate to canonical memory", async () => {
    const model = await memory.submitModelCandidate(service, submission({ subject: { kind: "TENANT", ref: tenantId } }));
    const brain = await memory.submitExternalCandidate(service, submission({ subject: { kind: "TENANT", ref: tenantId } }));
    for (const c of [model, brain]) {
      const promotion = await rejects(
        "insert into memory_promotions(id,tenant_id,candidate_id,decision,rule_id,policy_version,reason,promoted_by_kind,evidence,result_memory_id,result_version) values($1,$2,$3,'ALLOW','forged','x','forged','POLICY_ENGINE','[{\"type\":\"TELEGRAM_UPDATE\",\"ref\":\"x\"}]'::jsonb,$4,1)",
        [randomUUID(), tenantId, c.candidateId, randomUUID()],
      );
      expect(promotion?.code).toBe("23514");
      const approved = await rejects(
        "insert into memory_promotions(id,tenant_id,candidate_id,decision,rule_id,policy_version,reason,promoted_by_kind,evidence,result_memory_id,result_version,approval_id) values($1,$2,$3,'ALLOW_APPROVED','forged','x','forged','APPROVED_HUMAN','[{\"type\":\"TELEGRAM_UPDATE\",\"ref\":\"x\"}]'::jsonb,$4,1,$5)",
        [randomUUID(), tenantId, c.candidateId, randomUUID(), randomUUID()],
      );
      expect(approved).not.toBeNull();
    }
    const forgedCandidate = await rejects(
      "insert into memory_candidates(id,tenant_id,origin,submitted_by,idempotency_key,proposed_class,intent,content,content_digest,subject_kind,subject_ref,evidence,reason,request_digest,state,state_reason) values($1,$2,'MODEL_PROPOSAL',$3,$4,'FACT','NEW','x',$5,'TENANT','tenant','[{\"type\":\"MODEL_CALL\",\"ref\":\"x\"}]'::jsonb,'r',$5,'PROMOTED','forged')",
      [randomUUID(), tenantId, service.principal.id, key(), "a".repeat(64)],
    );
    expect(forgedCandidate?.code).toBe("23514");
    const orphanVersion = await rejects(
      "insert into memory_versions(memory_id,version,tenant_id,class,kind,content,content_digest,subject_kind,subject_ref,trust_class,confidence,provenance,evidence,policy,candidate_id,promotion_id,created_at) values($1,1,$2,'FACT','ASSERT','x',$3,'TENANT',$2,'MODEL_DERIVED','INFERRED','{}'::jsonb,'[{\"type\":\"MODEL_CALL\",\"ref\":\"x\"}]'::jsonb,'{}'::jsonb,$4,$5,now())",
      [randomUUID(), tenantId, "a".repeat(64), model.candidateId, randomUUID()],
    );
    expect(orphanVersion).not.toBeNull();
  });

  it("refuses, in the database, a version whose trust class is not the one its origin earns", async () => {
    const r = await memory.submitOperatorInstruction(owner, submission());
    const promotion = await db.pool.query("select id from memory_promotions where candidate_id=$1", [r.candidateId]);
    // A second version by the same promotion is impossible (unique promotion), so forge a fresh promotion for the same candidate.
    const err = await rejects(
      "insert into memory_versions(memory_id,version,tenant_id,class,kind,content,content_digest,subject_kind,subject_ref,trust_class,confidence,provenance,evidence,policy,candidate_id,promotion_id,supersedes_version,created_at) select memory_id,2,tenant_id,class,'ASSERT','forged',$2,subject_kind,subject_ref,'INTERNAL_DERIVED',confidence,provenance,evidence,policy,candidate_id,$1,1,created_at from memory_versions where memory_id=$3 and version=1",
      [promotion.rows[0].id, "b".repeat(64), r.memoryId],
    );
    expect(err).not.toBeNull();
  });
});

describe("append-only history: correction, supersession, retraction", () => {
  it("corrects a memory as a new version and lists only the current one", async () => {
    const first = await memory.submitOperatorInstruction(owner, submission({ content: "Jonny prefers detailed summaries", subject: { kind: "PRINCIPAL", ref: owner.principal.id } }));
    const fix = await memory.submitOperatorInstruction(owner, submission({ intent: "CORRECT", targetMemoryId: first.memoryId, content: "Jonny now prefers concise summaries" }));
    expect(fix).toMatchObject({ state: "PROMOTED", memoryId: first.memoryId, version: 2 });
    const view = await memory.find(owner, first.memoryId as string);
    expect(view?.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(view?.versions[0]?.content).toBe("Jonny prefers detailed summaries");
    expect(view?.head.content).toBe("Jonny now prefers concise summaries");
    expect(view?.head.supersedesVersion).toBe(1);
    expect(view?.versions.every((v) => v.evidence.length >= 1 && v.provenance.candidateId.length > 0)).toBe(true);
    const current = await memory.listCurrent(owner);
    expect(current.filter((m) => m.memoryId === first.memoryId).map((m) => m.version)).toEqual([2]);
    const older = await db.pool.query("select content from memory_versions where memory_id=$1 and version=1", [first.memoryId]);
    expect(older.rows[0].content).toBe("Jonny prefers detailed summaries");
  });

  it("supersedes a memory with a new one and stops selecting the old one", async () => {
    const old = await memory.submitOperatorInstruction(owner, submission({ class: "FACT", content: "the staging server is in Frankfurt" }));
    const next = await memory.submitOperatorInstruction(owner, submission({ class: "FACT", intent: "SUPERSEDE", targetMemoryId: old.memoryId, content: "the staging server is in London" }));
    expect(next).toMatchObject({ state: "PROMOTED", version: 1 });
    expect(next.memoryId).not.toBe(old.memoryId);
    const oldView = await memory.find(owner, old.memoryId as string);
    expect(oldView).toMatchObject({ status: "SUPERSEDED", supersededBy: next.memoryId });
    const newView = await memory.find(owner, next.memoryId as string);
    expect(newView?.supersedes).toEqual([old.memoryId]);
    const ctx = await memory.assemble(owner, { purpose: "where is the staging server", allowedClasses: ["FACT"], budget: { maxItems: 10, maxTokens: 500 } });
    const ids = ctx.items.map((i) => i.memoryId);
    expect(ids).toContain(next.memoryId);
    expect(ids).not.toContain(old.memoryId);
    const again = await memory.submitOperatorInstruction(owner, submission({ intent: "CORRECT", targetMemoryId: old.memoryId, class: "FACT", content: "too late" }));
    expect(again).toMatchObject({ state: "REFUSED", ruleId: "target-superseded" });
  });

  it("retracts without erasing: history stays, the memory leaves retrieval, and it cannot be built on", async () => {
    const m = await memory.submitOperatorInstruction(owner, submission({ content: "I prefer tabs over spaces" }));
    const gone = await memory.submitOperatorInstruction(owner, submission({ intent: "RETRACT", targetMemoryId: m.memoryId, content: "", reason: "operator asked to forget this" }));
    expect(gone).toMatchObject({ state: "PROMOTED", version: 2 });
    const view = await memory.find(owner, m.memoryId as string);
    expect(view?.status).toBe("RETRACTED");
    expect(view?.head.kind).toBe("RETRACT");
    expect(view?.versions[0]?.content).toBe("I prefer tabs over spaces");
    expect((await memory.listCurrent(owner)).some((x) => x.memoryId === m.memoryId)).toBe(false);
    const ctx = await memory.assemble(owner, { purpose: "tabs or spaces", allowedClasses: ["PREFERENCE"], budget: { maxItems: 10, maxTokens: 500 } });
    expect(ctx.items.some((i) => i.memoryId === m.memoryId)).toBe(false);
    const after = await memory.submitOperatorInstruction(owner, submission({ intent: "CORRECT", targetMemoryId: m.memoryId, content: "spaces" }));
    expect(after).toMatchObject({ state: "REFUSED", ruleId: "target-retracted" });
    expect(await rejects("delete from memory_versions where memory_id=$1", [m.memoryId])).not.toBeNull();
  });

  it("flags a conflict between two current memories without rewriting either", async () => {
    const a = await memory.submitOperatorInstruction(owner, submission({ class: "FACT", content: "the deadline is Friday" }));
    const b = await memory.submitOperatorInstruction(owner, submission({ class: "FACT", content: "the deadline is Monday" }));
    expect(await memory.flagConflict(owner, a.memoryId as string, b.memoryId as string, evidence())).toEqual({ created: true });
    expect(await memory.flagConflict(owner, b.memoryId as string, a.memoryId as string, evidence())).toEqual({ created: false });
    const ctx = await memory.assemble(owner, { purpose: "when is the deadline", allowedClasses: ["FACT"], budget: { maxItems: 10, maxTokens: 800 } });
    const flagged = ctx.items.filter((i) => [a.memoryId, b.memoryId].includes(i.memoryId));
    expect(flagged).toHaveLength(2);
    expect(flagged.every((i) => i.conflictsWith.length === 1)).toBe(true);
    await expect(memory.flagConflict(service, a.memoryId as string, b.memoryId as string, evidence())).rejects.toBeInstanceOf(MemoryError);
  });

  it("makes versions, promotions, relations, assemblies and candidate content immutable", async () => {
    const r = await memory.submitOperatorInstruction(owner, submission());
    expect(await rejects("update memory_versions set content='x' where memory_id=$1", [r.memoryId])).not.toBeNull();
    expect(await rejects("delete from memory_promotions where candidate_id=$1", [r.candidateId])).not.toBeNull();
    expect(await rejects("update memory_candidates set content='x' where id=$1", [r.candidateId])).not.toBeNull();
    expect(await rejects("delete from memory_candidates where id=$1", [r.candidateId])).not.toBeNull();
    expect(await rejects("update memory_candidates set state='HELD' where id=$1", [r.candidateId])).not.toBeNull();
    expect(await rejects("truncate memory_versions cascade")).not.toBeNull();
    await memory.assemble(owner, { purpose: "anything", allowedClasses: ["FACT"], budget: { maxItems: 3, maxTokens: 100 } });
    expect(await rejects("update memory_context_assemblies set digest = repeat('c',64)")).not.toBeNull();
    expect(await rejects("delete from memory_relations")).not.toBeNull();
  });
});

describe("tenant and subject isolation", () => {
  it("does not let another tenant see, assemble, correct or retract a memory", async () => {
    const m = await memory.submitOperatorInstruction(owner, submission({ subject: { kind: "TENANT", ref: tenantId }, class: "FACT", content: "tenant secret-free fact about the cheese rota" }));
    expect(await memory.find(other, m.memoryId as string)).toBeNull();
    expect(await memory.listCurrent(other)).toEqual([]);
    const ctx = await memory.assemble(other, { purpose: "cheese rota", allowedClasses: ["FACT"], budget: { maxItems: 10, maxTokens: 500 } });
    expect(ctx.items).toEqual([]);
    for (const intent of ["CORRECT", "RETRACT", "SUPERSEDE"] as const) {
      const r = await memory.submitOperatorInstruction(other, {
        idempotencyKey: key(),
        class: "FACT",
        content: "hijack",
        intent,
        targetMemoryId: m.memoryId,
        subject: { kind: "PRINCIPAL", ref: other.principal.id },
        evidence: evidence(),
        reason: "hijack attempt",
      });
      expect(r).toMatchObject({ state: "REFUSED", ruleId: "target-not-found" });
    }
    expect((await memory.find(owner, m.memoryId as string))?.versions).toHaveLength(1);
  });

  it("does not let a principal outside the tenant act at all", async () => {
    const stranger: TenantContext = { tenantId, principal: other.principal };
    await expect(memory.submitOperatorInstruction(stranger, submission())).rejects.toThrow("Tenant access denied");
    await expect(memory.assemble(stranger, { purpose: "x", allowedClasses: ["FACT"], budget: { maxItems: 1, maxTokens: 100 } })).rejects.toThrow("Tenant access denied");
  });

  it("keeps personal memories visible only to their subject within a tenant", async () => {
    const m = await memory.submitOperatorInstruction(owner, submission({ content: "I prefer green tea in the mornings" }));
    expect(await memory.find(member, m.memoryId as string)).toBeNull();
    expect((await memory.listCurrent(member)).some((x) => x.memoryId === m.memoryId)).toBe(false);
    const ctx = await memory.assemble(member, { purpose: "tea in the morning", allowedClasses: ["PREFERENCE"], budget: { maxItems: 10, maxTokens: 500 } });
    expect(ctx.items.some((i) => i.memoryId === m.memoryId)).toBe(false);
    await expect(memory.assemble(member, { purpose: "tea", subject: { kind: "PRINCIPAL", ref: owner.principal.id }, allowedClasses: ["PREFERENCE"], budget: { maxItems: 5, maxTokens: 200 } })).rejects.toBeInstanceOf(MemoryError);
  });
});

describe("verified outcomes", () => {
  const ref = () => `${db.task.id}/${db.evidence.id}`;
  it("records an episode from verified task evidence and refuses invented evidence", async () => {
    const ok = await memory.submitVerifiedOutcomeCandidate(service, {
      idempotencyKey: key(),
      class: "EPISODE",
      content: "the uppercase task completed and was verified",
      subject: { kind: "TENANT", ref: tenantId },
      evidence: [{ type: "TASK_EVIDENCE", ref: ref() }],
      reason: "verified outcome",
    });
    expect(ok).toMatchObject({ origin: "VERIFIED_OUTCOME", state: "PROMOTED", decision: "ALLOW" });
    expect((await memory.find(service, ok.memoryId as string))?.head.trustClass).toBe("INTERNAL_DERIVED");
    const fake = await memory.submitVerifiedOutcomeCandidate(service, {
      idempotencyKey: key(),
      class: "EPISODE",
      content: "an outcome that never happened",
      subject: { kind: "TENANT", ref: tenantId },
      evidence: [{ type: "TASK_EVIDENCE", ref: `${randomUUID()}/${randomUUID()}` }],
      reason: "invented",
    });
    expect(fake).toMatchObject({ state: "REFUSED", ruleId: "outcome-not-verified" });
    const wrongClass = await memory.submitVerifiedOutcomeCandidate(service, {
      idempotencyKey: key(),
      class: "PREFERENCE",
      content: "verified outcomes cannot state preferences",
      subject: { kind: "TENANT", ref: tenantId },
      evidence: [{ type: "TASK_EVIDENCE", ref: ref() }],
      reason: "wrong class",
    });
    expect(wrongClass).toMatchObject({ state: "REFUSED", ruleId: "outcome-class" });
  });
});

describe("protected promotion through the existing approval machinery", () => {
  const protectedSubmission = () => submission({ class: "RELATIONSHIP", content: "Sam is my accountant and handles the VAT return", subject: { kind: "PRINCIPAL", ref: owner.principal.id } });
  const decide = async (approvalId: string, decision: "GRANTED" | "DENIED", actor: PrincipalRef = approver) => {
    const store = new ApprovalStore(db.pool);
    const { scopeDigest } = await store.read(approvalId);
    return store.resolve(approvalId, { decision, scopeDigest }, actor, randomUUID(), randomUUID());
  };

  it("holds the candidate awaiting a real approval, and promotes only once the named approver grants that exact candidate", async () => {
    const r = await memory.submitOperatorInstruction(owner, protectedSubmission());
    expect(r).toMatchObject({ state: "AWAITING_APPROVAL", decision: "REQUIRE_APPROVAL", memoryId: null });
    expect(r.approvalId).not.toBeNull();
    const approvalRow = await db.pool.query("select status, requested_from from approvals where id=$1", [r.approvalId]);
    expect(approvalRow.rows[0]).toMatchObject({ status: "PENDING", requested_from: approver.id });
    expect(await memory.settleApproval(owner, r.candidateId)).toMatchObject({ state: "AWAITING_APPROVAL", memoryId: null });
    await decide(r.approvalId as string, "GRANTED");
    const done = await memory.settleApproval(owner, r.candidateId);
    expect(done, JSON.stringify(done)).toMatchObject({ state: "PROMOTED", decision: "ALLOW_APPROVED", version: 1 });
    const head = (await memory.find(owner, done.memoryId as string))?.head;
    expect(head?.policy).toMatchObject({ decision: "ALLOW_APPROVED", protected: true, approvalId: r.approvalId });
    const promos = await db.pool.query("select decision, promoted_by_kind, promoted_by_principal, approval_id from memory_promotions where candidate_id=$1 order by created_at, decision", [r.candidateId]);
    expect(promos.rows.map((p) => p.decision).sort()).toEqual(["ALLOW_APPROVED", "REQUIRE_APPROVAL"]);
    expect(promos.rows.find((p) => p.decision === "ALLOW_APPROVED")).toMatchObject({ promoted_by_kind: "APPROVED_HUMAN", promoted_by_principal: approver.id, approval_id: r.approvalId });
    const replay = await memory.settleApproval(owner, r.candidateId);
    expect(replay).toMatchObject({ state: "PROMOTED", memoryId: done.memoryId, replayed: true });
    expect(await count("memory_versions")).toBeGreaterThan(0);
    expect((await db.pool.query("select count(*)::int as n from memory_versions where candidate_id=$1", [r.candidateId])).rows[0].n).toBe(1);
  });

  it("rejects the candidate when the approver denies", async () => {
    const r = await memory.submitOperatorInstruction(owner, protectedSubmission());
    await decide(r.approvalId as string, "DENIED");
    const done = await memory.settleApproval(owner, r.candidateId);
    expect(done).toMatchObject({ state: "REJECTED", decision: "REJECT_APPROVAL", memoryId: null });
    expect((await db.pool.query("select count(*)::int as n from memory_versions where candidate_id=$1", [r.candidateId])).rows[0].n).toBe(0);
  });

  it("rejects the candidate when the approval expires", async () => {
    const quick = new CanonicalMemory(db.pool, { approvals: new PgPromotionApprovals(db.pool, { approver, ttlMs: 1000 }) });
    const r = await quick.submitOperatorInstruction(owner, protectedSubmission());
    expect(r.state).toBe("AWAITING_APPROVAL");
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const done = await quick.settleApproval(owner, r.candidateId);
    expect(done).toMatchObject({ state: "REJECTED", ruleId: "approval-expired", memoryId: null });
    expect((await decide(r.approvalId as string, "GRANTED")).status).toBe("EXPIRED");
    expect(await memory.settleApproval(owner, r.candidateId)).toMatchObject({ state: "REJECTED", memoryId: null });
  });

  it("does not let an approval for one candidate promote another", async () => {
    const a = await memory.submitOperatorInstruction(owner, protectedSubmission());
    const b = await memory.submitOperatorInstruction(owner, protectedSubmission());
    await decide(a.approvalId as string, "GRANTED");
    // Forge candidate b so that it points at a's granted approval. The ledger must not let that promote b.
    await db.pool.query("alter table memory_candidates disable trigger memory_candidates_guard");
    await db.pool.query("update memory_candidates set approval_id=$1 where id=$2", [a.approvalId, b.candidateId]);
    await db.pool.query("alter table memory_candidates enable trigger memory_candidates_guard");
    await expect(memory.settleApproval(owner, b.candidateId)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.pool.query("select count(*)::int as n from memory_versions where candidate_id=$1", [b.candidateId])).rows[0].n).toBe(0);
  });

  it("does not let a non-approver resolve the approval", async () => {
    const r = await memory.submitOperatorInstruction(owner, protectedSubmission());
    await expect(decide(r.approvalId as string, "GRANTED", owner.principal)).rejects.toThrow();
    expect(await memory.settleApproval(owner, r.candidateId)).toMatchObject({ state: "AWAITING_APPROVAL" });
  });

  it("stays a held candidate when no approver is configured", async () => {
    const bare = new CanonicalMemory(db.pool, { now: () => clock });
    const r = await bare.submitOperatorInstruction(owner, protectedSubmission());
    expect(r).toMatchObject({ state: "HELD", ruleId: "approval-unavailable", memoryId: null });
  });

  it("holds a verified-outcome lesson for approval", async () => {
    const r = await memory.submitVerifiedOutcomeCandidate(service, {
      idempotencyKey: key(),
      class: "LESSON",
      content: "always verify the artefact rather than the symptom",
      subject: { kind: "TENANT", ref: tenantId },
      evidence: [{ type: "TASK_EVIDENCE", ref: `${db.task.id}/${db.evidence.id}` }],
      reason: "drawn from a verified outcome",
    });
    expect(r).toMatchObject({ state: "AWAITING_APPROVAL", decision: "REQUIRE_APPROVAL", memoryId: null });
  });
});

describe("bounded, deterministic context assembly", () => {
  const request = (o: Record<string, unknown> = {}) => ({ purpose: "write the deployment summary", allowedClasses: ["PREFERENCE", "FACT", "COMMITMENT"], budget: { maxItems: 10, maxTokens: 600 }, ...o });

  it("selects the relevant memory with provenance, a reason and a stable digest", async () => {
    const m = await memory.submitOperatorInstruction(owner, submission({ evidence: evidence("tg-2002"), content: "I prefer concise deployment summaries unless I explicitly ask for detail" }));
    const a = await memory.assemble(owner, request());
    const b = await memory.assemble(owner, request());
    expect(a.digest).toBe(b.digest);
    expect(a.assemblyId).toBe(b.assemblyId);
    expect(a.items.map((i) => i.memoryId)).toEqual(b.items.map((i) => i.memoryId));
    const item = a.items.find((i) => i.memoryId === m.memoryId);
    expect(item).toBeDefined();
    expect(item?.provenance.evidence).toEqual(evidence("tg-2002"));
    expect(item?.reason.length).toBeGreaterThan(0);
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes the digest when the selected memories change", async () => {
    const before = await memory.assemble(owner, request({ purpose: "quarterly invoicing cadence" }));
    await memory.submitOperatorInstruction(owner, submission({ class: "COMMITMENT", content: "I will send invoicing reminders every quarter" }));
    const after = await memory.assemble(owner, request({ purpose: "quarterly invoicing cadence" }));
    expect(after.digest).not.toBe(before.digest);
    expect(after.items.length).toBeGreaterThan(before.items.length);
  });

  it("never exceeds its budget and records what did not fit", async () => {
    for (let i = 0; i < 8; i++) await memory.submitOperatorInstruction(owner, submission({ class: "FACT", content: `budget probe fact number ${i} about the zebra rota ${"x".repeat(200)}` }));
    const ctx = await memory.assemble(owner, request({ purpose: "zebra rota", allowedClasses: ["FACT"], budget: { maxItems: 3, maxTokens: 16 + 200 } }));
    expect(ctx.items.length).toBeLessThanOrEqual(3);
    expect(ctx.budget.usedTokens).toBeLessThanOrEqual(ctx.budget.maxTokens);
    expect(ctx.excluded.length).toBeGreaterThan(0);
    expect(ctx.excluded.every((e) => e.reason === "OVER_BUDGET" || e.reason === "OVER_ITEM_LIMIT")).toBe(true);
    const tight = await memory.assemble(owner, request({ purpose: "zebra rota", allowedClasses: ["FACT"], budget: { maxItems: 50, maxTokens: 16 } }));
    expect(tight.items).toEqual([]);
    expect(tight.budget.usedTokens).toBeLessThanOrEqual(16);
  });

  it("applies the class filter before ranking", async () => {
    const ctx = await memory.assemble(owner, request({ purpose: "zebra rota", allowedClasses: ["LESSON"] }));
    expect(ctx.items).toEqual([]);
  });

  it("keeps external context separate, untrusted, bounded and counted", async () => {
    const boundary = new SharedBrainBoundary({ search: async () => [{ ref: "d1", kind: "KNOWLEDGE", text: "zebra facts from outside ".repeat(20) }, { ref: "d2", kind: "KNOWLEDGE", text: "more zebra facts ".repeat(40) }] }, memory);
    const external = await boundary.contextFor(owner, "zebra");
    const ctx = await memory.assemble(owner, request({ purpose: "zebra", allowedClasses: ["FACT"], budget: { maxItems: 2, maxTokens: 260 } }), { external });
    expect(ctx.budget.usedTokens).toBeLessThanOrEqual(260);
    expect(ctx.external.every((e) => e.trustClass === "UNTRUSTED_EXTERNAL" && e.ref.startsWith("shared-brain:"))).toBe(true);
    expect(ctx.external.length + ctx.externalDropped).toBe(external.length);
    expect(ctx.items.every((i) => i.trustClass !== "UNTRUSTED_EXTERNAL")).toBe(true);
  });

  it("records the assembly, keyed to the task that consumed it, and refuses a record that exceeds its budget", async () => {
    const ctx = await memory.assemble(owner, request(), { consumer: { taskId: db.task.id, stepId: randomUUID(), callId: randomUUID() } });
    const row = await db.pool.query("select digest, task_id, principal_id, items from memory_context_assemblies where id=$1", [ctx.assemblyId]);
    expect(row.rows[0]).toMatchObject({ digest: ctx.digest, task_id: db.task.id, principal_id: owner.principal.id });
    expect(row.rows[0].items.map((i: { memoryId: string }) => i.memoryId)).toEqual(ctx.items.map((i) => i.memoryId));
    const over = await rejects(
      "insert into memory_context_assemblies(id,tenant_id,principal_id,digest,purpose_digest,request,items,external,excluded,budget_max_tokens,budget_used_tokens) values($1,$2,$3,$4,$4,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,10,11)",
      [randomUUID(), tenantId, owner.principal.id, "d".repeat(64)],
    );
    expect(over?.code).toBe("23514");
  });
});

describe("schema hygiene", () => {
  it("has row level security on and no public grants for every memory table", async () => {
    const tables = ["memory_candidates", "memory_promotions", "memory_versions", "memory_relations", "memory_context_assemblies"];
    const rls = await db.pool.query("select relname, relrowsecurity from pg_class where relname = any($1) and relnamespace = 'public'::regnamespace", [tables]);
    expect(rls.rows).toHaveLength(5);
    expect(rls.rows.every((r) => r.relrowsecurity === true)).toBe(true);
    const grants = await db.pool.query(
      "select table_name, grantee from information_schema.role_table_grants where table_schema='public' and table_name = any($1) and grantee in ('anon','authenticated','PUBLIC')",
      [[...tables, "memory_current"]],
    );
    expect(grants.rows).toEqual([]);
  });
});
