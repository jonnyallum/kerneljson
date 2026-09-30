import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/**
 * KJ-P7B-1 (ADR-0022 section 6, B4) - the identity import fence, from the repository's real RUNTIME import graph.
 *
 * Only runtime imports count: `import type` / `export type` are erased and cannot carry identity bytes. The graph is
 * built from source text, so this test needs nothing to be importable - which is what lets the mutation harness
 * inject a forbidden import into, say, faculty routing and see THIS test fail.
 */
const ROOTS = ["packages", "services", "apps"];
const PROJECTION = "services/kernel/src/identity/projection.ts";
const BINDING = "services/kernel/src/identity/cognition-binding.ts";
const EVIDENCE_VERIFY = "services/kernel/src/identity/evidence-verify.ts";

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(path).isDirectory()) files(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path.replaceAll("\\", "/"));
  }
  return out;
}

/** Runtime import edges: `import x from`, `import {..} from`, `import "x"`, `export .. from`, and `import("x")`. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specs: string[] = [];
  const statement = /(^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(statement)) {
    if (m[3]) continue; // `import type ... from` / `export type ... from`
    const clause = m[4] ?? "";
    // `import { type A, type B } from` is type-only too.
    const inner = /^\{([\s\S]*)\}$/.exec(clause.trim())?.[1];
    if (inner !== undefined && inner.split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
    specs.push(m[5]!);
  }
  for (const m of text.matchAll(/(^|\n)\s*import\s+["']([^"']+)["']/g)) specs.push(m[2]!);
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]!);
  return specs
    .filter((s) => s.startsWith("."))
    .map((s) => normalize(join(dirname(file), s)).replaceAll("\\", "/").replace(/\.js$/, ".ts"));
}

const all = ROOTS.flatMap((r) => files(r));
const graph = new Map(all.map((f) => [f, runtimeImports(f)] as const));
const reach = (from: string): Set<string> => {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const next = stack.pop()!;
    for (const dep of graph.get(next) ?? []) if (!seen.has(dep)) { seen.add(dep); stack.push(dep); }
  }
  return seen;
};
const importersOf = (target: string) => [...graph].filter(([, deps]) => deps.includes(target)).map(([f]) => f).sort();
const FORBIDDEN_ROOTS = (f: string) =>
  f.startsWith("services/kernel/src/faculty/") ||
  f.startsWith("services/memory/") ||
  f.startsWith("apps/gateway/") ||
  f.startsWith("services/kernel/src/compiler/") ||
  f.startsWith("services/kernel/src/planner/") ||
  f === "services/kernel/src/policy.ts" ||
  /^services\/kernel\/src\/approval-[^/]*\.ts$/.test(f) ||
  f === "services/kernel/src/mission/prompts.ts" ||
  f === "services/kernel/src/ledger.ts" ||
  /^services\/kernel\/src\/verification[^/]*\.ts$/.test(f);

describe("B4 identity import fence (runtime import graph)", () => {
  it("the graph is real: it sees the whole repository and the known wiring edges", () => {
    expect(all.length).toBeGreaterThan(150);
    expect(graph.get("services/kernel/src/mission/analyst-assembly.ts")).toContain(PROJECTION);
    expect(graph.get("services/kernel/src/index.ts")).toContain(BINDING);
    // Negative control: a type-only import is not an edge.
    expect(graph.get("services/kernel/src/executor/workflow.ts")).not.toContain(BINDING);
  });
  it("only the analyst assembler, the mission wiring and the binding itself import the projection module", () => {
    expect(importersOf(PROJECTION)).toEqual([
      "services/kernel/src/identity/cognition-binding.ts",
      "services/kernel/src/mission/analyst-assembly.ts",
      "services/kernel/src/mission/run.ts",
    ]);
  });
  it("only the composition root imports the cognition binding at runtime", () => {
    expect(importersOf(BINDING)).toEqual(["services/kernel/src/index.ts"]);
  });
  it("no forbidden root reaches either identity module, directly or transitively", () => {
    const offenders = all.filter(FORBIDDEN_ROOTS).filter((f) => { const r = reach(f); return r.has(PROJECTION) || r.has(BINDING); });
    expect(offenders).toEqual([]);
    expect(all.filter(FORBIDDEN_ROOTS).length).toBeGreaterThan(20); // the forbidden set is really populated
  });
  it("identity never reaches faculty routing, registry, templates or memory (it may read only the faculty ceiling)", () => {
    for (const from of [PROJECTION, BINDING]) {
      const r = [...reach(from)];
      expect(r.filter((f) => ["services/kernel/src/faculty/registry.ts", "services/kernel/src/faculty/policy.ts", "services/kernel/src/faculty/templates.ts"].includes(f) || f.startsWith("services/memory/")), from).toEqual([]);
    }
  });
  it("completion verification stays pure: contracts and the canonical digest only", () => {
    const r = [...reach(EVIDENCE_VERIFY)].filter((f) => !f.startsWith("packages/contracts/"));
    expect(r).toEqual(["services/kernel/src/identity/canonical.ts"]);
    expect(importersOf(EVIDENCE_VERIFY)).toEqual(["services/kernel/src/health/collect.ts", "services/kernel/src/ledger.ts", "services/kernel/src/mission/run.ts", "services/kernel/src/reflection/verify.ts"]);
  });
  it("reflection source verification cannot reach model, prompt, identity assembly or persistence wiring", () => {
    const from = "services/kernel/src/reflection/verify.ts", r = [...reach(from)];
    expect(r).toContain(EVIDENCE_VERIFY);
    expect(r.filter(f => [PROJECTION, BINDING, "services/kernel/src/ledger.ts",
      "services/kernel/src/mission/prompts.ts", "services/kernel/src/mission/analyst-assembly.ts",
      "services/kernel/src/mission/run.ts", "services/kernel/src/index.ts"].includes(f)
      || f.startsWith("packages/models/") || /(?:store|workflow|registry)\.ts$/.test(f))).toEqual([]);
    // K1 exposes no production execution entry point. K3 must explicitly review this fence.
    expect(importersOf(from)).toEqual([]);
  });
});
