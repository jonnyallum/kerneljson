import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Id, MISSION_RECIPE, parseMissionObjective } from "../../../../packages/contracts/src/index.js";

/**
 * `mission admit|status` - admit and watch a repository-analysis mission through the
 * admission door, the same public path every other task uses. KernelJSON stays the only
 * authority: this tool asks the door for a task and reads back what the ledger says.
 *
 *   mission admit  --repo owner/repo --label <id> [--findings N | --max-findings N] [--question "..."] --door-url <url> --bearer-file <path>
 *   mission status --task-id <uuid> --door-url <url> --bearer-file <path>
 *
 * The bearer comes only from a file (mode 600, from `secretctl get --out`); a flag that
 * would carry it is refused outright, so it can never reach argv or shell history. Output
 * is ids, statuses, summaries and evidence digests: never the bearer, never runtime text.
 */
export class CliError extends Error {}

const FORBIDDEN = new Set(["--bearer", "--token", "--authorization", "--secret", "--password"]);

export interface Parsed {
  command: "admit" | "status";
  values: Record<string, string>;
}

export function parseArgs(argv: readonly string[]): Parsed {
  const [command, ...rest] = argv;
  if (command !== "admit" && command !== "status") throw new CliError("usage: mission admit|status ...");
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag && FORBIDDEN.has(flag)) throw new CliError("a credential must never be passed as an argument; use --bearer-file <path>");
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new CliError("flags must be --key value pairs");
    values[flag.slice(2)] = value;
  }
  const need = command === "admit" ? ["repo", "label", "door-url", "bearer-file"] : ["task-id", "door-url", "bearer-file"];
  for (const key of need) if (!values[key]) throw new CliError(`--${key} is required`);
  return { command, values };
}

export function readBearer(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string {
  let text: string;
  try {
    text = read(path);
  } catch {
    throw new CliError("bearer file could not be read");
  }
  const bearer = text.replace(/^\uFEFF/, "").trim();
  if (!/^[A-Za-z0-9._~+/-]{20,512}=*$/.test(bearer)) throw new CliError("bearer file does not hold a bearer token of the expected shape");
  return bearer;
}

function doorBase(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("--door-url must be an http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new CliError("--door-url must be an http(s) URL");
  return parsed.origin;
}

interface Io {
  fetch?: typeof fetch;
  readFile?: (p: string) => string;
}

/** `directives` is the structured contract text (`findings=3`), so a different contract is a different request. */
export function idempotencyKey(repo: string, question: string, label: string, directives = ""): string {
  const material = directives ? `${repo}\n${question}\n${label}\n${directives}` : `${repo}\n${question}\n${label}`;
  return `mission-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export async function admitMission(values: Record<string, string>, io: Io = {}): Promise<string[]> {
  const send = io.fetch ?? fetch;
  const bearer = readBearer(values["bearer-file"]!, io.readFile);
  const base = doorBase(values["door-url"]!);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(values["label"]!)) throw new CliError("--label must match [A-Za-z0-9._-]{1,40}");
  const directives = [
    values["findings"] ? `findings=${values["findings"]}` : "",
    values["max-findings"] ? `max-findings=${values["max-findings"]}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const objective = [values["repo"]!, directives, values["question"] ?? ""].filter(Boolean).join(" ").trim();
  // Validated exactly as the kernel will at admission: a bad count never reaches the door.
  const { repo, question } = parseMissionObjective(objective);
  let response: Response;
  try {
    response = await send(`${base}/v1/tasks`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey(repo, question, values["label"]!, directives),
      },
      body: JSON.stringify({ recipe: MISSION_RECIPE, objective }),
    });
  } catch {
    throw new CliError("the admission door could not be reached");
  }
  if (response.status === 409) throw new CliError("that label was already used with different content");
  if (response.status !== 202) throw new CliError(`the admission door returned HTTP ${response.status}`);
  const body = (await response.json()) as { taskId?: string; status?: string; dispatch?: string };
  return [`admitted task ${Id.parse(body.taskId)} status=${body.status ?? "?"} dispatch=${body.dispatch ?? "?"}`];
}

export async function missionStatus(values: Record<string, string>, io: Io = {}): Promise<string[]> {
  const send = io.fetch ?? fetch;
  const bearer = readBearer(values["bearer-file"]!, io.readFile);
  const base = doorBase(values["door-url"]!);
  const taskId = Id.parse(values["task-id"]);
  const get = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await send(`${base}${path}`, { redirect: "error", headers: { authorization: `Bearer ${bearer}` } });
    } catch {
      throw new CliError("the admission door could not be reached");
    }
    if (!response.ok) throw new CliError(`the admission door returned HTTP ${response.status}`);
    return response.json();
  };
  const task = (await get(`/v1/tasks/${taskId}`)) as { status?: string; outcome?: { status?: string; summary?: string } | null };
  const lines = [`task ${taskId} status=${task.status ?? "?"}`];
  if (task.outcome) lines.push(`outcome ${task.outcome.status ?? "?"}: ${String(task.outcome.summary ?? "").slice(0, 300)}`);
  const evidence = (await get(`/v1/tasks/${taskId}/evidence`)) as Array<{ type?: string; source?: string; digest?: string }>;
  for (const e of Array.isArray(evidence) ? evidence : [])
    lines.push(`evidence ${e.type ?? "?"} ${e.source ?? "?"} ${String(e.digest ?? "").slice(0, 12)}`);
  return lines;
}

async function main(): Promise<void> {
  const { command, values } = parseArgs(process.argv.slice(2));
  const lines = command === "admit" ? await admitMission(values) : await missionStatus(values);
  process.stdout.write(lines.join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`mission failed: ${err instanceof CliError ? err.message : "unexpected failure"}\n`);
    process.exitCode = 4;
  });
}
