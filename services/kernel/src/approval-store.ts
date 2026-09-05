import pg from "pg";
import {
  ApprovalAnswer,
  ApprovalResolution,
  CapabilityInvocation,
  Id,
  PolicyEvaluation,
  PrincipalRef,
  Task,
  TaskStep,
} from "../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../packages/capabilities/src/index.js";

export class ApprovalError extends Error {}
type Ticket = {
  evaluation: PolicyEvaluation;
  invocation: CapabilityInvocation;
  approvalId: string;
};
export class ApprovalStore {
  constructor(private readonly pool: pg.Pool) {}
  private async member(db: pg.PoolClient, tenant: string, actor: PrincipalRef) {
    const rows = await db.query(
      "select 1 from tenant_memberships m join principals p on p.id=m.principal_id where m.tenant_id=$1 and p.id=$2 and p.kind=$3",
      [tenant, actor.id, actor.kind],
    );
    if (rows.rowCount !== 1)
      throw new ApprovalError("Identity is not a member of the task tenant");
  }
  async record(
    evaluation: PolicyEvaluation,
    invocation: CapabilityInvocation,
    approvalId: string,
  ): Promise<void> {
    const e = PolicyEvaluation.parse(evaluation),
      request = CapabilityInvocation.parse(invocation);
    Id.parse(approvalId);
    if (
      e.scopeDigest !== capabilityDigest(e.scope) ||
      e.scope.invocationDigest !== capabilityDigest(request)
    )
      throw new ApprovalError("Invalid policy scope");
    const payload = { evaluation: e, invocation: request, approvalId };
    const digest = capabilityDigest(payload),
      key = `policy-approval:${approvalId}`;
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        e.scope.taskId,
      ]);
      const prior = await db.query<{ request_digest: string }>(
        "select request_digest from task_events where task_id=$1 and event_key=$2",
        [e.scope.taskId, key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== digest)
          throw new ApprovalError("Policy idempotency conflict");
        await db.query("commit");
        return;
      }
      const tasks = await db.query<{ contract: unknown }>(
        "select contract from tasks where id=$1 for update",
        [e.scope.taskId],
      );
      const task = Task.parse(tasks.rows[0]?.contract);
      const steps = await db.query<{ contract: unknown }>(
        "select contract from task_steps where id=$1 and task_id=$2",
        [e.scope.stepId, task.id],
      );
      const step = TaskStep.parse(steps.rows[0]?.contract);
      if (
        task.status !== "COMPILED" ||
        step.status !== "READY" ||
        task.tenant.id !== e.scope.tenantId ||
        capabilityDigest(task.principal) !==
          capabilityDigest(e.scope.principal) ||
        task.traceId !== e.scope.trace.traceId ||
        capabilityDigest(step.input) !== capabilityDigest(request.input) ||
        step.idempotencyKey !== request.idempotencyKey ||
        capabilityDigest(step.requiredCapabilities) !==
          capabilityDigest([request.capability])
      )
        throw new ApprovalError("Policy does not match persisted task step");
      await this.member(db, task.tenant.id, task.principal);
      if (e.decision.decision === "APPROVAL_REQUIRED") {
        await this.member(db, task.tenant.id, e.approver!);
        await db.query(
          "insert into approvals(id,task_id,step_id,requested_from,requested_at,status) values($1,$2,$3,$4,$5,'PENDING')",
          [
            approvalId,
            task.id,
            step.id,
            e.approver!.id,
            e.decision.evaluatedAt,
          ],
        );
      }
      await db.query(
        "insert into task_events(id,task_id,step_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,$3,$4,$5,'POLICY_CHECKED',$6,$7,$8,$9)",
        [
          e.decision.id,
          task.id,
          step.id,
          key,
          digest,
          e.decision.evaluatedAt,
          task.principal.id,
          task.traceId,
          JSON.stringify(payload),
        ],
      );
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
    }
  }
  private async ticket(db: pg.PoolClient, id: string, lock = false) {
    const rows = await db.query<{
      status: ApprovalResolution["status"];
      evidence_id: string | null;
      payload: Ticket;
      metadata: { reason?: ApprovalResolution["reason"] } | null;
    }>(
      `select a.status,a.evidence_id,e.payload,v.metadata from approvals a join task_events e on e.task_id=a.task_id and e.event_key='policy-approval:'||a.id::text left join evidence v on v.id=a.evidence_id where a.id=$1 ${lock ? "for update of a" : ""}`,
      [Id.parse(id)],
    );
    const row = rows.rows[0];
    if (!row) throw new ApprovalError("Unknown approval");
    const evaluation = PolicyEvaluation.parse(row.payload.evaluation);
    const invocation = CapabilityInvocation.parse(row.payload.invocation);
    const resolution = ApprovalResolution.parse({
      approvalId: id,
      scopeDigest: evaluation.scopeDigest,
      status: row.status,
      expiresAt: evaluation.expiresAt,
      ...(row.evidence_id
        ? { evidenceId: row.evidence_id, reason: row.metadata?.reason }
        : {}),
    });
    return { evaluation, invocation, resolution };
  }
  async read(id: string): Promise<ApprovalResolution> {
    const db = await this.pool.connect();
    try {
      return (await this.ticket(db, id)).resolution;
    } finally {
      db.release();
    }
  }
  async resolve(
    id: string,
    raw: unknown,
    actor: PrincipalRef,
    evidenceId: string,
    eventId: string,
  ) {
    const answer = ApprovalAnswer.parse(raw);
    return this.finish(
      id,
      answer.decision,
      PrincipalRef.parse(actor),
      answer.scopeDigest,
      evidenceId,
      eventId,
    );
  }
  async cancel(
    id: string,
    actor: PrincipalRef,
    evidenceId: string,
    eventId: string,
  ) {
    return this.finish(
      id,
      "CANCEL",
      PrincipalRef.parse(actor),
      undefined,
      evidenceId,
      eventId,
    );
  }
  async expire(id: string, evidenceId: string, eventId: string) {
    return this.finish(id, "EXPIRE", undefined, undefined, evidenceId, eventId);
  }
  private async finish(
    id: string,
    action: "GRANTED" | "DENIED" | "CANCEL" | "EXPIRE",
    actor: PrincipalRef | undefined,
    scopeDigest: string | undefined,
    evidenceId: string,
    eventId: string,
  ): Promise<ApprovalResolution> {
    Id.parse(evidenceId);
    Id.parse(eventId);
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      const first = await this.ticket(db, id);
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        first.evaluation.scope.taskId,
      ]);
      const { evaluation: e, resolution } = await this.ticket(db, id, true);
      if (action !== "EXPIRE") {
        const expected = action === "CANCEL" ? e.scope.principal : e.approver!;
        if (
          !actor ||
          actor.id !== expected.id ||
          actor.kind !== expected.kind ||
          (action !== "CANCEL" && scopeDigest !== e.scopeDigest)
        )
          throw new ApprovalError("Approval identity or scope mismatch");
        await this.member(db, e.scope.tenantId, actor);
      }
      if (resolution.status !== "PENDING") {
        await db.query("commit");
        return resolution;
      }
      const clock = await db.query<{ now: Date }>(
        "select clock_timestamp() as now",
      );
      const at = clock.rows[0]!.now.toISOString();
      const expired = Date.parse(at) >= Date.parse(e.expiresAt!);
      if (action === "EXPIRE" && !expired) {
        await db.query("commit");
        return resolution;
      }
      const tasks = await db.query<{ status: string }>(
        "select status from tasks where id=$1 for update",
        [e.scope.taskId],
      );
      const cancelled =
        action === "CANCEL" || tasks.rows[0]?.status === "CANCELLED";
      if (
        !cancelled &&
        !["COMPILED", "APPROVAL_REQUIRED"].includes(tasks.rows[0]?.status ?? "")
      )
        throw new ApprovalError("Task is not awaiting authorization");
      const status = expired
        ? "EXPIRED"
        : cancelled
          ? "DENIED"
          : action === "GRANTED"
            ? "GRANTED"
            : "DENIED";
      const reason = expired ? "EXPIRED" : cancelled ? "CANCELLED" : "HUMAN";
      const attributed = actor ?? e.scope.principal;
      const metadata = {
        approvalId: id,
        scopeDigest: e.scopeDigest,
        status,
        reason,
        actor: attributed,
      };
      const digest = capabilityDigest(metadata);
      await db.query(
        "insert into evidence(id,task_id,step_id,type,source,digest,captured_at,metadata) values($1,$2,$3,$4,'kerneljson:approval/v1',$5,$6,$7)",
        [
          evidenceId,
          e.scope.taskId,
          e.scope.stepId,
          reason === "HUMAN" ? "HUMAN_DECISION" : "DETERMINISTIC_RESULT",
          digest,
          at,
          metadata,
        ],
      );
      await db.query(
        "update approvals set status=$2,resolved_at=$3,evidence_id=$4 where id=$1",
        [id, status, at, evidenceId],
      );
      await db.query(
        "insert into task_events(id,task_id,step_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          eventId,
          e.scope.taskId,
          e.scope.stepId,
          `approval:${id}:resolved`,
          digest,
          status === "GRANTED" ? "APPROVAL_GRANTED" : "POLICY_CHECKED",
          at,
          attributed.id,
          e.scope.trace.traceId,
          JSON.stringify(metadata),
        ],
      );
      await db.query("commit");
      return ApprovalResolution.parse({
        ...resolution,
        status,
        evidenceId,
        reason,
      });
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
    }
  }
}
