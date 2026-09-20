import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CliError, missionStatus, readBearer } from "./mission/mission-cli.js";
import { Id } from "../../../packages/contracts/src/index.js";

/**
 * `approval-test admit|status` - start, and watch, the ONE harmless synthetic approval boundary.
 *
 * It submits an `uppercase/v1` task through the admission door, the same public path every other task
 * uses. That capability uppercases the task's own text: it touches no file, network or account, so
 * there is nothing for an approval to protect except the approval path itself. With the approval
 * boundary configured, the task pauses at the policy workflow's approval gate and asks for a human
 * answer; the Telegram card is how that answer is given. This tool cannot approve anything: it only
 * submits and reads, and never calls the door's approve control.
 *
 *   approval-test admit  --label <id> --door-url <url> --bearer-file <path>
 *   approval-test status --task-id <uuid> --door-url <url> --bearer-file <path>
 *
 * The bearer comes only from a file (mode 600, from `secretctl get --out`); a flag that would carry it
 * is refused outright. The objective is fixed text plus the label, so a task can be told apart and
 * nothing user-supplied or secret ever becomes the card's content. Output is ids and statuses only.
 */
const FORBIDDEN = new Set(["--bearer", "--token", "--authorization", "--secret", "--password"]);
const LABEL = /^[A-Za-z0-9._-]{1,40}$/;

export interface Parsed {
  command: "admit" | "status";
  values: Record<string, string>;
}

export function parseArgs(argv: readonly string[]): Parsed {
  const [command, ...rest] = argv;
  if (command !== "admit" && command !== "status") throw new CliError("usage: approval-test admit|status ...");
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag && FORBIDDEN.has(flag)) throw new CliError("a credential must never be passed as an argument; use --bearer-file <path>");
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new CliError("flags must be --key value pairs");
    values[flag.slice(2)] = value;
  }
  const need = command === "admit" ? ["label", "door-url", "bearer-file"] : ["task-id", "door-url", "bearer-file"];
  for (const key of need) if (!values[key]) throw new CliError(`--${key} is required`);
  return { command, values };
}

/** The same label is the same task, so a repeated command never creates a second approval. */
export const idempotencyKeyFor = (label: string): string =>
  `approval-test-${createHash("sha256").update(label).digest("hex").slice(0, 32)}`;

/** Fixed text: the label distinguishes tasks, and nothing else ever reaches the card or the ledger. */
export const objectiveFor = (label: string): string => `approval test ${label}`;

interface Io {
  fetch?: typeof fetch;
  readFile?: (p: string) => string;
}

export async function admitApprovalTest(values: Record<string, string>, io: Io = {}): Promise<string[]> {
  const send = io.fetch ?? fetch;
  const label = values["label"]!;
  if (!LABEL.test(label)) throw new CliError("--label must match [A-Za-z0-9._-]{1,40}");
  const bearer = readBearer(values["bearer-file"]!, io.readFile);
  let base: string;
  try {
    const parsed = new URL(values["door-url"]!);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("scheme");
    base = parsed.origin;
  } catch {
    throw new CliError("--door-url must be an http(s) URL");
  }
  let response: Response;
  try {
    response = await send(`${base}/v1/tasks`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKeyFor(label),
      },
      body: JSON.stringify({ recipe: "uppercase/v1", objective: objectiveFor(label) }),
    });
  } catch {
    throw new CliError("the admission door could not be reached");
  }
  if (response.status === 409) throw new CliError("that label was already used with different content");
  if (response.status !== 202) throw new CliError(`the admission door returned HTTP ${response.status}`);
  const body = (await response.json()) as { taskId?: string; status?: string; dispatch?: string };
  return [`admitted task ${Id.parse(body.taskId)} status=${body.status ?? "?"} dispatch=${body.dispatch ?? "?"}`];
}

async function main(): Promise<void> {
  const { command, values } = parseArgs(process.argv.slice(2));
  const lines = command === "admit" ? await admitApprovalTest(values) : await missionStatus(values);
  process.stdout.write(lines.join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`approval-test failed: ${err instanceof CliError ? err.message : "unexpected failure"}\n`);
    process.exitCode = 4;
  });
}
