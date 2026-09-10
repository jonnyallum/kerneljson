import { z } from "zod";
import type pg from "pg";
import type { Context } from "@restatedev/restate-sdk";
import {
  Task,
  TaskStep,
  CapabilityInvocation,
  RouteObservation,
  RoutingLimits,
  CapabilityRef,
  Timestamp,
  type TenantContext,
} from "../../../packages/contracts/src/index.js";
import {
  capabilityDigest,
  type CapabilityRegistry,
} from "../../../packages/capabilities/src/index.js";
import { withTenant } from "../../../packages/identity/src/index.js";
import { PolicyRules, evaluatePolicy } from "./policy.js";
import { stableId } from "./compiler/index.js";
const Config = z.strictObject({
  version: z.string().min(1),
  compatible: z.array(CapabilityRef).min(1).max(16),
  defaultCapability: CapabilityRef,
  limits: RoutingLimits,
});
type Config = z.infer<typeof Config>;
const key = (ref: { id: string; version: string }) =>
  `${ref.id}@${ref.version}`;
export class AdaptiveRouter {
  private readonly config: Config;
  private readonly policy: PolicyRules;
  constructor(
    private readonly registry: CapabilityRegistry,
    config: Config,
    policy: PolicyRules,
    private readonly evaluated: (
      ref: z.infer<typeof CapabilityRef>,
      descriptorDigest: string,
    ) => Promise<boolean>,
  ) {
    this.config = Config.parse(config);
    this.policy = PolicyRules.parse(policy);
    if (
      new Set(config.compatible.map(key)).size !== config.compatible.length ||
      !config.compatible.some((c) => key(c) === key(config.defaultCapability))
    )
      throw new Error("Invalid compatible routes");
    for (const ref of config.compatible) registry.describe(ref);
  }
  async select(
    rawTask: Task,
    rawStep: TaskStep,
    rawRequest: CapabilityInvocation,
    rawObservations: RouteObservation[],
    at: string,
  ) {
    const task = Task.parse(rawTask),
      step = TaskStep.parse(rawStep),
      request = CapabilityInvocation.parse(rawRequest),
      observations = z.array(RouteObservation).max(1000).parse(rawObservations);
    Timestamp.parse(at);
    if (
      new Set(observations.map((o) => o.evidenceId)).size !==
      observations.length
    )
      throw new Error("Duplicate measurement evidence");
    const options = [];
    for (const ref of this.config.compatible) {
      const descriptor = this.registry.describe(ref),
        invocation = CapabilityInvocation.parse({
          ...request,
          capability: ref,
        });
      const planned = TaskStep.parse({ ...step, requiredCapabilities: [ref] });
      const evaluation = evaluatePolicy(
        this.policy,
        task,
        planned,
        invocation,
        descriptor,
        stableId([
          "route-policy/v1",
          task.id,
          step.id,
          ref,
          this.policy.version,
        ]),
        at,
      );
      if (
        evaluation.decision.decision !== "ALLOW" ||
        !(await this.evaluated(ref, descriptor.digest))
      )
        continue;
      const samples = observations.filter(
        (o) =>
          key(o.capability) === key(ref) &&
          o.descriptorDigest === descriptor.digest &&
          Date.parse(o.observedAt) <= Date.parse(at) &&
          Date.parse(at) - Date.parse(o.observedAt) <=
            this.config.limits.maxAgeMs,
      );
      const successRate =
        samples.filter((o) => o.success).length / samples.length;
      const latencyMs =
        samples.reduce((sum, o) => sum + o.latencyMs, 0) / samples.length;
      const costUnits =
        samples.reduce((sum, o) => sum + o.costUnits, 0) / samples.length;
      const measured = samples.length >= this.config.limits.minSamples;
      if (
        measured
          ? successRate < this.config.limits.minSuccessRate ||
            latencyMs > this.config.limits.maxLatencyMs ||
            costUnits > this.config.limits.maxCostUnits
          : !this.config.limits.allowColdStart ||
            samples.length !== 0 ||
            key(ref) !== key(this.config.defaultCapability)
      )
        continue;
      options.push({
        invocation,
        step: planned,
        evaluation,
        reason: measured ? ("MEASURED" as const) : ("COLD_START" as const),
        samples: samples.length,
        successRate: measured ? successRate : 0,
        latencyMs: measured ? latencyMs : 0,
        costUnits: measured ? costUnits : 0,
      });
    }
    options.sort(
      (a, b) =>
        Number(b.reason === "MEASURED") - Number(a.reason === "MEASURED") ||
        b.successRate - a.successRate ||
        a.costUnits - b.costUnits ||
        a.latencyMs - b.latencyMs ||
        (key(a.invocation.capability) < key(b.invocation.capability) ? -1 : 1),
    );
    const selected = options[0];
    if (!selected)
      throw new Error("No eligible evaluated policy-allowed route");
    return {
      ...selected,
      routerVersion: this.config.version,
      snapshotDigest: capabilityDigest(observations),
    };
  }
}
export type RouteSelection = Awaited<ReturnType<AdaptiveRouter["select"]>>;
export async function routeDurably(
  ctx: Pick<Context, "run">,
  router: AdaptiveRouter,
  task: Task,
  step: TaskStep,
  request: CapabilityInvocation,
  at: string,
  read: () => Promise<RouteObservation[]>,
  record: (selection: RouteSelection) => Promise<void>,
): Promise<RouteSelection> {
  const selection = await ctx.run(`route:${request.runId}:select`, async () =>
    router.select(task, step, request, await read(), at),
  );
  await ctx.run(`route:${request.runId}:record`, () => record(selection));
  return selection;
}
/** Measured task success and elapsed execution interval, not provider billing or CPU time. */
export async function readRouteObservations(
  pool: pg.Pool,
  context: TenantContext,
): Promise<RouteObservation[]> {
  return withTenant(pool, context, async (db, ctx) => {
    const rows = await db.query(
      `select r.task_id as "taskId",r.evidence_id as "evidenceId",r.result->'capability' as capability,r.result->>'descriptorDigest' as "descriptorDigest",to_char(o.completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "observedAt",o.status='COMPLETED' as success,extract(epoch from (v.at-s.at))*1000 as "latencyMs",1 as "costUnits" from capability_runs r join tasks t on t.id=r.task_id join outcomes o on o.task_id=t.id join lateral (select min(occurred_at) as at from task_events where task_id=t.id and type='TASK_STARTED') s on s.at is not null join lateral (select max(occurred_at) as at from task_events where task_id=t.id and type='TASK_VERIFYING') v on v.at>=s.at where t.tenant_id=$1 order by o.completed_at desc,r.id limit 1000`,
      [ctx.tenantId],
    );
    return rows.rows.map((r) =>
      RouteObservation.parse({ ...r, latencyMs: Number(r["latencyMs"]) }),
    );
  });
}
