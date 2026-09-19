import { describe, it, expect } from "vitest";
import {
  MISSION_RECIPE,
  RECONCILE_CHECKS,
  parseMissionObjective,
  type GithubFacts,
} from "../packages/contracts/src/index.js";
import { compileIntent, criteria } from "../services/kernel/src/compiler/index.js";
import { planTask, orderedSteps, projectStep } from "../services/kernel/src/planner/index.js";
import { digest } from "../services/kernel/src/deterministic.js";
import {
  failedCheckNames,
  missionSummary,
  parseAnalysis,
  parseRuntimeJson,
  reconcileMission,
  sha256Text,
} from "../services/kernel/src/mission/reconcile.js";
import { analystRequest, reviewerRequest } from "../services/kernel/src/mission/prompts.js";
import { enqueueMissionNotice, missionNoticeDecision } from "../services/kernel/src/mission/notify.js";
import { loadMissionConfig } from "../services/kernel/src/mission/config.js";
import { InMemoryNotificationOutboxStore } from "../services/kernel/src/alerting/outbox-store.js";
import { PublicSubmission } from "../apps/gateway/src/server.js";
import { kernelSubmission } from "../evals/fixtures/kernel.js";
import { id, at } from "../evals/fixtures/contracts.js";
import { CITED, HEAD, REPO, analysisJson, makeFacts, reviewJson } from "./support/mission-fixture.js";

const submission = (objective: string) => ({
  recipe: MISSION_RECIPE,
  intent: { ...kernelSubmission.intent, objective },
});

describe("KJ-P3 mission objective and admission", () => {
  it("parses owner/repo with and without a question", () => {
    expect(parseMissionObjective(REPO).repo).toBe(REPO);
    expect(parseMissionObjective(REPO).question).toMatch(/architecture/);
    expect(parseMissionObjective(`${REPO}   What are the risks?`)).toEqual({ repo: REPO, question: "What are the risks?" });
  });

  it("rejects anything that is not a plain GitHub slug (traversal, urls, flags, empty)", () => {
    for (const bad of ["", "   ", "just-a-name", "../etc/passwd", "a/b/c", "https://github.com/a/b", "a/..", "-a/b", "a b/c", "o/r;rm", "o/r$(id)", "a/b" + "x".repeat(200)]) {
      expect(() => parseMissionObjective(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("treats text after the slug as a question, never as part of the repository name", () => {
    expect(parseMissionObjective("o/r\nrm -rf /")).toEqual({ repo: "o/r", question: "rm -rf /" });
  });

  it("is rejected at compile time (admission), not mid-run, when the objective is invalid", () => {
    expect(() => compileIntent(submission("not a slug"))).toThrow();
    const { task } = compileIntent(submission(`${REPO} why?`));
    expect(task.acceptanceCriteria).toEqual([criteria[MISSION_RECIPE]]);
    expect(task.riskClass).toBe("LOW");
  });

  it("is admissible through the public gateway schema, and only by its exact id", () => {
    expect(PublicSubmission.safeParse({ recipe: MISSION_RECIPE, objective: REPO }).success).toBe(true);
    expect(PublicSubmission.safeParse({ recipe: "repo-analysis-mission/v2", objective: REPO }).success).toBe(false);
  });
});

describe("KJ-P3 plan", () => {
  const { task } = compileIntent(submission(REPO));
  const plan = planTask(task, MISSION_RECIPE);

  it("is four linear steps in the fixed order, each depending on the previous", () => {
    const ordered = orderedSteps(plan);
    expect(ordered.map((s) => s.operation)).toEqual(["GITHUB_EVIDENCE", "RUNTIME_ANALYSE", "RUNTIME_REVIEW", "RECONCILE"]);
    ordered.slice(1).forEach((s, i) => expect(s.dependencies).toEqual([ordered[i]!.id]));
    expect(plan.resultStepId).toBe(ordered[3]!.id);
  });

  it("projects evidence to a tool call, two LLM calls and a deterministic reconcile", () => {
    expect(orderedSteps(plan).map((s) => projectStep(s).kind)).toEqual(["TOOL_CALL", "LLM_CALL", "LLM_CALL", "DETERMINISTIC_FUNCTION"]);
    expect(projectStep(orderedSteps(plan)[0]!).requiredCapabilities).toHaveLength(1);
  });

  it("is deterministic, and a task that does not match the recipe cannot be planned", () => {
    expect(digest(planTask(task, MISSION_RECIPE))).toBe(digest(plan));
    expect(() => planTask({ ...task, riskClass: "HIGH" }, MISSION_RECIPE)).toThrow();
    expect(() => planTask({ ...task, acceptanceCriteria: ["Output equals uppercase(trim(objective))"] }, MISSION_RECIPE)).toThrow();
  });

  it("leaves every existing recipe's plan exactly as it was", () => {
    const base = compileIntent(kernelSubmission).task;
    expect(orderedSteps(planTask(base, "uppercase-reverse/v1")).map((s) => s.operation)).toEqual(["UPPERCASE", "WAIT_FOR_EVENT", "REVERSE"]);
    expect(id).toBeTruthy();
    expect(at).toBeTruthy();
  });
});

describe("KJ-P3 reconciliation (the kernel's judgement, from evidence alone)", () => {
  const facts = makeFacts();
  const analysisText = analysisJson();
  const base = {
    facts,
    analysisText,
    analystModel: "anthropic/claude-test",
    reviewText: reviewJson({ analysisText }),
    reviewerModel: "x-ai/grok-test",
  };
  const failing = (input: Parameters<typeof reconcileMission>[0]) => failedCheckNames(reconcileMission(input));

  it("accepts a well-formed, evidence-matching, independently approved analysis", () => {
    const rec = reconcileMission(base);
    expect(rec.decision).toBe("ACCEPTED");
    expect(rec.checks.map((c) => c.name)).toEqual([...RECONCILE_CHECKS]);
    expect(rec.analysisDigest).toBe(sha256Text(analysisText));
  });

  it("rejects an analysis about a different commit", () => {
    const text = analysisJson({ headSha: "f".repeat(40) });
    expect(failing({ ...base, analysisText: text, reviewText: reviewJson({ analysisText: text }) })).toContain("analysis_head_sha_matches_evidence");
  });

  it("rejects a finding that cites a file that is not in the evidence (hallucination), even if the reviewer approves", () => {
    const text = analysisJson({ paths: [...CITED, "services/kernel/src/does-not-exist.ts"] });
    const rec = reconcileMission({ ...base, analysisText: text, reviewText: reviewJson({ analysisText: text }) });
    expect(rec.decision).toBe("REJECTED");
    expect(failedCheckNames(rec)).toEqual(["analysis_paths_exist_in_evidence"]);
  });

  it("rejects a review that is not bound to this exact analysis (wrong digest echoed)", () => {
    expect(failing({ ...base, reviewText: reviewJson({ analysisText, echoDigest: "0".repeat(64) }) })).toEqual(["review_binds_to_analysis"]);
  });

  it("rejects when the reviewer says reject, or flags unsupported findings", () => {
    expect(failing({ ...base, reviewText: reviewJson({ analysisText, verdict: "reject" }) })).toContain("review_verdict_acceptable");
    expect(failing({ ...base, reviewText: reviewJson({ analysisText, unsupported: [0] }) })).toContain("review_flags_no_unsupported_findings");
  });

  it("accepts approve_with_notes but not with unsupported findings", () => {
    expect(reconcileMission({ ...base, reviewText: reviewJson({ analysisText, verdict: "approve_with_notes" }) }).decision).toBe("ACCEPTED");
  });

  it("enforces who played which role, by the model the provider reports it ran", () => {
    expect(failing({ ...base, analystModel: "openai/gpt-test" })).toEqual(["analyst_is_claude_family"]);
    expect(failing({ ...base, reviewerModel: "anthropic/claude-test" })).toEqual(["reviewer_is_grok_family"]);
    expect(failing({ ...base, analystModel: "anthropic/claude-test", reviewerModel: "anthropic/claude-other" })).toEqual(["reviewer_is_grok_family"]);
  });

  it("fails closed on runtime output that is not the required JSON", () => {
    expect(failing({ ...base, analysisText: "Looks great!" })).toEqual(expect.arrayContaining(["analysis_schema_valid", "analysis_head_sha_matches_evidence", "analysis_paths_exist_in_evidence", "review_binds_to_analysis"]));
    expect(failing({ ...base, reviewText: '{"verdict":"approve"}' })).toEqual(expect.arrayContaining(["review_schema_valid", "review_verdict_acceptable"]));
    expect(failing({ ...base, analysisText: `${analysisText} trailing junk` })).toContain("analysis_schema_valid");
  });

  it("rejects extra keys, empty findings and out-of-range indexes in runtime output", () => {
    expect(parseAnalysis(JSON.stringify({ ...JSON.parse(analysisText), extra: 1 }))).toBeNull();
    expect(parseAnalysis(JSON.stringify({ ...JSON.parse(analysisText), findings: [] }))).toBeNull();
  });

  it("accepts exactly one fenced json block and nothing looser", () => {
    expect(parseRuntimeJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(() => parseRuntimeJson("Here you go:\n```json\n{\"a\":1}\n```")).toThrow();
  });

  it("produces a deterministic summary the ledger can require", () => {
    expect(missionSummary(parseAnalysis(analysisText)!)).toMatch(/^Accepted: KernelJSON is a durable task kernel/);
  });

  it("cannot produce an inconsistent reconciliation", () => {
    const rec = reconcileMission(base);
    expect(rec.checks.every((c) => c.passed)).toBe(true);
  });
});

describe("KJ-P3 prompts (the runtime contract)", () => {
  const facts: GithubFacts = makeFacts();
  const common = { callId: id, taskId: id, stepId: id, trace: { traceId: id, correlationId: id }, facts, factsDigest: "c".repeat(64) };

  it("gives the analyst the head sha, the tree, the readme and the question, and no tools", () => {
    const req = analystRequest({ ...common, question: "What are the risks?" });
    const text = req.messages.map((m) => m.content).join("\n");
    expect(text).toContain(`head sha: ${HEAD}`);
    expect(text).toContain("f services/kernel/src/ledger.ts");
    expect(text).toContain("KernelJSON is a durable cognitive execution platform.");
    expect(text).toContain("What are the risks?");
    expect(req.maxOutputTokens).toBeLessThanOrEqual(8192);
  });

  it("gives the reviewer the verbatim analysis and the digest to echo", () => {
    const analysisText = analysisJson();
    const req = reviewerRequest({ ...common, analysisText, analysisDigest: sha256Text(analysisText) });
    const text = req.messages.map((m) => m.content).join("\n");
    expect(text).toContain(`Analysis digest (copy exactly): ${sha256Text(analysisText)}`);
    expect(text).toContain(analysisText);
  });

  it("flags a truncated tree so the runtime knows what it cannot cite", () => {
    const req = analystRequest({ ...common, facts: makeFacts({ treeTruncated: true }), question: "q" });
    expect(req.messages.map((m) => m.content).join("\n")).toContain("TRUNCATED");
  });
});

describe("KJ-P3 completion notice", () => {
  const notice = { taskId: "842f3f95-cef9-8dfd-ae96-96a8c11382c7", status: "COMPLETED" as const, at: "2026-09-19T15:00:00.000Z" };

  it("is a P3 for a completion and a P2 for a failure, carrying the task id in the check id", () => {
    const ok = missionNoticeDecision(notice);
    expect(ok).toMatchObject({ kind: "NEW", severity: "P3", checkId: "MISSION.repoAnalysis.842f3f95.completed", notify: true });
    expect(missionNoticeDecision({ ...notice, status: "FAILED" })).toMatchObject({ severity: "P2", checkId: "MISSION.repoAnalysis.842f3f95.failed" });
  });

  it("queues exactly one intent, and a replay queues nothing more", async () => {
    const outbox = new InMemoryNotificationOutboxStore();
    const a = await enqueueMissionNotice(outbox, notice);
    const b = await enqueueMissionNotice(outbox, notice);
    expect(a.notificationId).toBe(b.notificationId);
    expect(await outbox.getAll()).toHaveLength(1);
  });
});

describe("KJ-P3 mission runtime configuration (fail closed)", () => {
  const full = {
    MISSION_OPENROUTER_API_KEY: "sk-or-v1-" + "a".repeat(64),
    MISSION_ANALYST_MODEL: "anthropic/claude-test",
    MISSION_REVIEWER_MODEL: "x-ai/grok-test",
  };

  it("serves no mission when nothing is set, exactly as the worker did before", () => {
    expect(loadMissionConfig({})).toBeUndefined();
    expect(loadMissionConfig({ MISSION_OPENROUTER_API_KEY: "", MISSION_ANALYST_MODEL: "", MISSION_REVIEWER_MODEL: "" })).toBeUndefined();
  });

  it("refuses to start half-configured, without ever printing the key", () => {
    for (const drop of Object.keys(full)) {
      const partial = { ...full } as Record<string, string>;
      delete partial[drop];
      let message = "";
      try { loadMissionConfig(partial); } catch (e) { message = (e as Error).message; }
      expect(message, drop).toMatch(/all be set or all left unset/);
      expect(message).not.toContain("sk-or-v1");
    }
  });

  it("requires the recipe's families: Claude analyses, Grok reviews", () => {
    expect(() => loadMissionConfig({ ...full, MISSION_ANALYST_MODEL: "x-ai/grok-test" })).toThrow(/anthropic/);
    expect(() => loadMissionConfig({ ...full, MISSION_REVIEWER_MODEL: "anthropic/claude-test" })).toThrow(/x-ai/);
  });

  it("builds two ports when fully configured", () => {
    const c = loadMissionConfig(full)!;
    expect(c.analystModel).toBe("anthropic/claude-test");
    expect(c.reviewerModel).toBe("x-ai/grok-test");
    expect(typeof c.analyst.generate).toBe("function");
  });
});
