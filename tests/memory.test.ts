import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { MemoryStore } from "../services/memory/src/index.js";
import { MemoryItem } from "../packages/contracts/src/index.js";
let db: Awaited<ReturnType<typeof knowledgeDatabase>>, store: MemoryStore;
beforeAll(async () => {
  db = await knowledgeDatabase();
  store = new MemoryStore(db.pool);
});
afterAll(async () => {
  await db?.close();
});
it("remembers verified output once under concurrent retries and retrieves provenance", async () => {
  const request = {
    taskId: db.task.id,
    evidenceId: db.evidence.id,
    validUntil: "2099-01-01T00:00:00.000Z",
  };
  const items = await Promise.all(
    Array.from({ length: 3 }, () => store.remember(db.context, request)),
  );
  expect(
    items.every((i) => JSON.stringify(i) === JSON.stringify(items[0])),
  ).toBe(true);
  expect((await db.pool.query("select 1 from memory_items")).rowCount).toBe(1);
  const rows = await store.retrieve(db.context, {
    text: db.outcome.summary.toLowerCase(),
    at: new Date().toISOString(),
  });
  expect(rows).toEqual([items[0]]);
  expect(rows[0]?.content.text).toBe(db.outcome.summary);
  expect(rows[0]?.evidenceId).toBe(db.evidence.id);
  expect(
    await store.remember(db.context, {
      ...request,
      validUntil: "2099-01-01T01:00:00+01:00",
    }),
  ).toEqual(items[0]);
});
it("excludes future observations and expired memory, including expiry boundary", async () => {
  for (const at of [
    "2000-01-01T00:00:00.000Z",
    "2099-01-01T00:00:00.000Z",
    "2100-01-01T00:00:00.000Z",
  ])
    expect(
      await store.retrieve(db.context, { text: db.outcome.summary, at }),
    ).toEqual([]);
});
it("does not interpret search wildcards or accept unbounded requests", async () => {
  expect(
    await store.retrieve(db.context, {
      text: "%",
      at: new Date().toISOString(),
    }),
  ).toEqual([]);
  await expect(
    store.retrieve(db.context, {
      text: "a",
      at: new Date().toISOString(),
      limit: 51,
    }),
  ).rejects.toThrow();
  await expect(
    store.remember(db.context, {
      taskId: db.task.id,
      evidenceId: db.evidence.id,
      content: "injected",
    }),
  ).rejects.toThrow();
});
it("rejects foreign or unsupported evidence and conflicting validity", async () => {
  await expect(
    store.remember(db.context, {
      taskId: db.task.id,
      evidenceId: randomUUID(),
    }),
  ).rejects.toThrow("Verified task evidence");
  await expect(
    store.remember(db.context, {
      taskId: randomUUID(),
      evidenceId: db.evidence.id,
    }),
  ).rejects.toThrow();
  await expect(
    store.remember(db.context, {
      taskId: db.task.id,
      evidenceId: db.evidence.id,
    }),
  ).rejects.toThrow("Conflicting");
  expect(MemoryItem.safeParse({}).success).toBe(false);
});
it("isolates tenants even for a principal belonging to both", async () => {
  const tenantId = randomUUID();
  await db.pool.query("insert into tenants(id,name) values($1,'other')", [
    tenantId,
  ]);
  await db.pool.query(
    "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')",
    [tenantId, db.context.principal.id],
  );
  const context = { ...db.context, tenantId };
  expect(
    await store.retrieve(context, {
      text: db.outcome.summary,
      at: new Date().toISOString(),
    }),
  ).toEqual([]);
  await expect(
    store.remember(context, { taskId: db.task.id, evidenceId: db.evidence.id }),
  ).rejects.toThrow();
});
it("rejects non-completed task evidence and evidence outside the verified outcome", async () => {
  const id = randomUUID(),
    evidenceId = randomUUID();
  const task = { ...db.task, id, status: "RECEIVED" };
  await db.pool.query(
    "insert into tasks(id,tenant_id,principal_id,trace_id,status,contract,created_at) values($1,$2,$3,$4,'RECEIVED',$5,$6)",
    [
      id,
      db.context.tenantId,
      db.context.principal.id,
      task.traceId,
      task,
      task.createdAt,
    ],
  );
  await db.pool.query(
    "insert into evidence(id,task_id,type,source,digest,captured_at,metadata) values($1,$2,'DETERMINISTIC_RESULT','test',$3,now(),'{}')",
    [evidenceId, id, "a".repeat(64)],
  );
  await expect(
    store.remember(db.context, { taskId: id, evidenceId }),
  ).rejects.toThrow("Verified task evidence");
  for (const type of ["HUMAN_DECISION", "DETERMINISTIC_RESULT"]) {
    const evidenceId = randomUUID();
    await db.pool.query(
      "insert into evidence(id,task_id,type,source,digest,captured_at,metadata) values($1,$2,$3,'test',$4,now(),'{}')",
      [evidenceId, db.task.id, type, "b".repeat(64)],
    );
    await expect(
      store.remember(db.context, { taskId: db.task.id, evidenceId }),
    ).rejects.toThrow();
  }
});
it("database rejects memory mutation and deletion", async () => {
  for (const sql of [
    "update memory_items set source='forged'",
    "delete from memory_items",
    "truncate memory_items",
  ])
    await expect(db.pool.query(sql)).rejects.toThrow();
});
it("rechecks revoked membership and principal kind", async () => {
  await expect(
    store.retrieve(
      {
        ...db.context,
        principal: { ...db.context.principal, kind: "SERVICE" },
      },
      { text: "a", at: new Date().toISOString() },
    ),
  ).rejects.toThrow("Tenant access denied");
  const reader = { id: randomUUID(), kind: "HUMAN" as const };
  await db.pool.query("insert into principals(id,kind) values($1,'HUMAN')", [
    reader.id,
  ]);
  await db.pool.query(
    "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'reader')",
    [db.context.tenantId, reader.id],
  );
  const context = { ...db.context, principal: reader };
  expect(
    (
      await store.retrieve(context, {
        text: db.outcome.summary,
        at: new Date().toISOString(),
      })
    ).length,
  ).toBe(1);
  await db.pool.query(
    "delete from tenant_memberships where tenant_id=$1 and principal_id=$2",
    [db.context.tenantId, reader.id],
  );
  await expect(
    store.retrieve(context, { text: "a", at: new Date().toISOString() }),
  ).rejects.toThrow("Tenant access denied");
});
