import type pg from "pg";
import type { SystemStatus } from "./views.js";

/**
 * KJ-P4A - `/status`: a deterministic, read-only summary of the running system. Aggregates and
 * closed-vocabulary fields only. It runs inside a READ ONLY transaction, so even a bug in this file
 * cannot write anything, and it answers from the ledger and the alert and outbox tables directly:
 * no model is consulted and no text a model wrote is read.
 */
export interface StatusReader {
  read(): Promise<SystemStatus>;
}

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];
const AWAITING = ["WAITING", "APPROVAL_REQUIRED"];

export class PgStatusReader implements StatusReader {
  constructor(private readonly pool: pg.Pool) {}

  async read(): Promise<SystemStatus> {
    const db = await this.pool.connect();
    try {
      await db.query("begin transaction read only");
      const epoch = await db.query<{ epoch: string }>("select epoch::text from kernel_private.release_epoch");
      const release = await db.query<{ release_id: string }>(
        "select release_id from kernel_private.release_activations order by epoch desc limit 1",
      );
      const tasks = await db.query<{ total: number; in_flight: number; awaiting: number; missions: number }>(
        `select count(*)::int total,
                count(*) filter (where status::text <> all($1::text[]))::int in_flight,
                count(*) filter (where status::text = any($2::text[]))::int awaiting,
                count(*) filter (where contract->'acceptanceCriteria'->>0 like 'An independent reviewer%')::int missions
           from public.tasks`,
        [TERMINAL, AWAITING],
      );
      const fire = await db.query<{ fire_window_key: string; state: string }>(
        "select fire_window_key, state from public.schedule_fires order by created_at desc limit 1",
      );
      const alerts = await db.query<{ severity: "P0" | "P1" | "P2" | "P3"; n: number }>(
        "select severity, count(*)::int n from kernel_private.alert_state where current_state = 'OPEN' group by 1",
      );
      const outbox = await db.query<{ status: string; n: number }>(
        "select status, count(*)::int n from kernel_private.notification_outbox group by 1",
      );
      await db.query("commit");
      const t = tasks.rows[0]!;
      const alertsOpen = { P0: 0, P1: 0, P2: 0, P3: 0 };
      for (const a of alerts.rows) alertsOpen[a.severity] = a.n;
      const by = (s: string): number => outbox.rows.find((r) => r.status === s)?.n ?? 0;
      return {
        epoch: epoch.rows[0]?.epoch ?? null,
        releaseId: release.rows[0]?.release_id ?? null,
        tasksTotal: t.total,
        tasksInFlight: t.in_flight,
        tasksAwaiting: t.awaiting,
        missionTasks: t.missions,
        latestFire: fire.rows[0] ? { windowKey: fire.rows[0].fire_window_key, state: fire.rows[0].state } : null,
        alertsOpen,
        outboxPending: by("PENDING") + by("SENDING"),
        outboxPoison: by("POISON"),
      };
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
}
