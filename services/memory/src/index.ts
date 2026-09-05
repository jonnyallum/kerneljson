import type pg from "pg";
import { z } from "zod";
import {
  Id,
  MemoryItem,
  Timestamp,
  type TenantContext,
} from "../../../packages/contracts/src/index.js";
import { withTenant } from "../../../packages/identity/src/index.js";
import { capabilityDigest } from "../../../packages/capabilities/src/index.js";
import { stableId } from "../../kernel/src/compiler/index.js";
import { verifiedResult } from "../../kernel/src/provenance.js";
export const RememberResult = z.strictObject({
  taskId: Id,
  evidenceId: Id,
  validUntil: Timestamp.nullable().default(null),
});
export const MemoryQuery = z.strictObject({
  text: z.string().trim().min(1).max(256),
  at: Timestamp,
  limit: z.number().int().min(1).max(50).default(10),
});
const columns = `id,tenant_id as "tenantId",task_id as "taskId",evidence_id as "evidenceId",source,content,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "observedAt",to_char(valid_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "validUntil"`;
export class MemoryStore {
  constructor(private readonly pool: pg.Pool) {}
  async remember(context: TenantContext, raw: unknown): Promise<MemoryItem> {
    const request = RememberResult.parse(raw);
    return withTenant(this.pool, context, async (db, ctx) => {
      const { outcome } = await verifiedResult(
        db,
        ctx.tenantId,
        request.taskId,
        request.evidenceId,
      );
      const item = MemoryItem.parse({
        id: stableId([
          "memory/v1",
          ctx.tenantId,
          request.taskId,
          request.evidenceId,
        ]),
        tenantId: ctx.tenantId,
        ...request,
        validUntil: request.validUntil
          ? new Date(request.validUntil).toISOString()
          : null,
        source: "kerneljson:verified-outcome/v1",
        content: {
          kind: "TASK_RESULT",
          text: outcome.summary,
          outcomeDigest: capabilityDigest(outcome),
        },
        observedAt: new Date(outcome.completedAt).toISOString(),
      });
      await db.query(
        "insert into memory_items(id,tenant_id,task_id,evidence_id,source,content,observed_at,valid_until) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(id) do nothing",
        [
          item.id,
          item.tenantId,
          item.taskId,
          item.evidenceId,
          item.source,
          item.content,
          item.observedAt,
          item.validUntil,
        ],
      );
      const rows = await db.query(
        `select ${columns} from memory_items where id=$1 and tenant_id=$2`,
        [item.id, ctx.tenantId],
      );
      const stored = MemoryItem.parse(rows.rows[0]);
      if (capabilityDigest(stored) !== capabilityDigest(item))
        throw new Error("Conflicting memory provenance or validity");
      return stored;
    });
  }
  async retrieve(context: TenantContext, raw: unknown): Promise<MemoryItem[]> {
    const query = MemoryQuery.parse(raw);
    return withTenant(this.pool, context, async (db, ctx) => {
      const rows = await db.query(
        `select ${columns} from memory_items where tenant_id=$1 and source='kerneljson:verified-outcome/v1' and observed_at<=$2 and (valid_until is null or valid_until>$2) and strpos(lower(content->>'text'),lower($3))>0 order by observed_at desc,id limit $4`,
        [ctx.tenantId, query.at, query.text, query.limit],
      );
      return rows.rows.map((row) => MemoryItem.parse(row));
    });
  }
}
