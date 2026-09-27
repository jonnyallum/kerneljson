// KJ-P7A - mutation check for the primary identity authority rules (ADR-0021).
//
// A check is not trustworthy until it has failed on purpose. This script breaks each authority rule
// in turn (governance derivation, the origin ceiling, approval gating, immutability, cross-tenant
// isolation, the freeze, the rate cap, D8 ordering, the ROLLBACK/version document match fixes, the
// secret screen, the P5 fence), runs the identity tests against the broken source, and requires that
// the tests FAIL. A mutation the tests do not notice is a hole in the tests, and the script exits
// non-zero.
//
//   node scripts/mutation-check-identity.mjs                run every mutation (needs Docker: docker info first)
//   node scripts/mutation-check-identity.mjs --only M9       run one
//
// Every file is restored afterwards, including on Ctrl-C.
//
// Deliberately NOT covered here (see ADR-0021 and the KJ-P7A review notes for why):
//   - wrong approval digest: ApprovalStore's own logic, unchanged by this phase, already covered by
//     its own existing test suite (tests/database.test.ts, tests/approval-boundary.test.ts).
//   - direct version/activation insert bypassing the workflow: not a source mutation - covered by the
//     RLS/grants tests in tests/identity-migration.integration.test.ts (anon/authenticated cannot
//     touch these tables at all; only the app's own privileged role can write, same as every other
//     kernel table).
//   - removing the identity_activation_guard()/identity_version_guard() advisory locks specifically:
//     the primary key on (identity_id, version) backstops the race regardless of the lock, so a
//     black-box test cannot distinguish "lock present" from "lock removed" - the concurrency test
//     (tests/identity-migration.integration.test.ts) proves the PK-level guarantee instead, which is
//     the one that actually matters to an external observer.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIGRATION = "supabase/migrations/20260925120000_primary_identity.sql";
const WORKFLOW = "services/kernel/src/identity-workflow.ts";
const POLICY = "services/memory/src/canonical/policy.ts";
const COMPLETE = "services/kernel/src/identity/complete.ts";
const STORE = "services/kernel/src/identity/store.ts";
const HEALTH = "services/kernel/src/health/evaluate.ts";

// Scoped per mutation, not one uniform list: the full set (below) needs a fresh Docker rebuild for
// the Restate E2E workflow suite alone (measured ~480s), and only the two mutations that actually
// touch identity-workflow.ts (M1, M21) can only be observed by running the code that file is in -
// the DB-trigger suite proposes/activates candidates with raw SQL, bypassing the workflow entirely.
// Running the full set for every one of 22 mutations was originally clocked at ~3 hours; scoping
// each mutation to only the test file(s) that can actually see it brings this down to minutes.
const DB_TESTS = ["tests/identity-migration.integration.test.ts"];
const WORKFLOW_TESTS = ["tests/identity-workflow.integration.test.ts"];
const MEMORY_TESTS = ["tests/memory-canonical.test.ts"];
const HEALTH_TESTS = ["tests/health-model.test.ts"];
const FULL_TESTS = [...DB_TESTS, ...WORKFLOW_TESTS, "tests/primary-identity-contracts.test.ts", "tests/identity-canonical.test.ts", "tests/identity-secret-scan.test.ts", ...MEMORY_TESTS, ...HEALTH_TESTS];

/** [id, what the mutation breaks, file, exact text to find (must occur once), replacement, tests to run] */
const MUTATIONS = [
  ["M1", "the workflow claims a non-operator origin for its own candidates", WORKFLOW, 'origin: "OPERATOR_INSTRUCTION",', 'origin: "MODEL_PROPOSAL",', WORKFLOW_TESTS],
  ["M2", "a non-HUMAN owner can bootstrap an identity", MIGRATION, "if owner_kind is distinct from 'HUMAN' then", "if false then", DB_TESTS],
  ["M3", "a caller-asserted governance class survives instead of being overwritten (Class A -> C downgrade)", MIGRATION, "new.governance_class := 'A';", "new.governance_class := 'C';", DB_TESTS],
  ["M4", "a real Class A change is never detected, so it is misclassified through Class C", MIGRATION, "changed_a := (head.document->'sections'->'classA') is distinct from (new.document->'sections'->'classA');", "changed_a := false;", DB_TESTS],
  ["M5", "a Class A/ROLLBACK activation no longer requires a granted approval", MIGRATION, "if new.governance_class in ('A','ROLLBACK') and new.approval_id is null then", "if false then", DB_TESTS],
  ["M6", "a HELD candidate's document can be swapped in place after proposal", MIGRATION, "or new.document is distinct from old.document", "or false", DB_TESTS],
  ["M7", "a tenant can bootstrap a second identity", MIGRATION, "tenant_id uuid not null unique references public.tenants(id),", "tenant_id uuid not null references public.tenants(id),", DB_TESTS],
  ["M8", "the same candidate can be activated twice", MIGRATION, "candidate_id uuid not null unique references public.identity_candidates(id),", "candidate_id uuid not null references public.identity_candidates(id),", DB_TESTS],
  ["M9", "identity_versions rows become updatable", MIGRATION, "create trigger identity_versions_immutable before update or delete on public.identity_versions", "create trigger identity_versions_immutable before delete on public.identity_versions", DB_TESTS],
  ["M10", "identity_versions rows become deletable", MIGRATION, "create trigger identity_versions_immutable before update or delete on public.identity_versions", "create trigger identity_versions_immutable before update on public.identity_versions", DB_TESTS],
  ["M11", "identity_versions can be truncated", MIGRATION, "create trigger identity_versions_no_truncate before truncate on public.identity_versions", "create trigger identity_versions_no_truncate before truncate on public.identity_profiles", DB_TESTS],
  ["M12", "identity_activations can be truncated", MIGRATION, "create trigger identity_activations_no_truncate before truncate on public.identity_activations", "create trigger identity_activations_no_truncate before truncate on public.identity_profiles", DB_TESTS],
  // M13 removes the trigger outright. It used to move it onto identity_versions, which does not exist
  // yet at that point in the migration, so the mutated migration failed to apply and the run was
  // counted KILLED with zero failing tests - a broken mutation, not a caught one.
  [
    "M13",
    "identity_profiles can be truncated",
    MIGRATION,
    "create trigger identity_profiles_no_truncate before truncate on public.identity_profiles\n  for each statement execute function public.reject_ledger_mutation();\n",
    "",
    DB_TESTS,
  ],
  [
    "M14",
    "a candidate's tenant_id no longer has to actually own the identity it names",
    MIGRATION,
    "check ((governance_class = 'BOOTSTRAP') = (base_version is null)),\n  foreign key (identity_id, tenant_id) references public.identity_profiles(id, tenant_id),",
    "check ((governance_class = 'BOOTSTRAP') = (base_version is null)),",
    DB_TESTS,
  ],
  ["M15", "the Class C/D rate cap never bites", MIGRATION, "if recent_cd >= 3 then", "if recent_cd >= 300 then", DB_TESTS],
  ["M16", "a frozen identity still accepts a Class C/D activation", MIGRATION, "if coalesce(is_frozen, true) and new.governance_class in ('C','D') then", "if false then", DB_TESTS],
  [
    "M17",
    "a MODEL_PROPOSAL/SHARED_BRAIN BOOTSTRAP candidate can self-activate with no human involved (the KJ-P7A origin-check regression)",
    MIGRATION,
    "candidate.state = 'HELD' and candidate.origin = 'OPERATOR_INSTRUCTION' and new.governance_class in ('C','D','BOOTSTRAP')",
    "candidate.state = 'HELD' and new.governance_class in ('C','D','BOOTSTRAP')",
    DB_TESTS,
  ],
  ["M18", "D8 stops requiring the owning task to be COMPLETED before a version can exist", MIGRATION, "if prior_task_status <> 'COMPLETED' then", "if false then", DB_TESTS],
  [
    "M19",
    "the ROLLBACK document comparison never strips 'version', so no rollback can ever match (the original KJ-P7A bug)",
    MIGRATION,
    "if not exists (select 1 from public.identity_versions where identity_id = new.identity_id and (document - 'version') = new.document) then",
    "if not exists (select 1 from public.identity_versions where identity_id = new.identity_id and document = new.document) then",
    DB_TESTS,
  ],
  [
    "M20",
    "a version's document is compared to its candidate without stripping the version number, so no version can ever be inserted",
    MIGRATION,
    "if candidate.document <> (new.document - 'version') then",
    "if candidate.document <> new.document then",
    DB_TESTS,
  ],
  ["M21", "identity documents are no longer screened for secret-shaped content", WORKFLOW, "if (secretShape) throw new restate.TerminalError", "if (false) throw new restate.TerminalError", WORKFLOW_TESTS],
  [
    "M22",
    "the P5 fence is reverted: RELATIONSHIP reaches the broken no-admission approval carrier again",
    POLICY,
    'decision: "REFUSE",\r\n      ruleId: "relationship-promotion-disabled",',
    'decision: "REQUIRE_APPROVAL",\r\n      ruleId: "relationship-promotion-disabled",',
    MEMORY_TESTS,
  ],
  // --- KJ-P7A pre-hostile review fixes (findings 1-4) ---
  ["M23", "the workflow no longer refuses a non-owner before creating a task (finding 4)", WORKFLOW, "if (profile && profile.ownerPrincipalId !== actor.id)", "if (false)", WORKFLOW_TESTS],
  ["M24", "the database no longer requires the proposing task's principal to be the identity owner (finding 4)", MIGRATION, "if proposer_id is distinct from owner_id then", "if false then", DB_TESTS],
  ["M25", "bootstrap is chosen by the absence of a profile instead of a head, so an interrupted bootstrap is stuck forever (finding 3)", WORKFLOW, 'governanceClass: request.kind === "ROLLBACK" ? "ROLLBACK" : head ? "A" : "BOOTSTRAP",', 'governanceClass: request.kind === "ROLLBACK" ? "ROLLBACK" : profile ? "A" : "BOOTSTRAP",', WORKFLOW_TESTS],
  ["M26", "a refusal after the task exists no longer ends it FAILED - a zombie task (finding 2)", WORKFLOW, 'await emit("refused", "TASK_FAILED", "FAILED", undefined, { reason });', "", WORKFLOW_TESTS],
  [
    "M27",
    "completion commits in its own transaction before the version/activation (the original D8 atomicity bug, finding 1)",
    COMPLETE,
    "const outcome = await completeIdentityTaskTx(db, input.taskId, input.summary, input.proof, input.audit);",
    'const outcome = await completeIdentityTaskTx(db, input.taskId, input.summary, input.proof, input.audit);\n    await db.query("commit");\n    await db.query("begin");',
    DB_TESTS,
  ],
  ["M28", "a transient database error is turned into a governance refusal, so a retryable failure FAILS the task (finding 1)", STORE, "if (!isDeterministicRefusal(error)) throw error;", "if (false) throw error;", DB_TESTS],
  ["M29", "a version may be created by a task other than its candidate's own proposing task", MIGRATION, "if candidate.proposed_by_task is not null and candidate.proposed_by_task is distinct from new.created_by_task then", "if false then", DB_TESTS],
  ["M30", "an activation may be requested by a task other than the one that created its version", MIGRATION, "if version_row.created_by_task is distinct from new.request_task_id then", "if false then", DB_TESTS],
  ["M31", "a retried apply after a lost journal entry re-runs instead of returning what already committed (finding 1)", COMPLETE, "    if (existing.rows[0]) {\n      const outcome = Outcome.parse(existing.rows[0].contract);", "    if (false) {\n      const outcome = Outcome.parse(existing.rows[0].contract);", DB_TESTS],
  ["M32", "an interrupted bootstrap's existing profile is not resumed, so recovery collides with it (finding 3)", STORE, "if (existing) return this.matchProfile(existing, input);", "if (false) return this.matchProfile(existing, input);", WORKFLOW_TESTS],
  ["M33", "an identity profile left without an activated identity is never surfaced by health (finding 3)", HEALTH, 'incomplete.length === 0 ? "HEALTHY" : "DEGRADED",', '"HEALTHY",', HEALTH_TESTS],
  // --- KJ-P7A delta review (1df2d52): stale candidates and approval binding ---
  [
    "M34",
    "a stale candidate (proposed against an older head) applies anyway and silently reverts the newer identity",
    MIGRATION,
    "if prior.version is distinct from candidate.base_version\n     or prior.identity_core_digest is distinct from candidate.base_identity_core_digest then",
    "if false then",
    DB_TESTS,
  ],
  [
    "M35",
    "a caller-supplied base token survives instead of being derived from the real head",
    MIGRATION,
    "new.base_version := head.version;\n  new.base_identity_core_digest := head.identity_core_digest;",
    "new.base_version := coalesce(new.base_version, head.version);\n  new.base_identity_core_digest := coalesce(new.base_identity_core_digest, head.identity_core_digest);",
    DB_TESTS,
  ],
  [
    "M36",
    "a candidate's base token can be rewritten after proposal",
    MIGRATION,
    "\n     or new.base_version is distinct from old.base_version or new.base_identity_core_digest is distinct from old.base_identity_core_digest then",
    " then",
    DB_TESTS,
  ],
  ["M37", "a PENDING/DENIED approval satisfies a Class A/ROLLBACK activation", MIGRATION, "if approval_status is distinct from 'GRANTED' then", "if false then", DB_TESTS],
  [
    "M38",
    "the approval is no longer bound to this candidate and proposed document (D5)",
    MIGRATION,
    "    if not exists (\n      select 1 from public.task_events e\n      where e.task_id = new.request_task_id and e.type = 'POLICY_CHECKED'\n        and e.event_key",
    "    if false and not exists (\n      select 1 from public.task_events e\n      where e.task_id = new.request_task_id and e.type = 'POLICY_CHECKED'\n        and e.event_key",
    DB_TESTS,
  ],
  ["M39", "an approval belonging to a different task satisfies the activation", MIGRATION, "if approval_task is distinct from new.request_task_id then", "if false then", DB_TESTS],
  // --- KJ-P7A hostile seal pass (04fd7bb): D7 default freeze, D6 policy on every C/D change ---
  ["M40", "Class C/D is no longer frozen by default after bootstrap - a missing governance row means open (D7)", MIGRATION, "if coalesce(is_frozen, true) and new.governance_class in ('C','D') then", "if coalesce(is_frozen, false) and new.governance_class in ('C','D') then", DB_TESTS],
  ["M41", "a Class C/D activation no longer needs a persisted ALLOW policy decision (D6)", MIGRATION, "  elsif new.governance_class in ('C','D') then", "  elsif false then", DB_TESTS],
  ["M42", "an approval's policy event no longer has to be an APPROVAL_REQUIRED decision", MIGRATION, "        and e.payload->'evaluation'->'decision'->>'decision' = 'APPROVAL_REQUIRED'\n", "", DB_TESTS],
  [
    "M43",
    "a Class C/D ALLOW decision no longer has to be under that class's own gate - a Class D rule authorises Class C (D6)",
    MIGRATION,
    "        and e.payload->'invocation'->'capability'->>'id' = gate\n        and e.payload->'evaluation'->'decision'->>'decision' = 'ALLOW'",
    "        and e.payload->'evaluation'->'decision'->>'decision' = 'ALLOW'",
    DB_TESTS,
  ],
  ["M44", "the workflow skips policy for Class C changes (D6)", WORKFLOW, ': governanceClass === "C" ? IDENTITY_APPLY_C', ': governanceClass === "C" ? null', WORKFLOW_TESTS],
  [
    "M45",
    "the workflow proceeds on a DENY policy decision (D6)",
    WORKFLOW,
    'const acceptable = decision === "APPROVAL_REQUIRED" || (decision === "ALLOW" && (governanceClass === "C" || governanceClass === "D"));',
    "const acceptable = true;",
    WORKFLOW_TESTS,
  ],
  ["M46", "a Class C/D version may change the Class A bytes (D6)", MIGRATION, "if new.governance_class in ('C','D') and new.class_a_digest <> prior.class_a_digest then", "if false then", DB_TESTS],
  ["M47", "the Class A byte-identity rule wrongly applies to ROLLBACK, so an emergency rollback past a Class A change can never apply (D7)", MIGRATION, "if new.governance_class in ('C','D') and new.class_a_digest <> prior.class_a_digest then", "if new.governance_class <> 'A' and new.class_a_digest <> prior.class_a_digest then", DB_TESTS],
];

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
// Crash-safe restore. A SIGINT handler alone is not enough: on 2026-09-27 a run was SIGKILLed by the
// machine's memory-pressure safeguard mid-mutation, no handler ran, and the checkpoint commit 5e13c28
// then captured M2 and M11 still applied in the migration. The pristine text is now written to disk
// BEFORE each mutation and recovered on the next start, whatever killed the previous run.
const BACKUP = ".mutation-check-identity.backup.json";
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
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    restore();
    process.exit(130);
  });

// Preflight: every mutation's target text must be present exactly once in the UNMUTATED source before
// the (long) baseline runs. A missing target means either the source drifted or a mutation leaked into
// it - in both cases every result below would mean nothing.
// Line endings follow the file, not the table: with core.autocrlf=true the same file is CRLF in one
// working copy and LF in another (and always LF on a Linux CI checkout), and a multi-line target
// written for one would silently fail to match the other.
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const inEol = (s, eol) => s.replaceAll("\r\n", "\n").replaceAll("\n", eol);
const occurrences = (file, find) => {
  const text = readFileSync(file, "utf8");
  return text.split(inEol(find, eolOf(text))).length - 1;
};
const unapplicable = MUTATIONS.filter(([, , file, find]) => occurrences(file, find) !== 1).map(([id]) => id);
if (unapplicable.length > 0) {
  console.error(`PREFLIGHT FAILED: target text missing or duplicated for ${unapplicable.join(", ")} - a leaked mutation or drifted source.`);
  process.exit(2);
}

// Verdicts come from vitest's own JSON report, never from its exit code alone or from parsing its text.
// The text summary misparsed once (a false SURVIVED, 2026-09-25); the exit code alone then produced a
// false KILLED (M13, 2026-09-27: exit 1 with 0 failing tests - the run errored, no assertion failed).
// A mutation is KILLED only when at least one test actually FAILED; a non-zero exit with no failed
// test is INCONCLUSIVE and counts against the run like a survivor. Full output is kept per run.
const LOGS = process.env["MUTATION_LOG_DIR"] ?? join(tmpdir(), "mutation-check-identity");
function runTests(files, label) {
  const report = join(LOGS, `${label}.json`);
  rmSync(report, { force: true });
  const r = spawnSync("npx", ["vitest", "run", ...files, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`], {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, DOCKER_CONTEXT: "default", CI: "true" },
    // The FULL_TESTS baseline alone measured 480-685s live across two runs on this same machine
    // (2026-09-25, 2026-09-27 - this machine's load varies); per-mutation runs use much smaller
    // scoped file sets and return in well under a minute, so this ceiling only matters for the
    // baseline and for a mutation whose failure mode is a hang/retry storm rather than a clean fast
    // rejection.
    timeout: 900_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  writeFileSync(join(LOGS, `${label}.log`), out);
  let failed = 0,
    total = 0;
  if (existsSync(report)) {
    const json = JSON.parse(readFileSync(report, "utf8"));
    failed = json.numFailedTests ?? 0;
    total = json.numTotalTests ?? 0;
  }
  return { code: r.status, failed, total, out };
}

let survivors = 0;
try {
  mkdirSync(LOGS, { recursive: true });
  const base = runTests(FULL_TESTS, "baseline");
  if (base.code !== 0 || base.failed !== 0 || base.total === 0) {
    console.error("BASELINE FAILED: the unmutated tests do not pass, so a mutation result would mean nothing.");
    console.error(base.out.split("\n").slice(-25).join("\n"));
    process.exit(2);
  }
  console.log("baseline: identity tests pass unmutated");
  for (let [id, what, file, find, replace, tests] of MUTATIONS) {
    if (only && only !== id) continue;
    const text = readFileSync(file, "utf8");
    const eol = eolOf(text);
    find = inEol(find, eol);
    replace = inEol(replace, eol);
    const count = text.split(find).length - 1;
    if (count !== 1) {
      console.error(`${id} CANNOT APPLY: expected the target text once in ${file}, found ${count}`);
      survivors++;
      continue;
    }
    originals.set(file, text);
    writeFileSync(BACKUP, JSON.stringify({ file, text }));
    writeFileSync(file, text.replace(find, () => replace));
    const result = runTests(tests, id);
    restore();
    const verdict = result.failed > 0 ? "KILLED      " : result.code !== 0 ? "INCONCLUSIVE" : "SURVIVED    ";
    if (result.failed === 0) survivors++;
    console.log(`${id} ${verdict} (${result.failed}/${result.total} failing, exit ${result.code}, log ${join(LOGS, id + ".log")}) ${what}`);
  }
} finally {
  restore();
}
console.log(survivors === 0 ? "ALL MUTATIONS KILLED" : `${survivors} MUTATION(S) SURVIVED, INCONCLUSIVE OR COULD NOT APPLY`);
process.exit(survivors === 0 ? 0 : 1);
