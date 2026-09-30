import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * KJ-P7B-1 OFF-mode golden fixtures (ADR-0022 section 5): deterministic analyst/reviewer inputs, and a function that
 * renders them with a given source tree. `capture` renders with the UNMODIFIED production release tree (4127361,
 * extracted with `git archive`) and is what produced tests/fixtures/p7b-off-golden.json; the test renders the same
 * inputs with the new assembler and requires byte equality - of the request object AND of each provider's HTTP body.
 * No dummy credential here is real: they only satisfy the adapters' own shape checks and never leave the process.
 */
export const GOLDEN_IDS = {
  tenant: "11111111-1111-4111-8111-111111111111",
  task: "22222222-2222-4222-8222-222222222222",
  analystStep: "33333333-3333-4333-8333-333333333333",
  reviewerStep: "44444444-4444-4444-8444-444444444444",
  analystCall: "55555555-5555-4555-8555-555555555555",
  reviewerCall: "66666666-6666-4666-8666-666666666666",
  trace: "77777777-7777-4777-8777-777777777777",
};
const DUMMY_OPENROUTER = `sk-or-v1-${"0".repeat(64)}`;
const DUMMY_DEEPSEEK = `sk-${"0".repeat(32)}`;

export interface GoldenCase {
  name: string;
  question: string;
  findings: number | null;
  memory: string;
  faculty: boolean;
}
export const GOLDEN_CASES: GoldenCase[] = [
  { name: "no-faculty-no-memory", question: "What are the biggest risks?", findings: null, memory: "", faculty: false },
  { name: "faculty-no-memory", question: "What are the biggest risks?", findings: null, memory: "", faculty: true },
  { name: "faculty-with-memory", question: "Where is the evidence weakest?", findings: null,
    memory: "OPERATOR MEMORY (canonical KernelJSON memory)\n- [PREFERENCE] I prefer terse reports — café \u{1F600}", faculty: true },
  { name: "faculty-exact-findings", question: "Identify the three highest-value improvements", findings: 3, memory: "", faculty: true },
];

export interface GoldenRender {
  analystRequest: string;
  reviewerRequest: string;
  analystBodies: { deepseek: string; openrouter: string };
}

type Loaded = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function loadTree(root: string): Promise<Loaded> {
  const at = (p: string) => import(pathToFileURL(resolve(root, p)).href);
  return {
    prompts: await at("services/kernel/src/mission/prompts.ts"),
    policy: await at("services/kernel/src/faculty/policy.ts"),
    templates: await at("services/kernel/src/faculty/templates.ts"),
    capabilities: await at("packages/capabilities/src/index.ts"),
    fixture: await at("tests/support/mission-fixture.ts"),
    deepseek: await at("packages/models/src/deepseek.ts"),
    openrouter: await at("packages/models/src/openrouter.ts"),
  };
}

export function goldenPins(t: Loaded) {
  const faculties = t.templates.coreTeamTemplates(GOLDEN_IDS.tenant, "test:golden") as Array<Record<string, unknown>>;
  const pin = (id: string, stepId: string, operation: string, reason: string, provider: string, model: string) => {
    const faculty = faculties.find((f) => f["id"] === id)!;
    return { tenantId: GOLDEN_IDS.tenant, taskId: GOLDEN_IDS.task, stepId, operation, faculty,
      facultyDigest: t.capabilities.capabilityDigest(faculty), routingReason: reason, provider, model, policyVersion: faculty["policyVersion"] };
  };
  return {
    analyst: pin("intelligence", GOLDEN_IDS.analystStep, "RUNTIME_ANALYSE", "repo-analysis/analyst", "deepseek", "deepseek-v4-flash"),
    reviewer: pin("verifier", GOLDEN_IDS.reviewerStep, "RUNTIME_REVIEW", "repo-analysis/independent-reviewer", "openrouter", "x-ai/grok-test"),
  };
}

export function goldenAnalystInput(t: Loaded, c: GoldenCase) {
  const facts = t.fixture.makeFacts();
  return {
    callId: GOLDEN_IDS.analystCall, taskId: GOLDEN_IDS.task, stepId: GOLDEN_IDS.analystStep,
    trace: { traceId: GOLDEN_IDS.trace, correlationId: GOLDEN_IDS.task },
    facts, factsDigest: t.capabilities.capabilityDigest(facts), question: c.question,
    contract: c.findings === null
      ? { outputSchema: "repo-analysis-findings/v2", requestedFindings: null, minFindings: 1, maxFindings: 8 }
      : { outputSchema: "repo-analysis-findings/v2", requestedFindings: c.findings, minFindings: c.findings, maxFindings: c.findings },
    memory: c.memory,
  };
}

/** The exact HTTP body each provider adapter would send for this request. The fake fetch records it and refuses. */
export async function providerBodies(t: Loaded, request: unknown): Promise<{ deepseek: string; openrouter: string }> {
  const capture = async (make: (fetch: typeof globalThis.fetch) => { generate: (r: unknown) => Promise<unknown> }) => {
    let body = "";
    const fetch = (async (_url: unknown, init: { body: string }) => { body = init.body; throw new Error("golden capture: no network"); }) as unknown as typeof globalThis.fetch;
    await make(fetch).generate(request);
    return body;
  };
  return {
    deepseek: await capture((fetch) => t.deepseek.createDeepSeekPort({ apiKey: DUMMY_DEEPSEEK, model: "deepseek-v4-flash", fetch })),
    openrouter: await capture((fetch) => t.openrouter.createOpenRouterPort({ apiKey: DUMMY_OPENROUTER, model: "anthropic/claude-test", fetch })),
  };
}

/** The pre-P7B composition, exactly as run.ts at 4127361 did it. */
export async function renderOld(t: Loaded, c: GoldenCase): Promise<GoldenRender> {
  const pins = goldenPins(t);
  const base = t.prompts.analystRequest(goldenAnalystInput(t, c));
  const analyst = c.faculty ? t.policy.projectFacultyRequest(pins.analyst, base) : base;
  const facts = t.fixture.makeFacts();
  const review = t.prompts.reviewerRequest({
    callId: GOLDEN_IDS.reviewerCall, taskId: GOLDEN_IDS.task, stepId: GOLDEN_IDS.reviewerStep,
    trace: { traceId: GOLDEN_IDS.trace, correlationId: GOLDEN_IDS.task }, facts, factsDigest: t.capabilities.capabilityDigest(facts),
    analysisText: '{"headSha":"x","summary":"s","findings":[]}', analysisDigest: "a".repeat(64),
  });
  const reviewer = c.faculty ? t.policy.projectFacultyRequest(pins.reviewer, review) : review;
  return { analystRequest: JSON.stringify(analyst), reviewerRequest: JSON.stringify(reviewer), analystBodies: await providerBodies(t, analyst) };
}

/** `npx tsx tests/support/p7b-off-golden.ts <tree root>` prints the fixture for that tree. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: p7b-off-golden.ts <source tree root>");
  const t = await loadTree(root);
  const cases: Record<string, GoldenRender> = {};
  for (const c of GOLDEN_CASES) cases[c.name] = await renderOld(t, c);
  process.stdout.write(JSON.stringify({ capturedFrom: process.argv[3] ?? root, cases }, null, 2) + "\n");
}
