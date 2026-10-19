import {
  BRIEF_RECIPE,
  BriefFacts,
  BriefReconciliation,
  Evidence,
  GithubActivity,
  TaskStep,
  assertCompletion,
  type ExecutionPlan,
  type Outcome,
  type Task,
} from "../../../../packages/contracts/src/index.js";
import { capabilityDigest } from "../../../../packages/capabilities/src/index.js";
import { orderedSteps, projectStep } from "../planner/index.js";
import { BRIEF_SOURCES, briefStepOutputs, briefSummary, parseBrief, reconcileBrief } from "./brief.js";
import { sha256Text } from "./reconcile.js";

/**
 * The ledger's completion backstop for the morning brief, the counterpart of verifyMissionCompletion.
 * It trusts nothing the workflow computed: it re-hashes the persisted facts and runtime text, re-runs
 * the citation reconciliation from them and requires the persisted result, the steps and the outcome
 * to agree. Any mismatch throws, and the ledger turns that into a terminal FAILED outcome.
 */
interface Stored {
  step: unknown;
  record: unknown;
}

const fail = (why: string): never => {
  throw new Error(`Brief completion rejected: ${why}`);
};

/** The memory ids recorded on the analyst's own evidence, the only memory a brief may cite. */
export function briefMemoryIds(analystEvidence: Evidence): string[] {
  const ctx = analystEvidence.metadata["memory_context"] as { memories?: Array<{ memory_id?: unknown }> } | undefined;
  return (ctx?.memories ?? []).map((m) => m.memory_id).filter((id): id is string => typeof id === "string");
}

export function verifyBriefCompletion(
  task: Task,
  outcome: Outcome,
  plan: ExecutionPlan,
  steps: readonly TaskStep[],
  records: readonly Stored[],
): void {
  if (plan.recipe !== BRIEF_RECIPE) fail("wrong recipe");
  const nodes = orderedSteps(plan);
  if (nodes.length !== 4) fail("unexpected plan shape");
  const [gather, analyst, reviewer, reconcile] = nodes as [(typeof nodes)[0], (typeof nodes)[0], (typeof nodes)[0], (typeof nodes)[0]];

  const evidence = records.map((r) => Evidence.parse(r.record));
  const one = (stepId: string, type: Evidence["type"], source: string): Evidence => {
    const found = evidence.filter((e) => e.stepId === stepId && e.type === type && e.source === source);
    if (found.length !== 1) return fail(`expected exactly one ${source} evidence`);
    return found[0]!;
  };
  const e1 = one(gather.id, "TOOL_RECEIPT", BRIEF_SOURCES.facts);
  const e2 = one(analyst.id, "ARTIFACT", BRIEF_SOURCES.analyst);
  const e3 = one(reviewer.id, "ARTIFACT", BRIEF_SOURCES.reviewer);
  const e4 = one(reconcile.id, "DETERMINISTIC_RESULT", BRIEF_SOURCES.reconcile);

  const facts = BriefFacts.parse(e1.metadata["facts"]);
  const factsDigest = capabilityDigest(facts);
  if (e1.digest !== factsDigest || e1.metadata["content_sha256"] !== factsDigest) fail("facts digest mismatch");
  if (capabilityDigest(GithubActivity.parse(facts.github)) !== facts.githubDigest) fail("github activity digest mismatch");

  const text = (e: Evidence): string => {
    const t = e.metadata["text"];
    if (typeof t !== "string" || sha256Text(t) !== e.digest) return fail("runtime text does not match its digest");
    return t;
  };
  const analysisText = text(e2);
  const reviewText = text(e3);
  if (e2.metadata["role"] !== "analyst" || e2.metadata["subject_digest"] !== factsDigest)
    fail("analyst evidence is not bound to the facts");
  if (e3.metadata["role"] !== "reviewer" || e3.metadata["subject_digest"] !== e2.digest)
    fail("reviewer evidence is not bound to the brief");
  const str = (e: Evidence, key: string): string => {
    const v = e.metadata[key];
    return typeof v === "string" && v.length > 0 ? v : fail(`missing ${key}`);
  };

  const recomputed = reconcileBrief({
    facts,
    memoryIds: briefMemoryIds(e2),
    analysisText,
    analystModel: str(e2, "response_model"),
    analystProvider: str(e2, "provider"),
    reviewText,
    reviewerModel: str(e3, "response_model"),
    reviewerProvider: str(e3, "provider"),
  });
  const persisted = BriefReconciliation.parse(e4.metadata);
  if (capabilityDigest(persisted) !== capabilityDigest(recomputed) || e4.digest !== capabilityDigest(recomputed))
    fail("persisted reconciliation does not match the recomputed one");
  if (recomputed.decision !== "ACCEPTED") fail("reconciliation did not accept the brief");

  const expected = [
    [gather, briefStepOutputs.facts(factsDigest)],
    [analyst, briefStepOutputs.runtime(e2.digest as string)],
    [reviewer, briefStepOutputs.runtime(e3.digest as string)],
    [reconcile, briefStepOutputs.reconcile(recomputed)],
  ] as const;
  for (const [node, output] of expected) {
    const stored = steps.find((s) => s.id === node.id);
    if (!stored || stored.status !== "COMPLETED" || stored.kind !== projectStep(node).kind)
      fail("a planned step is missing or not completed");
    if (capabilityDigest(stored!.output ?? null) !== capabilityDigest(output)) fail("step output does not match evidence");
  }

  const brief = parseBrief(analysisText);
  if (!brief || outcome.summary !== briefSummary(brief)) fail("outcome summary is not the verified one");
  const ids = [e1, e2, e3, e4].map((e) => e.id).sort();
  if (JSON.stringify([...outcome.evidenceRefs].sort()) !== JSON.stringify(ids)) fail("outcome evidence set mismatch");
  assertCompletion(task, outcome, [e1, e2, e3, e4]);
}
