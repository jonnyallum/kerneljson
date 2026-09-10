import type pg from "pg";
import { z } from "zod";
import {
  Id,
  Timestamp,
  WorldEntity,
  WorldObservation,
  WorldRelationship,
  type TenantContext,
} from "../../../packages/contracts/src/index.js";
import { withTenant } from "../../../packages/identity/src/index.js";
import { capabilityDigest } from "../../../packages/capabilities/src/index.js";
import { stableId } from "../../kernel/src/compiler/index.js";
import { verifiedResult } from "../../kernel/src/provenance.js";
const EntityInput = WorldEntity.pick({ identityKey: true, type: true });
const ObservationInput = z.strictObject({
  entityId: Id,
  taskId: Id,
  evidenceId: Id,
  validFrom: Timestamp,
  validUntil: Timestamp.nullable().default(null),
});
const LinkInput = z.strictObject({
  sourceId: Id,
  targetId: Id,
  taskId: Id,
  evidenceId: Id,
});
const ViewInput = z.strictObject({
  entityId: Id,
  at: Timestamp,
  limit: z.number().int().min(1).max(50).default(20),
});
const entities = `id,tenant_id as "tenantId",identity_key as "identityKey",type`;
const relationships = `id,tenant_id as "tenantId",source_id as "sourceId",target_id as "targetId",type,task_id as "taskId",evidence_id as "evidenceId"`;
const observations = `id,tenant_id as "tenantId",entity_id as "entityId",task_id as "taskId",evidence_id as "evidenceId",source,value,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "observedAt",to_char(valid_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "validFrom",to_char(valid_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "validUntil",confidence::float as confidence`;
function same(a: unknown, b: unknown) {
  if (capabilityDigest(a) !== capabilityDigest(b))
    throw new Error("World record conflict");
}
export class WorldStore {
  constructor(private readonly pool: pg.Pool) {}
  async entity(context: TenantContext, raw: unknown): Promise<WorldEntity> {
    const input = EntityInput.parse(raw);
    return withTenant(this.pool, context, async (db, ctx) => {
      const entity = WorldEntity.parse({
        id: stableId(["entity/v1", ctx.tenantId, input.identityKey]),
        tenantId: ctx.tenantId,
        ...input,
      });
      await db.query(
        "insert into entities(id,tenant_id,identity_key,type) values($1,$2,$3,$4) on conflict(tenant_id,identity_key) do nothing",
        [entity.id, entity.tenantId, entity.identityKey, entity.type],
      );
      const rows = await db.query(
        `select ${entities} from entities where tenant_id=$1 and identity_key=$2`,
        [ctx.tenantId, entity.identityKey],
      );
      const stored = WorldEntity.parse(rows.rows[0]);
      same(stored, entity);
      return stored;
    });
  }
  async observe(
    context: TenantContext,
    raw: unknown,
  ): Promise<WorldObservation> {
    const input = ObservationInput.parse(raw);
    return withTenant(this.pool, context, async (db, ctx) => {
      const { outcome } = await verifiedResult(
        db,
        ctx.tenantId,
        input.taskId,
        input.evidenceId,
      );
      const validFrom = new Date(input.validFrom).toISOString();
      const observation = WorldObservation.parse({
        ...input,
        id: stableId([
          "observation/v1",
          ctx.tenantId,
          input.entityId,
          input.taskId,
          input.evidenceId,
          validFrom,
        ]),
        tenantId: ctx.tenantId,
        source: "kerneljson:verified-outcome/v1",
        value: {
          kind: "TASK_RESULT",
          text: outcome.summary,
          outcomeDigest: capabilityDigest(outcome),
        },
        observedAt: new Date(outcome.completedAt).toISOString(),
        validFrom,
        validUntil: input.validUntil
          ? new Date(input.validUntil).toISOString()
          : null,
        confidence: 1,
      });
      await db.query(
        "insert into observations(id,tenant_id,entity_id,task_id,evidence_id,source,value,observed_at,valid_from,valid_until,confidence) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1) on conflict(id) do nothing",
        [
          observation.id,
          ctx.tenantId,
          input.entityId,
          input.taskId,
          input.evidenceId,
          observation.source,
          observation.value,
          observation.observedAt,
          validFrom,
          observation.validUntil,
        ],
      );
      const rows = await db.query(
        `select ${observations} from observations where id=$1 and tenant_id=$2`,
        [observation.id, ctx.tenantId],
      );
      const stored = WorldObservation.parse(rows.rows[0]);
      same(stored, observation);
      return stored;
    });
  }
  async link(context: TenantContext, raw: unknown): Promise<WorldRelationship> {
    const input = LinkInput.parse(raw);
    return withTenant(this.pool, context, async (db, ctx) => {
      await verifiedResult(db, ctx.tenantId, input.taskId, input.evidenceId);
      const relation = WorldRelationship.parse({
        ...input,
        id: stableId(["relationship/v1", ctx.tenantId, input]),
        tenantId: ctx.tenantId,
        type: "SHARES_VERIFIED_RESULT",
      });
      const endpoints = await db.query(
        "select distinct entity_id from observations where tenant_id=$1 and entity_id=any($2::uuid[]) and task_id=$3 and evidence_id=$4 and source='kerneljson:verified-outcome/v1'",
        [
          ctx.tenantId,
          [input.sourceId, input.targetId],
          input.taskId,
          input.evidenceId,
        ],
      );
      if (endpoints.rowCount !== 2)
        throw new Error("Both endpoints require matching observations");
      await db.query(
        "insert into relationships(id,tenant_id,source_id,target_id,type,task_id,evidence_id) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do nothing",
        [
          relation.id,
          ctx.tenantId,
          relation.sourceId,
          relation.targetId,
          relation.type,
          relation.taskId,
          relation.evidenceId,
        ],
      );
      const rows = await db.query(
        `select ${relationships} from relationships where id=$1 and tenant_id=$2`,
        [relation.id, ctx.tenantId],
      );
      const stored = WorldRelationship.parse(rows.rows[0]);
      same(stored, relation);
      return stored;
    });
  }
  async view(context: TenantContext, raw: unknown) {
    const query = ViewInput.parse(raw);
    return withTenant(this.pool, context, async (db, ctx) => {
      const entity = await db.query(
        `select ${entities} from entities where id=$1 and tenant_id=$2`,
        [query.entityId, ctx.tenantId],
      );
      if (!entity.rows[0]) return null;
      const facts = await db.query(
        `select ${observations} from observations where tenant_id=$1 and entity_id=$2 and source='kerneljson:verified-outcome/v1' and observed_at<=$3 and valid_from<=$3 and (valid_until is null or valid_until>$3) order by observed_at desc,id limit $4`,
        [ctx.tenantId, query.entityId, query.at, query.limit],
      );
      // Edges describe shared historical provenance, not current truth at the queried time.
      const links = await db.query(
        `select ${relationships} from relationships where tenant_id=$1 and source_id=$2 and task_id is not null and evidence_id is not null order by id limit $3`,
        [ctx.tenantId, query.entityId, query.limit],
      );
      return {
        entity: WorldEntity.parse(entity.rows[0]),
        observations: facts.rows.map((r) => WorldObservation.parse(r)),
        historicalRelationships: links.rows.map((r) =>
          WorldRelationship.parse(r),
        ),
      };
    });
  }
}
