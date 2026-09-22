import type { SystemStatus, TaskView } from "./views.js";
import type { ForgetOutcome, MemoryDetail, MemoryLine, RememberOutcome, ShowOutcome } from "./memory-port.js";

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
  | { kind: "TASK_UNAVAILABLE" }
  | { kind: "REMEMBERED"; outcome: RememberOutcome }
  | { kind: "MEMORY_LIST"; items: MemoryLine[] }
  | { kind: "MEMORY_VIEW"; outcome: ShowOutcome }
  | { kind: "FORGOTTEN"; outcome: ForgetOutcome }
  | { kind: "MEMORY_OFF" }
  | { kind: "MEMORY_UNAVAILABLE" };

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
  "/remember <text>",
  "/memories",
  "/memory <id>",
  "/forget <id>",
];

const RULE = /^[a-z][a-z0-9-]{1,60}$/;
const HEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLASS = /^[A-Z_]{4,20}$/;
const short = (id: string): string => (HEX_ID.test(id) ? id.slice(0, 8) : "?");
/** Memory text the operator wrote themselves, made safe for a chat line: single line, no controls, bounded. */
const own = (text: string | null): string => (text === null ? "(not shown: not written by you)" : stripControls(text).replace(/[\r\n]+/g, " ").slice(0, 200));

function memoryLine(m: MemoryLine): string {
  return `${short(m.memoryId)} ${q(m.class, CLASS)} v${n(m.version)} ${own(m.text)}`;
}

function memoryDetail(d: MemoryDetail): string[] {
  const lines = [`Memory ${short(d.memoryId)} ${q(d.class, CLASS)}, ${q(d.status, /^[A-Z]{6,10}$/)}`];
  if (d.supersededBy) lines.push(`Superseded by ${short(d.supersededBy)}`);
  if (d.conflictsWith.length > 0) lines.push(`Flagged as conflicting with ${d.conflictsWith.slice(0, 3).map(short).join(", ")}`);
  for (const v of d.versions.slice(-5)) {
    lines.push(`v${n(v.version)} ${v.kind === "RETRACT" ? "retracted" : "asserted"} ${q(v.promotedAt.slice(0, 10), /^[0-9-]{10}$/)} ${q(v.origin, /^[A-Z_]{4,24}$/)}: ${own(v.text)}`);
    for (const e of v.evidence.slice(0, 2)) lines.push(`  from ${q(e, SAFE)}`);
  }
  return lines;
}

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
    case "REMEMBERED": {
      const o = input.outcome;
      const id = o.memoryId ? `${short(o.memoryId)} v${n(o.version ?? -1)}` : "";
      switch (o.state) {
        case "PROMOTED":
          return mint([`${o.replayed ? "Already remembered" : "Remembered"} as ${q(o.class, CLASS)}: memory ${id}.`, "See /memory <id> for its provenance."]);
        case "AWAITING_APPROVAL":
          return mint([`That needs an approval before it becomes memory (${q(o.class, CLASS)}). Nothing is remembered yet.`]);
        case "HELD":
          return mint([`Kept as a candidate only, not memory (${q(o.ruleId, RULE)}).`]);
        case "REFUSED":
          return mint([`Not remembered (${q(o.ruleId, RULE)}).`]);
        case "REJECTED":
          return mint([`Not remembered: the approval was not granted (${q(o.ruleId, RULE)}).`]);
      }
      return mint(["Not remembered."]);
    }
    case "MEMORY_LIST":
      return input.items.length === 0
        ? mint(["No current memories."])
        : mint([`Current memories (${n(input.items.length)}):`, ...input.items.slice(0, 10).map(memoryLine), "Use /memory <id> for one memory's history."]);
    case "MEMORY_VIEW":
      if (input.outcome.result === "AMBIGUOUS") return mint(["That id matches more than one memory. Send more of it."]);
      if (input.outcome.result === "NOT_FOUND") return mint(["No memory with that id that I can show you."]);
      return mint(memoryDetail(input.outcome.detail));
    case "FORGOTTEN": {
      const o = input.outcome;
      switch (o.result) {
        case "RETRACTED":
          return mint([`Forgotten: memory ${short(o.memoryId)} is retracted at v${n(o.version)}.`, "It no longer appears in memory or context. Its history is kept."]);
        case "ALREADY_RETRACTED":
          return mint([`Memory ${short(o.memoryId)} was already retracted.`]);
        case "NOT_FOUND":
          return mint(["No memory with that id that I can change."]);
        case "AMBIGUOUS":
          return mint(["That id matches more than one memory. Send more of it."]);
        case "REFUSED":
          return mint([`Not forgotten (${q(o.ruleId, RULE)}).`]);
        case "HELD":
          return mint([`The retraction is held, not applied (${q(o.ruleId, RULE)}).`]);
      }
      return mint(["Not forgotten."]);
    }
    case "MEMORY_OFF":
      return mint(["Memory is not switched on for this deployment."]);
    case "MEMORY_UNAVAILABLE":
      return mint(["I could not reach memory just now. Nothing was changed. Try again in a moment."]);
  }
}
