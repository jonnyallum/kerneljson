import { collectBindingProvenance } from "./release-provenance.js";
import type pg from "pg";
import { createRestateAdminClient, type RestateAdminClient } from "./restate-client.js";
import type { HealthConnectionConfig } from "./config.js";
import type {
  HealthExpectations,
  HealthSnapshot,
  RestateInvocationRow,
  ScheduleFireRow,
  ScheduleStateRow,
} from "./snapshot.js";
import type { Unavailable } from "./types.js";

/**
 * COLLECT — the only impure layer. Every function here either returns real data or
 * an `Unavailable` marker; it never throws past its own boundary and never invents
 * a fallback value. `evaluate.ts` is what turns a snapshot into verdicts; this file
 * only gathers facts.
 */

const unavailable = (reason: string): Unavailable => ({ unavailable: true, reason });

const BOUND_RELEASE_REJECTION_TEXT = "Task requires its bound worker release";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

async function fetchScheduleState(pool: pg.Pool, scheduleId: string): Promise<ScheduleStateRow | null> {
  const res = await pool.query(
    "select schedule_id, state, active_version, updated_at from schedule_state where schedule_id=$1",
    [scheduleId],
  );
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    scheduleId: String(r["schedule_id"]),
    state: String(r["state"]),
    activeVersion: String(r["active_version"]),
    updatedAt: iso(r["updated_at"]),
  };
}

async function fetchFires(pool: pg.Pool, scheduleId: string): Promise<ScheduleFireRow[]> {
  const res = await pool.query(
    `select schedule_id, schedule_version, fire_window_key, fire_at_utc, state,
            admitted_child_task_id, created_at
     from schedule_fires where schedule_id=$1 order by fire_at_utc`,
    [scheduleId],
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    scheduleId: String(r["schedule_id"]),
    scheduleVersion: String(r["schedule_version"]),
    fireWindowKey: String(r["fire_window_key"]),
    fireAtUtc: iso(r["fire_at_utc"]),
    state: String(r["state"]),
    admittedChildTaskId: r["admitted_child_task_id"] ? String(r["admitted_child_task_id"]) : null,
    createdAt: iso(r["created_at"]),
  }));
}

/** Classifies EVERY admitted fire (not merely ones missing from public.tasks — a
 *  fire whose task_id happens to exist in public.tasks despite having no
 *  kernel_private.task_admissions row is exactly as much of a genuine authority
 *  breach as one whose task_id is absent everywhere, and must not be filtered out
 *  before classification) by whether KernelJSON's own admission record exists —
 *  see AuthoritySnapshot's field comments for why this distinction is load-bearing
 *  for the correct severity. */
export async function fetchAdmittedFiresMissingTasks(
  pool: pg.Pool,
  scheduleId: string,
): Promise<{ missingAdmission: string[]; unmaterialised: string[] }> {
  const res = await pool.query(
    `select f.admitted_child_task_id as task_id,
            (a.task_id is not null) as has_admission,
            (t.id is not null) as has_task
     from schedule_fires f
     left join public.tasks t on t.id = f.admitted_child_task_id
     left join kernel_private.task_admissions a on a.task_id = f.admitted_child_task_id
     where f.schedule_id=$1 and f.admitted_child_task_id is not null`,
    [scheduleId],
  );
  const missingAdmission: string[] = [];
  const unmaterialised: string[] = [];
  for (const r of res.rows as Record<string, unknown>[]) {
    const taskId = String(r["task_id"]);
    if (!r["has_admission"]) missingAdmission.push(taskId);
    else if (!r["has_task"]) unmaterialised.push(taskId);
  }
  return { missingAdmission, unmaterialised };
}

async function fetchBoundReleaseRejectionSeen(pool: pg.Pool): Promise<boolean> {
  const res = await pool.query(
    `select 1
     from public.task_events
     where type = 'TASK_FAILED' and payload::text ilike $1
     order by occurred_at desc limit 1`,
    [`%${BOUND_RELEASE_REJECTION_TEXT}%`],
  );
  return (res.rowCount ?? 0) > 0;
}

async function fetchHumanOperatorPresent(pool: pg.Pool): Promise<boolean> {
  const res = await pool.query(
    `select 1
     from public.principals p join public.tenant_memberships m on m.principal_id = p.id
     where p.kind = 'HUMAN' and m.status = 'ACTIVE' and m.role = 'operator'
     limit 1`,
  );
  return (res.rowCount ?? 0) > 0;
}

async function fetchEvidenceForTask(
  pool: pg.Pool,
  taskId: string,
): Promise<{ id: string; taskId: string; type: string; source: string; digest: string | null; capturedAt: string; metadata: Record<string, unknown> }[]> {
  const res = await pool.query(
    `select id, task_id, type, source, digest, captured_at, metadata
     from public.evidence where task_id=$1 order by captured_at`,
    [taskId],
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    id: String(r["id"]),
    taskId: String(r["task_id"]),
    type: String(r["type"]),
    source: String(r["source"]),
    digest: r["digest"] ? String(r["digest"]) : null,
    capturedAt: iso(r["captured_at"]),
    metadata: (r["metadata"] as Record<string, unknown>) ?? {},
  }));
}

async function probeAdmissionDoor(
  admissionUrl: string | undefined,
  fetchImpl: typeof fetch,
): Promise<boolean | Unavailable> {
  if (!admissionUrl) return unavailable("KJ_ADMISSION_URL not configured");
  try {
    const res = await fetchImpl(`${admissionUrl.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err));
  }
}

function buildRestateClient(restateAdminUrl: string | undefined, fetchImpl: typeof fetch): RestateAdminClient | null {
  return restateAdminUrl ? createRestateAdminClient(restateAdminUrl, fetchImpl) : null;
}

async function collectRestateInvocations(
  client: RestateAdminClient | null,
  scheduleId: string,
): Promise<RestateInvocationRow[] | Unavailable> {
  if (!client) return unavailable("RESTATE_ADMIN_URL not configured");
  try {
    return await client.invocationsForKey(scheduleId);
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err));
  }
}

async function collectRestateServices(client: RestateAdminClient | null): Promise<string[] | Unavailable> {
  if (!client) return unavailable("RESTATE_ADMIN_URL not configured");
  try {
    return await client.registeredServices();
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err));
  }
}

async function collectRestateReachable(client: RestateAdminClient | null): Promise<boolean | Unavailable> {
  if (!client) return unavailable("RESTATE_ADMIN_URL not configured");
  return client.health();
}

function restartCountOrUnavailable(v: number | undefined, envVarName: string): number | Unavailable {
  return v === undefined ? unavailable(`${envVarName} not supplied`) : v;
}

export interface CollectDeps {
  pool: pg.Pool;
  connection: HealthConnectionConfig;
  expectations: HealthExpectations;
  /** This process's own env — used only for the self-reported bits (release id,
   *  SCHED_ARM_NEXT, SCHED_APPROVED_SHA256, SCHED_RECIPE, EXPECTED_SCHEDULE_ID),
   *  never for anything that should come from the database. */
  selfEnv: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function collectHealthSnapshot(deps: CollectDeps): Promise<HealthSnapshot> {
  const { pool, connection, expectations, selfEnv } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();

  // database reachability first — everything else that touches Postgres depends on it.
  let dbReachable = true;
  try {
    await pool.query("select 1");
  } catch {
    dbReachable = false;
  }

  const scheduleState = dbReachable ? await fetchScheduleState(pool, expectations.scheduleId) : null;
  const fires = dbReachable ? await fetchFires(pool, expectations.scheduleId) : [];
  const bindingProvenance = dbReachable ? await collectBindingProvenance(pool) : null;
  const admittedMissing = dbReachable
    ? await fetchAdmittedFiresMissingTasks(pool, expectations.scheduleId)
    : { missingAdmission: [], unmaterialised: [] };
  const boundReleaseRejectionSeen = dbReachable ? await fetchBoundReleaseRejectionSeen(pool) : false;
  const humanOperatorPresent = dbReachable ? await fetchHumanOperatorPresent(pool) : false;

  const mostRecentAdmittedFire =
    [...fires].filter((f) => f.admittedChildTaskId).sort((a, b) => Date.parse(b.fireAtUtc) - Date.parse(a.fireAtUtc))[0] ??
    null;
  const evidenceForTask =
    dbReachable && mostRecentAdmittedFire
      ? await fetchEvidenceForTask(pool, mostRecentAdmittedFire.admittedChildTaskId!)
      : [];

  const restateClient = buildRestateClient(connection.restateAdminUrl, fetchImpl);
  const restateInvocations = await collectRestateInvocations(restateClient, expectations.scheduleId);
  const registeredServices = await collectRestateServices(restateClient);
  const restateReachable = await collectRestateReachable(restateClient);

  const doorHealthy = await probeAdmissionDoor(connection.admissionUrl, fetchImpl);

  const rawArmNext = selfEnv["SCHED_ARM_NEXT"];
  const armNext = rawArmNext === undefined || rawArmNext === "" ? null : rawArmNext === "true";
  const rawDigest = selfEnv["SCHED_APPROVED_SHA256"];
  const approvedDigestShapeValid = rawDigest === undefined || rawDigest === "" ? null : /^[0-9a-f]{64}$/.test(rawDigest);

  return {
    checkedAt,
    scheduler: {
      dbReachable,
      scheduleState,
      recipe: selfEnv["SCHED_RECIPE"] ?? null,
      fires,
      restateInvocations,
    },
    authority: {
      dbReachable,
      bindingProvenance,
      admittedFireTaskIdsMissingAdmission: admittedMissing.missingAdmission,
      admittedFireTaskIdsUnmaterialised: admittedMissing.unmaterialised,
      boundReleaseRejectionSeen,
    },
    admission: {
      dbReachable,
      doorHealthy,
      humanOperatorPresent,
    },
    execution: {
      registeredServices,
      workerRestartCount: restartCountOrUnavailable(connection.workerRestartCount, "WORKER_RESTART_COUNT"),
      doorRestartCount: restartCountOrUnavailable(connection.doorRestartCount, "DOOR_RESTART_COUNT"),
    },
    restate: {
      reachable: restateReachable,
      registeredServices,
      scheduleInvocations: restateInvocations,
    },
    database: {
      reachable: dbReachable,
      scheduleReadOk: dbReachable, // fetchScheduleState/fetchFires above did not throw
      taskReadOk: dbReachable,
    },
    evidence: {
      dbReachable,
      mostRecentScheduledTaskId: mostRecentAdmittedFire?.admittedChildTaskId ?? null,
      evidenceForTask,
    },
    releaseParity: {
      dbReachable,
      selfReportedReleaseId: selfEnv["KERNELJSON_RELEASE_ID"] ?? null,
      bindingProvenance,
      boundReleaseRejectionSeen,
    },
    productionConfig: {
      armNext,
      approvedDigestShapeValid,
      scheduleIdConfigured: expectations.scheduleId,
      recipeConfigured: selfEnv["SCHED_RECIPE"] ?? null,
    },
    legacyAuthority: {
      // Deliberately always unavailable in this pass: the Shared Brain (B1/C1) is a
      // separate Supabase project this module has no credentials for, and wiring a
      // second database into a "KernelJSON production health" tool is a scope
      // decision, not a defect — see the P1.1 result doc's "genuine issues" section.
      b1FreezeObservable: unavailable(
        "Shared Brain cross-system check not wired into this module (KJ-P1.1 scope decision)",
      ),
    },
  };
}
