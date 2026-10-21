import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sha256Text } from "../services/kernel/src/mission/reconcile.js";
import type { Context } from "@restatedev/restate-sdk";
import {
  BRIEF_RECIPE,
  BRIEF_RECONCILE_CHECKS,
  BriefFacts,
  Evidence,
  KernelSubmission,
  TaskStep,
  parseBriefObjective,
  type Outcome,
  type Task,
} from "../packages/contracts/src/index.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { planTask } from "../services/kernel/src/planner/index.js";
import { verifyPlanCompletion } from "../services/kernel/src/executor/index.js";
import { runMorningBriefMission, type BriefDeps } from "../services/kernel/src/mission/run-brief.js";
import type { Emit } from "../services/kernel/src/mission/run.js";
import type { BriefNotice } from "../services/kernel/src/mission/notify.js";
import { briefNoticeDecision, enqueueBriefNotice } from "../services/kernel/src/mission/notify.js";
import { BRIEF_MESSAGE_LIMIT, briefMessage, briefRefs, parseBrief, reconcileBrief } from "../services/kernel/src/mission/brief.js";
import { escapeTelegramMarkdownV2, formatTelegramMessage } from "../services/kernel/src/alerting/format.js";
import { isBriefCompletedCheckId } from "../services/kernel/src/alerting/brief-notice.js";
import { InMemoryNotificationOutboxStore } from "../services/kernel/src/alerting/outbox-store.js";
import { RecordingNotifier } from "../services/kernel/src/alerting/notifier.js";
import { runDeliveryWorker } from "../services/kernel/src/alerting/delivery-worker.js";
import { HttpAdmissionGateway } from "../services/kernel/src/scheduler/http-admission.js";
import { createGithubActivityReader } from "../packages/runtimes/src/github-activity.js";
import { id as tenantId, principal } from "../evals/fixtures/contracts.js";
import {
  KERNEL, WINDOW_END, activityResult, briefJson, fakeBriefAnalyst, fakeBriefReviewer, makeActivity,
} from "./support/brief-fixture.js";
import type { MissionMemoryPort } from "../services/kernel/src/mission/memory-port.js";

const CREATED = "2026-10-20T05:59:00.000Z";

function newTask(objective = "morning brief 2026-10-20"): { task: Task; plan: ReturnType<typeof planTask> } {
  const submission = KernelSubmission.parse({
    recipe: BRIEF_RECIPE,
    intent: {
      id: randomUUID(), principal, tenant: { id: tenantId }, source: "test", objective,
      attachments: [], contextRefs: [], receivedAt: CREATED,
      trace: { traceId: randomUUID(), correlationId: randomUUID() },
    },
  });
  const { task } = compileIntent(submission);
  return { task, plan: planTask(task, BRIEF_RECIPE) };
}

interface Run {
  outcome: Outcome;
  task: Task;
  plan: ReturnType<typeof planTask>;
  steps: Map<string, TaskStep>;
  evidence: Evidence[];
  notices: BriefNotice[];
  verifyError: Error | null;
}

/** An in-memory ledger: records steps and evidence, and runs the REAL completion verifier on COMPLETED. */
async function run(over: Partial<BriefDeps> = {}): Promise<Run> {
  const { task, plan } = newTask();
  const steps = new Map<string, TaskStep>();
  const evidence: Evidence[] = [];
  const notices: BriefNotice[] = [];
  let verifyError: Error | null = null;
  let t = 0;
  const now = async () => new Date(Date.parse(WINDOW_END) + 1000 * t++).toISOString();
  const emit: Emit = async (_key, _type, status, extra = {}) => {
    if (extra.step) steps.set(extra.step.id, extra.step);
    if (extra.evidence) evidence.push(extra.evidence);
    if (status === "COMPLETED" && extra.outcome) {
      try {
        verifyPlanCompletion({ ...task, status: "VERIFYING" }, extra.outcome, plan, [...steps.values()], evidence.map((record) => ({ record, step: null })));
        return extra.outcome;
      } catch (error) {
        verifyError = error as Error;
        return { ...extra.outcome, status: "FAILED" } as Outcome;
      }
    }
  };
  const ctx = { run: async (_n: string, action: () => unknown) => structuredClone(await action()) } as unknown as Pick<Context, "run">;
  const outcome = await runMorningBriefMission({
    ctx, task, plan, emit, now, uuid: randomUUID,
    githubActivity: async () => activityResult(),
    kernelState: async () => KERNEL,
    analyst: fakeBriefAnalyst(),
    reviewer: fakeBriefReviewer(),
    notify: async (n) => { notices.push(n); },
    ...over,
  });
  return { outcome, task, plan, steps, evidence, notices, verifyError };
}

const verify = (r: Run, evidence = r.evidence, outcome = r.outcome) =>
  verifyPlanCompletion({ ...r.task, status: "VERIFYING" }, outcome, r.plan, [...r.steps.values()], evidence.map((record) => ({ record, step: null })));

describe("morning-brief/v1 admission", () => {
  it("accepts 'morning brief' with an optional label and nothing else", () => {
    expect(parseBriefObjective("morning brief")).toEqual({ label: "" });
    expect(parseBriefObjective("Morning brief 2026-10-20T06:00")).toEqual({ label: "2026-10-20T06:00" });
    for (const bad of ["", "brief", "morning", "evening brief", "jonnyallum/kerneljson", `morning brief ${"x".repeat(201)}`])
      expect(() => parseBriefObjective(bad), bad).toThrow();
  });

  it("compiles to the mission's four existing step kinds and no new operation", () => {
    const { plan } = newTask();
    expect(plan.steps.map((s) => s.operation)).toEqual(["GITHUB_EVIDENCE", "RUNTIME_ANALYSE", "RUNTIME_REVIEW", "RECONCILE"]);
    expect(() => compileIntent(KernelSubmission.parse({
      recipe: BRIEF_RECIPE,
      intent: { id: randomUUID(), principal, tenant: { id: tenantId }, source: "test", objective: "summarise my repos",
        attachments: [], contextRefs: [], receivedAt: CREATED, trace: { traceId: randomUUID(), correlationId: randomUUID() } },
    }))).toThrow();
  });
});

describe("morning-brief/v1 end to end against an in-memory ledger and the real completion verifier", () => {
  it("completes on cited, reviewed evidence and queues the brief text as a P3 notice", async () => {
    const r = await run();
    expect(r.verifyError).toBeNull();
    expect(r.outcome.status).toBe("COMPLETED");
    expect(r.outcome.summary).toMatch(/^Brief accepted: CI is failing/);
    expect(r.evidence.map((e) => e.source)).toEqual([
      "kerneljson:github-activity/v1", "kerneljson:runtime/analyst", "kerneljson:runtime/reviewer", "kerneljson:brief-reconcile/v1",
    ]);
    expect([...r.steps.values()].map((s) => s.status)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatchObject({ status: "COMPLETED", taskId: r.task.id });
    expect(r.notices[0]!.text).toContain("Morning brief, Tue 20/10/2026");
    expect(r.notices[0]!.text).toContain("1. Item 1: kerneljson CI failing");
    expect(r.notices[0]!.text).toContain("reviewed by anthropic/claude-sonnet-test");
  });

  it("a quiet day (nothing pushed) is a valid brief citing the scan", async () => {
    const r = await run({
      githubActivity: async () => activityResult(makeActivity({ active: [] })),
      analyst: fakeBriefAnalyst({ items: [{ refs: ["scan"] }] }),
    });
    expect(r.outcome.status).toBe("COMPLETED");
  });

  // 21/10/2026: the analyst copied the evidence's brackets onto every reference and a correct brief was rejected.
  it("accepts real references the analyst wrapped in the evidence's square brackets", async () => {
    const r = await run({
      analyst: fakeBriefAnalyst({ items: [{ refs: ["[ci:jonnyallum/kerneljson]", " [repo:jonnyallum/kerneljson] "] }, { refs: ["[kj:canary]", "scan"] }] }),
    });
    expect(r.verifyError).toBeNull();
    expect(r.outcome.status).toBe("COMPLETED");
    expect(r.evidence[3]!.metadata["decision"]).toBe("ACCEPTED");
  });

  it("memory the analyst was given can be cited; memory it was not given cannot", async () => {
    const memoryId = "abcdef12-3456-4789-8abc-def012345678";
    const memory: MissionMemoryPort = {
      assemble: async () => ({
        status: "ASSEMBLED", assemblyId: randomUUID(), digest: "d".repeat(64),
        text: `OPERATOR MEMORY (...)\n- [PREFERENCE/OPERATOR v1 ${memoryId.slice(0, 8)}] Watch the B1 cutover`,
        memories: [{ memoryId, version: 1 }], externalCount: 0, usedTokens: 20,
      }),
    };
    const ok = await run({ memory, analyst: fakeBriefAnalyst({ memory: true }) });
    expect(ok.outcome.status).toBe("COMPLETED");
    const analyst = ok.evidence.find((e) => e.source === "kerneljson:runtime/analyst")!;
    expect(parseBrief(String(analyst.metadata["text"]))!.items.at(-1)!.refs).toEqual(["memory:abcdef12"]);
    const forged = await run({ analyst: fakeBriefAnalyst({ items: [{ refs: ["memory:abcdef12"] }] }) });
    expect(forged.outcome.status).toBe("FAILED");
    expect(forged.outcome.summary).toContain("brief_refs_exist_in_evidence");
  });

  const rejected: Array<[string, Partial<BriefDeps>, (typeof BRIEF_RECONCILE_CHECKS)[number]]> = [
    ["the analyst answers in prose", { analyst: fakeBriefAnalyst({ reply: "All quiet, nothing to report." }) }, "brief_schema_valid"],
    ["the brief is for a different window", { analyst: fakeBriefAnalyst({ windowEnd: "2026-10-18T06:00:00.000Z" }) }, "brief_window_matches_evidence"],
    ["an item cites nothing", { analyst: fakeBriefAnalyst({ items: [{ refs: [] }] }) }, "brief_items_cited"],
    ["an item cites a commit that is not in the evidence", { analyst: fakeBriefAnalyst({ items: [{ refs: [`commit:jonnyallum/kerneljson@${"9".repeat(12)}`] }] }) }, "brief_refs_exist_in_evidence"],
    ["an item cites a repository that was not active", { analyst: fakeBriefAnalyst({ items: [{ refs: ["ci:jonnyallum/agent-hub-conductor"] }] }) }, "brief_refs_exist_in_evidence"],
    ["an item cites, in brackets, a commit that is not in the evidence", { analyst: fakeBriefAnalyst({ items: [{ refs: [`[commit:jonnyallum/kerneljson@${"9".repeat(12)}]`] }] }) }, "brief_refs_exist_in_evidence"],
    ["an item cites a reference with doubled brackets", { analyst: fakeBriefAnalyst({ items: [{ refs: ["[[ci:jonnyallum/kerneljson]]"] }] }) }, "brief_refs_exist_in_evidence"],
    ["an item cites a reference with an unclosed bracket", { analyst: fakeBriefAnalyst({ items: [{ refs: ["[ci:jonnyallum/kerneljson"] }] }) }, "brief_refs_exist_in_evidence"],
    ["the reviewer rejects", { reviewer: fakeBriefReviewer({ verdict: "reject" }) }, "review_verdict_acceptable"],
    ["the reviewer flags the only item", { reviewer: fakeBriefReviewer({ unsupported: [0] }) }, "review_leaves_supported_items"],
    ["the reviewer flags an item that does not exist", { reviewer: fakeBriefReviewer({ unsupported: [5] }) }, "review_leaves_supported_items"],
    ["the reviewer reviewed something else", { reviewer: fakeBriefReviewer({ echoDigest: "0".repeat(64) }) }, "review_binds_to_analysis"],
    ["the reviewer is the analyst's model", { reviewer: fakeBriefReviewer({ model: "deepseek-flash" }) }, "reviewer_is_independent"],
    ["the analyst is not an allowed family", { analyst: fakeBriefAnalyst({ model: "openai/gpt-test", provider: "openrouter" }) }, "analyst_runtime_allowed"],
  ];
  for (const [label, over, check] of rejected) {
    it(`ends FAILED with four evidence rows and a P2 notice when ${label}`, async () => {
      const r = await run(over);
      expect(r.outcome.status).toBe("FAILED");
      expect(r.outcome.summary).toContain(check);
      expect(r.evidence).toHaveLength(4);
      expect(r.evidence[3]!.metadata["decision"]).toBe("REJECTED");
      expect(r.notices).toEqual([expect.objectContaining({ status: "FAILED" })]);
      expect(r.notices[0]!.text).toBeUndefined();
    });
  }

  it("withholds the items the reviewer flags and delivers the rest, saying so", async () => {
    const r = await run({
      analyst: fakeBriefAnalyst({ items: [{ refs: ["ci:jonnyallum/kerneljson"] }, { refs: ["repo:jonnyallum/agent-hub-conductor"] }, { refs: ["kj:canary"] }] }),
      reviewer: fakeBriefReviewer({ verdict: "approve_with_notes", unsupported: [1] }),
    });
    expect(r.verifyError).toBeNull();
    expect(r.outcome.status).toBe("COMPLETED");
    expect(r.evidence[3]!.metadata).toMatchObject({ decision: "ACCEPTED", itemCount: 3, withheldItems: [1] });
    const text = r.notices[0]!.text!;
    expect(text).toContain("1. Item 1:");
    expect(text).toContain("2. Item 3:");
    expect(text).not.toContain("Item 2:");
    expect(text).toContain("1 item withheld: the reviewer found it unsupported.");
  });

  it("a GitHub read failure ends FAILED at the first step, with evidence, and no brief is sent", async () => {
    const r = await run({ githubActivity: async () => { throw new Error("AUTH"); } });
    expect(r.outcome.status).toBe("FAILED");
    expect(r.outcome.summary).toBe("brief FAILED: GITHUB_AUTH");
    expect(r.evidence).toHaveLength(1);
    expect(r.notices).toEqual([expect.objectContaining({ status: "FAILED" })]);
  });

  it("activity whose digest does not match the capability's receipt ends FAILED", async () => {
    const r = await run({ githubActivity: async () => ({ ...activityResult(), activityDigest: "0".repeat(64) }) });
    expect(r.outcome.summary).toBe("brief FAILED: GITHUB_DIGEST_MISMATCH");
  });

  it("a model provider failure ends FAILED with the error recorded", async () => {
    const r = await run({ analyst: fakeBriefAnalyst({ reply: { fail: "RATE_LIMIT" } }) });
    expect(r.outcome.summary).toBe("brief FAILED: ANALYST_RATE_LIMIT");
  });
});

describe("the ledger backstop re-derives a brief completion from persisted evidence", () => {
  const tamper = (e: Evidence, metadata: Record<string, unknown>, digest = e.digest): Evidence =>
    Evidence.parse({ ...e, metadata: { ...e.metadata, ...metadata }, ...(digest ? { digest } : {}) });

  it("accepts the untouched record (positive control)", async () => {
    const r = await run();
    expect(() => verify(r)).not.toThrow();
  });

  it("refuses edited brief text, even with its digest recomputed", async () => {
    const r = await run();
    const forged = briefJson({ items: [{ refs: [`commit:jonnyallum/kerneljson@${"9".repeat(12)}`] }] });
    const ev = r.evidence.map((e) => (e.source === "kerneljson:runtime/analyst" ? tamper(e, { text: forged }, sha256Text(forged)) : e));
    expect(() => verify(r, ev)).toThrow(/Brief completion rejected/);
  });

  it("refuses edited facts", async () => {
    const r = await run();
    const facts = BriefFacts.parse(r.evidence[0]!.metadata["facts"]);
    const edited = { ...facts, kernel: { ...facts.kernel, lastCanary: null } };
    const ev = r.evidence.map((e, i) => (i === 0 ? tamper(e, { facts: edited }) : e));
    expect(() => verify(r, ev)).toThrow(/facts digest mismatch/);
  });

  it("refuses facts whose GitHub part was edited and re-digested at the top level only", async () => {
    const r = await run();
    const facts = BriefFacts.parse(r.evidence[0]!.metadata["facts"]);
    const edited = BriefFacts.parse({ ...facts, github: { ...facts.github, reposVisible: 1 } });
    const d = capabilityDigest(edited);
    const ev = r.evidence.map((e, i) => (i === 0 ? tamper(e, { facts: edited, content_sha256: d }, d) : e));
    expect(() => verify(r, ev)).toThrow(/github activity digest mismatch|not bound/);
  });

  it("refuses a missing reviewer row", async () => {
    const r = await run();
    expect(() => verify(r, r.evidence.filter((e) => e.source !== "kerneljson:runtime/reviewer"))).toThrow(/expected exactly one/);
  });

  it("refuses a summary the brief does not support", async () => {
    const r = await run();
    expect(() => verify(r, r.evidence, { ...r.outcome, summary: "Brief accepted: all good" })).toThrow(/summary/);
  });
});

describe("brief references and reconciliation", () => {
  const facts = BriefFacts.parse({ github: makeActivity(), githubDigest: capabilityDigest(makeActivity()), kernel: KERNEL });

  it("lists exactly what the evidence holds", () => {
    expect([...briefRefs(facts, [])].sort()).toEqual([
      "ci:jonnyallum/kerneljson",
      `commit:jonnyallum/kerneljson@${"1".repeat(12)}`,
      `commit:jonnyallum/kerneljson@${"2".repeat(12)}`,
      "kj:canary", "kj:tasks", "pr:jonnyallum/kerneljson#56",
      "repo:jonnyallum/agent-hub-conductor", "repo:jonnyallum/kerneljson", "scan",
    ]);
    const noCanary = BriefFacts.parse({ ...facts, kernel: { tasks: [], lastCanary: null } });
    expect(briefRefs(noCanary, []).has("kj:canary")).toBe(false);
  });

  it("decision follows the checks and records the independence it saw", () => {
    const text = briefJson();
    const rec = reconcileBrief({
      facts, memoryIds: [], analysisText: text, analystModel: "deepseek-flash", analystProvider: "deepseek",
      reviewText: JSON.stringify({ reviewedAnalysisSha256: sha256Text(text), verdict: "approve", unsupportedFindings: [], notes: [] }),
      reviewerModel: "anthropic/claude-sonnet-5", reviewerProvider: "openrouter",
    });
    expect(rec.decision).toBe("ACCEPTED");
    expect(rec.independence).toMatchObject({ crossProvider: true, crossFamily: true });
  });
});

describe("the brief message", () => {
  const brief = parseBrief(briefJson())!;

  it("is plain text with a UK date, the headline, numbered items and the task", () => {
    const text = briefMessage(brief, { taskId: "d10442d5-0000-4000-8000-000000000000", activeRepos: 2, reviewerModel: "anthropic/claude-sonnet-5" });
    expect(text.split("\n\n")[0]).toBe("Morning brief, Tue 20/10/2026");
    expect(text).toContain(brief.headline);
    expect(text).toContain("1. Item 1: kerneljson CI failing");
    expect(text).toContain("2 active repos; reviewed by anthropic/claude-sonnet-5. Task d10442d5");
  });

  it("never exceeds Telegram's limit after escaping, however long the brief", () => {
    const long = parseBrief(JSON.stringify({
      windowEnd: WINDOW_END,
      headline: "!".repeat(300),
      items: Array.from({ length: 12 }, (_, i) => ({ title: `${i}.`.repeat(40).slice(0, 120), detail: "*_[]()~`>#+-=|{}.!".repeat(40).slice(0, 600), refs: ["scan"] })),
    }))!;
    const text = briefMessage(long, { taskId: "d10442d5-0000-4000-8000-000000000000", activeRepos: 2, reviewerModel: "m" });
    expect(escapeTelegramMarkdownV2(text).length).toBeLessThanOrEqual(BRIEF_MESSAGE_LIMIT);
    expect(text).toMatch(/more items: \/task d10442d5/);
  });
});

describe("only a completed brief keeps its text on the way to Telegram", () => {
  const taskId = "d10442d5-0000-4000-8000-000000000000";
  const AT = "2026-10-20T06:01:00.000Z";

  it("a completed brief is delivered as written (escaped, no alert header)", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const notifier = new RecordingNotifier();
    await enqueueBriefNotice(outbox, { taskId, status: "COMPLETED", at: AT, text: "Morning brief, Tue 20/10/2026\n\nAll quiet." });
    await runDeliveryWorker({ outbox, notifier, transport: "telegram", now: () => new Date("2026-10-20T06:02:00Z") });
    expect(notifier.sent[0]!.message).toBe("Morning brief, Tue 20/10/2026\n\nAll quiet.");
    expect(formatTelegramMessage(notifier.sent[0]!)).toBe(escapeTelegramMarkdownV2("Morning brief, Tue 20/10/2026\n\nAll quiet."));
  });

  it("negative control: a failed brief reaches the transport as the redacted summary", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const notifier = new RecordingNotifier();
    await enqueueBriefNotice(outbox, { taskId, status: "FAILED", at: AT });
    await runDeliveryWorker({ outbox, notifier, transport: "telegram", now: () => new Date("2026-10-20T06:02:00Z") });
    expect(notifier.sent[0]!.message).toBe("MISSION.morningBrief.d10442d5.failed: NEW (P2)");
  });

  it("negative control: look-alike check ids do not earn the exception", () => {
    for (const id of [
      "MISSION.morningBrief.d10442d5.failed", "MISSION.morningBrief.D10442D5.completed", "MISSION.morningBrief.d10442d.completed",
      "MISSION.morningBrief.d10442d5.completed.x", "MISSION.repoAnalysis.d10442d5.completed", " MISSION.morningBrief.d10442d5.completed",
      "MISSION.morningBrief.d10442d5.completed\nX",
    ])
      expect(isBriefCompletedCheckId(id), JSON.stringify(id)).toBe(false);
    expect(isBriefCompletedCheckId("MISSION.morningBrief.d10442d5.completed")).toBe(true);
  });

  it("a completed notice without its text is refused rather than sent empty", () => {
    expect(() => briefNoticeDecision({ taskId, status: "COMPLETED", at: AT })).toThrow();
  });
});

describe("the GitHub activity reader", () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const repo = (full_name: string, pushed_at: string | null, extra = {}) => ({ full_name, private: true, default_branch: "main", pushed_at, ...extra });
  const commit = (sha: string) => ({ sha, author: { login: "jonnyallum" }, commit: { author: { name: "J", date: "2026-10-19T20:00:00Z" }, committer: { date: "2026-10-19T20:00:00Z" }, message: "feat: x\n\nbody" } });

  function fake(routes: Record<string, () => Response>) {
    const calls: Array<{ url: string; method: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const path = url.replace("https://api.github.com", "");
      calls.push({ url: path, method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization") });
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      return key ? routes[key]!() : json({ message: "nope" }, 404);
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("reads only repositories pushed in the window, skips archived ones, and tolerates unreadable PRs and runs", async () => {
    const { fetchImpl, calls } = fake({
      "/user/repos": () => json([
        repo("jonnyallum/kerneljson", "2026-10-19T21:00:00Z"),
        repo("jonnyallum/empty", "2026-10-19T22:00:00Z"),
        repo("jonnyallum/old", "2026-10-01T00:00:00Z"),
        repo("jonnyallum/archived", "2026-10-19T22:00:00Z", { archived: true }),
      ]),
      "/repos/jonnyallum/kerneljson/commits": () => json([commit("a".repeat(40))]),
      "/repos/jonnyallum/kerneljson/pulls": () => json([{ number: 5, title: "PR", draft: true, updated_at: "2026-10-19T21:00:00Z", user: { login: "j" } }]),
      "/repos/jonnyallum/kerneljson/actions/runs": () => json({ workflow_runs: [{ id: 7, name: "ci", status: "completed", conclusion: "success", head_sha: "a".repeat(40), updated_at: "2026-10-19T21:00:00Z" }] }),
      "/repos/jonnyallum/empty/commits": () => json({ message: "Git Repository is empty." }, 409),
      "/repos/jonnyallum/empty/pulls": () => json({ message: "Resource not accessible" }, 403),
      "/repos/jonnyallum/empty/actions/runs": () => json({ message: "Resource not accessible" }, 403),
    });
    const read = createGithubActivityReader({ token: "ghp_testtokenvalue", fetch: fetchImpl });
    const { activity, activityDigest } = await read({ windowEnd: WINDOW_END });
    expect(activity.reposVisible).toBe(4);
    expect(activity.active.map((r) => r.repo)).toEqual(["jonnyallum/kerneljson", "jonnyallum/empty"]);
    expect(activity.active[0]).toMatchObject({ commits: [{ message: "feat: x" }], openPulls: [{ number: 5, draft: true }], ci: { conclusion: "success" } });
    expect(activity.active[1]).toMatchObject({ commits: [], openPulls: null, ci: null });
    expect(activityDigest).toBe(capabilityDigest(activity));
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => c.url.includes("/repos/jonnyallum/old"))).toBe(false);
    expect(JSON.stringify(activity)).not.toContain("ghp_testtokenvalue");
  });

  it("fails closed without a token, on a rate limit and on an auth failure of the listing", async () => {
    await expect(createGithubActivityReader({})({ windowEnd: WINDOW_END })).rejects.toThrow("AUTH");
    const limited = fake({ "/user/repos": () => json({}, 403, { "x-ratelimit-remaining": "0" }) });
    await expect(createGithubActivityReader({ token: "ghp_testtokenvalue", fetch: limited.fetchImpl })({ windowEnd: WINDOW_END })).rejects.toThrow("RATE_LIMITED");
    const denied = fake({ "/user/repos": () => json({}, 401) });
    await expect(createGithubActivityReader({ token: "ghp_testtokenvalue", fetch: denied.fetchImpl })({ windowEnd: WINDOW_END })).rejects.toThrow("AUTH");
    // A rate limit on a per-repository read is not "unreadable": it still fails the brief.
    const perRepo = fake({
      "/user/repos": () => json([repo("jonnyallum/kerneljson", "2026-10-19T21:00:00Z")]),
      "/repos/jonnyallum/kerneljson/commits": () => json([]),
      "/repos/jonnyallum/kerneljson/pulls": () => json({}, 403, { "x-ratelimit-remaining": "0" }),
    });
    await expect(createGithubActivityReader({ token: "ghp_testtokenvalue", fetch: perRepo.fetchImpl })({ windowEnd: WINDOW_END })).rejects.toThrow("RATE_LIMITED");
    // GitHub's secondary limit: 403 with retry-after while remaining is above 0. Still a rate limit, never "unreadable".
    const secondary = fake({
      "/user/repos": () => json([repo("jonnyallum/kerneljson", "2026-10-19T21:00:00Z")]),
      "/repos/jonnyallum/kerneljson/commits": () => json([]),
      "/repos/jonnyallum/kerneljson/pulls": () => json({}, 403, { "x-ratelimit-remaining": "4000", "retry-after": "60" }),
    });
    await expect(createGithubActivityReader({ token: "ghp_testtokenvalue", fetch: secondary.fetchImpl })({ windowEnd: WINDOW_END })).rejects.toThrow("RATE_LIMITED");
  });
});

describe("scheduler routes: one schedule admits the brief, every other keeps its recipe", () => {
  it("routes by schedule id", async () => {
    const bodies: Array<{ recipe: string; objective: string }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ taskId: randomUUID() }), { status: 202 });
    }) as typeof fetch;
    const BRIEF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const gw = new HttpAdmissionGateway("http://door", {
      authorization: "Bearer x", recipe: "claude_md_check/v1", fetchImpl,
      routes: { [BRIEF]: { recipe: BRIEF_RECIPE, objectiveFor: (req) => `morning brief ${req.fireWindowKey}` } },
    });
    const req = (scheduleId: string) => ({ admissionIdentity: "i", scheduleId, version: "1", fireWindowKey: "2026-10-20T07:00", fireAtUtc: "", at: "" });
    await gw.admit(req(BRIEF));
    await gw.admit(req("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    expect(bodies[0]).toEqual({ recipe: BRIEF_RECIPE, objective: "morning brief 2026-10-20T07:00" });
    expect(bodies[1]!.recipe).toBe("claude_md_check/v1");
    expect(() => parseBriefObjective(bodies[0]!.objective)).not.toThrow();
  });
});

describe("install-brief seeds the brief's schedule through the canary's reviewed seed", () => {
  it("passes the 07:00 Europe/London spec, and install-canary still passes none", async () => {
    const { BRIEF_SPEC, CANARY_SPEC, parseArgs, runCanaryOperation } = await import("../services/kernel/src/tools/canary-runner.js");
    const calls: unknown[] = [];
    const deps = {
      provisionHuman: async () => ({}), enableCanary: async () => ({}), disableCanary: async () => ({}), fireOnce: async () => ({}),
      installCanary: async (args: unknown) => { calls.push(args); return { installed: true }; },
    };
    const pool = {} as never;
    const flags = ["--schedule-id", randomUUID(), "--tenant-id", randomUUID(), "--owner-id", randomUUID(), "--created-at", CREATED];
    await runCanaryOperation(deps, pool, parseArgs(["install-brief", ...flags]));
    await runCanaryOperation(deps, pool, parseArgs(["install-canary", ...flags]));
    expect(calls[0]).toMatchObject({ spec: BRIEF_SPEC });
    expect(calls[1]).not.toHaveProperty("spec");
    expect(BRIEF_SPEC).toMatchObject({ name: "morning_brief", timezone: "Europe/London", calendar: { kind: "dailyAt", hour: 7, minute: 0 }, missedRunPolicy: "SKIP" });
    expect(CANARY_SPEC.calendar).toEqual({ kind: "dailyAt", hour: 9, minute: 0 });
  });
});

describe("SCHED_BRIEF_SCHEDULE_ID at worker startup", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; vi.resetModules(); });
  const DIGEST = "27255772beb1418e462fe262a2a747c53bf6a34973c3ad75907f7505a32f2b10";
  const base = () => {
    vi.resetModules();
    for (const k of Object.keys(process.env)) if (/^(MISSION_|GITHUB_READ_TOKEN|SCHED_|KJ_|ALERT_|TELEGRAM_)/.test(k)) delete process.env[k];
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused", KJ_REPO_ROOT: process.cwd(), SCHED_RECIPE: "claude_md_check/v1",
      SCHED_APPROVED_SHA256: DIGEST, KJ_ADMISSION_URL: "http://gateway:8081", KJ_ADMISSION_BEARER: "RAW_TEST_TOKEN_VALUE",
    });
  };
  const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("unset or empty means no brief schedule; a malformed value is refused", async () => {
    base();
    const mod = await import("../services/kernel/src/index.js");
    expect(mod.parseBriefScheduleId({})).toBeUndefined();
    expect(mod.parseBriefScheduleId({ SCHED_BRIEF_SCHEDULE_ID: "" })).toBeUndefined();
    expect(mod.parseBriefScheduleId({ SCHED_BRIEF_SCHEDULE_ID: ID })).toBe(ID);
    for (const bad of ["yes", ID.toUpperCase(), ` ${ID}`, `${ID}x`]) expect(() => mod.parseBriefScheduleId({ SCHED_BRIEF_SCHEDULE_ID: bad })).toThrow();
  });

  it("refuses to start when set but the brief cannot be served (no mission runtimes, no read token)", async () => {
    base();
    process.env["SCHED_BRIEF_SCHEDULE_ID"] = ID;
    await expect(import("../services/kernel/src/index.js")).rejects.toThrow(/SCHED_BRIEF_SCHEDULE_ID/);
  });

  it("starts with ScheduleDriver registered when the brief is fully servable", async () => {
    base();
    Object.assign(process.env, {
      SCHED_BRIEF_SCHEDULE_ID: ID, MISSION_DEEPSEEK_API_KEY: "sk-test-not-real-0000000000000000000", MISSION_OPENROUTER_API_KEY: "sk-or-v1-test",
      MISSION_ANALYST_MODEL: "deepseek-flash", MISSION_REVIEWER_MODEL: "anthropic/claude-sonnet-5", GITHUB_READ_TOKEN: "ghp_testtokenvalue",
    });
    const mod = await import("../services/kernel/src/index.js");
    expect(mod.services.map((x) => (x as { name: string }).name)).toEqual(expect.arrayContaining(["ScheduleDriver", "KernelWorkflowV1", "CapabilityServiceV1"]));
  });
});

describe("a withheld item can never leave the model's headline in front of Jonny", () => {
  const three = { items: [{ refs: ["ci:jonnyallum/kerneljson"] }, { refs: ["repo:jonnyallum/agent-hub-conductor"] }, { refs: ["kj:canary"] }] };

  it("replaces the headline in the message and the outcome summary, and the ledger re-derives it", async () => {
    const r = await run({ analyst: fakeBriefAnalyst(three), reviewer: fakeBriefReviewer({ verdict: "approve_with_notes", unsupported: [1] }) });
    expect(r.verifyError).toBeNull();
    expect(r.outcome.status).toBe("COMPLETED");
    const headline = "2 of 3 items passed review; the model's headline is not shown because an item was withheld.";
    expect(r.outcome.summary).toBe(`Brief accepted: ${headline}`);
    expect(r.notices[0]!.text!.split("\n\n")[1]).toBe(headline);
    expect(r.notices[0]!.text).not.toContain("CI is failing");
    // The ledger refuses the model's headline as the summary once an item was withheld.
    expect(() => verify(r, r.evidence, { ...r.outcome, summary: "Brief accepted: CI is failing on kerneljson after last night's brief work; one PR is open." }))
      .toThrow(/summary/);
  });

  it("negative control: with nothing withheld the model's headline is kept", async () => {
    const r = await run({ analyst: fakeBriefAnalyst(three) });
    expect(r.outcome.summary).toMatch(/^Brief accepted: CI is failing/);
  });
});

describe("the dry run sends a completed, labelled brief or nothing", () => {
  it("labels a completed brief and refuses failures, missing text and anything but exactly one notice", async () => {
    const { dryRunNotice } = await import("../services/kernel/src/mission/brief-cli.js");
    const done = { taskId: "d10442d5-0000-4000-8000-000000000000", status: "COMPLETED" as const, at: WINDOW_END, text: "Morning brief" };
    expect(dryRunNotice([done])!.text).toBe("DRY RUN from a local machine: KernelJSON's own state was not read.\n\nMorning brief");
    const { text: _text, ...untexted } = done;
    expect(dryRunNotice([{ ...untexted, status: "FAILED" }])).toBeNull();
    expect(dryRunNotice([{ ...done, status: "FAILED" }])).toBeNull();
    expect(dryRunNotice([untexted])).toBeNull();
    expect(dryRunNotice([])).toBeNull();
    expect(dryRunNotice([done, done])).toBeNull();
  });
});

describe("fire-once cannot spend the brief's schedule as a canary fire", () => {
  const saved = process.env["SCHED_BRIEF_SCHEDULE_ID"];
  afterEach(() => { if (saved === undefined) delete process.env["SCHED_BRIEF_SCHEDULE_ID"]; else process.env["SCHED_BRIEF_SCHEDULE_ID"] = saved; });
  it("refuses the brief's schedule id and still fires any other", async () => {
    const { parseArgs, runCanaryOperation } = await import("../services/kernel/src/tools/canary-runner.js");
    const BRIEF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    process.env["SCHED_BRIEF_SCHEDULE_ID"] = BRIEF;
    let fired = 0;
    const deps = {
      provisionHuman: async () => ({}), installCanary: async () => ({}), enableCanary: async () => ({}), disableCanary: async () => ({}),
      fireOnce: async () => { fired++; return {}; },
    };
    const args = (id: string) => parseArgs(["fire-once", "--schedule-id", id, "--tenant-id", randomUUID(), "--actor-id", randomUUID(),
      "--expected-active-version", "v2", "--last-tick", WINDOW_END, "--now", WINDOW_END, "--owner", "o", "--production", "true", "--preview", "true"]);
    await expect(runCanaryOperation(deps, {} as never, args(BRIEF))).rejects.toThrow(/morning brief/);
    await runCanaryOperation(deps, {} as never, args(randomUUID()));
    expect(fired).toBe(1);
  });
});
