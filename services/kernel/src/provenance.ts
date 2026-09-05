import type pg from "pg";
import { Id, Outcome, Task } from "../../../packages/contracts/src/index.js";
/** Reads an immutable verified result within an already-authorized tenant transaction. */
export async function verifiedResult(
  db: pg.PoolClient,
  tenantId: string,
  taskId: string,
  evidenceId: string,
) {
  Id.parse(taskId);
  Id.parse(evidenceId);
  const rows = await db.query<{
    task: unknown;
    outcome: unknown;
    digest: string;
  }>(
    `select t.contract as task,o.contract as outcome,e.digest from tasks t join outcomes o on o.task_id=t.id join evidence e on e.task_id=t.id where t.id=$1 and t.tenant_id=$2 and e.id=$3 and t.status='COMPLETED' and o.status='COMPLETED' and e.type in ('DETERMINISTIC_RESULT','TOOL_RECEIPT','ARTIFACT')`,
    [taskId, tenantId, evidenceId],
  );
  const row = rows.rows[0];
  if (!row) throw new Error("Verified task evidence required");
  const task = Task.parse(row.task),
    outcome = Outcome.parse(row.outcome);
  if (
    !outcome.evidenceRefs.includes(evidenceId) ||
    !outcome.acceptanceResults.some(
      (r) => r.passed && r.evidenceRefs.includes(evidenceId),
    )
  )
    throw new Error("Evidence is not part of verified outcome");
  return { task, outcome };
}
