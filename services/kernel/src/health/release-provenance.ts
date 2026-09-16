import type pg from "pg";
import type { BindingProvenance } from "./snapshot.js";

/** One statement/snapshot for activation and ALL bindings, including undispatched
 * admissions and older epochs. No rolling window or sample can hide a violation. */
export async function collectBindingProvenance(pool: Pick<pg.Pool, "query">): Promise<BindingProvenance | null> {
  try {
    const result = await pool.query(`
      select e.epoch::text as active_epoch, a.release_id as active_release_id,
        count(b.task_id) filter(where b.release_epoch=e.epoch and e.epoch>0)::int as current_count,
        count(b.task_id) filter(where b.release_epoch>0 and ba.release_id is not null
          and b.contract->>'releaseId' is distinct from ba.release_id)::int as mismatch_count,
        count(b.task_id) filter(where b.release_epoch>0
          and (ba.epoch is null or b.persisted_at is null or b.release_epoch>e.epoch))::int as missing_count,
        count(b.task_id) filter(where b.release_epoch=0)::int as legacy_count
      from kernel_private.release_epoch e
      left join kernel_private.release_activations a on a.epoch=e.epoch
      left join kernel_private.execution_bindings b on true
      left join kernel_private.release_activations ba on ba.epoch=b.release_epoch
      where e.singleton group by e.epoch,a.release_id`);
    const r = result.rows[0];
    return r ? { activeEpoch: r.active_epoch, activeReleaseId: r.active_release_id,
      currentBindingCount: r.current_count, mismatchedBindingCount: r.mismatch_count,
      missingProvenanceCount: r.missing_count, legacyBindingCount: r.legacy_count } : null;
  } catch {
    // Includes migration not yet installed, access denied, and unavailable DB.
    // Missing evidence must never become a healthy empty set.
    return null;
  }
}

export function bindingProvenanceVerdict(p: BindingProvenance | null, expectedRelease?: string) {
  if (!p || !p.activeReleaseId || p.activeEpoch === "0") {
    return { status: "UNKNOWN" as const, message: "NO_PROVENANCE: canonical release activation unavailable; transition qualification blocked" };
  }
  if (p.mismatchedBindingCount > 0 || (expectedRelease !== undefined && p.activeReleaseId !== expectedRelease)) {
    return { status: "CRITICAL" as const, message: "release epoch mismatch: binding differs from its activation or active release differs from expectation" };
  }
  if (p.missingProvenanceCount > 0) {
    return { status: "UNKNOWN" as const, message: "NO_PROVENANCE: binding provenance incomplete; transition qualification blocked" };
  }
  if (p.currentBindingCount === 0) {
    return { status: "UNKNOWN" as const, message: "NO_OBSERVATION: no bindings in the active release epoch" };
  }
  return { status: "HEALTHY" as const, message: "bindings match their canonical release epochs; pre-cutover history is preserved" };
}
