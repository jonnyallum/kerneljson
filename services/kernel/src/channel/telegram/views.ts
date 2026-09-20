import { z } from "zod";
import { MissionReconciliation } from "../../../../../packages/contracts/src/index.js";

/**
 * KJ-P4A - what a reply is allowed to say. Both views are built from closed vocabularies and
 * validated fields only: task and evidence ids, statuses, digests, counts, the kernel's own check
 * names. Text a model or a repository wrote (an outcome summary, a finding, a README) never passes
 * through here, so it can never reach Telegram and no prompt injection can ride a reply.
 */
export interface SystemStatus {
  epoch: string | null;
  releaseId: string | null;
  tasksTotal: number;
  tasksInFlight: number;
  tasksAwaiting: number;
  missionTasks: number;
  latestFire: { windowKey: string; state: string } | null;
  alertsOpen: { P0: number; P1: number; P2: number; P3: number };
  outboxPending: number;
  outboxPoison: number;
}

export interface MissionFacts {
  decision: "ACCEPTED" | "REJECTED";
  findingCount: number;
  contract: string;
  failedChecks: string[];
  analyst: string;
  reviewer: string;
  crossProvider: boolean;
  crossFamily: boolean;
}

export interface TaskView {
  taskId: string;
  status: string;
  evidence: Array<{ type: string; source: string; digest: string }>;
  mission: MissionFacts | null;
  /** A failure code from failure evidence, only if it is a bare upper-case code. */
  failure: string | null;
}

const Status = z.looseObject({
  taskId: z.string(),
  status: z.string(),
});
const EvidenceRow = z.looseObject({
  type: z.string(),
  source: z.string(),
  digest: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const TOKEN = /^[A-Za-z0-9._:/-]{1,80}$/;
const STATUS = /^[A-Z_]{3,24}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const guard = (v: string, re: RegExp): string => (re.test(v) ? v : "?");

/** Reads the door's own `GET /v1/tasks/:id` and `/evidence` bodies. Returns null if they do not parse. */
export function summariseTask(statusBody: unknown, evidenceBody: unknown): TaskView | null {
  const s = Status.safeParse(statusBody);
  const e = z.array(EvidenceRow).safeParse(evidenceBody);
  if (!s.success || !e.success) return null;
  const evidence = e.data.map((row) => ({
    type: guard(row.type, STATUS),
    source: guard(row.source.replace(/^kerneljson:/, ""), TOKEN),
    digest: row.digest && DIGEST.test(row.digest) ? row.digest.slice(0, 12) : "?",
  }));

  let mission: MissionFacts | null = null;
  const reconcile = e.data.find((row) => row.source === "kerneljson:mission-reconcile/v1");
  if (reconcile) {
    const rec = MissionReconciliation.safeParse(reconcile.metadata);
    if (rec.success) {
      const r = rec.data;
      mission = {
        decision: r.decision,
        findingCount: r.findingCount,
        contract:
          r.contract.requestedFindings !== null
            ? `exactly ${r.contract.requestedFindings}`
            : `${r.contract.minFindings} to ${r.contract.maxFindings}`,
        failedChecks: r.checks.filter((c) => !c.passed).map((c) => c.name),
        analyst: `${guard(r.independence.analystProvider, TOKEN)}/${guard(r.analystModel, TOKEN)}`,
        reviewer: `${guard(r.independence.reviewerProvider, TOKEN)}/${guard(r.reviewerModel, TOKEN)}`,
        crossProvider: r.independence.crossProvider,
        crossFamily: r.independence.crossFamily,
      };
    }
  }

  let failure: string | null = null;
  for (const row of e.data) {
    const code = row.metadata?.["error"];
    if (typeof code === "string" && /^[A-Z_]{3,40}$/.test(code)) failure = code;
  }
  return { taskId: guard(s.data.taskId, /^[0-9a-f-]{36}$/), status: guard(s.data.status, STATUS), evidence, mission, failure };
}
