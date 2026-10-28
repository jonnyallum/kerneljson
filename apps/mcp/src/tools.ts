import { z } from "zod";
import {
  BRIEF_RECIPE,
  CODE_CHANGE_LIMITS,
  CODE_CHANGE_RECIPE,
  Id,
  MISSION_HARD_MAX_FINDINGS,
  MISSION_RECIPE,
  RepoSlug,
  parseCodeChangeObjective,
  parseMissionObjective,
} from "../../../packages/contracts/src/index.js";
import type { DoorResult, OperatorDoor } from "./door.js";

/**
 * ADR-0025 phase 1 tool set. This list IS the safety boundary: a chat model that has been steered by
 * something it read can, at worst, read the ledger, start a read-only analysis or a brief, ask for a code
 * change that ends as a DRAFT pull request on an allowlisted repository, or cancel a task. Deliberately
 * absent: approve, signal, identity-change/v1, the test and canary recipes, merging, and anything that is
 * not a door route.
 */

/** The caller's own idempotency token for an act tool, namespaced so it can never equal another channel's key. */
const RequestId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,124}$/, "8 to 124 characters: letters, digits, '.', '_', ':' or '-'")
  .describe("A unique id for this request, such as a fresh UUID. Retrying with the same id returns the same task; never reuse one for a different request.");

export const idempotencyKeyFor = (requestId: string): string => `mcp:${requestId}`;

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run(door: OperatorDoor, args: z.infer<S>): Promise<DoorResult>;
}

const read = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

const define = <S extends z.ZodType>(tool: ToolDefinition<S>): ToolDefinition => tool as unknown as ToolDefinition;

const TaskRef = z.strictObject({ task_id: Id.describe("The task's UUID") });

export const TOOLS: readonly ToolDefinition[] = [
  define({
    name: "kj_list_tasks",
    description: "List recent KernelJSON tasks for Jonny's tenant, newest first: id, recipe, source, status, objective preview and times.",
    input: z.strictObject({ limit: z.number().int().min(1).max(50).default(20).describe("How many tasks, 1 to 50") }),
    annotations: read("List recent tasks"),
    run: (door, args) => door.listTasks(args.limit),
  }),
  define({
    name: "kj_get_task",
    description: "Read one task's current status, outcome summary, dispatch state and effect disposition.",
    input: TaskRef,
    annotations: read("Get a task"),
    run: (door, args) => door.task(args.task_id),
  }),
  define({
    name: "kj_task_evidence",
    description: "List the evidence records a task captured: id, type, source and digest.",
    input: TaskRef,
    annotations: read("Get a task's evidence"),
    run: (door, args) => door.task(args.task_id, "evidence"),
  }),
  define({
    name: "kj_task_history",
    description: "Read a task's ledger events, newest first.",
    input: TaskRef,
    annotations: read("Get a task's history"),
    run: (door, args) => door.task(args.task_id, "history"),
  }),
  define({
    name: "kj_memory",
    description: "Search KernelJSON's verified memory for items matching some text, as of a point in time (default now).",
    input: z.strictObject({
      text: z.string().trim().min(1).max(256).describe("What to look for"),
      at: z.iso.datetime().optional().describe("ISO 8601 UTC time to read memory as of; default now"),
    }),
    annotations: read("Search memory"),
    run: (door, args) => door.memory({ text: args.text, at: args.at ?? new Date().toISOString() }),
  }),
  define({
    name: "kj_world",
    description: "Read KernelJSON's world-model view of one entity: its relationships and observations, as of a point in time (default now).",
    input: z.strictObject({
      entity_id: Id.describe("The entity's UUID"),
      at: z.iso.datetime().optional().describe("ISO 8601 UTC time to read as of; default now"),
    }),
    annotations: read("Read the world model"),
    run: (door, args) => door.world({ entityId: args.entity_id, at: args.at ?? new Date().toISOString() }),
  }),
  define({
    name: "kj_health",
    description: "Ledger-side health: active release and epoch, binding mismatches, schedules and their last run, task counts and notification delivery.",
    input: z.strictObject({}),
    annotations: read("Check KernelJSON health"),
    run: (door) => door.health(),
  }),
  define({
    name: "kj_run_brief",
    description: "Start a morning brief now: GitHub activity for the last 24 hours, written by one model, reviewed by another, delivered to Telegram. Returns the task id to follow with kj_get_task.",
    input: z.strictObject({ request_id: RequestId }),
    annotations: { title: "Run a morning brief", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (door, args) => door.admit({ recipe: BRIEF_RECIPE, objective: "morning brief", idempotencyKey: idempotencyKeyFor(args.request_id) }),
  }),
  define({
    name: "kj_run_analysis",
    description: "Start a read-only analysis of one GitHub repository (the same mission as Telegram /brief and /review). It reads the repository, one model analyses and another reviews; nothing is changed. Returns the task id.",
    input: z
      .strictObject({
        request_id: RequestId,
        repo: RepoSlug.describe("owner/name, for example jonnyallum/kerneljson"),
        findings: z.number().int().min(1).max(MISSION_HARD_MAX_FINDINGS).optional().describe(`Exact number of findings, 1 to ${MISSION_HARD_MAX_FINDINGS}`),
        question: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          // A leading directive would be read as part of the contract, not as question text.
          .refine((q) => !/^(findings|max-findings)=/i.test(q), "The question must not start with findings= or max-findings=")
          .optional()
          .describe("What the analysis should answer; default is architecture, components, risks and gaps"),
      })
      .superRefine((a, ctx) => {
        try {
          parseMissionObjective(analysisObjective(a));
        } catch (error) {
          ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid analysis request" });
        }
      }),
    annotations: { title: "Run a repository analysis", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (door, args) => door.admit({ recipe: MISSION_RECIPE, objective: analysisObjective(args), idempotencyKey: idempotencyKeyFor(args.request_id) }),
  }),
  define({
    name: "kj_run_code_change",
    description:
      "Ask KernelJSON to make a bounded code change to an allowlisted GitHub repository. A GitHub Actions runner writes it on a kj/<task> branch, tests run on that commit, a different model reviews the diff, and if KernelJSON's checks accept it a DRAFT pull request is opened for Jonny to review. It never merges or deploys; CI, infrastructure, secrets, billing and dependency files are refused. Jonny gets Telegram messages when it starts, fails or opens the PR. Returns the task id to follow with kj_get_task.",
    input: z
      .strictObject({
        request_id: RequestId,
        repo: RepoSlug.describe("owner/name of an allowlisted repository, for example jonnyallum/kj-pilot"),
        instructions: z
          .string()
          .trim()
          .min(CODE_CHANGE_LIMITS.minInstructionChars)
          .max(CODE_CHANGE_LIMITS.maxInstructionChars)
          .describe("The change to make, in plain words. Small and specific works best: one behaviour, with its tests."),
      })
      .superRefine((a, ctx) => {
        try {
          parseCodeChangeObjective(codeChangeObjective(a));
        } catch (error) {
          ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid code-change request" });
        }
      }),
    annotations: { title: "Run a code change (draft PR)", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (door, args) => door.admit({ recipe: CODE_CHANGE_RECIPE, objective: codeChangeObjective(args), idempotencyKey: idempotencyKeyFor(args.request_id) }),
  }),
  define({
    name: "kj_cancel_task",
    description: "Ask KernelJSON to cancel a task started from ChatGPT that has not finished. Tasks started elsewhere (the scheduled brief, Telegram) cannot be cancelled from here. The kernel decides whether it can; cancelling never undoes work already done.",
    input: TaskRef,
    annotations: { title: "Cancel a task", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (door, args) => door.cancel(args.task_id),
  }),
];

/** In the grammar the door and the kernel enforce: `owner/repo [findings=N] [question]`. */
export function analysisObjective(a: { repo: string; findings?: number | undefined; question?: string | undefined }): string {
  return [a.repo, a.findings === undefined ? null : `findings=${a.findings}`, a.question ?? null].filter((p) => p !== null).join(" ");
}

/** In the grammar the kernel enforces: `owner/repo instructions`. */
export function codeChangeObjective(a: { repo: string; instructions: string }): string {
  return `${a.repo} ${a.instructions.trim()}`;
}

export function toolList(): Array<{ name: string; title: string; description: string; inputSchema: unknown; annotations: ToolAnnotations }> {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.annotations.title,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: "input" }),
    annotations: t.annotations,
  }));
}
