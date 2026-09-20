import { describe, it, expect } from "vitest";
import {
  MISSION_OUTPUT_SCHEMA,
  MISSION_RECIPE,
  MissionAnalysis,
  MissionReview,
  RECONCILE_CHECKS,
  modelFamily,
  parseMissionObjective,
  sameModel,
  type GithubFacts,
} from "../packages/contracts/src/index.js";
import { capabilityDigest } from "../packages/capabilities/src/index.js";
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
import { REVIEWER_MAX_TOKENS, analystRequest, reviewerRequest } from "../services/kernel/src/mission/prompts.js";
import { enqueueMissionNotice, missionNoticeDecision } from "../services/kernel/src/mission/notify.js";
import { loadMissionConfig } from "../services/kernel/src/mission/config.js";
import { InMemoryNotificationOutboxStore } from "../services/kernel/src/alerting/outbox-store.js";
import { PublicSubmission } from "../apps/gateway/src/server.js";
import { kernelSubmission } from "../evals/fixtures/kernel.js";
import { id, at } from "../evals/fixtures/contracts.js";
import { CITED, HEAD, REPO, analysisJson, cite, makeFacts, reviewJson, shaFor } from "./support/mission-fixture.js";

const submission = (objective: string) => ({
  recipe: MISSION_RECIPE,
  intent: { ...kernelSubmission.intent, objective },
});

describe("KJ-P3 mission objective and admission", () => {
  it("parses owner/repo with and without a question", () => {
    expect(parseMissionObjective(REPO).repo).toBe(REPO);
    expect(parseMissionObjective(REPO).question).toMatch(/architecture/);
    expect(parseMissionObjective(`${REPO}   What are the risks?`)).toMatchObject({ repo: REPO, question: "What are the risks?" });
  });

  it("rejects anything that is not a plain GitHub slug (traversal, urls, flags, empty)", () => {
    for (const bad of ["", "   ", "just-a-name", "../etc/passwd", "a/b/c", "https://github.com/a/b", "a/..", "-a/b", "a b/c", "o/r;rm", "o/r$(id)", "a/b" + "x".repeat(200)]) {
      expect(() => parseMissionObjective(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("treats text after the slug as a question, never as part of the repository name", () => {
    expect(parseMissionObjective("o/r\nrm -rf /")).toMatchObject({ repo: "o/r", question: "rm -rf /" });
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

describe("KJ-P3.1 mission contract in the objective", () => {
  const contractOf = (objective: string) => parseMissionObjective(objective).contract;

  it("defaults to between one and eight findings when nothing is asked for", () => {
    expect(contractOf(REPO)).toEqual({ outputSchema: MISSION_OUTPUT_SCHEMA, requestedFindings: null, minFindings: 1, maxFindings: 8 });
    expect(contractOf(`${REPO} What are the risks?`)).toMatchObject({ requestedFindings: null, minFindings: 1, maxFindings: 8 });
  });

  it("findings=N asks for exactly N, and the directive is not part of the question", () => {
    const p = parseMissionObjective(`${REPO} findings=3 Identify the three highest-value improvements`);
    expect(p.contract).toEqual({ outputSchema: MISSION_OUTPUT_SCHEMA, requestedFindings: 3, minFindings: 3, maxFindings: 3 });
    expect(p.question).toBe("Identify the three highest-value improvements");
    expect(parseMissionObjective(`${REPO} findings=2`).question).toMatch(/architecture/);
  });

  it("max-findings=N sets a ceiling and no exact count", () => {
    expect(contractOf(`${REPO} max-findings=5 risks?`)).toEqual({ outputSchema: MISSION_OUTPUT_SCHEMA, requestedFindings: null, minFindings: 1, maxFindings: 5 });
  });

  it("recognises a directive only straight after the slug, and never reads a number out of the English", () => {
    expect(contractOf(`${REPO} What is wrong? findings=3`)).toMatchObject({ requestedFindings: null, maxFindings: 8 });
    expect(contractOf(`${REPO} Give me the three best improvements`)).toMatchObject({ requestedFindings: null, maxFindings: 8 });
  });

  it("rejects a malformed or contradictory directive at admission instead of leaving it unenforced", () => {
    for (const bad of ["findings=0", "findings=13", "findings=three", "findings=", "findings=-1", "findings=3 findings=4", "max-findings=0", "max-findings=x", "findings=3 max-findings=5", "findings=1.5"]) {
      expect(() => parseMissionObjective(`${REPO} ${bad} q`), bad).toThrow();
      expect(() => compileIntent(submission(`${REPO} ${bad} q`)), bad).toThrow();
    }
    expect(compileIntent(submission(`${REPO} findings=3 why?`)).task.riskClass).toBe("LOW");
  });

  it("leaves the task's acceptance criterion, and so its plan, exactly as it was", () => {
    const { task } = compileIntent(submission(`${REPO} findings=3 why?`));
    expect(task.acceptanceCriteria).toEqual([criteria[MISSION_RECIPE]]);
    expect(() => planTask(task, MISSION_RECIPE)).not.toThrow();
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
    contract: parseMissionObjective(REPO).contract,
    analysisText,
    analystModel: "anthropic/claude-test",
    analystProvider: "openrouter",
    reviewText: reviewJson({ analysisText }),
    reviewerModel: "x-ai/grok-test",
    reviewerProvider: "openrouter",
  };
  const failing = (input: Parameters<typeof reconcileMission>[0]) => failedCheckNames(reconcileMission(input));
  /** The same mission judged with a different analysis, the reviewer approving it. */
  const withAnalysis = (text: string, over: Partial<typeof base> = {}) => ({
    ...base,
    ...over,
    analysisText: text,
    reviewText: reviewJson({ analysisText: text }),
  });

  it("accepts a well-formed, evidence-matching, independently approved analysis", () => {
    const rec = reconcileMission(base);
    expect(rec.decision).toBe("ACCEPTED");
    expect(rec.checks.map((c) => c.name)).toEqual([...RECONCILE_CHECKS]);
    expect(rec.analysisDigest).toBe(sha256Text(analysisText));
  });

  it("rejects an analysis about a different commit", () => {
    const text = analysisJson({ headSha: "f".repeat(40) });
    expect(failing(withAnalysis(text))).toContain("analysis_head_sha_matches_evidence");
  });

  it("rejects a finding that cites a file that is not in the evidence (hallucination), even if the reviewer approves", () => {
    const text = analysisJson({ evidence: [...CITED.map((p) => cite(p)), cite("services/kernel/src/does-not-exist.ts")] });
    const rec = reconcileMission(withAnalysis(text));
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

  it("accepts any allowed runtime family for either role, judged by the model the provider reports it ran", () => {
    expect(failing({ ...base, analystModel: "openai/gpt-test" })).toEqual(["analyst_runtime_allowed"]);
    expect(failing({ ...base, reviewerModel: "mistral/large" })).toEqual(["reviewer_runtime_allowed"]);
    expect(reconcileMission({ ...base, analystModel: "deepseek-v4-flash", reviewerModel: "deepseek-v4-pro" }).decision).toBe("ACCEPTED");
    expect(reconcileMission({ ...base, analystModel: "deepseek/deepseek-v4-flash", reviewerModel: "anthropic/claude-test" }).decision).toBe("ACCEPTED");
    expect(reconcileMission({ ...base, analystModel: "anthropic/claude-test", reviewerModel: "x-ai/grok-test" }).decision).toBe("ACCEPTED");
  });

  it("reads the family from both the provider/slug and the bare model forms", () => {
    expect(modelFamily("anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(modelFamily("x-ai/grok-4.6")).toBe("x-ai");
    expect(modelFamily("deepseek/deepseek-v4-pro")).toBe("deepseek");
    expect(modelFamily("deepseek-v4-flash")).toBe("deepseek");
    expect(modelFamily("/weird")).not.toBe("anthropic");
  });

  it("fails closed on runtime output that is not the required JSON", () => {
    expect(failing({ ...base, analysisText: "Looks great!" })).toEqual(expect.arrayContaining([
      "analysis_schema_valid", "analysis_head_sha_matches_evidence", "analysis_finding_count_within_contract",
      "analysis_findings_cited", "analysis_paths_exist_in_evidence", "analysis_evidence_binds_to_commit", "review_binds_to_analysis",
    ]));
    expect(failing({ ...base, reviewText: '{"verdict":"approve"}' })).toEqual(expect.arrayContaining(["review_schema_valid", "review_verdict_acceptable"]));
    expect(failing({ ...base, analysisText: `${analysisText} trailing junk` })).toContain("analysis_schema_valid");
    // Unparseable output must not leave a grounding digest behind.
    expect(reconcileMission({ ...base, analysisText: "Looks great!" }).findingEvidenceDigests).toEqual([]);
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

  describe("KJ-P3.1 the requested count is enforced by the kernel, not by prompt wording", () => {
    const three = parseMissionObjective(`${REPO} findings=3 Identify the three highest-value improvements`).contract;

    it("asks for 3 and receives 8: REJECTED on the count alone, even though the reviewer approved", () => {
      const rec = reconcileMission(withAnalysis(analysisJson({ findings: 8 }), { contract: three }));
      expect(rec.decision).toBe("REJECTED");
      expect(failedCheckNames(rec)).toEqual(["analysis_finding_count_within_contract"]);
      expect(rec.findingCount).toBe(8);
      expect(rec.contract).toMatchObject({ requestedFindings: 3, minFindings: 3, maxFindings: 3 });
    });

    it("asks for 3 and receives exactly 3: eligible, with one grounding digest per finding", () => {
      const rec = reconcileMission(withAnalysis(analysisJson({ findings: 3 }), { contract: three }));
      expect(rec.decision).toBe("ACCEPTED");
      expect(rec.findingCount).toBe(3);
      expect(rec.findingEvidenceDigests).toHaveLength(3);
    });

    it("an exact count also rejects too few", () => {
      expect(failing(withAnalysis(analysisJson({ findings: 2 }), { contract: three }))).toEqual(["analysis_finding_count_within_contract"]);
      expect(failing(withAnalysis(analysisJson({ findings: 4 }), { contract: three }))).toEqual(["analysis_finding_count_within_contract"]);
    });

    it("a ceiling accepts fewer findings but never more", () => {
      const five = parseMissionObjective(`${REPO} max-findings=5`).contract;
      expect(reconcileMission(withAnalysis(analysisJson({ findings: 2 }), { contract: five })).decision).toBe("ACCEPTED");
      expect(reconcileMission(withAnalysis(analysisJson({ findings: 5 }), { contract: five })).decision).toBe("ACCEPTED");
      expect(failing(withAnalysis(analysisJson({ findings: 6 }), { contract: five }))).toEqual(["analysis_finding_count_within_contract"]);
    });

    it("applies the default ceiling of 8 when nothing was asked for", () => {
      expect(reconcileMission(withAnalysis(analysisJson({ findings: 8 }))).decision).toBe("ACCEPTED");
      expect(failing(withAnalysis(analysisJson({ findings: 9 })))).toEqual(["analysis_finding_count_within_contract"]);
    });

    it("beyond the schema's hard cap the analysis is not even valid", () => {
      expect(failing(withAnalysis(analysisJson({ findings: 13 })))).toContain("analysis_schema_valid");
    });

    it("rejects a finding with a required field missing", () => {
      const parsed = JSON.parse(analysisText) as { findings: Array<Record<string, unknown>> };
      for (const field of ["title", "detail", "evidence"]) {
        const broken = structuredClone(parsed);
        delete broken.findings[0]![field];
        expect(failing(withAnalysis(JSON.stringify(broken))), field).toContain("analysis_schema_valid");
      }
      // The pre-KJ-P3.1 output shape (bare paths, no object ids) is no longer accepted.
      const legacy = structuredClone(parsed);
      delete legacy.findings[0]!["evidence"];
      legacy.findings[0]!["paths"] = CITED;
      expect(failing(withAnalysis(JSON.stringify(legacy)))).toContain("analysis_schema_valid");
    });

    it("cannot be relaxed by the analysis: the contract is an input, never read from runtime output", () => {
      const sneaky = JSON.stringify({ ...JSON.parse(analysisJson({ findings: 8 })), contract: { maxFindings: 12 } });
      expect(failing(withAnalysis(sneaky, { contract: three }))).toContain("analysis_schema_valid");
    });
  });

  describe("KJ-P3.1 claim grounding: each finding is bound to this exact repository evidence", () => {
    const evidenceDigest = (paths: string[], salt = "") =>
      capabilityDigest({
        headSha: HEAD,
        evidence: [...paths].sort().map((path) => ({ path, sha: shaFor(path, salt) })),
      });

    it("accepts a valid grounded finding, and issues a digest over the head, each path and its full object id", () => {
      const rec = reconcileMission(base);
      expect(rec.decision).toBe("ACCEPTED");
      expect(rec.findingEvidenceDigests).toEqual([evidenceDigest(CITED)]);
    });

    it("accepts the full 40 character object id as well as the 12 character prefix the prompt shows", () => {
      const full = CITED.map((path) => ({ path, blobSha: shaFor(path) }));
      expect(reconcileMission(withAnalysis(analysisJson({ evidence: full }))).decision).toBe("ACCEPTED");
      expect(MissionAnalysis.safeParse(JSON.parse(analysisJson({ evidence: [{ path: "README.md", blobSha: shaFor("README.md").slice(0, 11) }] }))).success).toBe(false);
    });

    it("rejects an uncited finding, by name", () => {
      const rec = reconcileMission(withAnalysis(analysisJson({ evidence: [] })));
      expect(failedCheckNames(rec)).toEqual(["analysis_findings_cited"]);
      expect(rec.findingEvidenceDigests).toEqual([]);
    });

    it("rejects a finding where the path exists but the evidence digest does not bind", () => {
      const rec = reconcileMission(withAnalysis(analysisJson({ evidence: [{ path: "README.md", blobSha: "0".repeat(12) }] })));
      expect(rec.decision).toBe("REJECTED");
      // The path is in the tree, so the existence check passes: only the binding fails.
      expect(failedCheckNames(rec)).toEqual(["analysis_evidence_binds_to_commit"]);
      expect(rec.findingEvidenceDigests).toEqual([]);
    });

    it("rejects evidence taken from another commit, even when every path still exists", () => {
      const otherCommit = CITED.map((p) => cite(p, "another-commit"));
      expect(failing(withAnalysis(analysisJson({ evidence: otherCommit })))).toEqual(["analysis_evidence_binds_to_commit"]);
    });

    it("rejects evidence when the analysis claims a different head sha", () => {
      const names = failing(withAnalysis(analysisJson({ headSha: "f".repeat(40) })));
      expect(names).toEqual(expect.arrayContaining(["analysis_head_sha_matches_evidence", "analysis_evidence_binds_to_commit"]));
    });

    it("binds a directory by its tree id as well as a file by its blob id", () => {
      expect(reconcileMission(withAnalysis(analysisJson({ paths: ["services/kernel"] }))).decision).toBe("ACCEPTED");
      expect(failing(withAnalysis(analysisJson({ evidence: [{ path: "services/kernel", blobSha: shaFor("README.md").slice(0, 12) }] })))).toEqual(["analysis_evidence_binds_to_commit"]);
    });

    it("one bad citation among good ones is enough to reject the whole analysis", () => {
      const mixed = [cite("README.md"), { path: "ARCHITECTURE.md", blobSha: "f".repeat(12) }];
      expect(failing(withAnalysis(analysisJson({ evidence: mixed })))).toEqual(["analysis_evidence_binds_to_commit"]);
    });

    it("changes the digest when the cited file changes at the same path, so it is bound to content and not to the name", () => {
      const changed = makeFacts({ tree: makeFacts().tree.map((e) => (e.path === "README.md" ? { ...e, sha: shaFor("README.md", "edited") } : e)) });
      const text = analysisJson({ evidence: [cite("README.md", "edited")] });
      const rec = reconcileMission(withAnalysis(text, { facts: changed }));
      expect(rec.decision).toBe("ACCEPTED");
      expect(rec.findingEvidenceDigests).toEqual([evidenceDigest(["README.md"], "edited")]);
      expect(rec.findingEvidenceDigests[0]).not.toBe(evidenceDigest(["README.md"]));
      // ...and the original citation no longer binds to the edited tree.
      expect(failing(withAnalysis(analysisJson({ evidence: [cite("README.md")] }), { facts: changed }))).toEqual(["analysis_evidence_binds_to_commit"]);
    });
  });

  describe("KJ-P3.1 analyst and reviewer independence", () => {
    it("rejects a reviewer that is the same model as the analyst (it would be marking its own work)", () => {
      expect(failing({ ...base, analystModel: "deepseek-v4-pro", reviewerModel: "deepseek-v4-pro" })).toEqual(["reviewer_is_independent"]);
      expect(failing({ ...base, analystModel: "anthropic/claude-test", reviewerModel: "anthropic/claude-test" })).toEqual(["reviewer_is_independent"]);
    });

    it("rejects the same model reached by two routes, judged on the slug and not the route", () => {
      expect(failing({ ...base, analystModel: "deepseek-v4-pro", analystProvider: "deepseek", reviewerModel: "deepseek/deepseek-v4-pro", reviewerProvider: "openrouter" })).toEqual(["reviewer_is_independent"]);
      expect(sameModel("deepseek-v4-pro", "DeepSeek/deepseek-v4-pro")).toBe(true);
      expect(sameModel("deepseek-v4-flash", "deepseek/deepseek-v4-pro")).toBe(false);
    });

    it("accepts a cross-provider, cross-family pair and records both providers as the receipts reported them", () => {
      const rec = reconcileMission({
        ...base,
        analystModel: "deepseek-v4-flash", analystProvider: "deepseek",
        reviewerModel: "anthropic/claude-sonnet-5", reviewerProvider: "openrouter",
      });
      expect(rec.decision).toBe("ACCEPTED");
      expect(rec.independence).toEqual({
        analystProvider: "deepseek", reviewerProvider: "openrouter",
        analystFamily: "deepseek", reviewerFamily: "anthropic",
        crossProvider: true, crossFamily: true,
      });
    });

    it("keeps the same-provider, same-family fallback, and says plainly that it is the weaker configuration", () => {
      const rec = reconcileMission({
        ...base,
        analystModel: "deepseek-flash", analystProvider: "deepseek",
        reviewerModel: "deepseek-v4-pro", reviewerProvider: "deepseek",
      });
      expect(rec.decision).toBe("ACCEPTED");
      expect(rec.independence).toMatchObject({ crossProvider: false, crossFamily: false });
    });

    it("does not mistake a different route to the same lineage for cross-family independence", () => {
      const rec = reconcileMission({
        ...base,
        analystModel: "deepseek-v4-flash", analystProvider: "deepseek",
        reviewerModel: "deepseek/deepseek-v4-pro", reviewerProvider: "openrouter",
      });
      expect(rec.decision).toBe("ACCEPTED");
      expect(rec.independence).toMatchObject({ crossProvider: true, crossFamily: false });
    });
  });
});

describe("KJ-P3 prompts (the runtime contract)", () => {
  const facts: GithubFacts = makeFacts();
  const contract = parseMissionObjective(REPO).contract;
  const common = { callId: id, taskId: id, stepId: id, trace: { traceId: id, correlationId: id }, facts, factsDigest: "c".repeat(64) };

  it("gives the analyst the head sha, the tree with object ids, the readme and the question, and no tools", () => {
    const req = analystRequest({ ...common, question: "What are the risks?", contract });
    const text = req.messages.map((m) => m.content).join("\n");
    expect(text).toContain(`head sha: ${HEAD}`);
    expect(text).toContain(`f ${shaFor("services/kernel/src/ledger.ts").slice(0, 12)} services/kernel/src/ledger.ts`);
    expect(text).toContain(`d ${shaFor("services/kernel").slice(0, 12)} services/kernel`);
    expect(text).toContain("KernelJSON is a durable cognitive execution platform.");
    expect(text).toContain("What are the risks?");
    expect(req.maxOutputTokens).toBeLessThanOrEqual(8192);
  });

  it("states the hard output limits, inside the schema's own bounds, so a runtime cannot overshoot by accident", () => {
    const system = analystRequest({ ...common, question: "q", contract }).messages[0]!.content;
    expect(system).toContain("between 1 and 8 findings");
    expect(system).toContain("summary at most 1500 characters");
    expect(system).toContain("rejected outright");
    // The prompt's limits must never exceed what the schema accepts.
    expect(MissionAnalysis.safeParse({
      headSha: HEAD,
      summary: "s".repeat(1500),
      findings: Array.from({ length: 8 }, () => ({ title: "t".repeat(100), detail: "d".repeat(500), evidence: Array.from({ length: 8 }, () => cite("README.md")) })),
    }).success).toBe(true);
  });

  it("KJ-P3.1 tells the analyst the exact count it will be held to, for every count the objective can ask for", () => {
    const exact = parseMissionObjective(`${REPO} findings=3 q`).contract;
    expect(analystRequest({ ...common, question: "q", contract: exact }).messages[0]!.content).toContain("EXACTLY 3 findings");
    const ceiling = parseMissionObjective(`${REPO} max-findings=5 q`).contract;
    expect(analystRequest({ ...common, question: "q", contract: ceiling }).messages[0]!.content).toContain("between 1 and 5 findings");
    for (let n = 1; n <= 12; n += 1) {
      const c = parseMissionObjective(`${REPO} findings=${n} q`).contract;
      expect(analystRequest({ ...common, question: "q", contract: c }).messages[0]!.content).toContain(`EXACTLY ${n} findings`);
      expect(MissionAnalysis.safeParse(JSON.parse(analysisJson({ findings: n }))).success).toBe(true);
    }
  });

  it("KJ-P3.1 tells the analyst how to cite, in the same shape the schema demands", () => {
    const system = analystRequest({ ...common, question: "q", contract }).messages[0]!.content;
    expect(system).toContain('"evidence": [{"path"');
    expect(system).toContain("git object id prefix");
  });

  it("KJ-P3.1.1 gives the reviewer real headroom: 4096 output tokens, inside the ModelRequest ceiling", () => {
    const analysisText = analysisJson();
    const req = reviewerRequest({ ...common, analysisText, analysisDigest: sha256Text(analysisText) });
    expect(REVIEWER_MAX_TOKENS).toBe(4096);
    expect(req.maxOutputTokens).toBe(REVIEWER_MAX_TOKENS);
    // The first live Telegram-originated mission failed on a 2048-token cap that a Claude review exceeded.
    expect(REVIEWER_MAX_TOKENS).toBeGreaterThan(2048);
  });

  it("KJ-P3.1.1 asks the reviewer for concise structured output, and states the limits it is held to", () => {
    const analysisText = analysisJson();
    const system = reviewerRequest({ ...common, analysisText, analysisDigest: sha256Text(analysisText) }).messages[0]!.content;
    for (const phrase of ["Be concise", "no text before or after it", "indexes only", "at most 3 notes", "under 160 characters", "Do not restate the findings"]) {
      expect(system, phrase).toContain(phrase);
    }
    // The contract it must still honour is unchanged.
    expect(system).toContain("copied exactly");
    expect(system).toContain("ONE JSON object");
  });

  it("KJ-P3.1.1 the largest review the prompt permits is valid under the schema and small next to the budget", () => {
    const largest = {
      reviewedAnalysisSha256: "a".repeat(64),
      verdict: "approve_with_notes",
      unsupportedFindings: Array.from({ length: 12 }, (_, i) => i),
      notes: Array.from({ length: 3 }, () => "n".repeat(159)),
    };
    expect(MissionReview.safeParse(largest).success).toBe(true);
    // Even at one token per character (far worse than real text) the permitted maximum stays under a third
    // of the budget: the ceiling is headroom against a model that ignores the prompt, not the thing that keeps
    // the review short. (The regression to the old 2048 cap is pinned by the headroom test above.)
    expect(JSON.stringify(largest).length * 3).toBeLessThan(REVIEWER_MAX_TOKENS);
  });

  it("gives the reviewer the verbatim analysis and the digest to echo", () => {
    const analysisText = analysisJson();
    const req = reviewerRequest({ ...common, analysisText, analysisDigest: sha256Text(analysisText) });
    const text = req.messages.map((m) => m.content).join("\n");
    expect(text).toContain(`Analysis digest (copy exactly): ${sha256Text(analysisText)}`);
    expect(text).toContain(analysisText);
  });

  it("flags a truncated tree so the runtime knows what it cannot cite", () => {
    const req = analystRequest({ ...common, facts: makeFacts({ treeTruncated: true }), question: "q", contract });
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
  const OR_KEY = "sk-or-v1-" + "a".repeat(64);
  const DS_KEY = "sk-" + "a".repeat(32);
  const openrouter = {
    MISSION_OPENROUTER_API_KEY: OR_KEY,
    MISSION_ANALYST_MODEL: "anthropic/claude-test",
    MISSION_REVIEWER_MODEL: "x-ai/grok-test",
  };
  const deepseek = {
    MISSION_DEEPSEEK_API_KEY: DS_KEY,
    MISSION_ANALYST_MODEL: "deepseek-v4-flash",
    MISSION_REVIEWER_MODEL: "deepseek-v4-pro",
  };
  /** KJ-P3.1: DeepSeek analyst direct, Claude reviewer through OpenRouter. */
  const cross = {
    MISSION_DEEPSEEK_API_KEY: DS_KEY,
    MISSION_OPENROUTER_API_KEY: OR_KEY,
    MISSION_ANALYST_MODEL: "deepseek-v4-flash",
    MISSION_REVIEWER_MODEL: "anthropic/claude-sonnet-5",
  };
  const messageOf = (env: Record<string, string>): string => {
    try { loadMissionConfig(env); } catch (e) { return (e as Error).message; }
    return "";
  };

  it("serves no mission when nothing is set, exactly as the worker did before", () => {
    expect(loadMissionConfig({})).toBeUndefined();
    expect(loadMissionConfig({ MISSION_OPENROUTER_API_KEY: "", MISSION_DEEPSEEK_API_KEY: "", MISSION_ANALYST_MODEL: "", MISSION_REVIEWER_MODEL: "" })).toBeUndefined();
  });

  it("refuses to start half-configured, without ever printing a key", () => {
    for (const set of [openrouter, deepseek]) {
      for (const drop of Object.keys(set)) {
        const partial = { ...set } as Record<string, string>;
        delete partial[drop];
        const message = messageOf(partial);
        expect(message, drop).toMatch(/all be set or all left unset/);
        expect(message).not.toMatch(/sk-or-v1|sk-a{8}/);
      }
    }
  });

  it("builds a DeepSeek pair from bare deepseek-... models, both roles on DeepSeek", () => {
    const c = loadMissionConfig(deepseek)!;
    expect(c).toMatchObject({ analystProvider: "deepseek", reviewerProvider: "deepseek", analystModel: "deepseek-v4-flash", reviewerModel: "deepseek-v4-pro" });
    expect(typeof c.analyst.generate).toBe("function");
  });

  it("builds an OpenRouter pair from provider/slug models, including a Claude and Grok pairing", () => {
    expect(loadMissionConfig(openrouter)).toMatchObject({ analystProvider: "openrouter", reviewerProvider: "openrouter", analystModel: "anthropic/claude-test", reviewerModel: "x-ai/grok-test" });
    expect(loadMissionConfig({ ...openrouter, MISSION_ANALYST_MODEL: "deepseek/deepseek-v4-flash" })).toMatchObject({ analystProvider: "openrouter" });
  });

  it("KJ-P3.1 builds a cross-provider pair: DeepSeek analyst direct, Claude or Grok reviewer through OpenRouter", () => {
    const c = loadMissionConfig(cross)!;
    expect(c).toMatchObject({ analystProvider: "deepseek", reviewerProvider: "openrouter", analystModel: "deepseek-v4-flash", reviewerModel: "anthropic/claude-sonnet-5" });
    expect(loadMissionConfig({ ...cross, MISSION_REVIEWER_MODEL: "x-ai/grok-4.6" })).toMatchObject({ reviewerProvider: "openrouter", reviewerModel: "x-ai/grok-4.6" });
    // The other way round is also representable: an OpenRouter analyst with a DeepSeek reviewer.
    expect(loadMissionConfig({ ...cross, MISSION_ANALYST_MODEL: "anthropic/claude-sonnet-5", MISSION_REVIEWER_MODEL: "deepseek-v4-pro" })).toMatchObject({ analystProvider: "openrouter", reviewerProvider: "deepseek" });
  });

  it("KJ-P3.1 refuses a cross-provider configuration that is missing the key one role needs, without printing a key", () => {
    const noOpenrouter = { ...cross } as Record<string, string>;
    delete noOpenrouter["MISSION_OPENROUTER_API_KEY"];
    expect(messageOf(noOpenrouter)).toMatch(/MISSION_OPENROUTER_API_KEY must be set/);
    const noDeepseek = { ...cross } as Record<string, string>;
    delete noDeepseek["MISSION_DEEPSEEK_API_KEY"];
    expect(messageOf(noDeepseek)).toMatch(/MISSION_DEEPSEEK_API_KEY must be set/);
    for (const m of [messageOf(noOpenrouter), messageOf(noDeepseek)]) expect(m).not.toMatch(/sk-or-v1|sk-a{8}/);
    for (const drop of ["MISSION_ANALYST_MODEL", "MISSION_REVIEWER_MODEL"]) {
      const partial = { ...cross } as Record<string, string>;
      delete partial[drop];
      expect(messageOf(partial), drop).toMatch(/all be set or all left unset/);
    }
  });

  it("KJ-P3.1 refuses a provider key that no configured model uses, rather than holding a credential it never exercises", () => {
    expect(messageOf({ ...openrouter, MISSION_DEEPSEEK_API_KEY: DS_KEY })).toMatch(/MISSION_DEEPSEEK_API_KEY is set but no mission model uses/);
    expect(messageOf({ ...deepseek, MISSION_OPENROUTER_API_KEY: OR_KEY })).toMatch(/MISSION_OPENROUTER_API_KEY is set but no mission model uses/);
    expect(messageOf({ ...openrouter, MISSION_DEEPSEEK_API_KEY: DS_KEY })).not.toMatch(/sk-or-v1|sk-a{8}/);
  });

  it("requires the two models to differ, so the reviewer is never the analyst, even through two routes", () => {
    expect(() => loadMissionConfig({ ...deepseek, MISSION_REVIEWER_MODEL: "deepseek-v4-flash" })).toThrow(/must differ/);
    expect(() => loadMissionConfig({ ...openrouter, MISSION_REVIEWER_MODEL: "anthropic/claude-test" })).toThrow(/must differ/);
    expect(() => loadMissionConfig({ ...cross, MISSION_REVIEWER_MODEL: "deepseek/deepseek-v4-flash" })).toThrow(/must differ/);
  });

  it("rejects an unknown family, and a bare model name that is not DeepSeek", () => {
    expect(() => loadMissionConfig({ ...deepseek, MISSION_ANALYST_MODEL: "gpt-5" })).toThrow(/must be a model from one of/);
    expect(() => loadMissionConfig({ ...openrouter, MISSION_ANALYST_MODEL: "openai/gpt-x" })).toThrow(/must be a model from one of/);
    expect(() => loadMissionConfig({ ...cross, MISSION_REVIEWER_MODEL: "claude-sonnet-5" })).toThrow(/must be a model from one of/);
    // A provider/slug model needs the OpenRouter key, so on a DeepSeek-only deployment it is refused by name.
    expect(() => loadMissionConfig({ ...deepseek, MISSION_ANALYST_MODEL: "anthropic/claude-test" })).toThrow(/MISSION_OPENROUTER_API_KEY must be set/);
  });
});
