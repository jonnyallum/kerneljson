import type { Unavailable } from "./types.js";

/** What health evaluation is judged against. Every field is an explicit
 *  expectation, never inferred from "whatever the DB currently says" — that would
 *  make every check trivially pass. Unset optional fields degrade their dependent
 *  checks to UNKNOWN, never HEALTHY. */
export interface HealthExpectations {
  scheduleId: string;
  scheduleState: "enabled" | "disabled" | "paused";
  activeVersion?: string;
  recipe: string;
  approvedDigestSha256?: string;
  armNext: boolean;
  releaseId?: string;
  services: readonly string[];
  /** How stale a "most recent fire" may be before DEGRADED, in ms. Derived from the
   *  schedule's own cadence by the caller (CLI); a pure default (25h) is applied
   *  when the caller doesn't supply one. */
  fireStalenessGraceMs?: number;
  /** How long a fire may sit PLANNED (never admitted) before DEGRADED. */
  plannedFireGraceMs?: number;
  /** How long a "scheduled" (pending) Restate invocation may sit past its own
   *  `scheduled_start_at` before it's considered stuck rather than merely about to
   *  run. */
  stuckWakeGraceMs?: number;
}

export interface ScheduleStateRow {
  scheduleId: string;
  state: string;
  activeVersion: string;
  updatedAt: string;
}

export interface ScheduleFireRow {
  scheduleId: string;
  scheduleVersion: string;
  fireWindowKey: string;
  fireAtUtc: string;
  state: string;
  admittedChildTaskId: string | null;
  createdAt: string;
}

export interface BindingProvenance {
  activeEpoch: string;
  activeReleaseId: string | null;
  currentBindingCount: number;
  mismatchedBindingCount: number;
  missingProvenanceCount: number;
  legacyBindingCount: number;
}

export interface RestateInvocationRow {
  id: string;
  status: string;
  scheduledStartAt: string | null;
  invokedById: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface EvidenceRow {
  id: string;
  taskId: string;
  type: string;
  source: string;
  digest: string | null;
  capturedAt: string;
  metadata: Record<string, unknown>;
}

export interface SchedulerSnapshot {
  /** false when Postgres itself was unreachable this run — every field below then
   *  reflects "couldn't check", not a genuine empty/absent finding. See
   *  `database.reachable` for the authoritative signal; this is threaded through so
   *  evaluate*() never confuses "DB down" with "confirmed absent". */
  dbReachable: boolean;
  scheduleState: ScheduleStateRow | null;
  recipe: string | null;
  fires: ScheduleFireRow[];
  restateInvocations: RestateInvocationRow[] | Unavailable;
}

export interface AuthoritySnapshot {
  dbReachable: boolean;
  bindingProvenance: BindingProvenance | null;
  admittedFireTaskIdsMissingFromTasks: string[];
  boundReleaseRejectionSeen: boolean;
}

export interface AdmissionSnapshot {
  dbReachable: boolean;
  doorHealthy: boolean | Unavailable;
  humanOperatorPresent: boolean;
}

export interface ExecutionSnapshot {
  registeredServices: string[] | Unavailable;
  workerRestartCount: number | Unavailable;
  doorRestartCount: number | Unavailable;
}

export interface RestateSnapshot {
  reachable: boolean | Unavailable;
  registeredServices: string[] | Unavailable;
  scheduleInvocations: RestateInvocationRow[] | Unavailable;
}

export interface DatabaseSnapshot {
  reachable: boolean;
  scheduleReadOk: boolean;
  taskReadOk: boolean;
}

export interface EvidenceSnapshot {
  dbReachable: boolean;
  mostRecentScheduledTaskId: string | null;
  evidenceForTask: EvidenceRow[];
}

export interface ReleaseParitySnapshot {
  dbReachable: boolean;
  selfReportedReleaseId: string | null;
  bindingProvenance: BindingProvenance | null;
  boundReleaseRejectionSeen: boolean;
}

export interface ProductionConfigSnapshot {
  armNext: boolean | null;
  approvedDigestShapeValid: boolean | null;
  scheduleIdConfigured: string | null;
  recipeConfigured: string | null;
}

export interface LegacyAuthoritySnapshot {
  b1FreezeObservable: boolean | Unavailable;
}

export interface HealthSnapshot {
  checkedAt: string;
  scheduler: SchedulerSnapshot;
  authority: AuthoritySnapshot;
  admission: AdmissionSnapshot;
  execution: ExecutionSnapshot;
  restate: RestateSnapshot;
  database: DatabaseSnapshot;
  evidence: EvidenceSnapshot;
  releaseParity: ReleaseParitySnapshot;
  productionConfig: ProductionConfigSnapshot;
  legacyAuthority: LegacyAuthoritySnapshot;
}
