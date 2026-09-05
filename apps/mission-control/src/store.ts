import type pg from "pg";
import {
  Id,
  Task,
  Outcome,
  PolicyEvaluation,
  type TenantContext,
} from "../../../packages/contracts/src/index.js";
import { withTenant } from "../../../packages/identity/src/index.js";
export class MissionControlStore {
  constructor(private readonly pool: pg.Pool) {}
  async list(context: TenantContext) {
    return withTenant(this.pool, context, async (db, ctx) => {
      const rows = await db.query<{ contract: unknown }>(
        "select contract from tasks where tenant_id=$1 order by created_at desc,id limit 50",
        [ctx.tenantId],
      );
      return rows.rows.map((r) => Task.parse(r.contract));
    });
  }
  async task(context: TenantContext, taskId: string) {
    Id.parse(taskId);
    return withTenant(this.pool, context, async (db, ctx) => {
      const rows = await db.query<{ contract: unknown }>(
        "select contract from tasks where id=$1 and tenant_id=$2",
        [taskId, ctx.tenantId],
      );
      if (!rows.rows[0]) return null;
      const task = Task.parse(rows.rows[0].contract);
      const outcomes = await db.query<{ contract: unknown }>(
        "select contract from outcomes where task_id=$1",
        [taskId],
      );
      const events = await db.query<{
        id: string;
        type: string;
        at: Date;
        payload: unknown;
      }>(
        "select id,type,occurred_at as at,payload from task_events where task_id=$1 order by occurred_at desc,id limit 200",
        [taskId],
      );
      const evidence = await db.query<{
        id: string;
        type: string;
        source: string;
        digest: string | null;
      }>(
        "select id,type,source,digest from evidence where task_id=$1 order by captured_at,id limit 100",
        [taskId],
      );
      const approvals = await db.query<{
        requestedFrom: string;
        payload: { evaluation: unknown };
      }>(
        "select a.requested_from as \"requestedFrom\",e.payload from approvals a join task_events e on e.task_id=a.task_id and e.event_key='policy-approval:'||a.id::text where a.task_id=$1 and a.status='PENDING' order by a.id limit 1",
        [taskId],
      );
      const pending = approvals.rows[0];
      return {
        task,
        outcome: outcomes.rows[0]
          ? Outcome.parse(outcomes.rows[0].contract)
          : null,
        events: events.rows,
        evidence: evidence.rows,
        pending: pending
          ? {
              requestedFrom: pending.requestedFrom,
              evaluation: PolicyEvaluation.parse(pending.payload.evaluation),
            }
          : null,
      };
    });
  }
}
export type TaskView = NonNullable<
  Awaited<ReturnType<MissionControlStore["task"]>>
>;
