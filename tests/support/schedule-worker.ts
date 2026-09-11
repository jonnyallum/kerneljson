import * as restate from "@restatedev/restate-sdk";
import pg from "pg";
import { existsSync, unlinkSync } from "node:fs";
import {
  createScheduleDriverService,
  type ScheduleDriverConfig,
} from "../../services/kernel/src/scheduler/restate-service.js";
import { HttpAdmissionGateway } from "../../services/kernel/src/scheduler/http-admission.js";
import type {
  AdmissionGateway,
  AdmissionRequestInput,
  AdmissionResult,
} from "../../services/kernel/src/scheduler/durable-timer.js";

/**
 * Phase S1-R live qualification — HOST worker serving ONLY the ScheduleDriver object.
 *
 * Runs on the host (not in the compose stack) so the test can kill/respawn it at will
 * to prove durable-timer survival across worker restart, and point it at a per-test
 * throwaway database. The containerised Restate reaches it via host.docker.internal.
 *
 * Topology: Restate (container) → host.docker.internal:PORT → this worker →
 * ScheduleTimerDriver → real admission door (ADMISSION_URL) → throwaway Postgres.
 */

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) throw new Error("schedule-worker: DATABASE_URL required");
const admissionUrl = process.env["ADMISSION_URL"];
if (!admissionUrl) throw new Error("schedule-worker: ADMISSION_URL required");

const authorization = process.env["SCHED_AUTH"] ?? "Bearer owner";
const recipe = process.env["SCHED_RECIPE"] ?? "uppercase/v1";
const owner = process.env["SCHED_OWNER"] ?? "restate-driver";
const port = Number(process.env["PORT"] ?? 9091);
const crashAfterAdmitFlag = process.env["SCHED_CRASH_AFTER_ADMIT"];
const stallAfterAdmitFlag = process.env["SCHED_STALL_AFTER_ADMIT"];
const stallMs = Number(process.env["SCHED_STALL_MS"] ?? 3000);

const pool = new pg.Pool({ connectionString });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Test-only fault injection, applied AFTER admission commits (task_admissions has the
 * canonical id) and BEFORE the fenced bind. Both modes are armed by a flag FILE so the
 * fault is opt-in per invocation; the flag is one-shot (consumed) so the recovery run
 * succeeds. Either mode is a no-op when its flag is absent.
 *
 *  - crash: the process dies. The admit `ctx.run` never journals, so on Restate
 *    re-delivery it re-runs; the same Idempotency-Key makes the door return the SAME
 *    canonical id, and the resumed handler binds it once — no second task (Section 16).
 *  - stall: the admit sleeps, opening a window for an external lease takeover (epoch
 *    N+1). When admit returns, the bind runs with the now-stale fence (epoch N) and
 *    Postgres rejects it — proving Restate cannot bypass S1-F2 fencing (Section 17).
 */
class FaultAfterAdmit implements AdmissionGateway {
  constructor(
    private readonly inner: AdmissionGateway,
    private readonly opts: { crashFlag?: string | undefined; stallFlag?: string | undefined; stallMs: number },
  ) {}
  async admit(req: AdmissionRequestInput): Promise<AdmissionResult> {
    const res = await this.inner.admit(req); // POST commits task_admissions
    const { crashFlag, stallFlag, stallMs: ms } = this.opts;
    if (crashFlag && existsSync(crashFlag)) {
      try {
        unlinkSync(crashFlag); // one-shot: the replay must succeed
      } catch {
        /* best effort */
      }
      process.exit(137); // die before the admit ctx.run journals
    }
    if (stallFlag && existsSync(stallFlag)) {
      try {
        unlinkSync(stallFlag);
      } catch {
        /* best effort */
      }
      await delay(ms); // hold before the bind so a takeover can bump the epoch
    }
    return res;
  }
}

const baseAdmission = new HttpAdmissionGateway(admissionUrl, {
  authorization,
  recipe,
});
const admissionGateway: AdmissionGateway =
  crashAfterAdmitFlag || stallAfterAdmitFlag
    ? new FaultAfterAdmit(baseAdmission, {
        crashFlag: crashAfterAdmitFlag,
        stallFlag: stallAfterAdmitFlag,
        stallMs,
      })
    : baseAdmission;

const cfg: ScheduleDriverConfig = {
  pool,
  admissionUrl,
  authorization,
  recipe,
  owner,
  admissionGateway,
};

restate.serve({
  services: [createScheduleDriverService(cfg)],
  port,
});
