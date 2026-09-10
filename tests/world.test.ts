import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { WorldStore } from "../services/world-model/src/index.js";
import {
  WorldObservation,
  WorldRelationship,
  type WorldEntity,
} from "../packages/contracts/src/index.js";
let db: Awaited<ReturnType<typeof knowledgeDatabase>>,
  store: WorldStore,
  a: WorldEntity,
  b: WorldEntity;
beforeAll(async () => {
  db = await knowledgeDatabase();
  store = new WorldStore(db.pool);
  a = await store.entity(db.context, {
    identityKey: "document:a",
    type: "DOCUMENT",
  });
  b = await store.entity(db.context, {
    identityKey: "document:b",
    type: "DOCUMENT",
  });
});
afterAll(async () => {
  await db?.close();
});
const window = {
  validFrom: "2050-01-01T00:00:00.000Z",
  validUntil: "2060-01-01T00:00:00.000Z",
};
const at = "2055-01-01T00:00:00.000Z";
function observation(entityId: string) {
  return {
    entityId,
    taskId: db.task.id,
    evidenceId: db.evidence.id,
    ...window,
  };
}
it("keeps a stable tenant identity and rejects changing its type", async () => {
  const rows = await Promise.all(
    Array.from({ length: 3 }, () =>
      store.entity(db.context, { identityKey: "document:a", type: "DOCUMENT" }),
    ),
  );
  expect(rows).toEqual([a, a, a]);
  await expect(
    store.entity(db.context, { identityKey: "document:a", type: "PERSON" }),
  ).rejects.toThrow("conflict");
});
it("stores verified observations once and filters knowledge and validity intervals", async () => {
  const rows = await Promise.all(
    Array.from({ length: 3 }, () =>
      store.observe(db.context, observation(a.id)),
    ),
  );
  expect(rows.every((r) => JSON.stringify(r) === JSON.stringify(rows[0]))).toBe(
    true,
  );
  expect(rows[0]?.value.text).toBe(db.outcome.summary);
  expect(
    (await store.view(db.context, { entityId: a.id, at }))?.observations,
  ).toEqual([rows[0]]);
  for (const at of [
    "2000-01-01T00:00:00Z",
    "2049-01-01T00:00:00Z",
    window.validUntil,
  ])
    expect(
      (await store.view(db.context, { entityId: a.id, at }))?.observations,
    ).toEqual([]);
});
it("retains multiple valid observations and rejects rewriting an observation window", async () => {
  await expect(
    store.observe(db.context, { ...observation(a.id), validUntil: null }),
  ).rejects.toThrow("conflict");
  await store.observe(db.context, {
    ...observation(a.id),
    validFrom: "2051-01-01T00:00:00Z",
  });
  expect(
    (await store.view(db.context, { entityId: a.id, at }))?.observations,
  ).toHaveLength(2);
});
it("requires matching evidence on both endpoints before recording a typed relationship", async () => {
  const request = {
    sourceId: a.id,
    targetId: b.id,
    taskId: db.task.id,
    evidenceId: db.evidence.id,
  };
  await expect(store.link(db.context, request)).rejects.toThrow(
    "Both endpoints",
  );
  await store.observe(db.context, observation(b.id));
  const relation = await store.link(db.context, request);
  expect(await store.link(db.context, request)).toEqual(relation);
  expect(
    (await store.view(db.context, { entityId: a.id, at }))
      ?.historicalRelationships,
  ).toEqual([relation]);
  expect(relation.type).toBe("SHARES_VERIFIED_RESULT");
  await expect(
    store.link(db.context, { ...request, targetId: a.id }),
  ).rejects.toThrow();
});
it("isolates entity identities and prevents cross-tenant observations and edges", async () => {
  const tenantId = randomUUID();
  await db.pool.query("insert into tenants(id,name) values($1,'other')", [
    tenantId,
  ]);
  await db.pool.query(
    "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'owner')",
    [tenantId, db.context.principal.id],
  );
  const context = { ...db.context, tenantId };
  const other = await store.entity(context, {
    identityKey: "document:a",
    type: "DOCUMENT",
  });
  expect(other.id).not.toBe(a.id);
  expect(await store.view(context, { entityId: a.id, at })).toBeNull();
  await expect(store.observe(context, observation(other.id))).rejects.toThrow();
  await expect(
    store.observe(db.context, observation(other.id)),
  ).rejects.toThrow();
  await expect(
    store.link(db.context, {
      sourceId: a.id,
      targetId: other.id,
      taskId: db.task.id,
      evidenceId: db.evidence.id,
    }),
  ).rejects.toThrow();
});
it("rejects injected claims, confidence, invalid windows and missing evidence", async () => {
  await expect(
    store.observe(db.context, { ...observation(a.id), value: "injected" }),
  ).rejects.toThrow();
  await expect(
    store.observe(db.context, { ...observation(a.id), confidence: 0.5 }),
  ).rejects.toThrow();
  await expect(
    store.observe(db.context, {
      ...observation(a.id),
      validUntil: window.validFrom,
    }),
  ).rejects.toThrow();
  await expect(
    store.observe(db.context, {
      ...observation(a.id),
      evidenceId: randomUUID(),
    }),
  ).rejects.toThrow();
  expect(WorldObservation.safeParse({}).success).toBe(false);
  expect(WorldRelationship.safeParse({}).success).toBe(false);
});
it("database prevents graph history mutation and requires relationship provenance", async () => {
  for (const table of ["entities", "observations", "relationships"])
    for (const operation of [
      `update ${table} set id=id`,
      `delete from ${table}`,
      `truncate ${table}`,
    ])
      await expect(db.pool.query(operation)).rejects.toThrow();
  await expect(
    db.pool.query(
      "insert into relationships(id,tenant_id,source_id,target_id,type) values($1,$2,$3,$4,'SHARES_VERIFIED_RESULT')",
      [randomUUID(), db.context.tenantId, a.id, b.id],
    ),
  ).rejects.toThrow();
});
