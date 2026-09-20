import type { SystemStatus, TaskView } from "./views.js";

/**
 * KJ-P4A - every word KernelJSON says back over Telegram, from fixed templates.
 *
 * A reply is a `ReplyText`, a branded string that ONLY this module can mint. The outbox path that
 * forwards reply text to the transport accepts nothing else, so there is no route by which text from
 * a Telegram message, a repository or a model reaches the chat. Inputs are closed-vocabulary
 * fields (validated repo slug, task id, counts, statuses); anything that fails its guard prints "?".
 */
export type ReplyText = string & { readonly __brand: "OperatorReplyText" };

export type ReplyInput =
  | { kind: "USAGE" }
  | { kind: "RATE_LIMITED"; perMinute: number }
  | { kind: "CAP_EXCEEDED"; used: number; cap: number }
  | { kind: "ADMITTED"; command: "BRIEF" | "REVIEW"; repo: string; findings: number | null; taskId: string; used: number; cap: number }
  | { kind: "ADMISSION_FAILED"; reason: "UNAVAILABLE" | "REJECTED" | "CONFLICT" }
  | { kind: "STATUS"; status: SystemStatus; missionsToday: number; cap: number; asOf: string }
  | { kind: "TASK"; view: TaskView }
  | { kind: "TASK_NOT_FOUND"; taskId: string }
  | { kind: "TASK_UNAVAILABLE" };

const MAX_CHARS = 3000;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE = /^[A-Za-z0-9._:/|() -]{1,80}$/;

const q = (v: string, re: RegExp): string => (re.test(v) ? v : "?");
const n = (v: number): string => (Number.isSafeInteger(v) && v >= 0 ? String(v) : "?");

/** Keeps newline and printable characters; drops every other control character, whatever the inputs were. */
function stripControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 10 || (code >= 32 && code !== 127)) out += ch;
  }
  return out;
}

function mint(lines: string[]): ReplyText {
  return stripControls(lines.join("\n")).slice(0, MAX_CHARS) as ReplyText;
}

export const USAGE_LINES = [
  "KernelJSON commands:",
  "/status",
  "/brief owner/repo [findings=N]",
  "/review owner/repo [findings=N]",
  "/task <task id>",
];

export function renderReply(input: ReplyInput): ReplyText {
  switch (input.kind) {
    case "USAGE":
      return mint(["That is not a command I act on.", ...USAGE_LINES]);
    case "RATE_LIMITED":
      return mint([`Too many commands: the limit is ${n(input.perMinute)} a minute. Try again shortly.`]);
    case "CAP_EXCEEDED":
      return mint([
        `Daily mission cap reached (${n(input.used)} of ${n(input.cap)} today, UTC).`,
        "Nothing was started. /status and /task still work.",
      ]);
    case "ADMITTED": {
      const what = input.command === "REVIEW" ? "review" : "brief";
      const count = input.findings === null ? (input.command === "REVIEW" ? "3 findings (default)" : "default contract") : `exactly ${n(input.findings)} findings`;
      return mint([
        `Started a ${what} of ${q(input.repo, REPO)}: ${count}.`,
        `Task ${q(input.taskId, UUID)}`,
        `Missions today: ${n(input.used)} of ${n(input.cap)}.`,
        "Check progress with /task <id>. A notice arrives when it finishes.",
      ]);
    }
    case "ADMISSION_FAILED":
      return mint([
        input.reason === "UNAVAILABLE"
          ? "The admission door did not answer. Nothing was started. Send the command again in a moment."
          : input.reason === "CONFLICT"
            ? "The door refused that request as a conflict. Nothing was started."
            : "The door refused that request. Nothing was started.",
      ]);
    case "STATUS": {
      const s = input.status;
      return mint([
        `KernelJSON status as of ${q(input.asOf, /^[0-9T:.Z-]{10,30}$/)}`,
        `Release ${s.releaseId ? q(s.releaseId.slice(0, 7), /^[0-9a-f]{7}$/) : "?"}, epoch ${s.epoch ? q(s.epoch, /^\d{1,6}$/) : "?"}`,
        `Tasks: ${n(s.tasksTotal)} total, ${n(s.tasksInFlight)} in flight, ${n(s.tasksAwaiting)} awaiting approval or an event`,
        `Missions: ${n(s.missionTasks)} total, ${n(input.missionsToday)} of ${n(input.cap)} started today`,
        s.latestFire ? `Latest fire: ${q(s.latestFire.windowKey, SAFE)} ${q(s.latestFire.state, /^[A-Z_]{2,24}$/)}` : "Latest fire: none",
        `Open alerts: P0 ${n(s.alertsOpen.P0)}, P1 ${n(s.alertsOpen.P1)}, P2 ${n(s.alertsOpen.P2)}, P3 ${n(s.alertsOpen.P3)}`,
        `Outbox: ${n(s.outboxPending)} pending, ${n(s.outboxPoison)} poison`,
      ]);
    }
    case "TASK": {
      const v = input.view;
      const lines = [`Task ${q(v.taskId, UUID)}`, `Status: ${v.status}`, `Evidence: ${v.evidence.length} rows`];
      for (const e of v.evidence.slice(0, 8)) lines.push(`- ${e.type} ${q(e.source, SAFE)} ${q(e.digest, /^[a-f0-9?]{1,12}$/)}`);
      if (v.mission) {
        const m = v.mission;
        lines.push(`Mission: ${m.decision}, ${n(m.findingCount)} findings (${q(m.contract, SAFE)})`);
        if (m.failedChecks.length > 0) lines.push(`Failed checks: ${m.failedChecks.map((c) => q(c, /^[a-z_]{3,60}$/)).join(", ")}`);
        lines.push(`Analyst ${q(m.analyst, SAFE)}`);
        lines.push(`Reviewer ${q(m.reviewer, SAFE)}`);
        lines.push(`Cross-provider ${m.crossProvider ? "yes" : "no"}, cross-family ${m.crossFamily ? "yes" : "no"}`);
      }
      if (v.failure) lines.push(`Failure: ${q(v.failure, /^[A-Z_]{3,40}$/)}`);
      return mint(lines);
    }
    case "TASK_NOT_FOUND":
      return mint([`No task ${q(input.taskId, UUID)} that I can see.`]);
    case "TASK_UNAVAILABLE":
      return mint(["I could not read that task just now. Try again in a moment."]);
  }
}
