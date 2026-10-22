import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Context } from "@restatedev/restate-sdk";
import {
  CODE_CHANGE_RECIPE,
  Evidence,
  KernelSubmission,
  TaskStep,
  type ChangeFacts,
  type Outcome,
  type Task,
} from "../packages/contracts/src/index.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";
import { compileIntent } from "../services/kernel/src/compiler/index.js";
import { planTask } from "../services/kernel/src/planner/index.js";
import { verifyPlanCompletion } from "../services/kernel/src/executor/index.js";
import { runCodeChangeMission, type CodeChangeDeps, type CodeChangeGithub } from "../services/kernel/src/mission/run-code-change.js";
import type { Emit } from "../services/kernel/src/mission/run.js";
import { codeChangeNoticeDecision, type CodeChangeNotice } from "../services/kernel/src/mission/notify.js";
import { isCodeChangeCheckId } from "../services/kernel/src/alerting/code-change-notice.js";
import { formatTelegramMessage } from "../services/kernel/src/alerting/format.js";
import { loadCodeChangeConfig } from "../services/kernel/src/mission/code-change-config.js";
import { modelRequest } from "../evals/fixtures/models.js";
import { sha256Text } from "../services/kernel/src/mission/reconcile.js";
import { id as tenantId, principal } from "../evals/fixtures/contracts.js";
import { fakeRuntime, type FakeReply } from "./support/mission-fixture.js";

const REPO = "jonnyallum/kj-pilot";
const BASE = "0123456789abcdef0123456789abcdef01234567";
const HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const CREATED = "2026-10-22T12:00:00.000Z";
const INSTRUCTIONS = "Add a slugify(text) helper to src/text.js with tests.";
const PATCH_TEXT = "@@ -20,0 +21,4 @@\n+/** Lower-case, hyphenated. */\n+export function slugify(text) {\n+  return squash(text).toLowerCase().replace(/[^a-z0-9]+/g, \"-\");\n+}\n";
const PATCH = `--- src/text.js\n+++ src/text.js\n${PATCH_TEXT}\n`;
const CONFIG = { allowedRepos: [REPO] };

function newTask(objective = `${REPO} ${INSTRUCTIONS}`): { task: Task; plan: ReturnType<typeof planTask> } {
  const { task } = compileIntent(KernelSubmission.parse({
    recipe: CODE_CHANGE_RECIPE,
    intent: {
      id: randomUUID(), principal, tenant: { id: tenantId }, source: "test", objective,
      attachments: [], contextRefs: [], receivedAt: CREATED, trace: { traceId: randomUUID(), correlationId: randomUUID() },
    },
  }));
  return { task, plan: planTask(task, CODE_CHANGE_RECIPE) };
}

const runFor = (taskId: string, kind: "code" | "test", over: Record<string, unknown> = {}) => ({
  id: kind === "code" ? 101 : 202,
  workflowPath: `.github/workflows/${kind === "code" ? "kj-code-change.yml" : "kj-test.yml"}`,
  event: "workflow_dispatch",
  headBranch: kind === "code" ? "main" : `kj/${taskId}`,
  headSha: kind === "code" ? BASE : HEAD,
  displayTitle: `kj:${taskId} ${kind}`,
  status: "completed",
  conclusion: "success",
  ...over,
});

function factsFor(taskId: string, files?: ChangeFacts["files"]): ChangeFacts {
  return {
    repo: REPO, defaultBranch: "main", baseSha: BASE, branch: `kj/${taskId}`, headSha: HEAD,
    compareStatus: "ahead", aheadBy: 1, behindBy: 0,
    files: files ?? [{ path: "src/text.js", status: "modified", previousPath: null, additions: 4, deletions: 0, blobSha: "e".repeat(40), patchSha256: sha256Text(PATCH_TEXT) }],
    filesTruncated: false, patchBytes: Buffer.byteLength(PATCH, "utf8"),
    codeRun: runFor(taskId, "code") as ChangeFacts["codeRun"],
    testRun: runFor(taskId, "test") as ChangeFacts["testRun"],
  };
}

interface GithubOpts {
  codeConclusion?: string;
  testConclusion?: string;
  runNeverAppears?: boolean;
  files?: ChangeFacts["files"];
  prError?: string;
}

/** A fake GitHub behind the capability service: runs appear after a poll, progress, then finish. */
function fakeGithub(taskId: string, o: GithubOpts = {}) {
  const calls: Array<{ name: string; req: unknown }> = [];
  const polls: Record<string, number> = { code: 0, test: 0 };
  const github: CodeChangeGithub = {
    base: async (req) => (calls.push({ name: "base", req }), { defaultBranch: "main", baseSha: BASE }),
    dispatch: async (req) => (calls.push({ name: "dispatch", req }), { dispatched: true }),
    dispatchTest: async (req) => (calls.push({ name: "dispatchTest", req }), { dispatched: true }),
    run: async (req) => {
      const n = polls[req.kind]!++;
      if (o.runNeverAppears || n === 0) return null;
      if (n === 1) return runFor(taskId, req.kind, { status: "in_progress", conclusion: null });
      const conclusion = req.kind === "code" ? (o.codeConclusion ?? "success") : (o.testConclusion ?? "success");
      return runFor(taskId, req.kind, { conclusion });
    },
    branchHead: async () => HEAD,
    capture: async (req) => {
      calls.push({ name: "capture", req });
      const facts = factsFor(taskId, o.files);
      return { facts, factsDigest: capabilityDigest(facts), patch: PATCH };
    },
    openPr: async (req) => {
      calls.push({ name: "openPr", req });
      if (o.prError) throw new Error(o.prError);
      return { number: 7, url: `https://github.com/${REPO}/pull/7`, headSha: HEAD };
    },
  };
  return { github, calls };
}

/** Grok-like reviewer: copies the change digest out of the prompt. */
function fakeReviewer(over: { verdict?: string; concerns?: string[]; model?: string; reply?: FakeReply } = {}) {
  return fakeRuntime({
    model: over.model ?? "x-ai/grok-test",
    reply: (prompt) =>
      over.reply ??
      JSON.stringify({
        reviewedChangeDigest: /Change digest \(copy exactly\): ([0-9a-f]{64})/.exec(prompt)?.[1] ?? "",
        verdict: over.verdict ?? "approve",
        scopeMatchesInstructions: true,
        concerns: over.concerns ?? [],
        notes: ["Consider a test for empty input."],
      }),
  });
}

interface Run {
  outcome: Outcome;
  task: Task;
  plan: ReturnType<typeof planTask>;
  steps: Map<string, TaskStep>;
  evidence: Evidence[];
  notices: CodeChangeNotice[];
  calls: Array<{ name: string; req: unknown }>;
  reviewed: number;
  verifyError: Error | null;
}

const verify = (r: Pick<Run, "task" | "plan" | "steps" | "evidence" | "outcome">, config: { allowedRepos: string[] } | null = CONFIG, evidence = r.evidence, outcome = r.outcome) =>
  verifyPlanCompletion({ ...r.task, status: "VERIFYING" }, outcome, r.plan, [...r.steps.values()], evidence.map((record) => ({ record, step: null })), undefined, config ?? undefined);

async function run(o: GithubOpts & { deps?: Partial<CodeChangeDeps>; objective?: string } = {}): Promise<Run> {
  const { task, plan } = newTask(o.objective);
  const steps = new Map<string, TaskStep>();
  const evidence: Evidence[] = [];
  const notices: CodeChangeNotice[] = [];
  let verifyError: Error | null = null;
  let t = 0;
  const now = async () => new Date(Date.parse(CREATED) + 1000 * ++t).toISOString();
  const emit: Emit = async (_key, _type, status, extra = {}) => {
    if (extra.step) steps.set(extra.step.id, extra.step);
    if (extra.evidence) evidence.push(extra.evidence);
    if (status === "COMPLETED" && extra.outcome) {
      try {
        verify({ task, plan, steps, evidence, outcome: extra.outcome });
        return extra.outcome;
      } catch (error) {
        verifyError = error as Error;
        return { ...extra.outcome, status: "FAILED" } as Outcome;
      }
    }
  };
  const ctx = { run: async (_n: string, action: () => unknown) => structuredClone(await action()) } as unknown as Pick<Context, "run">;
  const { github, calls } = fakeGithub(task.id, o);
  let reviewed = 0;
  const reviewer = o.deps?.reviewer ?? fakeReviewer();
  const outcome = await runCodeChangeMission({
    ctx, sleep: async () => {}, task, plan, emit, now, uuid: randomUUID, github,
    reviewer: { generate: (req) => (reviewed++, reviewer.generate(req)) },
    coderModel: "anthropic/claude-sonnet-test", allowedRepos: [REPO],
    notify: async (n) => { notices.push(n); },
    ...o.deps,
  });
  return { outcome, task, plan, steps, evidence, notices, calls, reviewed, verifyError };
}

describe("code-change/v1 admission and plan", () => {
  it("compiles to six steps, the three new ones as tool calls", () => {
    const { plan } = newTask();
    expect(plan.steps.map((s) => s.operation)).toEqual(["GITHUB_EVIDENCE", "CODE_RUN", "CODE_TEST", "RUNTIME_REVIEW", "RECONCILE", "OPEN_DRAFT_PR"]);
  });

  it("refuses a malformed objective at admission", () => {
    for (const bad of [REPO, `${REPO} fix`, `not a slug at all here`]) expect(() => newTask(bad), bad).toThrow();
  });
});

describe("code-change/v1 end to end against an in-memory ledger and the real completion verifier", () => {
  it("opens a draft PR on accepted evidence, completes, and tells Jonny it started and where the PR is", async () => {
    const r = await run();
    expect(r.verifyError).toBeNull();
    expect(r.outcome.status).toBe("COMPLETED");
    expect(r.outcome.summary).toBe(`Draft PR #7 opened for review: https://github.com/${REPO}/pull/7`);
    expect(r.evidence.map((e) => e.source)).toEqual([
      "kerneljson:code-change-base/v1", "kerneljson:code-change-run/v1", "kerneljson:code-change-capture/v1",
      "kerneljson:runtime/reviewer", "kerneljson:code-change-reconcile/v1", "kerneljson:code-change-pr/v1",
    ]);
    expect([...r.steps.values()].map((s) => s.status)).toEqual(Array(6).fill("COMPLETED"));
    expect(r.calls.find((c) => c.name === "dispatch")!.req).toEqual({ repo: REPO, taskId: r.task.id, baseSha: BASE, instructions: INSTRUCTIONS });
    const pr = r.calls.find((c) => c.name === "openPr")!.req as { expectedHeadSha: string; title: string; body: string };
    expect(pr.expectedHeadSha).toBe(HEAD);
    expect(pr.title).toBe(`kj: ${INSTRUCTIONS}`);
    expect(pr.body).toContain("This is a draft: KernelJSON cannot merge or deploy it.");
    expect(pr.body).toContain("Consider a test for empty input.");
    expect(r.notices.map((n) => n.status)).toEqual(["STARTED", "PR_OPENED"]);
    expect(r.notices[1]!.text).toContain(`https://github.com/${REPO}/pull/7`);
    expect(r.notices[1]!.text).toContain("reviewed by x-ai/grok-test");
  });

  const failures: Array<[string, Parameters<typeof run>[0], string, { dispatched?: boolean; reviewed?: boolean; started?: boolean }]> = [
    ["the repository is not allowlisted", { objective: `jonnyallum/kerneljson ${INSTRUCTIONS}` }, "REPOSITORY_NOT_ALLOWLISTED", { dispatched: false, started: false }],
    ["the coding run fails", { codeConclusion: "failure" }, "CODE_RUN_FAILURE", { reviewed: false }],
    ["the coding run never appears", { runNeverAppears: true }, "CODE_RUN_NOT_FOUND", { reviewed: false }],
    ["the tests fail", { testConclusion: "failure" }, "TESTS_FAILURE", { reviewed: false }],
    ["the reviewer rejects", { deps: { reviewer: fakeReviewer({ verdict: "reject" }) } }, "review_verdict_acceptable", {}],
    ["the reviewer raises a blocking concern", { deps: { reviewer: fakeReviewer({ concerns: ["Breaks squash() for tabs."] }) } }, "review_verdict_acceptable", {}],
    ["the reviewer is the coder's family", { deps: { reviewer: fakeReviewer({ model: "anthropic/claude-opus-test" }) } }, "reviewer_is_independent", {}],
    ["the reviewer answers in prose", { deps: { reviewer: fakeReviewer({ reply: "Looks fine to me." }) } }, "review_schema_valid", {}],
    ["the reviewer call fails", { deps: { reviewer: fakeReviewer({ reply: { fail: "RATE_LIMIT" } }) } }, "REVIEWER_RATE_LIMIT", {}],
    ["the change edits CI", { files: [{ path: ".github/workflows/ci.yml", status: "modified", previousPath: null, additions: 1, deletions: 0, blobSha: "e".repeat(40), patchSha256: "a".repeat(64) }] }, "change_avoids_refused_paths", {}],
    ["the branch moved before the PR", { prError: "HEAD_MOVED" }, "PR_HEAD_MOVED", {}],
  ];
  for (const [label, opts, reason, expectations] of failures) {
    it(`ends FAILED with a P2 notice and no merge path when ${label}`, async () => {
      const r = await run(opts);
      expect(r.outcome.status).toBe("FAILED");
      expect(r.outcome.summary).toContain(reason);
      expect(r.verifyError).toBeNull();
      const prOpened = r.calls.some((c) => c.name === "openPr");
      if (!label.includes("before the PR")) expect(prOpened).toBe(false);
      if (expectations.dispatched === false) expect(r.calls.some((c) => c.name === "dispatch")).toBe(false);
      if (expectations.reviewed === false) expect(r.reviewed).toBe(0);
      expect(r.notices.at(-1)).toMatchObject({ status: "FAILED" });
      expect(r.notices.at(-1)!.text).toContain("Nothing was merged or deployed.");
      expect(r.notices.map((n) => n.status)).toEqual(expectations.started === false ? ["FAILED"] : ["STARTED", "FAILED"]);
    });
  }

  it("names the refused category in the failure", async () => {
    const r = await run({ files: [{ path: "package.json", status: "modified", previousPath: null, additions: 1, deletions: 0, blobSha: "e".repeat(40), patchSha256: "a".repeat(64) }] });
    expect(r.outcome.summary).toContain("refused: dependencies");
  });
});

describe("code-change/v1 completion verifier refuses tampered or unconfigured completions", () => {
  const swap = (evidence: Evidence[], source: string, patch: (e: Evidence) => Evidence) => evidence.map((e) => (e.source === source ? patch(e) : e));
  const meta = (e: Evidence, m: Record<string, unknown>) => Evidence.parse({ ...e, metadata: { ...e.metadata, ...m } });

  it("accepts the untouched completion (positive control)", async () => {
    const r = await run();
    expect(() => verify(r)).not.toThrow();
  });

  const tampers: Array<[string, (r: Run) => () => void]> = [
    ["no allowlist configured", (r) => () => verify(r, null)],
    ["the allowlist no longer has the repository", (r) => () => verify(r, { allowedRepos: ["jonnyallum/other"] })],
    ["the diff text was altered", (r) => () => verify(r, CONFIG, swap(r.evidence, "kerneljson:code-change-capture/v1", (e) => meta(e, { patch: PATCH + "+evil\n" })))],
    ["the review text was altered", (r) => () => verify(r, CONFIG, swap(r.evidence, "kerneljson:runtime/reviewer", (e) => meta(e, { text: "{}" })))],
    ["the PR is for another commit", (r) => () => verify(r, CONFIG, swap(r.evidence, "kerneljson:code-change-pr/v1", (e) => {
      const pr = { ...(e.metadata["pr"] as object), headSha: BASE };
      return Evidence.parse({ ...e, digest: capabilityDigest(pr), metadata: { ...e.metadata, pr } });
    }))],
    ["the PR is not a draft", (r) => () => verify(r, CONFIG, swap(r.evidence, "kerneljson:code-change-pr/v1", (e) => meta(e, { draft: false })))],
    ["the base is for other instructions", (r) => () => verify(r, CONFIG, swap(r.evidence, "kerneljson:code-change-base/v1", (e) => {
      const m = { ...e.metadata, instructions_sha256: "f".repeat(64) };
      return Evidence.parse({ ...e, digest: capabilityDigest(m), metadata: m });
    }))],
    ["an evidence row is missing", (r) => () => verify(r, CONFIG, r.evidence.filter((e) => e.source !== "kerneljson:code-change-run/v1"))],
    ["the outcome names another PR", (r) => () => verify(r, CONFIG, r.evidence, { ...r.outcome, summary: "Draft PR #8 opened for review: https://github.com/jonnyallum/kj-pilot/pull/8" })],
  ];
  for (const [label, make] of tampers)
    it(`throws when ${label}`, async () => {
      const r = await run();
      expect(make(r)).toThrow();
    });
});

describe("code-change/v1 notices", () => {
  const AT = "2026-10-22T12:00:00.000Z";
  const taskId = "abcdef12-3456-4789-8abc-def012345678";

  it("forwards only the code-change check-id shapes, as written", () => {
    for (const [status, suffix] of [["STARTED", "started"], ["FAILED", "failed"], ["PR_OPENED", "opened"]] as const) {
      const d = codeChangeNoticeDecision({ taskId, status, at: AT, text: "Draft PR ready: https://github.com/a/b/pull/1" });
      expect(d.checkId).toBe(`MISSION.codeChange.abcdef12.${suffix}`);
      expect(isCodeChangeCheckId(d.checkId)).toBe(true);
      expect(d.severity).toBe(status === "FAILED" ? "P2" : "P3");
    }
    for (const id of ["MISSION.codeChange.abcdef12.merged", "MISSION.codeChange.ABCDEF12.opened", "MISSION.repoAnalysis.abcdef12.completed", "MISSION.codeChange.abcdef12.opened.x"])
      expect(isCodeChangeCheckId(id), id).toBe(false);
    const text = formatTelegramMessage({
      notificationId: randomUUID(), checkId: "MISSION.codeChange.abcdef12.opened", kind: "NEW", severity: "P3", entityId: taskId,
      message: "Draft PR ready", occurrenceCount: 1, durationMs: null, at: AT,
    } as unknown as Parameters<typeof formatTelegramMessage>[0]);
    expect(text).toBe("Draft PR ready");
  });

  it("refuses an empty or oversized notice", () => {
    expect(() => codeChangeNoticeDecision({ taskId, status: "STARTED", at: AT, text: "" })).toThrow();
    expect(() => codeChangeNoticeDecision({ taskId, status: "STARTED", at: AT, text: "x".repeat(1001) })).toThrow();
  });
});

describe("code-change/v1 worker configuration", () => {
  const keys = { MISSION_OPENROUTER_API_KEY: "sk-or-v1-SYNTHETIC", MISSION_DEEPSEEK_API_KEY: "sk-SYNTHETIC" };
  const ok = {
    ...keys,
    KJ_CODE_CHANGE_GITHUB_TOKEN: "github_pat_SYNTHETIC_0000000000000000",
    KJ_CODE_CHANGE_REPOS: `${REPO}`,
    KJ_CODE_CHANGE_CODER_MODEL: "anthropic/claude-sonnet-test",
    KJ_CODE_CHANGE_REVIEWER_MODEL: "deepseek-v4-pro",
  };

  it("is off when unset and loads a complete configuration", () => {
    expect(loadCodeChangeConfig(keys)).toBeUndefined();
    expect(loadCodeChangeConfig({ ...keys, KJ_CODE_CHANGE_REPOS: "" })).toBeUndefined();
    const config = loadCodeChangeConfig(ok)!;
    expect({ ...config, reviewer: undefined }).toEqual({
      token: ok.KJ_CODE_CHANGE_GITHUB_TOKEN, allowedRepos: [REPO], coderModel: "anthropic/claude-sonnet-test",
      reviewerModel: "deepseek-v4-pro", reviewerProvider: "deepseek", reviewer: undefined,
    });
    expect(loadCodeChangeConfig({ ...ok, KJ_CODE_CHANGE_REVIEWER_MODEL: "x-ai/grok-test" })!.reviewerProvider).toBe("openrouter");
  });

  it("serves its own reviewer, independent of the mission reviewer the brief uses", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      seen.push(JSON.parse(String(init?.body)).model);
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const config = loadCodeChangeConfig({ ...ok, MISSION_REVIEWER_MODEL: "anthropic/claude-sonnet-5" }, fetchImpl)!;
    await config.reviewer.generate(modelRequest).catch(() => undefined);
    expect(seen).toEqual(["deepseek-v4-pro"]);
  });

  it.each([
    ["half configured", { ...ok, KJ_CODE_CHANGE_REVIEWER_MODEL: "" }],
    ["a bare coder name", { ...ok, KJ_CODE_CHANGE_CODER_MODEL: "claude-sonnet-test" }],
    ["a coder outside the families", { ...ok, KJ_CODE_CHANGE_CODER_MODEL: "openai/gpt-test" }],
    ["a reviewer of the coder's family", { ...ok, KJ_CODE_CHANGE_REVIEWER_MODEL: "anthropic/claude-opus-test" }],
    ["a reviewer outside the families", { ...ok, KJ_CODE_CHANGE_REVIEWER_MODEL: "openai/gpt-test" }],
    ["a reviewer whose provider key is not set", { ...ok, MISSION_DEEPSEEK_API_KEY: "" }],
    ["too many repositories", { ...ok, KJ_CODE_CHANGE_REPOS: "a/a,b/b,c/c,d/d,e/e,f/f" }],
    ["a malformed repository", { ...ok, KJ_CODE_CHANGE_REPOS: `${REPO},../x` }],
    ["a malformed token", { ...ok, KJ_CODE_CHANGE_GITHUB_TOKEN: "short token" }],
  ])("refuses to start with %s", (_label, env) => {
    expect(() => loadCodeChangeConfig(env)).toThrow();
  });

  it("never echoes the token or a key in its errors", () => {
    for (const env of [{ ...ok, KJ_CODE_CHANGE_REPOS: "../x" }, { ...ok, MISSION_DEEPSEEK_API_KEY: "" }, { ...ok, KJ_CODE_CHANGE_REVIEWER_MODEL: "anthropic/x" }]) {
      let message = "";
      try {
        loadCodeChangeConfig(env);
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toBe("");
      for (const secret of [ok.KJ_CODE_CHANGE_GITHUB_TOKEN, keys.MISSION_DEEPSEEK_API_KEY, keys.MISSION_OPENROUTER_API_KEY]) expect(message).not.toContain(secret);
    }
  });
});
