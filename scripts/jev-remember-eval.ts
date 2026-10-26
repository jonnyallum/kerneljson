/**
 * Offline shadow evaluation: Jev (via OpenRouter's Decisions API) vs the deterministic `classifyRemember` keyword
 * rules, on unlabelled `/remember` texts with operator-assigned gold classes. Nothing here touches production; it only
 * reads a JSONL test set and writes a local report.
 *
 *   node --import tsx scripts/jev-remember-eval.ts --key-file <path> --data <set.jsonl> --out <report.json>
 *     [--model typesafe/jev-1.14] [--threshold 0.85] [--concurrency 4]
 *
 * The API key is read from --key-file and only ever placed in the Authorization header. It is never logged, and no
 * error message built here includes it or the request headers.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { classifyRemember } from "../services/memory/src/canonical/classify.js";

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const OPENROUTER_KEY_LENGTH = 73;

/** RELATIONSHIP is deliberately absent: production only accepts it from an explicit label, so Jev may never pick it. */
const CRITERIA = {
  FACT: { what: "Something stated to be true about the world, a person or the business.", not_for: "Choices, plans, how the operator likes things done, or a dated event." },
  PREFERENCE: { what: "How the operator likes things done: style, format, timing, tone, channel.", not_for: "A one-off choice between options (DECISION)." },
  DECISION: { what: "A choice that has been made or a standing rule the operator has set.", not_for: "A taste or style the operator likes (PREFERENCE)." },
  COMMITMENT: { what: "Something someone will do, owes or must do, usually with a deadline or owner.", not_for: "A general rule (DECISION) or a fact about the future (FACT)." },
  LESSON: { what: "Something learned from an outcome or mistake, a rule of thumb drawn from experience.", not_for: "The bare account of what happened (EPISODE)." },
  EPISODE: { what: "A record of a specific thing that happened at a particular time.", not_for: "The takeaway learned from it (LESSON)." },
  PROJECT_KNOWLEDGE: { what: "How a specific project, system or codebase works: architecture, behaviour, configuration.", not_for: "General facts unrelated to a project (FACT)." },
} as const;
type Gold = keyof typeof CRITERIA;
const CLASSES = Object.keys(CRITERIA) as Gold[];

interface Item { id: string; source: string; gold: Gold; text: string }
interface Row {
  id: string; source: string; gold: Gold;
  baseline: string; baselineCorrect: boolean;
  jev?: string; confidence?: number; jevCorrect?: boolean; latencyMs?: number; costUsd?: number; error?: string;
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

function loadItems(path: string): Item[] {
  return readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0).map((l, n) => {
    const item = JSON.parse(l) as Item;
    if (!CLASSES.includes(item.gold)) throw new Error(`line ${n + 1}: gold ${item.gold} is not an allowed class`);
    if (classifyRemember(item.text).explicit) throw new Error(`line ${n + 1}: ${item.id} is explicitly labelled; the eval covers unlabelled text only`);
    return item;
  });
}

/** Reads and shape-checks the key without ever printing it. Strips a UTF-8 BOM in either form. */
function loadKey(path: string): () => string {
  const key = readFileSync(path, "utf8").replace(/^\uFEFF|^\u00EF\u00BB\u00BF/, "").trim();
  if (key.length !== OPENROUTER_KEY_LENGTH || !key.startsWith("sk-or-v1-")) throw new Error(`key file has the wrong shape (length ${key.length})`);
  return () => key;
}

async function askJev(key: () => string, model: string, text: string): Promise<{ choice: string; confidence: number; costUsd: number; latencyMs: number }> {
  const started = performance.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
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
  const latencyMs = Math.round(performance.now() - started);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { answers?: { memory_class?: { choice?: string; confidence?: number } }; usage?: { cost?: number } };
  const answer = body.answers?.memory_class;
  if (answer?.choice === undefined) throw new Error("response has no memory_class choice");
  return { choice: answer.choice, confidence: answer.confidence ?? 0, costUsd: body.usage?.cost ?? 0, latencyMs };
}

function rate(rows: Row[], ok: (r: Row) => boolean | undefined): string {
  const hits = rows.filter((r) => ok(r) === true).length;
  return rows.length === 0 ? "n/a" : `${hits}/${rows.length} (${Math.round((100 * hits) / rows.length)}%)`;
}

async function main(): Promise<void> {
  const key = loadKey(arg("key-file"));
  const items = loadItems(arg("data"));
  const out = arg("out");
  const model = arg("model", "typesafe/jev-1.14");
  const threshold = Number(arg("threshold", "0.85"));
  const concurrency = Number(arg("concurrency", "4"));

  const rows: Row[] = items.map((it) => {
    const baseline = classifyRemember(it.text).class;
    return { id: it.id, source: it.source, gold: it.gold, baseline, baselineCorrect: baseline === it.gold };
  });

  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i] as Item;
      const row = rows[i] as Row;
      try {
        const a = await askJev(key, model, item.text);
        Object.assign(row, { jev: a.choice, confidence: a.confidence, jevCorrect: a.choice === item.gold, latencyMs: a.latencyMs, costUsd: a.costUsd });
      } catch (err) {
        row.error = err instanceof Error ? err.message : "unknown error";
      }
    }
  }));

  const answered = rows.filter((r) => r.error === undefined);
  const confident = answered.filter((r) => (r.confidence ?? 0) >= threshold);
  const unsure = answered.filter((r) => (r.confidence ?? 0) < threshold);
  const latencies = answered.map((r) => r.latencyMs ?? 0).sort((a, b) => a - b);
  const summary = {
    model, threshold, items: rows.length, errors: rows.length - answered.length,
    baseline: rate(rows, (r) => r.baselineCorrect),
    jev: rate(answered, (r) => r.jevCorrect),
    jevConfident: rate(confident, (r) => r.jevCorrect),
    jevUnsure: rate(unsure, (r) => r.jevCorrect),
    baselineOnJevUnsure: rate(unsure, (r) => r.baselineCorrect),
    bySource: Object.fromEntries([...new Set(rows.map((r) => r.source))].map((s) => {
      const sub = rows.filter((r) => r.source === s);
      return [s, { baseline: rate(sub, (r) => r.baselineCorrect), jev: rate(sub.filter((r) => r.error === undefined), (r) => r.jevCorrect) }];
    })),
    latencyMs: latencies.length === 0 ? null : { p50: latencies[Math.floor(latencies.length / 2)], max: latencies[latencies.length - 1] },
    totalCostUsd: Number(answered.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(6)),
  };

  writeFileSync(out, JSON.stringify({ summary, rows }, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  for (const r of rows) {
    if (r.error !== undefined) console.log(`${r.id}  ERROR ${r.error}`);
    else if (!r.jevCorrect || !r.baselineCorrect)
      console.log(`${r.id}  gold=${r.gold}  baseline=${r.baseline}${r.baselineCorrect ? "" : "x"}  jev=${r.jev}${r.jevCorrect ? "" : "x"} @${(r.confidence ?? 0).toFixed(2)}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "failed");
  process.exit(1);
});
