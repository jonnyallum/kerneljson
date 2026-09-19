import {
  Evidence,
  GithubFacts,
  MISSION_RECIPE,
  MissionReconciliation,
  TaskStep,
  assertCompletion,
  parseMissionObjective,
  type ExecutionPlan,
  type Outcome,
  type Task,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { orderedSteps, projectStep } from "../planner/index.js";
import { SOURCES, stepOutputs } from "./evidence.js";
import { missionSummary, parseAnalysis, reconcileMission, sha256Text } from "./reconcile.js";

/**
 * KJ-P3 - the load-bearing backstop for mission completion, called by the ledger inside
 * the transaction that commits COMPLETED. It trusts nothing the workflow computed: it
 * re-parses the persisted GitHub facts, re-hashes the persisted runtime text, re-runs the
 * reconciliation and requires the persisted result, the steps and the outcome to agree.
 * Any mismatch throws, and the ledger turns that into a terminal FAILED outcome.
 */
interface Stored {
  step: unknown;
  record: unknown;
}

const md = (e: Evidence): Record<string, unknown> => e.metadata;
const fail = (why: string): never => {
  throw new Error(`Mission completion rejected: ${why}`);
};

export function verifyMissionCompletion(
  task: Task,
  outcome: Outcome,
  plan: ExecutionPlan,
  steps: readonly TaskStep[],
  records: readonly Stored[],
): void {
  if (plan.recipe !== MISSION_RECIPE) fail("wrong recipe");
  const nodes = orderedSteps(plan);
  if (nodes.length !== 4) fail("unexpected plan shape");
  const [github, analyst, reviewer, reconcile] = nodes as [
    (typeof nodes)[number],
    (typeof nodes)[number],
    (typeof nodes)[number],
    (typeof nodes)[number],
  ];

  const evidence = records.map((r) => Evidence.parse(r.record));
  const one = (stepId: string, type: Evidence["type"], source: string): Evidence => {
    const found = evidence.filter((e) => e.stepId === stepId && e.type === type && e.source === source);
    if (found.length !== 1) return fail(`expected exactly one ${source} evidence`);
    return found[0]!;
  };
  const e1 = one(github.id, "TOOL_RECEIPT", SOURCES.github);
  const e2 = one(analyst.id, "ARTIFACT", SOURCES.analyst);
  const e3 = one(reviewer.id, "ARTIFACT", SOURCES.reviewer);
  const e4 = one(reconcile.id, "DETERMINISTIC_RESULT", SOURCES.reconcile);

  // GitHub evidence: the persisted facts must hash to the recorded digest and describe
  // the repository this task was admitted for, not some other one.
  const facts = GithubFacts.parse(md(e1)["facts"]);
  const factsDigest = capabilityDigest(facts);
  if (e1.digest !== factsDigest || md(e1)["content_sha256"] !== factsDigest) fail("github digest mismatch");
  if (md(e1)["head_sha"] !== facts.headSha) fail("github head sha mismatch");
  if (facts.repo.toLowerCase() !== parseMissionObjective(task.objective).repo.toLowerCase())
    fail("evidence is for a different repository");

  // Runtime evidence: the text must hash to the recorded digest, and be bound to its input.
  const text = (e: Evidence): string => {
    const t = md(e)["text"];
    if (typeof t !== "string" || sha256Text(t) !== e.digest) return fail("runtime text does not match its digest");
    return t;
  };
  const analysisText = text(e2);
  const reviewText = text(e3);
  if (md(e2)["role"] !== "analyst" || md(e2)["subject_digest"] !== factsDigest)
    fail("analyst evidence is not bound to the github evidence");
  if (md(e3)["role"] !== "reviewer" || md(e3)["subject_digest"] !== e2.digest)
    fail("reviewer evidence is not bound to the analysis");
  const model = (e: Evidence): string => {
    const m = md(e)["response_model"];
    return typeof m === "string" ? m : fail("missing response model");
  };

  // Independently recompute the reconciliation and require the persisted one to match.
  const recomputed = reconcileMission({
    facts,
    analysisText,
    analystModel: model(e2),
    reviewText,
    reviewerModel: model(e3),
  });
  const persisted = MissionReconciliation.parse(e4.metadata);
  if (capabilityDigest(persisted) !== capabilityDigest(recomputed) || e4.digest !== capabilityDigest(recomputed))
    fail("persisted reconciliation does not match the recomputed one");
  if (recomputed.decision !== "ACCEPTED") fail("reconciliation did not accept the mission");

  // Steps: each one completed, of the planned kind, with the output the evidence implies.
  const expected = [
    [github, stepOutputs.github(facts, factsDigest)],
    [analyst, stepOutputs.runtime(e2.digest as string)],
    [reviewer, stepOutputs.runtime(e3.digest as string)],
    [reconcile, stepOutputs.reconcile(recomputed)],
  ] as const;
  for (const [node, output] of expected) {
    const stored = steps.find((s) => s.id === node.id);
    if (!stored || stored.status !== "COMPLETED" || stored.kind !== projectStep(node).kind)
      fail("a planned step is missing or not completed");
    if (capabilityDigest(stored!.output ?? null) !== capabilityDigest(output)) fail("step output does not match evidence");
  }

  // Outcome: the summary is the deterministic one, and it cites exactly the four evidence rows.
  const analysis = parseAnalysis(analysisText);
  if (!analysis || outcome.summary !== missionSummary(analysis)) fail("outcome summary is not the verified one");
  const ids = [e1, e2, e3, e4].map((e) => e.id).sort();
  if (JSON.stringify([...outcome.evidenceRefs].sort()) !== JSON.stringify(ids)) fail("outcome evidence set mismatch");
  assertCompletion(task, outcome, [e1, e2, e3, e4]);
}
