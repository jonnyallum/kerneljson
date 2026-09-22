// KJ-P5 - mutation check for the memory authority rules.
//
// A check is not trustworthy until it has failed on purpose. This script breaks each authority rule in turn (the
// policy table, the entry points' origins, the database triggers, tenant and subject scoping, the supersession view,
// the assembler's budgets and the approval binding), runs the memory tests against the broken source, and requires
// that the tests FAIL. A mutation the tests do not notice is a hole in the tests, and the script exits non-zero.
//
//   node scripts/mutation-check-memory.mjs            run every mutation (needs the validation Postgres: docker info first)
//   node scripts/mutation-check-memory.mjs --only M3  run one
//
// Every file is restored afterwards, including on Ctrl-C.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SERVICE = "services/memory/src/canonical/service.ts";
const POLICY = "services/memory/src/canonical/policy.ts";
const ASSEMBLER = "services/memory/src/canonical/assembler.ts";
const BINDING = "services/memory/src/canonical/approval-binding.ts";
const MIGRATION = "supabase/migrations/20260921180000_canonical_memory.sql";
const TESTS = ["tests/memory-canonical.test.ts", "tests/memory-canonical.integration.test.ts", "tests/telegram-memory.integration.test.ts"];

/** [id, what the mutation breaks, file, exact text to find (must occur once), replacement] */
const MUTATIONS = [
  ["M1", "policy lets a model proposal be promoted", POLICY, 'return { decision: "HOLD", ruleId: "model-candidate-only"', 'return { decision: "ALLOW", ruleId: "model-candidate-only"'],
  ["M2", "policy lets the Shared Brain be promoted", POLICY, 'return { decision: "HOLD", ruleId: "shared-brain-candidate-only"', 'return { decision: "ALLOW", ruleId: "shared-brain-candidate-only"'],
  ["M3", "the model entry point claims the operator origin", SERVICE, 'return this.submit("MODEL_PROPOSAL", ctx, raw);', 'return this.submit("OPERATOR_INSTRUCTION", ctx, raw);'],
  ["M4", "the Shared Brain entry point claims the operator origin", SERVICE, 'return this.submit("SHARED_BRAIN", ctx, raw);', 'return this.submit("OPERATOR_INSTRUCTION", ctx, raw);'],
  ["M5", "the database no longer refuses model or Shared Brain promotions", MIGRATION, "and c.origin not in ('OPERATOR_INSTRUCTION','VERIFIED_OUTCOME') then", "and false then"],
  ["M6", "the database accepts a model candidate recorded as promoted", MIGRATION, "check (state <> 'PROMOTED' or origin in ('OPERATOR_INSTRUCTION','VERIFIED_OUTCOME'))", "check (true)"],
  ["M7", "the database no longer checks a version's trust class against its origin", MIGRATION, "if new.trust_class <> expected then", "if false then"],
  ["M8", "canonical versions become updatable", MIGRATION, "before update or delete on public.memory_versions", "before delete on public.memory_versions"],
  ["M9", "target lookup ignores the tenant", SERVICE, "where tenant_id=$1 and memory_id=$2 order by version desc limit 1", "where memory_id=$2 and $1::uuid is not null order by version desc limit 1"],
  ["M10", "retracted memories stay current", MIGRATION, "and v.kind = 'ASSERT'", "and v.kind in ('ASSERT','RETRACT')"],
  ["M11", "superseded memories stay current", MIGRATION, "r.kind = 'SUPERSEDES' and r.to_memory = v.memory_id and r.tenant_id = v.tenant_id", "r.kind = 'NEVER' and r.to_memory = v.memory_id and r.tenant_id = v.tenant_id"],
  ["M12", "the assembler ignores the token budget", ASSEMBLER, "if (used + tokens > budget.maxTokens) {", "if (false) {"],
  ["M13", "the assembler ignores the item limit", ASSEMBLER, "if (items.length >= budget.maxItems) {", "if (false) {"],
  ["M14", "an approval is no longer bound to its candidate", SERVICE, "if (state.boundCandidateId !== row.id || state.boundCandidateDigest !== row.request_digest)", "if (false)"],
  ["M15", "credentials are no longer refused", POLICY, "if (secret !== null)", "if (false)"],
  ["M16", "personal memories are writable about someone else", SERVICE, 'if (origin === "OPERATOR_INSTRUCTION" && sub.subject.kind === "PRINCIPAL" && sub.subject.ref !== ctx.principal.id)', "if (false)"],
  ["M17", "a reused idempotency key with different content is accepted", SERVICE, "if (row.request_digest !== p.requestDigest)", "if (false)"],
  ["M18", "a superseded memory can be changed again", SERVICE, "if (target.superseded) return refuse", "if (false) return refuse"],
  ["M19", "personal memories are visible to other principals", SERVICE, "(${alias}.subject_kind <> 'PRINCIPAL' or ${alias}.subject_ref = $${params.length})", "(true or ${alias}.subject_ref = $${params.length})"],
  ["M20", "a promoted retraction is no longer recorded as a retraction", SERVICE, 'retract ? "RETRACT" : "ASSERT",', '"ASSERT",'],
  ["M21", "the assembler ignores the class filter", SERVICE, "v.class = any($4) and", "v.class = any($4) or true and"],
  ["M22", "the assembler reads every version rather than the current head", SERVICE, "from memory_current v where v.tenant_id=$1 and v.class = any($4)", "from memory_versions v where v.tenant_id=$1 and v.class = any($4)"],
  ["M23", "a denied or expired approval promotes anyway", SERVICE, 'if (state.status === "GRANTED") {', "if (state.status !== undefined) {"],
];

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const originals = new Map();
const restore = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
  originals.clear();
};
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

function runTests() {
  const r = spawnSync("npx", ["vitest", "run", ...TESTS], {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, DOCKER_CONTEXT: "default", CI: "true" },
    timeout: 280_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const failed = /Tests\s+(\d+) failed/.exec(out);
  return { code: r.status, failed: failed ? Number(failed[1]) : 0, out };
}

let survivors = 0;
try {
  const base = runTests();
  if (base.code !== 0) {
    console.error("BASELINE FAILED: the unmutated tests do not pass, so a mutation result would mean nothing.");
    console.error(base.out.split("\n").slice(-25).join("\n"));
    process.exit(2);
  }
  console.log("baseline: memory tests pass unmutated");
  for (const [id, what, file, find, replace] of MUTATIONS) {
    if (only && only !== id) continue;
    const text = readFileSync(file, "utf8");
    const count = text.split(find).length - 1;
    if (count !== 1) {
      console.error(`${id} CANNOT APPLY: expected the target text once in ${file}, found ${count}`);
      survivors++;
      continue;
    }
    originals.set(file, text);
    writeFileSync(file, text.replace(find, () => replace));
    const result = runTests();
    restore();
    const killed = result.code !== 0 && result.failed > 0;
    if (!killed) survivors++;
    console.log(`${id} ${killed ? "KILLED  " : "SURVIVED"} (${result.failed} failing) ${what}`);
  }
} finally {
  restore();
}
console.log(survivors === 0 ? "ALL MUTATIONS KILLED" : `${survivors} MUTATION(S) SURVIVED OR COULD NOT APPLY`);
process.exit(survivors === 0 ? 0 : 1);
