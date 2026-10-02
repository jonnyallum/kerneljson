import { RUNTIME_ROLES, RuntimeRoleRefusal, assertRuntimeRole, compareDefinerFunctions, compareRoleToManifest, loadManifest } from "../database/runtime-roles.js";
import { collectBindingProvenance } from "./release-provenance.js";
import type pg from "pg";
import { createRestateAdminClient, type RestateAdminClient } from "./restate-client.js";
import type { HealthConnectionConfig } from "./config.js";
import { IDENTITY_CHANGE_CRITERION } from "../../../../packages/contracts/src/index.js";
import type {
  HealthExpectations,
  HealthSnapshot,
  IdentityCognitionSnapshot,
  IdentityOrphanRow,
  IncompleteBootstrapRow,
  RestateInvocationRow,
  ScheduleFireRow,
  ScheduleStateRow,
} from "./snapshot.js";
import type { Unavailable } from "./types.js";
import { provenanceOf } from "../identity/evidence-verify.js";
import { canonicalDigest } from "../identity/canonical.js";
import { IdentityCognitionPin } from "../../../../packages/contracts/src/index.js";

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

/** KJ-P7A - ADR-0021 D8's orphan detector: COMPLETED identity-change tasks with no activation. See
 *  IdentityOrphanRow - completion and activation are one transaction, so any row here is corruption. */
export async function fetchIdentityOrphans(pool: pg.Pool, now: Date): Promise<IdentityOrphanRow[]> {
  const res = await pool.query(
    `select t.id as task_id, t.updated_at
     from public.tasks t
     where t.status = 'COMPLETED'
       and t.contract->'acceptanceCriteria'->>0 = $1
       and not exists (select 1 from public.identity_activations a where a.request_task_id = t.id)`,
    [IDENTITY_CHANGE_CRITERION],
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    taskId: String(r["task_id"]),
    ageMs: now.getTime() - new Date(iso(r["updated_at"])).getTime(),
  }));
}

/** KJ-P7A - identity profiles with no activated identity (an interrupted bootstrap). */
export async function fetchIncompleteBootstraps(pool: pg.Pool, now: Date): Promise<IncompleteBootstrapRow[]> {
  const res = await pool.query(
    `select p.id, p.tenant_id, p.created_at
     from public.identity_profiles p
     where not exists (select 1 from public.identity_activations a where a.identity_id = p.id)`,
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    identityId: String(r["id"]),
    tenantId: String(r["tenant_id"]),
    ageMs: now.getTime() - new Date(iso(r["created_at"])).getTime(),
  }));
}

/** KJ-P7B-1 (ADR-0022 section 11) - the P7B store invariants and the two cognition-binding invariants. Every read is
 *  a durable database fact; nothing here reads the feature switch. Unavailable if the P7B schema cannot be read. */
export async function fetchIdentityCognition(pool: pg.Pool): Promise<IdentityCognitionSnapshot | Unavailable> {
  try {
    const parity = await pool.query(
      `select v.id from public.identity_versions v
       where v.identity_core_digest is distinct from kernel_private.identity_core_digest_v1(v.document)
          or v.class_a_digest is distinct from kernel_private.identity_core_digest_v1(v.document->'sections'->'classA')`,
    );
    const multi = await pool.query(`select tenant_id from public.identity_current group by tenant_id having count(*) > 1`);
    const head = await pool.query(
      `select h.identity_id from public.identity_head h
       left join public.identity_current c on c.identity_id = h.identity_id
       where c.version is distinct from h.version`,
    );
    const marker = await pool.query(`select first_release_epoch from kernel_private.identity_cognition_contract_v1 where singleton`);
    const required = await pool.query(
      `select l.task_id, l.step_id, p.pin,
         (v.id is null) as no_version,
         (v.id is not null and (v.identity_core_digest is distinct from p.pin->>'identityCoreDigest'
            or kernel_private.identity_core_digest_v1(v.document) is distinct from p.pin->>'identityCoreDigest'
            or kernel_private.identity_core_digest_v1(v.document->'sections'->'classA') is distinct from p.pin->>'classADigest')) as version_mismatch,
         (p.pin is not null and kernel_private.identity_core_digest_v1(p.pin->'projection') is distinct from p.pin->>'projectionDigest') as projection_mismatch,
         e.metadata as analyst_metadata
       from kernel_private.identity_cognition_latches l
       left join public.identity_pins p on p.task_id = l.task_id and p.step_id = l.step_id
       left join public.identity_versions v on v.id::text = p.pin->>'identityVersionId'
       left join lateral (select ev.metadata from public.evidence ev
                          where ev.task_id = l.task_id and ev.step_id = l.step_id and ev.source = 'kerneljson:runtime/analyst'
                            and ev.metadata ? 'output_digest' -- a completed model execution, not a refusal record
                          order by ev.captured_at limit 1) e on true
       where l.mode = 'REQUIRED'`,
    );
    const unboundRequired: IdentityCognitionSnapshot["unboundRequired"] = [];
    for (const r of required.rows as Array<Record<string, unknown>>) {
      const at = { taskId: String(r["task_id"]), stepId: String(r["step_id"]) };
      if (!r["pin"]) { unboundRequired.push({ ...at, reason: "REQUIRED latch has no identity pin" }); continue; }
      if (r["no_version"]) { unboundRequired.push({ ...at, reason: "pinned identity version is unavailable" }); continue; }
      if (r["version_mismatch"]) { unboundRequired.push({ ...at, reason: "pinned version digests do not equal the pin" }); continue; }
      if (r["projection_mismatch"]) { unboundRequired.push({ ...at, reason: "pinned projection digest does not verify" }); continue; }
      const metadata = r["analyst_metadata"] as Record<string, unknown> | null;
      if (!metadata) continue; // the call has not produced evidence yet: nothing consumed to compare
      const pin = IdentityCognitionPin.safeParse(r["pin"]);
      if (!pin.success || metadata["identity_cognition_mode"] !== "REQUIRED"
        || canonicalDigest(metadata["identity"] ?? null) !== canonicalDigest(provenanceOf(pin.data)))
        unboundRequired.push({ ...at, reason: "analyst runtime evidence differs from the canonical pin" });
    }
    const observed = await pool.query(
      `select count(*)::int as n from public.evidence e
       join kernel_private.execution_bindings b on b.task_id = e.task_id
       join kernel_private.identity_cognition_contract_v1 m on m.singleton
       where e.source in ('kerneljson:runtime/analyst', 'kerneljson:runtime/reviewer') and b.release_epoch >= m.first_release_epoch`,
    );
    const isolation = await pool.query(
      `select e.task_id, 'reviewer evidence carries identity' as reason from public.evidence e
         where e.source = 'kerneljson:runtime/reviewer' and e.metadata ? 'identity'
       union all
       select p.task_id, 'identity pin on a non-analyst step' from public.identity_pins p
         where not exists (select 1 from public.faculty_pins f
                           where f.task_id = p.task_id and f.step_id = p.step_id and f.faculty_id = 'intelligence')
       union all
       select l.task_id, 'NONE-latched analyst evidence carries identity' from kernel_private.identity_cognition_latches l
         join public.evidence e on e.task_id = l.task_id and e.step_id = l.step_id and e.source = 'kerneljson:runtime/analyst'
         where l.mode = 'NONE' and e.metadata ? 'identity' and jsonb_typeof(e.metadata->'identity') <> 'null'`,
    );
    return {
      digestParityFailures: parity.rows.map((r: Record<string, unknown>) => String(r["id"])),
      tenantsWithMultipleCurrent: multi.rows.map((r: Record<string, unknown>) => String(r["tenant_id"])),
      headCurrentMismatches: head.rows.map((r: Record<string, unknown>) => String(r["identity_id"])),
      contractActive: marker.rows.length === 1,
      requiredLatches: required.rows.length,
      unboundRequired,
      contractRuntimeRecords: Number((observed.rows[0] as Record<string, unknown>)["n"]),
      isolationViolations: isolation.rows.map((r: Record<string, unknown>) => ({ taskId: String(r["task_id"]), reason: String(r["reason"]) })),
    };
  } catch (error) {
    return unavailable(`identity cognition schema not readable: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
  }
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

/** KJ-P8 B1: is this session exactly kj_worker, and do both runtime roles hold exactly the frozen manifest? */
export async function fetchRuntimeRoles(pool: pg.Pool): Promise<HealthSnapshot["database"]["runtimeRoles"]> {
  try {
    const manifest = loadManifest();
    const problems: string[] = [];
    try {
      await assertRuntimeRole(pool, "kj_worker");
    } catch (error) {
      if (!(error instanceof RuntimeRoleRefusal)) throw error;
      problems.push(error.code);
    }
    for (const role of RUNTIME_ROLES) {
      const diff = await compareRoleToManifest(pool, manifest, role);
      for (const f of diff.missing) problems.push(`${role} lacks ${f}`);
      for (const f of diff.extra) problems.push(`${role} holds unlisted ${f}`);
    }
    const definer = await compareDefinerFunctions(pool, manifest);
    for (const f of definer.missing) problems.push(`${f} is not SECURITY DEFINER as the manifest requires`);
    for (const f of definer.extra) problems.push(`unlisted SECURITY DEFINER function ${f}`);
    return { available: true, problems };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message.slice(0, 200) : "runtime role catalogue unreadable" };
  }
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
  const identityOrphans = dbReachable ? await fetchIdentityOrphans(pool, deps.now?.() ?? new Date()) : [];
  const incompleteBootstraps = dbReachable ? await fetchIncompleteBootstraps(pool, deps.now?.() ?? new Date()) : [];
  const identityCognition = dbReachable ? await fetchIdentityCognition(pool) : unavailable("database unreachable");

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
      runtimeRoles: dbReachable ? await fetchRuntimeRoles(pool) : { available: false, reason: "database unreachable" },
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
    identity: {
      dbReachable,
      completedTasksMissingActivation: identityOrphans,
      profilesWithoutCurrentIdentity: incompleteBootstraps,
      cognition: identityCognition,
    },
  };
}
