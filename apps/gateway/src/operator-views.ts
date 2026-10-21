import type pg from "pg";
import { z } from "zod";
import type { TenantContext } from "../../../packages/contracts/src/index.js";
import { withTenant } from "../../../packages/identity/src/index.js";

/**
 * ADR-0025: the two read-only views the operator MCP server needs from the door, so it never needs a
 * database credential of its own. Both are SELECTs inside the caller's tenant transaction. Neither
 * returns model output, notification text, env or configuration values.
 */

export const TaskListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export interface TaskListItem {
  taskId: string;
  recipe: string | null;
  source: string | null;
  status: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
}

const OBJECTIVE_PREVIEW = 160;

/** Recent tasks for the caller's tenant, newest first. Reading needs the `read` permission. */
export async function listTasks(pool: pg.Pool, context: TenantContext, query: z.infer<typeof TaskListQuery>): Promise<TaskListItem[]> {
  return withTenant(pool, context, async (db, ctx) => {
    const rows = await db.query<{
      id: string; status: string; objective: string | null; created_at: Date; updated_at: Date;
      recipe: string | null; source: string | null;
    }>(
      `select t.id, t.status::text as status, t.contract->>'objective' as objective, t.created_at, t.updated_at,
              a.payload->>'recipe' as recipe, a.payload->'intent'->>'source' as source
         from tasks t left join kernel_private.task_admissions a on a.task_id = t.id and a.tenant_id = t.tenant_id
        where t.tenant_id = $1
        order by t.created_at desc, t.id
        limit $2`,
      [ctx.tenantId, query.limit],
    );
    return rows.rows.map((r) => {
      const objective = r.objective ?? "";
      return {
        taskId: r.id,
        recipe: r.recipe,
        source: r.source,
        status: r.status,
        objective: objective.length > OBJECTIVE_PREVIEW ? objective.slice(0, OBJECTIVE_PREVIEW) + "..." : objective,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      };
    });
  });
}

export interface OperatorHealth {
  checkedAt: string;
  release: {
    door: string;
    active: { epoch: number; releaseId: string | null; activatedAt: string | null };
    doorMatchesActive: boolean;
    bindingMismatches: number;
  };
  schedules: Array<{
    scheduleId: string;
    name: string;
    state: string;
    activeVersion: string;
    lastFire: { windowKey: string; fireAtUtc: string; state: string; taskId: string | null; taskStatus: string | null } | null;
  }>;
  tasks: { nonterminal: number; failedLast24h: number; completedLast24h: number };
  /** By status: rows created in the last 24 hours, plus any still PENDING, SENDING or POISON. */
  notifications: { recentByStatus: Record<string, number>; pendingOlderThan10m: number; poison: number };
}

/**
 * Ledger-side operational health. It is deployment detail, so it needs the `schedule` permission
 * (owner or operator), not just `read`. Restate-side checks stay in the operator CLI: the door has no
 * Restate admin access and does not gain any.
 */
export async function operatorHealth(pool: pg.Pool, context: TenantContext, doorRelease: string, now: () => Date = () => new Date()): Promise<OperatorHealth> {
  return withTenant(
    pool,
    context,
    async (db, ctx) => {
      const active = (
        await db.query<{ epoch: string; release_id: string | null; activated_at: Date | null }>(
          `select e.epoch::text as epoch, a.release_id, a.activated_at
             from kernel_private.release_epoch e left join kernel_private.release_activations a using (epoch)
            where e.singleton`,
        )
      ).rows[0];
      const mismatches = (
        await db.query<{ n: number }>(
          `select count(*)::int as n from kernel_private.execution_bindings b
             join kernel_private.release_activations a on a.epoch = b.release_epoch
            where b.tenant_id = $1 and b.contract->>'releaseId' is distinct from a.release_id`,
          [ctx.tenantId],
        )
      ).rows[0]!.n;
      const schedules = (
        await db.query<{
          schedule_id: string; name: string; state: string; active_version: string;
          fire_window_key: string | null; fire_at_utc: Date | null; fire_state: string | null;
          task_id: string | null; task_status: string | null;
        }>(
          `select s.schedule_id, sp.name, s.state::text as state, s.active_version,
                  f.fire_window_key, f.fire_at_utc, f.state::text as fire_state, f.admitted_child_task_id as task_id,
                  t.status::text as task_status
             from schedule_state s
             join schedule_specs sp on sp.schedule_id = s.schedule_id and sp.version = s.active_version
             left join lateral (
               select fire_window_key, fire_at_utc, state, admitted_child_task_id from schedule_fires
                where schedule_id = s.schedule_id order by fire_at_utc desc limit 1
             ) f on true
             left join tasks t on t.id = f.admitted_child_task_id
            where sp.tenant_id = $1
            order by sp.name, s.schedule_id`,
          [ctx.tenantId],
        )
      ).rows;
      const tasks = (
        await db.query<{ nonterminal: number; failed: number; completed: number }>(
          `select count(*) filter (where status::text not in ('COMPLETED','FAILED','CANCELLED','REJECTED'))::int as nonterminal,
                  count(*) filter (where status::text = 'FAILED' and updated_at > now() - interval '24 hours')::int as failed,
                  count(*) filter (where status::text = 'COMPLETED' and updated_at > now() - interval '24 hours')::int as completed
             from tasks where tenant_id = $1`,
          [ctx.tenantId],
        )
      ).rows[0]!;
      const outbox = (
        await db.query<{ status: string; n: number; stale: number }>(
          `select status, count(*)::int as n,
                  count(*) filter (where status = 'PENDING' and created_at < now() - interval '10 minutes')::int as stale
             from kernel_private.notification_outbox
            where created_at > now() - interval '24 hours' or status in ('PENDING','SENDING','POISON')
            group by status`,
        )
      ).rows;
      const epoch = Number(active?.epoch ?? 0);
      return {
        checkedAt: now().toISOString(),
        release: {
          door: doorRelease,
          active: { epoch, releaseId: active?.release_id ?? null, activatedAt: active?.activated_at?.toISOString() ?? null },
          doorMatchesActive: active?.release_id === doorRelease,
          bindingMismatches: mismatches,
        },
        schedules: schedules.map((s) => ({
          scheduleId: s.schedule_id,
          name: s.name,
          state: s.state,
          activeVersion: s.active_version,
          lastFire: s.fire_window_key
            ? { windowKey: s.fire_window_key, fireAtUtc: s.fire_at_utc!.toISOString(), state: s.fire_state!, taskId: s.task_id, taskStatus: s.task_status }
            : null,
        })),
        tasks: { nonterminal: tasks.nonterminal, failedLast24h: tasks.failed, completedLast24h: tasks.completed },
        notifications: {
          recentByStatus: Object.fromEntries(outbox.map((o) => [o.status, o.n])),
          pendingOlderThan10m: outbox.reduce((sum, o) => sum + o.stale, 0),
          poison: outbox.find((o) => o.status === "POISON")?.n ?? 0,
        },
      };
    },
    "schedule",
  );
}
