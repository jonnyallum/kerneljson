import { randomUUID, createHash } from "node:crypto";
import type pg from "pg";

const hex64 = (): string => createHash("sha256").update(randomUUID()).digest("hex");

/**
 * S1-R Option B: create a bindable CANONICAL child task id in the admission ledger
 * (kernel_private.execution_bindings -> kernel_private.task_admissions). This is
 * exactly what a successful KernelJSON Admission (POST /v1/tasks) records, and is
 * what `schedule_fires.admitted_child_task_id` now references. `public.tasks`
 * materialises later (via the Restate workflow/ledger) and is NOT required for a
 * ScheduleFire to bind the canonical identity.
 */
export async function seedAdmittedTask(
  pool: pg.Pool,
  args: { taskId: string; tenantId: string; principalId: string },
): Promise<void> {
  const { taskId, tenantId, principalId } = args;
  await pool.query(
    "insert into kernel_private.execution_bindings(task_id,tenant_id,principal_id,contract) values($1,$2,$3,$4) on conflict(task_id) do nothing",
    [taskId, tenantId, principalId, JSON.stringify({ taskId, tenantId, principal: { id: principalId } })],
  );
  await pool.query(
    "insert into kernel_private.task_admissions(task_id,tenant_id,principal_id,key_digest,request_digest,payload) values($1,$2,$3,$4,$5,$6) on conflict(task_id) do nothing",
    [taskId, tenantId, principalId, hex64(), hex64(), JSON.stringify({ seed: true })],
  );
}
