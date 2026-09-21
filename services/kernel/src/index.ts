import { pathToFileURL } from "node:url";
import * as restate from "@restatedev/restate-sdk";
import pg from "pg";
import { Ledger } from "./ledger.js";
import { createTaskWorkflow } from "./workflow.js";
import { createKernelWorkflow } from "./executor/workflow.js";
import { createCapabilityService } from "./capability-service.js";
import { loadCanaryConfig } from "./scheduler/canary-config.js";
import { createScheduleDriverService } from "./scheduler/restate-service.js";
import { productionAlertMonitor } from "./alerting/runner-production.js";
import { productionTelegramOperator } from "./channel/telegram/production.js";
import { productionApprovalWorkflow } from "./approval-boundary.js";
import { PgNotificationOutboxStore } from "./alerting/pg-outbox-store.js";
import { loadMissionConfig } from "./mission/config.js";
import { enqueueMissionNotice } from "./mission/notify.js";
import { createConfiguredMemory, loadMemoryConfig } from "../../memory/src/canonical/config.js";
import { createMissionMemoryPort } from "../../memory/src/canonical/mission-port.js";

const connectionString = process.env["DATABASE_URL"];
if (!connectionString)
  throw new Error(
    "Inject DATABASE_URL at runtime from jVault project kerneljson",
  );
const pool = new pg.Pool({ connectionString });

// Canary executor is enabled only when a repository root is configured. Then the
// approved digest + recipe are loaded from the environment (fail-closed) and the
// sealed-local CapabilityServiceV1 is registered. Without KJ_REPO_ROOT the worker
// serves only the deterministic recipes, exactly as before.
const repositoryRoot = process.env["KJ_REPO_ROOT"];
const canaryConfig = repositoryRoot ? loadCanaryConfig(process.env) : undefined;
const canary = canaryConfig
  ? {
      recipe: canaryConfig.recipe,
      approvedContentSha256: canaryConfig.approvedContentSha256,
    }
  : undefined;
// KJ-P3: optional read-only token for private repositories; public ones need none.
const githubToken = process.env["GITHUB_READ_TOKEN"] || undefined;
const capabilityService = repositoryRoot
  ? createCapabilityService({
      repositoryRoot,
      ...(githubToken ? { github: { token: githubToken } } : {}),
    })
  : undefined;
// KJ-P3 mission runtimes (Claude analyst, Grok reviewer). All-or-nothing, like the seams
// above: unset serves no mission, a partial configuration refuses to start.
const missionRuntimes = loadMissionConfig(process.env);
if (missionRuntimes && !(canary && capabilityService))
  throw new Error(
    "Mission runtimes are configured but the canary/capability service (KJ_REPO_ROOT) is not " +
      "- refusing to start half-configured",
  );
// KJ-P5 canonical memory. Off unless KJ_MEMORY_ENABLED=true; a partial configuration refuses to start. Missions only
// ever get the read-only port: they can be given a bounded memory context, and nothing else.
const memoryConfig = loadMemoryConfig(process.env);
const missionMemory = memoryConfig ? createMissionMemoryPort(createConfiguredMemory(pool, memoryConfig).memory) : undefined;
const mission = missionRuntimes
  ? {
      analyst: missionRuntimes.analyst,
      reviewer: missionRuntimes.reviewer,
      ...(missionMemory ? { memory: missionMemory } : {}),
      notify: async (notice: Parameters<typeof enqueueMissionNotice>[1]) => {
        await enqueueMissionNotice(new PgNotificationOutboxStore(pool), notice);
      },
    }
  : undefined;

const ledger = new Ledger(pool, undefined, undefined, undefined, canary);

// ScheduleDriver (the durable Restate-driven wake path) is enabled only when the
// admission seam is fully configured — same fail-closed, all-or-nothing gating as
// the canary/capability service above. This is the exact substitution class that
// hid the pre-Gate-3 gap (see tests/kernel-worker-registration.test.ts): a
// production worker missing a service silently, with no error, is worse than one
// that refuses to start. KJ_ADMISSION_BEARER is read from the environment only —
// never an argument, never printed — and given the required RFC 6750 "Bearer "
// prefix here (apps/gateway/src/server.ts: /^Bearer [^\s]{1,4096}$/), since this is
// a separate construction site from canary-runner.ts's buildAdmissionGatewayFromEnv.
const admissionUrl = process.env["KJ_ADMISSION_URL"];
const admissionBearer = process.env["KJ_ADMISSION_BEARER"];

/**
 * Recurring self-rearm (armNext) is OFF by default — a production worker that
 * silently starts self-arming is the same substitution-class risk called out above
 * for ScheduleDriver itself, so this parses eagerly (fail-fast at startup, same as
 * DATABASE_URL) and rejects anything that isn't exactly "true"/"false" rather than
 * guessing. armNext=true is only meaningful once qualified (see S1B —
 * docs/production/phase-s1b-rearm/): the boundary fixes in durable-timer.ts and
 * restate-service.ts. Unset stays the existing one-shot behaviour unconditionally.
 *
 * Empty string is treated identically to unset (both -> false), same as
 * Boolean(admissionUrl) above: execution.compose.yaml declares this var as
 * `${SCHED_ARM_NEXT:-}`, so a genuinely-unset production deploy reaches the
 * container as `""`, not `undefined` — caught live during S1D2 (2026-09-14) when
 * wiring the compose passthrough for this same var (see that fix's own commit).
 */
export function parseArmNext(env: NodeJS.ProcessEnv): boolean {
  const raw = env["SCHED_ARM_NEXT"];
  if (raw === undefined || raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(
    `SCHED_ARM_NEXT must be exactly "true" or "false" when set (got ${JSON.stringify(raw)}) ` +
      "— refusing to start with an ambiguous recurring-mode flag",
  );
}
const armNext = parseArmNext(process.env);
// The canary alone (no admission seam) is the current, valid, pre-existing state —
// it must remain a silent no-op, not an error. Only an INCONSISTENT admission seam,
// or an admission seam configured without the canary it depends on, fails closed.
if (Boolean(admissionUrl) !== Boolean(admissionBearer))
  throw new Error(
    "KJ_ADMISSION_URL and KJ_ADMISSION_BEARER must both be set or both left unset " +
      "— refusing to start half-configured",
  );
if (admissionUrl && admissionBearer && !canary)
  throw new Error(
    "KJ_ADMISSION_URL/KJ_ADMISSION_BEARER are set but the canary config " +
      "(KJ_REPO_ROOT + SCHED_RECIPE + SCHED_APPROVED_SHA256) is not — ScheduleDriver " +
      "requires both, refusing to start half-configured",
  );
const scheduleDriver =
  admissionUrl && admissionBearer && canary
    ? createScheduleDriverService({
        pool,
        admissionUrl,
        authorization: `Bearer ${admissionBearer}`,
        recipe: canary.recipe,
        owner: "restate-schedule-driver",
        productionRuntime: true,
        armNext,
      })
    : undefined;

const alertMonitor = productionAlertMonitor(process.env);
// KJ-P4A: the Telegram operator channel. Off unless TELEGRAM_INBOUND_ENABLED=true; a partial or
// ambiguous configuration refuses to start, exactly like the seams above.
const telegramOperator = productionTelegramOperator(process.env);
// KJ-P4B: the golden workflow behind the production approval boundary. Off unless
// KJ_APPROVAL_ENABLED=true; a partial or ambiguous configuration refuses to start, like the seams above.
const approvalWorkflow = productionApprovalWorkflow(ledger, process.env);
export const services = [
  createTaskWorkflow(ledger),
  createKernelWorkflow(
    ledger,
    canary && capabilityService
      ? { canary, capabilityService, ...(mission ? { mission } : {}) }
      : undefined,
  ),
  ...(capabilityService ? [capabilityService] : []),
  ...(scheduleDriver ? [scheduleDriver] : []),
  ...(alertMonitor ? [alertMonitor] : []),
  ...(telegramOperator ? [telegramOperator] : []),
  ...(approvalWorkflow ? [approvalWorkflow] : []),
];

// Serve only when invoked directly (not when imported by the registration test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  restate.serve({ services, port: Number(process.env["PORT"] ?? 9080) });
