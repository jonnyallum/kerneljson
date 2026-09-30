// KJ-P7B-1 - mutation check for the identity cognition binding (ADR-0022, D1 erratum).
//
// A check is not trustworthy until it has failed on purpose. Every mutation below breaks exactly one P7B-1 rule; the
// scoped tests must then FAIL. Two kill kinds exist, and they are never confused:
//   test       - a test assertion fails. For a migration mutation the mutated migration chain must STILL APPLY
//                (checked first, on a scratch database), so an apply or syntax failure can never pass as a kill.
//   precommit  - the migration's own pre-COMMIT qualification refuses to apply, with the exact signature
//                "KJ-P7B-1 PRE-COMMIT". That is a real, independent defence (the production apply would stop there).
//
//   node scripts/mutation-check-identity-cognition.mjs              run every mutation (Docker: docker info first)
//   node scripts/mutation-check-identity-cognition.mjs --only C21   run one (or several: --only C1,C2,T3)
//
// Verdicts come from vitest's JSON report; every file is restored afterwards, including after a hard kill (a crash-safe
// backup is written before each mutation and recovered on the next start, as in mutation-check-identity.mjs).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

const MIG = "supabase/migrations/20260929120000_identity_cognition_binding.sql";
const BIND = "services/kernel/src/identity/cognition-binding.ts";
const PROJ = "services/kernel/src/identity/projection.ts";
const CEIL = "services/kernel/src/faculty/identity-ceiling.ts";
const ASM = "services/kernel/src/mission/analyst-assembly.ts";
const RUN = "services/kernel/src/mission/run.ts";
const LEDGER = "services/kernel/src/ledger.ts";
const EV = "services/kernel/src/identity/evidence-verify.ts";
const RED = "services/kernel/src/alerting/reducer.ts";
const POL = "services/kernel/src/alerting/policy.ts";
const EVAL = "services/kernel/src/health/evaluate.ts";
const CANON = "services/kernel/src/identity/canonical.ts";
const UNIT = ["tests/identity-cognition.test.ts"];
const INT = ["tests/identity-cognition.integration.test.ts"];
const TOPO = ["tests/identity-topology.test.ts"];
const ALL = [...UNIT, ...INT, ...TOPO];

/** [id, what breaks, file, [[find, replace], ...], tests, kind] */
const MUTATIONS = [
  // --- G1 digest twin and the migration's pre-COMMIT qualification ---
  ["C1", "the identity_versions digest parity trigger is removed", MIG, [["create trigger identity_versions_digest_parity_v1 before insert on public.identity_versions\n  for each row execute function public.identity_version_digest_parity_v1();\n", ""]], INT],
  ["C2", "the pre-COMMIT Kernel v1 persisted-row assertion is skipped", MIG, [["  if found and (row_doc is distinct from", "  if false and (row_doc is distinct from"]], INT],
  ["C3", "the pre-COMMIT existing-version parity assertion is skipped", MIG, [["  if parity_failures <> 0 then", "  if false then"]], INT],
  ["C4", "the SQL twin escapes a newline differently from JSON.stringify", MIG, [[String.raw`  r := replace(r, chr(10), '\n');`, String.raw`  r := replace(r, chr(10), '\u000a');`]], INT],
  ["C5", "the SQL twin sorts keys in the wrong order (caught by the Kernel v1 self-assertion)", MIG, [[`order by e.key collate "C"`, "order by e.key desc"]], INT, "precommit"],
  ["C47", "the TypeScript twin accepts a non-integer number", CANON, [["    if (!Number.isSafeInteger(value)) throw", "    if (false) throw"]], UNIT],
  // --- latch / pin final-state invariant, tenant and release binding, marker ---
  ["C6", "a REQUIRED latch may commit without a pin", MIG, [["  if l.mode = 'REQUIRED' and pin_count <> 1 then", "  if false then"]], INT],
  ["C7", "a NONE latch may commit with a pin", MIG, [["  if l.mode = 'NONE' and pin_count <> 0 then", "  if false then"]], INT],
  ["C8", "a pin may commit without any latch", MIG, [["  if l.task_id is null then", "  if false then"]], INT],
  ["C9", "the latch-side deferred invariant trigger is removed", MIG, [["create constraint trigger identity_cognition_latches_pin_invariant after insert on kernel_private.identity_cognition_latches\n  deferrable initially deferred for each row execute function kernel_private.identity_latch_pin_consistency();\n", ""]], INT],
  ["C48", "the pin-side deferred invariant trigger is removed", MIG, [["create constraint trigger identity_pins_latch_invariant after insert on public.identity_pins\n  deferrable initially deferred for each row execute function kernel_private.identity_latch_pin_consistency();\n", ""]], INT],
  ["C10", "the latch tenant foreign key is removed", MIG, [["  constraint identity_cognition_latches_task_tenant foreign key (task_id, tenant_id) references public.tasks(id, tenant_id),\n", ""]], INT],
  ["C11", "the latch release-epoch/binding foreign key is removed", MIG, [["  constraint identity_cognition_latches_binding_epoch foreign key (task_id, tenant_id, release_epoch)\n    references kernel_private.execution_bindings(task_id, tenant_id, release_epoch),\n", ""]], INT],
  ["C12", "a legacy (pre-contract) task can be latched", MIG, [["  if first_epoch is null or new.release_epoch < first_epoch then", "  if false then"]], INT],
  ["C13", "a non-analyst step can be latched", MIG, [["  if not exists (select 1 from public.faculty_pins f\n                 where f.task_id = new.task_id and f.step_id = new.step_id and f.faculty_id = 'intelligence') then", "  if false then"]], INT],
  ["C14", "the contract marker can be backdated", MIG, [["  if new.first_release_epoch is distinct from current_epoch then", "  if false then"]], INT],
  ["C15", "a pin may name a version row other than the one it pins", MIG, [["  if v.id is null or v.id::text is distinct from new.pin->>'identityVersionId' then", "  if false then"]], INT],
  ["C16", "a pin's projection digest is not verified by the database", MIG, [["  if kernel_private.identity_core_digest_v1(new.pin->'projection') is distinct from new.pin->>'projectionDigest'\n     or", "  if false\n     or"]], INT],
  ["C17", "the 16 KiB cap is dropped from the pin CHECK", MIG, [["  and (pin->>'projectionBytes')::numeric <= 16384", "  and (pin->>'projectionBytes')::numeric <= 1638400"]], INT],
  // --- ACL ---
  ["C18", "service_role gains UPDATE on the latch (caught by the pre-COMMIT inventory)", MIG, [["grant select, insert on kernel_private.identity_cognition_latches to service_role;", "grant select, insert, update on kernel_private.identity_cognition_latches to service_role;"]], INT, "precommit"],
  ["C19", "service_role gains UPDATE on the latch AND the pre-COMMIT inventory is weakened (caught by the ACL test)", MIG, [
    ["grant select, insert on kernel_private.identity_cognition_latches to service_role;", "grant select, insert, update on kernel_private.identity_cognition_latches to service_role;"],
    ["        and not (c.relname = 'identity_cognition_latches'\n                 and not has_table_privilege('service_role', c.oid, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))", "        and c.relname <> 'identity_cognition_latches'"],
  ], INT],
  ["C20", "the P7B public trigger functions keep Supabase's default anon/authenticated EXECUTE (caught by pre-COMMIT under the default ACL)", MIG, [["revoke all on function public.identity_version_digest_parity_v1(), public.identity_pin_guard_v1()\n  from public, anon, authenticated, service_role;", "revoke all on function public.identity_version_digest_parity_v1(), public.identity_pin_guard_v1()\n  from public;"]], INT, "precommit-acl"],
  // --- latch creation, replay, call-time authorisation ---
  ["C21", "an existing latch re-reads the environment", BIND, [["      if (found.latch) {\n        await db.query(\"commit\");", "      if (found.latch) {\n        this.readEnabled();\n        await db.query(\"commit\");"]], INT],
  ["C22", "journal/database disagreement is ignored", BIND, [["    if (canonicalDigest(db) !== canonicalDigest(IdentityCognitionState.parse(state))) refuse(\"IDENTITY_JOURNAL_DB_MISMATCH\");", ""]], INT],
  ["C23", "the latest HEAD is substituted for the pinned version at call time", BIND, [["    const src = await this.source(this.pool, pin.tenantId, pin.identityId, pin.identityVersion);", "    const head = (await this.pool.query(\"select version from public.identity_current where identity_id=$1\", [pin.identityId])).rows[0].version;\n    const src = await this.source(this.pool, pin.tenantId, pin.identityId, head);"]], INT],
  ["C24", "the call-time assembly digest is not recomputed on the outgoing request", BIND, [["    if (assemblyDigestOf(request) !== expectedAssemblyDigest) refuse(\"IDENTITY_ASSEMBLY_MISMATCH\");", ""]], INT],
  ["C25", "the outgoing identity block is not checked against the pin", BIND, [["    if (blocks !== 1 || !system.includes(renderIdentityBlock(pin.projection, pin.projectionDigest))) refuse(\"IDENTITY_BLOCK_MISMATCH\");", ""]], INT],
  ["C26", "stored/SQL/TypeScript digest parity is not checked for the pinned version", BIND, [["    if (!agree || (expected && (expected.core !== tsCore || expected.classA !== tsClassA))) refuse(\"IDENTITY_DIGEST_MISMATCH\");", ""]], INT],
  // --- projection ---
  ["C27", "an over-cap projection is truncated instead of refused", PROJ, [["  if (bytes > IDENTITY_PROJECTION_MAX_BYTES) throw new IdentityCognitionRefusal(\"IDENTITY_PROJECTION_TOO_LARGE\");", "  if (bytes > IDENTITY_PROJECTION_MAX_BYTES) return IDENTITY_PROJECTION_MAX_BYTES;"]], [...UNIT, ...INT]],
  ["C28", "Class D is projected", PROJ, [["    sections: { classA, classC },\n  };", "    sections: { classA, classC, classD: document.sections.classD },\n  };"]], UNIT],
  ["C55", "presentation is projected", PROJ, [["    sections: { classA, classC },\n  };", "    sections: { classA, classC: { ...classC, presentation: document.sections.classC.presentation } },\n  };"]], UNIT],
  ["C29", "a split Class A is allowed", PROJ, [["  if (!CLASS_A_FIELDS.every((f) => effective.has(`classA.${f}`))) throw new IdentityCognitionRefusal(\"IDENTITY_SCOPE_CLASS_A_INCOMPLETE\");", ""]], UNIT],
  ["C30", "a missing profile falls back to a default instead of failing closed", PROJ, [["  if (!scope) throw new IdentityCognitionRefusal(\"IDENTITY_PROFILE_MISSING\");", "  if (!scope) return projectIdentity(rawDocument, \"ANALYST_INTELLIGENCE_V1\", ceiling);"]], UNIT],
  ["C31", "the reviewer (verifier) ceiling admits identity", CEIL, [["  [\"verifier@faculty-routing/v1\", Object.freeze([]) as readonly IdentityFieldPath[]],", "  [\"verifier@faculty-routing/v1\", INTELLIGENCE_FACULTY_ROUTING_V1],"]], UNIT],
  // --- assembler ---
  ["C32", "a second identity injection point (the user message)", ASM, [["    request = ModelRequest.parse({ ...base, messages: [{ role: \"system\", content: block + system.content }, user] });", "    request = ModelRequest.parse({ ...base, messages: [{ role: \"system\", content: block + system.content }, { ...user, content: block + user.content }] });"]], UNIT],
  ["C33", "the identity block is placed after the binding task contract", ASM, [["content: block + system.content }, user]", "content: system.content + block }, user]"]], UNIT],
  // --- mission wiring ---
  ["C34", "a REQUIRED refusal falls back to an unbound (legacy) run", RUN, [["    if (!latched.state) {\n      await begin(analyst);\n      return abort(analyst, SOURCES.analyst, { role: \"analyst\", error: latched.error }, latched.error!);\n    }\n    cognition = latched.state;", "    cognition = latched.state;"]], INT],
  ["C35", "analyst evidence drops the identity provenance", RUN, [["              identity: analystCognition.kind === \"REQUIRED\" ? provenanceOf(analystCognition.pin) : null,", "              identity: null,"]], INT],
  ["C36", "the MODEL_CALLED binding is never recorded", RUN, [["              if (receipt.status === \"FAILED\" && !receipt.error.mayHaveRun) return;", "              return;"]], INT],
  ["C37", "the identity call-time guard is not wired into the analyst call", RUN, [["        ? { authorize: (req: ModelRequest) => identityPort.authorize(latchedState, pins.analyst ?? null, req, assembled!.assemblyDigest) }", "        ? {}"]], INT],
  ["C56", "an unvalidated provider receipt can reach the binding recorder", "services/kernel/src/models.ts", [["        result = validateModelResult(request, await port.generate(request));", "        result = await port.generate(request);"]], INT],
  // --- completion ---
  ["C38", "Ledger.write skips verifyIdentityEvidence", LEDGER, [["            verifyCompletion(() => verifyIdentityEvidence({", "            verifyCompletion(() => ((_: unknown) => undefined)({"]], INT],
  ["C39", "the completion oracle uses the current release epoch instead of the task's binding epoch", LEDGER, [["\"select release_epoch from kernel_private.execution_bindings where task_id=$1\", [task.id]);\n            const marker", "\"select epoch as release_epoch from kernel_private.release_epoch where $1::uuid is not null\", [task.id]);\n            const marker"]], INT],
  ["C40", "runtime evidence is not compared with the MODEL_CALLED binding", EV, [["    if (a[field] !== value) fail(`analyst evidence ${field} differs from the MODEL_CALLED binding`);", ""]], [...UNIT, ...INT]],
  ["C41", "reviewer evidence may carry identity", EV, [["    if (\"identity\" in r.metadata) fail(\"reviewer evidence carries identity\");", ""]], UNIT],
  ["C42", "a legacy task may carry cognition state", EV, [["    if (facts.latches.length || facts.pins.length || bindings.length) fail(\"legacy task carries cognition state\");", ""]], UNIT],
  // --- alerting and health ---
  ["C43", "a deliberately silent episode announces its recovery", RED, [["    const notify = policy.notify !== false && (policy.notifyFor === undefined || existing.lastNotifiedAt !== null);", "    const notify = policy.notify !== false;"]], UNIT],
  ["C44", "per-status notification control is ignored", RED, [["  return policy.notifyFor ? policy.notifyFor(status, severity) : true;", "  return true;"]], UNIT],
  ["C45", "the identity.analystRunsBound policy row is missing (generic fallback)", POL, [["  identity(\n    \"identity.analystRunsBound\",", "  identity(\n    \"identity.analystRunsBound.removed\","]], UNIT],
  ...["completedTasksHaveActivation", "profilesHaveActivatedIdentity", "currentDigestParity", "singleCurrentPerTenant", "headEqualsCurrent", "verifierIsolated"].map((name, i) => [
    `C${49 + i}`, `the identity.${name} policy row is missing (generic fallback)`, POL,
    [[`  identity(\n    "identity.${name}",`, `  identity(\n    "identity.${name}.removed",`]], UNIT,
  ]),
  ["C46", "cognition OFF (no REQUIRED run) raises CRITICAL instead of NO_OBSERVATION", EVAL, [["      ? check(\"identity.analystRunsBound\", \"UNKNOWN\", source(\"identity.analystRunsBound\"),", "      ? check(\"identity.analystRunsBound\", \"CRITICAL\", source(\"identity.analystRunsBound\"),"]], UNIT],
  // --- B4 topology injections (ADR-0022 section 6) ---
  ["T1", "faculty routing (routeFaculty) imports identity", "services/kernel/src/faculty/policy.ts", [["import { FacultyPin, FacultyVersion } from \"../../../../packages/contracts/src/faculty.js\";", "import \"../identity/projection.js\";\nimport { FacultyPin, FacultyVersion } from \"../../../../packages/contracts/src/faculty.js\";"]], TOPO],
  ["T2", "the memory assembler imports identity", "services/memory/src/canonical/assembler.ts", [["import { createHash } from \"node:crypto\";", "import \"../../../kernel/src/identity/projection.js\";\nimport { createHash } from \"node:crypto\";"]], TOPO],
  ["T3", "admission (the gateway) imports identity", "apps/gateway/src/server.ts", [["import { randomUUID } from \"node:crypto\";", "import \"../../../services/kernel/src/identity/cognition-binding.js\";\nimport { randomUUID } from \"node:crypto\";"]], TOPO],
  ["T4", "kernel policy imports identity", "services/kernel/src/policy.ts", [["import { z } from \"zod\";", "import \"./identity/projection.js\";\nimport { z } from \"zod\";"]], TOPO],
  ["T5", "the reviewer prompt builder imports identity", "services/kernel/src/mission/prompts.ts", [["import {\n  GithubFacts,", "import \"../identity/projection.js\";\nimport {\n  GithubFacts,"]], TOPO],
  ["T6", "identity imports the faculty registry (the inverse direction)", BIND, [["import { identityFramingCeiling } from \"../faculty/identity-ceiling.js\";", "import \"../faculty/registry.js\";\nimport { identityFramingCeiling } from \"../faculty/identity-ceiling.js\";"]], TOPO],
];

const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1]?.split(",")) : null;
const BACKUP = ".mutation-check-identity-cognition.backup.json";
if (existsSync(BACKUP)) {
  const saved = JSON.parse(readFileSync(BACKUP, "utf8"));
  writeFileSync(saved.file, saved.text);
  rmSync(BACKUP);
  console.error(`RECOVERED ${saved.file} from ${BACKUP}: a previous run was killed while a mutation was applied.`);
}
const originals = new Map();
const restore = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
  originals.clear();
  rmSync(BACKUP, { force: true });
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { restore(); process.exit(130); });

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const inEol = (s, eol) => s.replaceAll("\r\n", "\n").replaceAll("\n", eol);
const count = (text, find) => text.split(inEol(find, eolOf(text))).length - 1;
const unknown = only ? [...only].filter((id) => !MUTATIONS.some(([known]) => known === id)) : [];
if (unknown.length) { console.error(`UNKNOWN MUTATION ID(S): ${unknown.join(", ")}`); process.exit(2); }
const unapplicable = MUTATIONS.filter(([, , file, pairs]) => pairs.some(([find]) => count(readFileSync(file, "utf8"), find) !== 1)).map(([id]) => id);
if (unapplicable.length) { console.error(`PREFLIGHT FAILED: target text missing or duplicated for ${unapplicable.join(", ")}`); process.exit(2); }

const DATABASE = "postgresql://postgres@127.0.0.1:55432/kerneljson";
/** Applies the whole (possibly mutated) migration chain to a scratch database. Returns null on success, else the error. */
async function applyChain(supabaseAcl) {
  let admin;
  for (let attempt = 0; ; attempt++) {
    admin = new pg.Client({ connectionString: DATABASE });
    try { await admin.connect(); break; } catch (error) {
      await admin.end().catch(() => {});
      if (attempt >= 60) throw error; // the disposable test database never became ready
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const name = `p7b_mut_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.query(`create database ${name}`);
  const db = new pg.Client({ connectionString: DATABASE.replace(/\/kerneljson$/, `/${name}`) });
  await db.connect();
  try {
    await db.query(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
    end $$`);
    if (supabaseAcl)
      for (const kind of ["tables", "sequences", "functions"])
        await db.query(`alter default privileges in schema public grant all on ${kind} to public, anon, authenticated, service_role`);
    for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) {
      try {
        await db.query("begin");
        await db.query(readFileSync(`supabase/migrations/${file}`, "utf8"));
        await db.query("commit");
      } catch (error) {
        await db.query("rollback").catch(() => {});
        return `${file}: ${error.message}`;
      }
    }
    return null;
  } finally {
    await db.end();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
}

const LOGS = process.env["MUTATION_LOG_DIR"] ?? join(tmpdir(), "mutation-check-identity-cognition");
function runTests(files, label) {
  const report = join(LOGS, `${label}.json`);
  rmSync(report, { force: true });
  const r = spawnSync("npx", ["vitest", "run", ...files, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`], {
    shell: true, encoding: "utf8", env: { ...process.env, DOCKER_CONTEXT: "default", CI: "true" }, timeout: 900_000,
  });
  writeFileSync(join(LOGS, `${label}.log`), `${r.stdout ?? ""}${r.stderr ?? ""}`);
  let failed = 0, total = 0;
  if (existsSync(report)) {
    const json = JSON.parse(readFileSync(report, "utf8"));
    failed = json.numFailedTests ?? 0;
    total = json.numTotalTests ?? 0;
  }
  return { code: r.status, failed, total };
}

let bad = 0;
const tally = { killed: 0, precommit: 0, survived: 0, inconclusive: 0 };
try {
  mkdirSync(LOGS, { recursive: true });
  if (await applyChain(false) || await applyChain(true)) { console.error("BASELINE FAILED: the unmutated migration chain does not apply."); process.exit(2); }
  const base = runTests(ALL, "baseline");
  if (base.code !== 0 || base.failed !== 0 || base.total === 0) { console.error("BASELINE FAILED: the unmutated tests do not pass."); process.exit(2); }
  console.log(`baseline: ${base.total} P7B tests pass unmutated; migration chain applies (plain and Supabase default ACL)`);
  for (const [id, what, file, pairs, tests, kind = "test"] of MUTATIONS) {
    if (only && !only.has(id)) continue;
    const text = readFileSync(file, "utf8");
    const eol = eolOf(text);
    let mutated = text;
    for (const [find, replace] of pairs) mutated = mutated.replace(inEol(find, eol), () => inEol(replace, eol));
    originals.set(file, text);
    writeFileSync(BACKUP, JSON.stringify({ file, text }));
    writeFileSync(file, mutated);
    let verdict, detail;
    try {
      if (file === MIG) {
        const plain = await applyChain(false);
        const acl = await applyChain(true);
        if (kind === "precommit" || kind === "precommit-acl") {
          const refusal = kind === "precommit" ? plain : acl;
          verdict = refusal?.includes("KJ-P7B-1 PRE-COMMIT") ? "KILLED-PRECOMMIT" : "SURVIVED";
          detail = refusal ? refusal.slice(0, 140) : "migration applied";
        } else if (plain || acl) {
          verdict = "INCONCLUSIVE";
          detail = `mutated migration does not apply: ${(plain ?? acl).slice(0, 140)}`;
        }
      }
      if (!verdict) {
        const result = runTests(tests, id);
        verdict = result.failed > 0 ? "KILLED" : result.code !== 0 ? "INCONCLUSIVE" : "SURVIVED";
        detail = `${result.failed}/${result.total} failing, exit ${result.code}`;
      }
    } finally {
      restore();
    }
    if (verdict === "KILLED") tally.killed++;
    else if (verdict === "KILLED-PRECOMMIT") tally.precommit++;
    else { bad++; verdict === "SURVIVED" ? tally.survived++ : tally.inconclusive++; }
    console.log(`${id} ${verdict.padEnd(16)} (${detail}) ${what}`);
  }
} finally {
  restore();
}
console.log(`SUMMARY killed-by-test=${tally.killed} killed-by-precommit=${tally.precommit} survived=${tally.survived} inconclusive=${tally.inconclusive}`);
console.log(bad === 0 ? "ALL MUTATIONS KILLED" : `${bad} MUTATION(S) SURVIVED OR INCONCLUSIVE`);
process.exit(bad === 0 ? 0 : 1);
