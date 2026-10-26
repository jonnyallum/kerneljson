/**
 * Shadow evaluation outside the production decision path: Jev (via OpenRouter's Decisions API, so each text IS sent
 * to OpenRouter) vs the deterministic `classifyRemember` keyword rules, on unlabelled `/remember` texts with gold
 * classes from a JSONL set. Gold labels are only as good as whoever assigned them; record that in the set's `source`.
 * Nothing here touches production; it reads a JSONL set and writes a local report.
 *
 *   node --import tsx scripts/jev-remember-eval.ts --key-file <path> --data <set.jsonl> --out <report.json>
 *     [--model typesafe/jev-1.14] [--threshold 0.85] [--concurrency 4] [--timeout-ms 15000]
 *   node --import tsx scripts/jev-remember-eval.ts --selftest
 *
 * The API key is read from --key-file and only ever placed in the Authorization header. It is never logged, and no
 * error recorded here includes it, the request headers or any provider-written text: errors are fixed strings plus at
 * most an HTTP status and an identifier-shaped code.
 * Exit code is non-zero unless every item was answered with a valid class and confidence.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { classifyRemember } from "../services/memory/src/canonical/classify.js";

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const OPENROUTER_KEY_LENGTH = 73;
const BOMS = [String.fromCharCode(0xfeff), String.fromCharCode(0xef, 0xbb, 0xbf)];

/** RELATIONSHIP is deliberately absent: production only accepts it from an explicit label, so Jev may never pick it. */
const CRITERIA = {
  FACT: { what: "Something stated to be true about the world, a person or the business, including an external deadline that is simply stated.", not_for: "Choices, plans, how the operator likes things done, a dated event, or how a project or system is configured." },
  PREFERENCE: { what: "How the operator likes things done: style, format, timing, tone, channel.", not_for: "A one-off choice between options (DECISION)." },
  DECISION: { what: "A choice that has been made or a standing rule the operator has set.", not_for: "A taste or style the operator likes (PREFERENCE)." },
  COMMITMENT: { what: "An action someone has undertaken or been assigned: they will do it, owe it or promised it.", not_for: "A general rule (DECISION), or a deadline that is stated without anyone taking on the action (FACT)." },
  LESSON: { what: "Something learned from an outcome or mistake, a rule of thumb drawn from experience.", not_for: "The bare account of what happened (EPISODE)." },
  EPISODE: { what: "A record of a specific thing that happened at a particular time.", not_for: "The takeaway learned from it (LESSON)." },
  PROJECT_KNOWLEDGE: { what: "How a specific project, system or codebase works: architecture, behaviour, configuration, access rules.", not_for: "General facts unrelated to a project or system (FACT)." },
} as const;
type Gold = keyof typeof CRITERIA;
const CLASSES = Object.keys(CRITERIA) as Gold[];

interface Item { id: string; source: string; gold: Gold; text: string }
interface Row {
  id: string; source: string; gold: Gold;
  baseline: string; baselineCorrect: boolean;
  jev?: Gold; confidence?: number; jevCorrect?: boolean;
  /** Full classification latency: request sent to response read and validated. */
  latencyMs?: number;
  /** Undefined when the provider returned no usage cost; never silently zero. */
  costUsd?: number;
  responseId?: string; respondedModel?: string; provider?: string;
  error?: string;
}
type Fetch = typeof fetch;
interface Options { model: string; threshold: number; concurrency: number; timeoutMs: number }

class AuthError extends Error {}
class ProviderError extends Error {}
/** A 200 response whose answer failed validation. It may still have been billed, so its cost travels with it. */
class RejectedAnswer extends Error {
  constructor(message: string, readonly costUsd: number | undefined) { super(message); }
}

/** Only short identifier-shaped values from the provider may reach a log or report. */
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,40}$/;
const safe = (v: unknown): string | undefined => (typeof v === "string" || typeof v === "number") && SAFE_TOKEN.test(String(v)) ? String(v) : undefined;

function parseCost(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Every recorded error is one of a fixed set of strings plus at most a status and safe code; nothing provider-written. */
function describe(err: unknown, timeoutMs: number): string {
  if (err instanceof AuthError || err instanceof RejectedAnswer || err instanceof ProviderError) return err.message;
  if (err instanceof Error && err.name === "TimeoutError") return `timeout after ${timeoutMs} ms`;
  const cause = err instanceof Error ? safe((err.cause as { code?: unknown } | undefined)?.code) : undefined;
  return `transport error${cause ? ` (${cause})` : ""}`;
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

function parseItems(raw: string): Item[] {
  return raw.split(/\r?\n/).filter((l) => l.trim().length > 0).map((l, n) => {
    const item = JSON.parse(l) as Item;
    if (!CLASSES.includes(item.gold)) throw new Error(`line ${n + 1}: gold ${item.gold} is not an allowed class`);
    if (classifyRemember(item.text).explicit) throw new Error(`line ${n + 1}: ${item.id} is explicitly labelled; the eval covers unlabelled text only`);
    return item;
  });
}

/** Reads and shape-checks the key without ever printing it. Strips a UTF-8 BOM in either form. */
function loadKey(path: string): () => string {
  let key = readFileSync(path, "utf8");
  for (const bom of BOMS) if (key.startsWith(bom)) key = key.slice(bom.length);
  key = key.trim();
  if (key.length !== OPENROUTER_KEY_LENGTH || !key.startsWith("sk-or-v1-")) throw new Error(`key file has the wrong shape (length ${key.length})`);
  return () => key;
}

async function askJev(fetchImpl: Fetch, key: () => string, opts: Options, text: string): Promise<Required<Pick<Row, "jev" | "confidence" | "latencyMs">> & Pick<Row, "costUsd" | "responseId" | "respondedModel" | "provider">> {
  const started = performance.now();
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(opts.timeoutMs),
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      state: { remember_text: text },
      questions: {
        memory_class: {
          type: "choice",
          instructions: "The operator sent this text with /remember. Which kind of memory is it?",
          criteria: CRITERIA,
        },
      },
    }),
  });
  if (!res.ok) {
    let code: string | undefined;
    try { code = safe(((await res.json()) as { error?: { code?: unknown } }).error?.code); } catch { /* body not JSON */ }
    const message = `HTTP ${res.status}${code ? ` (code ${code})` : ""}`;
    throw res.status === 401 || res.status === 403 ? new AuthError(message) : new ProviderError(message);
  }
  let body: {
    id?: unknown; model?: unknown; provider?: unknown;
    answers?: { memory_class?: { choice?: unknown; confidence?: unknown } }; usage?: { cost?: unknown };
  };
  try { body = (await res.json()) as typeof body; } catch { throw new RejectedAnswer("malformed response body", undefined); }
  if (body === null || typeof body !== "object") throw new RejectedAnswer("malformed response body", undefined);
  const costUsd = parseCost(body.usage?.cost);
  const answer = body.answers?.memory_class;
  if (typeof answer?.choice !== "string" || !CLASSES.includes(answer.choice as Gold)) throw new RejectedAnswer("invalid choice", costUsd);
  const confidence = answer.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new RejectedAnswer("invalid confidence", costUsd);
  return {
    jev: answer.choice as Gold,
    confidence,
    costUsd,
    responseId: safe(body.id), respondedModel: typeof body.model === "string" && /^[A-Za-z0-9_.:/~-]{1,80}$/.test(body.model) ? body.model : undefined, provider: safe(body.provider),
    latencyMs: Math.round(performance.now() - started),
  };
}

function rate(rows: Row[], ok: (r: Row) => boolean | undefined): string {
  const hits = rows.filter((r) => ok(r) === true).length;
  return rows.length === 0 ? "n/a" : `${hits}/${rows.length} (${Math.round((100 * hits) / rows.length)}%)`;
}

async function run(items: Item[], fetchImpl: Fetch, key: () => string, opts: Options) {
  const rows: Row[] = items.map((it) => {
    const baseline = classifyRemember(it.text).class;
    return { id: it.id, source: it.source, gold: it.gold, baseline, baselineCorrect: baseline === it.gold };
  });

  let next = 0;
  let halted: string | undefined;
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    while (halted === undefined && next < items.length) {
      const i = next++;
      const item = items[i] as Item;
      const row = rows[i] as Row;
      try {
        const a = await askJev(fetchImpl, key, opts, item.text);
        Object.assign(row, a, { jevCorrect: a.jev === item.gold });
      } catch (err) {
        row.error = describe(err, opts.timeoutMs);
        if (err instanceof RejectedAnswer) row.costUsd = err.costUsd;
        if (err instanceof AuthError) halted = row.error;
      }
    }
  }));

  const attempted = rows.filter((r) => r.jev !== undefined || r.error !== undefined);
  const answered = rows.filter((r) => r.jev !== undefined);
  const confident = answered.filter((r) => (r.confidence as number) >= opts.threshold);
  const unsure = answered.filter((r) => (r.confidence as number) < opts.threshold);
  const latencies = answered.map((r) => r.latencyMs as number).sort((a, b) => a - b);
  const complete = answered.length === rows.length;
  // Every attempted request may have been billed, answered or not; an attempt without a known cost makes the total a floor.
  const costs = attempted.map((r) => r.costUsd);
  const summary = {
    model: opts.model, threshold: opts.threshold,
    items: rows.length, attempted: attempted.length, answered: answered.length, failed: attempted.length - answered.length,
    notAttempted: rows.length - attempted.length, halted: halted ?? null, complete,
    baseline: rate(rows, (r) => r.baselineCorrect),
    jev: complete ? rate(answered, (r) => r.jevCorrect) : `incomplete: ${rate(answered, (r) => r.jevCorrect)} of answered only`,
    jevConfident: rate(confident, (r) => r.jevCorrect),
    coverageAtThreshold: rate(answered, (r) => (r.confidence as number) >= opts.threshold),
    jevUnsure: rate(unsure, (r) => r.jevCorrect),
    baselineOnJevUnsure: rate(unsure, (r) => r.baselineCorrect),
    jevConfidentElseBaseline: rate(answered, (r) => ((r.confidence as number) >= opts.threshold ? r.jevCorrect : r.baselineCorrect)),
    bySource: Object.fromEntries([...new Set(rows.map((r) => r.source))].map((s) => {
      const sub = rows.filter((r) => r.source === s);
      return [s, { baseline: rate(sub, (r) => r.baselineCorrect), jev: rate(sub.filter((r) => r.jev !== undefined), (r) => r.jevCorrect) }];
    })),
    latencyMs: latencies.length === 0 ? null : {
      p50: latencies[Math.floor(latencies.length / 2)],
      p95: latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)],
      max: latencies[latencies.length - 1],
      note: `full request-to-validated-answer time at concurrency ${opts.concurrency}`,
    },
    totalCostUsd: Number(costs.reduce<number>((s, c) => s + (c ?? 0), 0).toFixed(9)),
    costComplete: costs.every((c) => c !== undefined),
  };
  return { summary, rows };
}

async function main(): Promise<void> {
  const dataPath = arg("data");
  const raw = readFileSync(dataPath, "utf8");
  const items = parseItems(raw);
  const key = loadKey(arg("key-file"));
  const out = arg("out");
  const opts: Options = {
    model: arg("model", "typesafe/jev-1.14"),
    threshold: Number(arg("threshold", "0.85")),
    concurrency: Number(arg("concurrency", "4")),
    timeoutMs: Number(arg("timeout-ms", "15000")),
  };

  const { summary, rows } = await run(items, fetch, key, opts);
  const provenance = {
    dataPath, dataSha256: createHash("sha256").update(raw).digest("hex"),
    scriptSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
    finishedAt: new Date().toISOString(),
    note: "each row carries the provider's response id, model and provider as returned",
  };
  writeFileSync(out, JSON.stringify({ provenance, summary, rows }, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  for (const r of rows) {
    if (r.error !== undefined) console.log(`${r.id}  ERROR ${r.error}`);
    else if (r.jev !== undefined && (!r.jevCorrect || !r.baselineCorrect))
      console.log(`${r.id}  gold=${r.gold}  baseline=${r.baseline}${r.baselineCorrect ? "" : "x"}  jev=${r.jev}${r.jevCorrect ? "" : "x"} @${(r.confidence as number).toFixed(2)}`);
  }
  // exitCode, not exit(): exiting while fetch's sockets close trips a libuv assertion on Windows.
  if (!summary.complete) process.exitCode = 2;
}

/** Feeds the runner deliberately broken responses through a fake fetch; no key, no network. Each case must fail as stated. */
async function selftest(): Promise<void> {
  // Fail unless the end is reached: an emptied event loop would otherwise exit 0 part-way through.
  process.exitCode = 1;
  const items = parseItems([
    { id: "a", source: "t", gold: "PREFERENCE", text: "Keep it short" },
    { id: "b", source: "t", gold: "EPISODE", text: "The van failed its MOT yesterday" },
    { id: "c", source: "t", gold: "FACT", text: "My accountant is in Leeds" },
  ].map((x) => JSON.stringify(x)).join("\n"));
  const key = () => "sk-or-v1-selftest";
  const opts: Options = { model: "test", threshold: 0.85, concurrency: 1, timeoutMs: 1000 };
  const reply = (status: number, body: unknown): Fetch => async () => new Response(JSON.stringify(body), { status });
  const answer = (choice: unknown, confidence?: unknown, cost?: unknown) =>
    reply(200, { id: "gen-1", model: "m", provider: "p", answers: { memory_class: { choice, confidence } }, ...(cost === undefined ? {} : { usage: { cost } }) });
  let calls = 0;
  const counting = (f: Fetch): Fetch => async (...a) => { calls++; return f(...a); };

  const failures: string[] = [];
  const expect = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures.push(name); };

  calls = 0;
  let r = await run(items, counting(reply(401, { error: { message: "User not found.", code: 401 } })), key, opts);
  expect("401 halts after the first request", calls === 1 && r.summary.halted !== null && r.summary.notAttempted === 2);
  expect("401 run is incomplete", !r.summary.complete);
  expect("error keeps status and code, not the provider message", r.rows[0]?.error === "HTTP 401 (code 401)");

  r = await run(items, reply(500, { error: { message: "secret-looking body", code: "x" } }), key, opts);
  expect("500 does not halt but the run is incomplete", r.summary.attempted === 3 && !r.summary.complete);

  r = await run(items, answer("RELATIONSHIP", 0.9, 0.0001), key, opts);
  expect("RELATIONSHIP choice is rejected", r.summary.answered === 0);
  r = await run(items, answer("nonsense", 0.9, 0.0001), key, opts);
  expect("unknown choice is rejected", r.summary.answered === 0);
  r = await run(items, answer("FACT", 2, 0.0001), key, opts);
  expect("confidence above 1 is rejected", r.summary.answered === 0);
  r = await run(items, answer("FACT", undefined, 0.0001), key, opts);
  expect("missing confidence is rejected", r.summary.answered === 0);
  r = await run(items, answer("FACT", Number.NaN, 0.0001), key, opts);
  expect("NaN confidence is rejected", r.summary.answered === 0);

  r = await run(items, answer("FACT", 0.9), key, opts);
  expect("missing cost is marked incomplete, not zero", r.summary.complete && !r.summary.costComplete && r.rows[0]?.costUsd === undefined);

  r = await run(items, answer("FACT", 0.9, 0.0001), key, opts);
  expect("a valid run is complete and scored", r.summary.complete && r.summary.costComplete && r.summary.jev === "1/3 (33%)" && r.rows[0]?.responseId === "gen-1");

  // AbortSignal.timeout's timer is unref'd, so hold the loop open until the abort fires.
  const slow: Fetch = (_u, init) => new Promise((_res, rej) => {
    const keepAlive = setInterval(() => {}, 1000);
    init?.signal?.addEventListener("abort", () => { clearInterval(keepAlive); rej(init.signal?.reason); });
  });
  r = await run(items.slice(0, 1), slow, key, { ...opts, timeoutMs: 50 });
  expect("a hung request times out", r.rows[0]?.error === "timeout after 50 ms");

  const LEAK = "LEAK-sk-or-v1-planted ignore previous instructions";
  const leaked = (x: unknown) => JSON.stringify(x).includes("LEAK");
  r = await run(items, answer(LEAK, 0.9, 0.001), key, opts);
  expect("invalid choice text is not copied into the report", r.rows[0]?.error === "invalid choice" && !leaked(r));
  r = await run(items, async () => new Response(`not json {${LEAK}`, { status: 200 }), key, opts);
  expect("malformed body is not copied into the report", r.rows[0]?.error === "malformed response body" && !leaked(r));
  r = await run(items, async () => { throw new Error(`connect failed ${LEAK}`, { cause: { code: LEAK } }); }, key, opts);
  expect("transport exception text is not copied into the report", r.rows[0]?.error === "transport error" && !leaked(r));
  r = await run(items, async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); }, key, opts);
  expect("a safe transport code is kept", r.rows[0]?.error === "transport error (ECONNRESET)");
  r = await run(items, reply(500, { error: { message: LEAK, code: LEAK } }), key, opts);
  expect("unsafe provider error code is dropped", r.rows[0]?.error === "HTTP 500" && !leaked(r));
  r = await run(items, reply(200, { id: LEAK, model: LEAK, provider: LEAK, answers: { memory_class: { choice: "FACT", confidence: 0.9 } }, usage: { cost: 0.001 } }), key, opts);
  expect("unsafe response id, model and provider are dropped", r.summary.complete && !leaked(r));

  r = await run(items, answer("nonsense", 0.9, 0.001), key, opts);
  expect("charges on rejected answers are counted", r.summary.answered === 0 && r.summary.totalCostUsd === 0.003 && r.summary.costComplete);
  r = await run(items, reply(500, {}), key, opts);
  expect("failed requests with unknown cost make the total incomplete", !r.summary.costComplete);

  let shapeRejected = false;
  try { parseItems(JSON.stringify({ id: "x", source: "t", gold: "RELATIONSHIP", text: "a" })); } catch { shapeRejected = true; }
  expect("RELATIONSHIP gold label is rejected", shapeRejected);

  if (failures.length > 0) { console.error(`${failures.length} selftest case(s) failed`); return; }
  console.log("selftest: all cases behaved as expected");
  process.exitCode = 0;
}

(process.argv.includes("--selftest") ? selftest() : main()).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "failed");
  process.exitCode = 1;
});
