import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Context } from "@restatedev/restate-sdk";
import {
  BRIEF_RECIPE,
  KernelState,
  KernelSubmission,
  Task,
  type Evidence,
  type Outcome,
  type TaskStep,
} from "../../../../packages/contracts/src/index.js";
import { createGithubActivityReader } from "../../../../packages/runtimes/src/github-activity.js";
import { compileIntent } from "../compiler/index.js";
import { planTask } from "../planner/index.js";
import { verifyPlanCompletion } from "../executor/index.js";
import { runDeliveryWorker } from "../alerting/delivery-worker.js";
import { InMemoryNotificationOutboxStore } from "../alerting/outbox-store.js";
import { selectNotifier } from "../alerting/select-notifier.js";
import { loadTransportConfig } from "../alerting/transport-config.js";
import { loadMissionConfig } from "./config.js";
import { enqueueBriefNotice, type BriefNotice } from "./notify.js";
import { runMorningBriefMission } from "./run-brief.js";
import type { Emit } from "./run.js";

/**
 * `pnpm brief:dry-run` - one morning brief, run locally, with nothing written anywhere.
 *
 * It drives the REAL mission (runMorningBriefMission) with the real GitHub activity reader and the
 * real model ports from the same MISSION_* configuration the worker uses, and commits through the
 * REAL completion verifier (verifyPlanCompletion) - but against an in-memory ledger, with no Restate,
 * no database and no outbox. The kernel's own state is empty here, because reading it needs the
 * production database. With `--send-to-telegram` the brief goes through the production delivery
 * path (outbox row -> delivery worker -> Telegram notifier) using an in-memory outbox.
 *
 * Secrets come from the environment only (load them with `--env-file`). Output is the brief, the
 * reconciliation and the outcome; never a credential.
 */
const SEND = "--send-to-telegram";

/**
 * What a dry run may send: a COMPLETED brief, labelled, or nothing. A failed dry run is never sent,
 * because its notice would be indistinguishable from a production failure alert.
 */
export function dryRunNotice(notices: readonly BriefNotice[]): BriefNotice | null {
  const [notice] = notices;
  if (notices.length !== 1 || !notice || notice.status !== "COMPLETED" || !notice.text) return null;
  return { ...notice, text: `DRY RUN from a local machine: KernelJSON's own state was not read.\n\n${notice.text}` };
}

async function main(argv: readonly string[]): Promise<number> {
  const runtimes = loadMissionConfig(process.env);
  if (!runtimes) throw new Error("MISSION_* configuration is required");
  const token = process.env["GITHUB_READ_TOKEN"];
  if (!token) throw new Error("GITHUB_READ_TOKEN is required");
  const send = argv.includes(SEND);
  const outAt = argv.indexOf("--out");
  const out = outAt >= 0 ? argv[outAt + 1] : undefined;

  const principal = { id: randomUUID(), kind: "HUMAN" as const };
  const submission = KernelSubmission.parse({
    recipe: BRIEF_RECIPE,
    intent: {
      id: randomUUID(), principal, tenant: { id: randomUUID() }, source: "brief-dry-run", objective: "morning brief dry run",
      attachments: [], contextRefs: [], receivedAt: new Date(Date.now() - 1000).toISOString(),
      trace: { traceId: randomUUID(), correlationId: randomUUID() },
    },
  });
  const { task } = compileIntent(submission);
  const plan = planTask(task, BRIEF_RECIPE);
  const steps = new Map<string, TaskStep>();
  const evidence: Evidence[] = [];
  const notices: BriefNotice[] = [];
  let verifyError: string | null = null;

  const emit: Emit = async (_key, _type, status, extra = {}) => {
    if (extra.step) steps.set(extra.step.id, extra.step);
    if (extra.evidence) evidence.push(extra.evidence);
    if (status === "COMPLETED" && extra.outcome) {
      try {
        verifyPlanCompletion(Task.parse({ ...task, status: "VERIFYING" }), extra.outcome, plan, [...steps.values()], evidence.map((record) => ({ record, step: null })));
        return extra.outcome;
      } catch (error) {
        verifyError = error instanceof Error ? error.message : "verification failed";
        return { ...extra.outcome, status: "FAILED" } as Outcome;
      }
    }
  };
  const ctx = { run: async (_n: string, action: () => unknown) => action() } as unknown as Pick<Context, "run">;
  const read = createGithubActivityReader({ token });

  const started = Date.now();
  const outcome = await runMorningBriefMission({
    ctx, task, plan, emit,
    now: async () => new Date().toISOString(),
    uuid: randomUUID,
    githubActivity: (req) => read(req),
    kernelState: async () => KernelState.parse({ tasks: [], lastCanary: null }),
    analyst: runtimes.analyst,
    reviewer: runtimes.reviewer,
    notify: async (n) => { notices.push(n); },
  });

  const rec = evidence.find((e) => e.source === "kerneljson:brief-reconcile/v1");
  const facts = evidence.find((e) => e.source === "kerneljson:github-activity/v1");
  const usage = evidence
    .filter((e) => e.source.startsWith("kerneljson:runtime/"))
    .map((e) => `${String(e.metadata["role"])}: ${String(e.metadata["response_model"] ?? e.metadata["model"])} ${JSON.stringify(e.metadata["usage"] ?? e.metadata["error"])}`);
  process.stdout.write(
    [
      `outcome: ${outcome.status} (${Math.round((Date.now() - started) / 1000)}s)`,
      `summary: ${outcome.summary}`,
      verifyError ? `ledger verifier: ${verifyError}` : outcome.status === "COMPLETED" ? "ledger verifier: accepted" : "ledger verifier: not reached (the kernel did not request COMPLETED)",
      `active repos: ${String(facts?.metadata["active_repos"] ?? "n/a")}`,
      ...usage,
      ...(rec ? [`withheld items: ${JSON.stringify(rec.metadata["withheldItems"])}`, `checks: ${(rec.metadata["checks"] as Array<{ name: string; passed: boolean }>).map((c) => `${c.passed ? "ok" : "FAIL"} ${c.name}`).join(", ")}`] : []),
      "",
      ...(notices[0]?.text ? ["--- message ---", notices[0].text, "---------------"] : []),
      "",
    ].join("\n"),
  );
  if (out) writeFileSync(out, JSON.stringify({ outcome, evidence, notices }, null, 2), { encoding: "utf8", mode: 0o600 });

  const toSend = dryRunNotice(notices);
  if (send && !toSend) process.stdout.write("telegram: nothing sent (a dry run only ever sends a completed brief)\n");
  if (send && toSend) {
    const transport = loadTransportConfig(process.env);
    if (transport.mode !== "telegram") throw new Error("ALERT_TRANSPORT must be telegram to send");
    const outbox = new InMemoryNotificationOutboxStore();
    await enqueueBriefNotice(outbox, toSend);
    const { notifier } = selectNotifier(transport);
    const summary = await runDeliveryWorker({ outbox, notifier, transport: "telegram" });
    process.stdout.write(`telegram: delivered=${summary.delivered} retried=${summary.retried} poisoned=${summary.poisoned}\n`);
    if (summary.delivered !== 1) return 3;
  }
  return outcome.status === "COMPLETED" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      // Only the class and a value-free message of our own; a driver error could carry a URL.
      process.stderr.write(`brief dry run failed: ${err instanceof Error ? `${err.constructor.name}: ${/^[\w .:/=-]{1,120}$/.test(err.message) ? err.message : "(message withheld)"}` : "UnknownError"}\n`);
      process.exitCode = 4;
    },
  );
}
