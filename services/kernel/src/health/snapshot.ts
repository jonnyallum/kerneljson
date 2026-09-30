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
  /** KJ-P7A: how long an identity profile may exist with no activated identity before it is reported
   *  as an interrupted bootstrap rather than one still in flight. Default 10min. */
  identityBootstrapGraceMs?: number;
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
  /** ADMITTED fires with NO kernel_private.task_admissions row at all — the scheduler
   *  minted without KernelJSON ever recording an admission. Genuine authority corruption. */
  admittedFireTaskIdsMissingAdmission: string[];
  /** ADMITTED fires WITH a real task_admissions row (KernelJSON's admission succeeded,
   *  per scheduler/persistence.ts's documented ADMITTED semantics) whose public.tasks
   *  row never materialised — a downstream execution/materialisation failure, not an
   *  authority breach. Distinct from admittedFireTaskIdsMissingAdmission on purpose. */
  admittedFireTaskIdsUnmaterialised: string[];
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

/** KJ-P7A - ADR-0021 D8's orphan detector. A completed identity-change task with no matching
 *  identity_activations row means the task claims success but the identity change it promised never
 *  took effect. Completion, version and activation now commit in ONE transaction
 *  (identity/complete.ts), so there is no legitimate in-flight window: any such row is corruption. */
export interface IdentityOrphanRow {
  taskId: string;
  ageMs: number;
}

/** KJ-P7A - an identity profile with no activated identity: a bootstrap that committed its profile
 *  and was then refused or interrupted. Recoverable (the owner's next bootstrap request resumes the
 *  same profile), so it is surfaced, not treated as corruption. */
export interface IncompleteBootstrapRow {
  identityId: string;
  tenantId: string;
  ageMs: number;
}

/** KJ-P7B-1 (ADR-0022 section 11) - the store invariants added by P7B and the two cognition-binding invariants.
 *  Unavailable only when the P7B schema itself cannot be read (for example before its migration is applied). */
export interface IdentityCognitionSnapshot {
  /** identity_versions ids whose stored digests differ from kernel_private.identity_core_digest_v1. */
  digestParityFailures: string[];
  /** Tenants with more than one current identity. */
  tenantsWithMultipleCurrent: string[];
  /** Identities whose head version is not their current activated version. */
  headCurrentMismatches: string[];
  /** The kernel_private.identity_cognition_contract_v1 marker exists. */
  contractActive: boolean;
  requiredLatches: number;
  unboundRequired: Array<{ taskId: string; stepId: string; reason: string }>;
  /** Mission runtime evidence records bound at or after the contract-start epoch. */
  contractRuntimeRecords: number;
  isolationViolations: Array<{ taskId: string; reason: string }>;
}

export interface IdentitySnapshot {
  dbReachable: boolean;
  completedTasksMissingActivation: IdentityOrphanRow[];
  profilesWithoutCurrentIdentity: IncompleteBootstrapRow[];
  cognition: IdentityCognitionSnapshot | Unavailable;
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
  identity: IdentitySnapshot;
}
