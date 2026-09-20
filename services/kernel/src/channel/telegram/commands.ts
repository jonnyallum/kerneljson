import {
  Id,
  MISSION_HARD_MAX_FINDINGS,
  MISSION_RECIPE,
  RepoSlug,
  parseMissionObjective,
} from "../../../../../packages/contracts/src/index.js";

/**
 * KJ-P4A - the Telegram command grammar. Pure: text in, one of four commands or MALFORMED out.
 *
 * This is a COMMAND channel, not a conversation. Nothing here interprets free text, calls a
 * model, or decides anything: it maps a fixed, small vocabulary onto requests the existing
 * admission door already understands. Anything else is MALFORMED and gets a fixed usage reply
 * that never echoes the input.
 *
 *   /status
 *   /brief  owner/repo [findings=N]     repository brief (architecture summary), optional exact count
 *   /review owner/repo [findings=N]     N highest-value improvements (default 3), every finding cited
 *   /task <task id>
 */
export type Command =
  | { kind: "STATUS" }
  | { kind: "MISSION"; command: "BRIEF" | "REVIEW"; repo: string; findings: number | null }
  | { kind: "TASK"; taskId: string }
  | { kind: "MALFORMED" };

export const DEFAULT_REVIEW_FINDINGS = 3;
const MAX_COMMAND_CHARS = 200;

const MALFORMED: Command = { kind: "MALFORMED" };

function parseFindings(token: string): number | null {
  const m = /^findings=(\d{1,2})$/.exec(token);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= MISSION_HARD_MAX_FINDINGS ? n : null;
}

export function parseCommand(text: string): Command {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_COMMAND_CHARS || !trimmed.startsWith("/")) return MALFORMED;
  const [head, ...args] = trimmed.split(/\s+/) as [string, ...string[]];
  // `/status@KernelJsonBot` is how Telegram addresses a bot in a group; accept and strip it.
  const name = head.slice(1).split("@")[0]!.toLowerCase();

  if (name === "status") return args.length === 0 ? { kind: "STATUS" } : MALFORMED;

  if (name === "task") {
    if (args.length !== 1) return MALFORMED;
    const id = Id.safeParse(args[0]);
    return id.success ? { kind: "TASK", taskId: id.data.toLowerCase() } : MALFORMED;
  }

  if (name === "brief" || name === "review") {
    if (args.length < 1 || args.length > 2) return MALFORMED;
    let repo: string | null = null;
    let findings: number | null = null;
    for (const token of args) {
      if (token.startsWith("findings=")) {
        if (findings !== null) return MALFORMED;
        findings = parseFindings(token);
        if (findings === null) return MALFORMED;
      } else {
        if (repo !== null) return MALFORMED;
        const slug = RepoSlug.safeParse(token);
        if (!slug.success) return MALFORMED;
        repo = slug.data;
      }
    }
    if (repo === null) return MALFORMED;
    const command = name === "brief" ? "BRIEF" : "REVIEW";
    const cmd: Command = { kind: "MISSION", command, repo, findings };
    // The door's own objective grammar is the final word: if it would refuse this, so do we.
    try {
      parseMissionObjective(missionObjective(cmd));
    } catch {
      return MALFORMED;
    }
    return cmd;
  }

  return MALFORMED;
}

/** The mission objective for a mission command, in the grammar the door and the kernel enforce. */
export function missionObjective(cmd: Extract<Command, { kind: "MISSION" }>): string {
  if (cmd.command === "BRIEF") {
    // No question: the mission's own default (architecture, components, risks, gaps) applies.
    return cmd.findings === null ? cmd.repo : `${cmd.repo} findings=${cmd.findings}`;
  }
  const n = cmd.findings ?? DEFAULT_REVIEW_FINDINGS;
  return (
    `${cmd.repo} findings=${n} Review the repository and identify the ${n} highest-value concrete ` +
    "improvements to reliability or operational usefulness. Every finding must cite exact repository evidence."
  );
}

/** What is sent to the door. The recipe is the existing mission recipe: no new recipe, no new authority. */
export function admissionRequest(cmd: Extract<Command, { kind: "MISSION" }>): { recipe: typeof MISSION_RECIPE; objective: string } {
  return { recipe: MISSION_RECIPE, objective: missionObjective(cmd) };
}
