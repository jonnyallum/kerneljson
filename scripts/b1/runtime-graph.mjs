// KJ-P8 B1 - the runtime import graph: which source files each runtime process can reach.
// Cheap and synchronous on purpose: the test harness loads it in every test process.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const rel = (p) => relative(ROOT, p).replaceAll("\\", "/");
export const read = (p) => readFileSync(join(ROOT, p), "utf8").replaceAll("\r\n", "\n");

// ---------------------------------------------------------------------------------------------------------------
// Runtime entry points. A process is a runtime process if it is started by a deployed service or by an operator
// command that runs against production with the service's own credential.
export const ENTRY_POINTS = {
  kj_worker: [
    "services/kernel/src/index.ts",
    "services/kernel/src/health/cli.ts",
    "services/kernel/src/alerting/cli.ts",
    "services/kernel/src/alerting/outbox-gate-cli.ts",
    "services/kernel/src/alerting/test-notification-cli.ts",
  ],
  kj_door: ["apps/gateway/src/main.ts"],
};
// Deployment-authority modules: operator provisioning that is run by a human with the owner credential in a change
// window. They are NOT runtime and are excluded from both roles. Each is justified in the inventory report.
export const DEPLOYMENT_MODULES = [
  "services/kernel/src/tools/canary-runner.ts",
  "services/kernel/src/scheduler/canary-seed.ts",
  "services/kernel/src/identity/provisioning-pg.ts",
  "services/kernel/src/approval-test-cli.ts",
  "services/evaluator/src/cli.ts",
];

// ---------------------------------------------------------------------------------------------------------------
// Import graph over the TypeScript sources.
export const stripTsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(),])\/\/[^\n]*/g, "$1");
function walk(dir, acc = []) {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "node_modules" || e === "dist") continue;
    const p = `${dir}/${e}`;
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}
export const SOURCES = ["services", "apps", "packages", "runtimes"].flatMap((d) => walk(d)).sort();
const importsOf = (file) => {
  const src = stripTsComments(read(file));
  const out = new Set();
  for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|import\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const target = rel(resolve(join(ROOT, dirname(file)), spec)).replace(/\.js$/, ".ts");
    if (existsSync(join(ROOT, target))) out.add(target);
    else if (existsSync(join(ROOT, target, "index.ts"))) out.add(`${target}/index.ts`);
  }
  return [...out].sort();
};
export function reach(entries, exclude = []) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || exclude.includes(f)) continue;
    seen.add(f);
    for (const i of importsOf(f)) stack.push(i);
  }
  return [...seen].sort();
}
