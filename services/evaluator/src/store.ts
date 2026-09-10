import type pg from "pg";
import { z } from "zod";
import {
  Id,
  EvaluationSuite,
  EvaluationReport,
  type TenantContext,
} from "../../../packages/contracts/src/index.js";
import { withTenant } from "../../../packages/identity/src/index.js";
import { capabilityDigest } from "../../../packages/capabilities/src/index.js";
import { stableId } from "../../kernel/src/compiler/index.js";
import { verifiedResult } from "../../kernel/src/provenance.js";
import {
  evaluate,
  promotionAllowed,
  type EvaluationCandidate,
} from "./index.js";
const Request = z.strictObject({ taskId: Id, evidenceId: Id });
export class EvaluationStore {
  private readonly suite: EvaluationSuite;
  private readonly candidate: EvaluationCandidate;
  constructor(
    private readonly pool: pg.Pool,
    suite: EvaluationSuite,
    candidate: EvaluationCandidate,
  ) {
    this.suite = EvaluationSuite.parse(suite);
    this.candidate = { ...candidate };
  }
  async run(context: TenantContext, raw: unknown) {
    const request = Request.parse(raw);
    return withTenant(this.pool, context, async (db, ctx) => {
      await verifiedResult(
        db,
        ctx.tenantId,
        request.taskId,
        request.evidenceId,
      );
      const id = stableId([
        "evaluation/v1",
        request,
        this.candidate.digest,
        capabilityDigest(this.suite),
      ]);
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        id,
      ]);
      const existing = await db.query<{ result: unknown }>(
        "select result from evaluations where id=$1",
        [id],
      );
      if (existing.rows[0])
        return { id, report: EvaluationReport.parse(existing.rows[0].result) };
      const report = evaluate(
        this.suite,
        this.candidate,
        new Date().toISOString(),
      );
      await db.query(
        "insert into evaluations(id,task_id,outcome_id,evaluator_version,result) select $1,$2,id,$3,$4 from outcomes where task_id=$2",
        [id, request.taskId, report.evaluatorVersion, report],
      );
      return { id, report };
    });
  }
  async canPromote(
    context: TenantContext,
    evaluationId: string,
  ): Promise<boolean> {
    Id.parse(evaluationId);
    return withTenant(this.pool, context, async (db, ctx) => {
      const rows = await db.query<{ result: unknown }>(
        "select e.result from evaluations e join tasks t on t.id=e.task_id where e.id=$1 and t.tenant_id=$2",
        [evaluationId, ctx.tenantId],
      );
      return promotionAllowed(
        rows.rows[0]?.result,
        this.suite,
        this.candidate.digest,
      );
    });
  }
}
