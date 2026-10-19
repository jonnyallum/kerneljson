import type pg from "pg";
import { KernelState } from "../../../../packages/contracts/src/index.js";

/**
 * The kernel's own recent state for the morning brief, read from the ledger it already writes. Read
 * only: two SELECTs over tasks and their compiled plans. The brief's own task is excluded so it does
 * not report itself as running.
 */
export function createKernelStateReader(pool: Pick<pg.Pool, "query">) {
  return async function kernelState(req: { since: string; excludeTaskId: string }): Promise<KernelState> {
    const tasks = await pool.query<{ recipe: string; status: string; count: number }>(
      `select coalesce(e.payload->'plan'->>'recipe', 'unknown') as recipe, t.status::text as status, count(*)::int as count
         from public.tasks t
         left join public.task_events e on e.task_id = t.id and e.type = 'PLAN_COMPILED'
        where t.created_at >= $1 and t.id <> $2
        group by 1, 2
        order by 1, 2
        limit 64`,
      [req.since, req.excludeTaskId],
    );
    const canary = await pool.query<{ task_id: string; status: string; created_at: Date }>(
      `select t.id as task_id, t.status::text as status, t.created_at
         from public.tasks t
         join public.task_events e on e.task_id = t.id and e.type = 'PLAN_COMPILED'
        where e.payload->'plan'->>'recipe' = 'claude_md_check/v1'
        order by t.created_at desc
        limit 1`,
    );
    const last = canary.rows[0];
    return KernelState.parse({
      tasks: tasks.rows.map((r) => ({ recipe: r.recipe.slice(0, 80), status: r.status.slice(0, 20), count: r.count })),
      lastCanary: last ? { taskId: last.task_id, status: last.status, createdAt: new Date(last.created_at).toISOString() } : null,
    });
  };
}
