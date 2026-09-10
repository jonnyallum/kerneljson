import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { EvaluationStore } from "../services/evaluator/src/store.js";
import { uppercaseCandidate } from "../services/evaluator/src/candidate.js";
import { uppercaseSuite } from "../evals/golden/uppercase.js";
let db: Awaited<ReturnType<typeof knowledgeDatabase>>,
  store: EvaluationStore,
  id: string,
  calls = 0;
beforeAll(async () => {
  db = await knowledgeDatabase();
  const candidate = uppercaseCandidate("c".repeat(64));
  store = new EvaluationStore(db.pool, uppercaseSuite, {
    ...candidate,
    execute: (input) => {
      calls++;
      return candidate.execute(input);
    },
  });
});
afterAll(async () => {
  await db?.close();
});
it("runs and persists an idempotent executable evaluation with a verified task anchor", async () => {
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      store.run(db.context, { taskId: db.task.id, evidenceId: db.evidence.id }),
    ),
  );
  id = results[0]!.id;
  expect(
    results.every((r) => JSON.stringify(r) === JSON.stringify(results[0])),
  ).toBe(true);
  expect(calls).toBe(uppercaseSuite.cases.length);
  expect(await store.canPromote(db.context, id)).toBe(true);
  expect((await db.pool.query("select 1 from evaluations")).rowCount).toBe(1);
});
it("rejects result injection, unverified anchors and stale candidate promotion", async () => {
  await expect(
    store.run(db.context, {
      taskId: db.task.id,
      evidenceId: db.evidence.id,
      report: { passed: true },
    }),
  ).rejects.toThrow();
  await expect(
    store.run(db.context, { taskId: db.task.id, evidenceId: randomUUID() }),
  ).rejects.toThrow();
  const changed = new EvaluationStore(
    db.pool,
    uppercaseSuite,
    uppercaseCandidate("d".repeat(64)),
  );
  expect(await changed.canPromote(db.context, id)).toBe(false);
  expect(await store.canPromote(db.context, randomUUID())).toBe(false);
});
it("isolates tenant reports and protects evaluation history in SQL", async () => {
  const tenantId = randomUUID();
  await db.pool.query("insert into tenants(id,name) values($1,'other')", [
    tenantId,
  ]);
  await db.pool.query(
    "insert into tenant_memberships(tenant_id,principal_id,role) values($1,$2,'reader')",
    [tenantId, db.context.principal.id],
  );
  expect(await store.canPromote({ ...db.context, tenantId }, id)).toBe(false);
  for (const sql of [
    "update evaluations set result='{}'",
    "delete from evaluations",
    "truncate evaluations",
  ])
    await expect(db.pool.query(sql)).rejects.toThrow();
});
