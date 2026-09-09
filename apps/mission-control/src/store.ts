import { readBinding } from "../../../services/kernel/src/execution-binding.js";
import { readOutcome } from "../../../services/kernel/src/terminal.js";
import { permissions } from "../../../packages/identity/src/index.js";
import { ControlResult, type ControlAction } from "../../../packages/contracts/src/index.js";
import type pg from "pg";
import {
  Id,
  Task,
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
      const outcome = await readOutcome(db,taskId);
      const binding = await readBinding(db,taskId);
      const controlRows = await db.query<{contract:unknown}>("select contract from kernel_private.control_events where task_id=$1 order by occurred_at desc,id desc limit 1",[taskId]);
      const lastControl = controlRows.rows[0] ? ControlResult.parse(controlRows.rows[0].contract) : null;
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
      const membership = await db.query<{role:string}>("select role from tenant_memberships where tenant_id=$1 and principal_id=$2",[ctx.tenantId,ctx.principal.id]);
      const controls: ControlAction[] = (binding?.controls ?? []).filter(action => !["COMPLETED","FAILED","CANCELLED"].includes(task.status) && (permissions[action] as readonly string[]).includes(membership.rows[0]?.role ?? "") && (action === "approve" ? !!pending && pending.requestedFrom === ctx.principal.id && ctx.principal.kind === "HUMAN" : task.principal.id === ctx.principal.id) && (action !== "signal" || task.status === "WAITING") && !(action === "cancel" && ["GoldenTaskWorkflowV1","PolicyCapabilityWorkflowV1","AutonomousChildTaskWorkflowV1"].includes(binding?.service ?? "") && task.status !== "APPROVAL_REQUIRED"));
      return {
        task, binding, controls, lastControl,
        outcome,
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
