import pg from "pg";
import { z } from "zod";
import {
  CapabilityInvocation,
  CapabilityResult,
  Evidence,
  Id,
  Task,
  TaskEvent,
  TaskStep,
  Timestamp,
} from "../../../packages/contracts/src/index.js";
import {
  CapabilityRegistry,
  capabilityDigest,
} from "../../../packages/capabilities/src/index.js";

const Audit = z.strictObject({
  evidenceId: Id,
  eventId: Id,
  recordedAt: Timestamp,
});
export type CapabilityAudit = z.infer<typeof Audit>;

/** Internal, trusted database adapter. No remote endpoint or scheduling loop. */
export class CapabilityStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: CapabilityRegistry,
  ) {}

  async record(
    raw: CapabilityInvocation,
    rawResult: CapabilityResult,
    rawAudit: CapabilityAudit,
  ): Promise<void> {
    const request = CapabilityInvocation.parse(raw);
    const result = this.registry.verify(request, rawResult);
    const audit = Audit.parse(rawAudit);
    const descriptor = this.registry.describe(request.capability);
    const descriptorJson = {
      metadata: descriptor.metadata,
      inputSchema: descriptor.inputSchema,
      outputSchema: descriptor.outputSchema,
      digest: descriptor.digest,
    };
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      // Same lock namespace as Ledger: serialize writes for one task.
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        request.taskId,
      ]);
      const prior = await db.query<{ request_digest: string; result: unknown }>(
        "select request_digest,result from public.capability_runs where task_id=$1 and idempotency_key=$2",
        [request.taskId, request.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (
          prior.rows[0].request_digest !== result.requestDigest ||
          capabilityDigest(CapabilityResult.parse(prior.rows[0].result)) !==
            capabilityDigest(result)
        )
          throw new Error("Capability idempotency conflict");
        await db.query("commit");
        return;
      }
      const tasks = await db.query<{ contract: unknown }>(
        "select contract from public.tasks where id=$1 for update",
        [request.taskId],
      );
      const task = Task.parse(tasks.rows[0]?.contract);
      const steps = await db.query<{ contract: unknown }>(
        "select contract from public.task_steps where id=$1 and task_id=$2 for update",
        [request.stepId, request.taskId],
      );
      const step = TaskStep.parse(steps.rows[0]?.contract);
      if (
        task.status !== "RUNNING" ||
        task.riskClass !== "LOW" ||
        task.traceId !== request.trace.traceId ||
        step.status !== "RUNNING" ||
        step.kind !== "DETERMINISTIC_FUNCTION" ||
        step.riskClass !== "LOW" ||
        step.idempotencyKey !== request.idempotencyKey ||
        capabilityDigest(step.input) !== capabilityDigest(request.input) ||
        capabilityDigest(step.requiredCapabilities) !==
          capabilityDigest([request.capability])
      )
        throw new Error(
          "Capability request does not match the running task step",
        );

      // Immutable by application convention: an existing exact version may never
      // be overwritten by registration. Persist schemas as well as metadata.
      await db.query(
        "insert into public.capabilities(id,name) values($1,$2) on conflict(id) do nothing",
        [request.capability.id, `kerneljson:${request.capability.id}`],
      );
      await db.query(
        "insert into public.capability_versions(capability_id,version,contract) values($1,$2,$3) on conflict(capability_id,version) do nothing",
        [request.capability.id, request.capability.version, descriptorJson],
      );
      const versions = await db.query<{ id: string; contract: unknown }>(
        "select id,contract from public.capability_versions where capability_id=$1 and version=$2 for share",
        [request.capability.id, request.capability.version],
      );
      const version = versions.rows[0];
      if (
        !version ||
        capabilityDigest(z.json().parse(version.contract)) !==
          capabilityDigest(descriptorJson)
      )
        throw new Error("Capability version definition conflict");

      const evidence = Evidence.parse({
        id: audit.evidenceId,
        taskId: task.id,
        stepId: step.id,
        type: "DETERMINISTIC_RESULT",
        source: "kerneljson:capability/v1",
        digest: capabilityDigest(result),
        capturedAt: audit.recordedAt,
        metadata: {
          capability: request.capability,
          runId: request.runId,
          requestDigest: result.requestDigest,
          outputDigest: result.outputDigest,
          descriptorDigest: result.descriptorDigest,
        },
      });
      const event = TaskEvent.parse({
        id: audit.eventId,
        taskId: task.id,
        stepId: step.id,
        type: "TOOL_CALLED",
        occurredAt: audit.recordedAt,
        actor: task.principal,
        traceId: task.traceId,
        payload: { result, evidenceId: evidence.id },
      });
      await db.query(
        "insert into public.evidence(id,task_id,step_id,type,source,digest,captured_at,metadata) values($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          evidence.id,
          task.id,
          step.id,
          evidence.type,
          evidence.source,
          evidence.digest,
          evidence.capturedAt,
          evidence.metadata,
        ],
      );
      await db.query(
        "insert into public.task_events(id,task_id,step_id,event_key,request_digest,type,occurred_at,actor_id,trace_id,payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          event.id,
          task.id,
          step.id,
          `capability:${request.idempotencyKey}`,
          result.requestDigest,
          event.type,
          event.occurredAt,
          event.actor.id,
          event.traceId,
          JSON.stringify(event.payload),
        ],
      );
      await db.query(
        "insert into public.capability_runs(id,task_id,step_id,capability_version_id,idempotency_key,request_digest,result,evidence_id,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          request.runId,
          task.id,
          step.id,
          version.id,
          request.idempotencyKey,
          result.requestDigest,
          result,
          evidence.id,
          audit.recordedAt,
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
}
