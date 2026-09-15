import type { AlertStateRow } from "./types.js";

/** Persistence boundary for alert episodes. `getAll()` is enough for this phase's
 *  scale (a few dozen checks) — no pagination needed for one production instance. */
export interface AlertStateStore {
  getAll(): Promise<AlertStateRow[]>;
  /** Replace/insert every row in `rows` (keyed by fingerprint). Rows not present
   *  in `rows` are left untouched — callers always pass the full next-state set
   *  for every check they evaluated this run. */
  putAll(rows: readonly AlertStateRow[]): Promise<void>;
}

/** In-memory implementation — used by every deterministic test, and by the CLI
 *  when no persistent store is configured (so the engine always works without an
 *  external database, per the P1.2 requirement that alerting must not depend on
 *  wiring a notification/state backend to produce a correct decision). */
export class InMemoryAlertStateStore implements AlertStateStore {
  private readonly rows = new Map<string, AlertStateRow>();

  async getAll(): Promise<AlertStateRow[]> {
    return [...this.rows.values()];
  }

  async putAll(rows: readonly AlertStateRow[]): Promise<void> {
    for (const row of rows) this.rows.set(row.fingerprint, row);
  }
}
