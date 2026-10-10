import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type pg from "pg";
import { knowledgeDatabase } from "./support/knowledge-db.js";
import { assertBaseTarget } from "../scripts/b1/base-guard.mjs";
import { bindingFor, persistBinding, workflowTargets } from "../services/kernel/src/execution-binding.js";
import { Task } from "../packages/contracts/src/index.js";
import { collectBindingProvenance, bindingProvenanceVerdict } from "../services/kernel/src/health/release-provenance.js";

let f: Awaited<ReturnType<typeof knowledgeDatabase>>;
beforeEach(async () => { f = await knowledgeDatabase("kj_release_provenance_base"); });
afterEach(async () => { await f?.close(); });
const evidence = { qualification: "disposable test only" };
async function activate(db: Pick<pg.PoolClient, "query">, release: string, previous = "0", request = randomUUID()) {
  return (await db.query("select kernel_private.activate_release($1,$2,$3,$4) as epoch", [request, release, previous, evidence])).rows[0].epoch as string;
}
function binding(release: string) {
  return bindingFor(Task.parse({ ...f.task, id: randomUUID(), status: "RECEIVED" }), workflowTargets.TaskWorkflow, release);
}
async function insert(db: pg.PoolClient, release: string) {
  const b = binding(release);
  await persistBinding(db, b);
  return b;
}
async function row(taskId: string) {
  return (await f.pool.query("select release_epoch,persisted_at from kernel_private.execution_bindings where task_id=$1", [taskId])).rows[0];
}

it("migration baselines preexisting immutable bindings without inventing their insertion time", async () => {
  await assertBaseTarget(f.pool);
  // Reconstruct the immediately preceding schema in this disposable database.
  // Remove the later P7B dependants explicitly before reconstructing the pre-provenance schema.
  await f.pool.query(`drop table kernel_private.identity_cognition_latches, kernel_private.identity_cognition_contract_v1;
    alter table kernel_private.execution_bindings drop constraint execution_bindings_task_tenant_epoch;
    drop trigger execution_bindings_provenance on kernel_private.execution_bindings;
    drop function kernel_private.stamp_binding_provenance();
    drop function kernel_private.activate_release(uuid,text,bigint,jsonb);
    drop table kernel_private.release_epoch, kernel_private.release_activations;
    alter table kernel_private.execution_bindings drop column release_epoch, drop column persisted_at;`);
  const db = await f.pool.connect();
  try {
    const old = await insert(db, "5a2335b41d8fe525ff940a3bd86912c98dae68af");
    await insert(db, "earlier-history");
    expect(await collectBindingProvenance(f.pool)).toBeNull();
    await db.query("begin");
    await db.query(await readFile("supabase/migrations/20260916205049_release_provenance.sql", "utf8"));
    await db.query("commit");
    expect(await row(old.taskId)).toEqual({ release_epoch: "0", persisted_at: null });
    const target = "d5abf22ec176d16932af5cfcd77a8ce3098027bc";
    await activate(db, target);
    expect(bindingProvenanceVerdict(await collectBindingProvenance(f.pool), target).status).toBe("UNKNOWN");
    await insert(db, target);
    expect(bindingProvenanceVerdict(await collectBindingProvenance(f.pool), target).status).toBe("HEALTHY");
    expect((await db.query("select contract from kernel_private.execution_bindings where task_id=$1", [old.taskId])).rows[0].contract).toEqual(old);
  } finally { await db.query("rollback"); db.release(); }
});

