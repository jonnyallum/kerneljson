/**
 * KJ-P1.1 — Production Health Model, shared types.
 *
 * Architecture: COLLECT (impure, hits Postgres/Restate/HTTP, never throws — every
 * source that cannot be reached or isn't configured degrades to `unavailable`) then
 * EVALUATE (pure, deterministic, takes a snapshot + explicit expectations, returns
 * CheckResult[]). This split is what makes the domain logic exhaustively unit
 * testable without Docker/Postgres/Restate: `evaluate*` functions take plain data,
 * never a pool or a socket.
 */

/** HEALTHY < UNKNOWN < DEGRADED < CRITICAL is the total order aggregation uses —
 *  "found nothing" (UNKNOWN) is deliberately worse than a confirmed HEALTHY, but
 *  better than a confirmed problem. See `aggregate.ts`. */
export const HEALTH_STATUSES = ["HEALTHY", "DEGRADED", "CRITICAL", "UNKNOWN"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const SEVERITY: Record<HealthStatus, number> = {
  HEALTHY: 0,
  UNKNOWN: 1,
  DEGRADED: 2,
  CRITICAL: 3,
};

export function worseOf(a: HealthStatus, b: HealthStatus): HealthStatus {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

export interface CheckResult {
  /** Stable, dotted check id, e.g. "scheduler.noDuplicateFireWindow". Never renamed
   *  once shipped — dashboards/alerts will key off this in later phases. */
  id: string;
  status: HealthStatus;
  /** What was actually observed (a value, a count, a list) — omitted only when
   *  nothing could be observed (paired with an `unavailable`-shaped UNKNOWN). */
  observed?: unknown;
  /** The condition/value that would make this HEALTHY, when useful to state. */
  expected?: unknown;
  /** Where this observation came from — a table/query/endpoint, not a person. */
  evidence: string;
  /** One-line human explanation of the verdict. */
  message: string;
  checkedAt: string;
}

export interface DomainResult {
  status: HealthStatus;
  checks: CheckResult[];
}

export const HEALTH_DOMAINS = [
  "authority",
  "admission",
  "scheduler",
  "execution",
  "restate",
  "database",
  "evidence",
  "releaseParity",
  "productionConfig",
  "legacyAuthority",
] as const;
export type DomainName = (typeof HEALTH_DOMAINS)[number];

export interface HealthReport {
  overall: HealthStatus;
  checkedAt: string;
  /** This process's own self-reported release, when known (KERNELJSON_RELEASE_ID of
   *  whichever component the CLI was invoked inside/against) — informational only;
   *  the release-parity verdict lives in `domains.releaseParity`. */
  release: string | null;
  domains: Record<DomainName, DomainResult>;
  criticalIssues: number;
  degradedIssues: number;
  unknownChecks: number;
  /** Headline facts for the human summary — last fire / next wake, when known. */
  lastFireAtUtc: string | null;
  nextWakeAtUtc: string | null;
}

/** A source that could not be reached/isn't configured. Every collector field that
 *  depends on an optional external source is `T | Unavailable`, never a guess. */
export interface Unavailable {
  unavailable: true;
  reason: string;
}

export function isUnavailable(v: unknown): v is Unavailable {
  return typeof v === "object" && v !== null && (v as { unavailable?: unknown }).unavailable === true;
}
