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
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const MIGRATION = "supabase/migrations/20260925120000_primary_identity.sql";
const WORKFLOW = "services/kernel/src/identity-workflow.ts";
const POLICY = "services/memory/src/canonical/policy.ts";

// Scoped per mutation, not one uniform list: the full set (below) needs a fresh Docker rebuild for
// the Restate E2E workflow suite alone (measured ~480s), and only the two mutations that actually
// touch identity-workflow.ts (M1, M21) can only be observed by running the code that file is in -
// the DB-trigger suite proposes/activates candidates with raw SQL, bypassing the workflow entirely.
// Running the full set for every one of 22 mutations was originally clocked at ~3 hours; scoping
// each mutation to only the test file(s) that can actually see it brings this down to minutes.
const DB_TESTS = ["tests/identity-migration.integration.test.ts"];
const WORKFLOW_TESTS = ["tests/identity-workflow.integration.test.ts"];
const MEMORY_TESTS = ["tests/memory-canonical.test.ts"];
const FULL_TESTS = [...DB_TESTS, ...WORKFLOW_TESTS, "tests/primary-identity-contracts.test.ts", "tests/identity-canonical.test.ts", "tests/identity-secret-scan.test.ts", ...MEMORY_TESTS];

/** [id, what the mutation breaks, file, exact text to find (must occur once), replacement, tests to run] */
const MUTATIONS = [
  ["M1", "the workflow claims a non-operator origin for its own candidates", WORKFLOW, 'origin: "OPERATOR_INSTRUCTION",', 'origin: "MODEL_PROPOSAL",', WORKFLOW_TESTS],
  ["M2", "a non-HUMAN owner can bootstrap an identity", MIGRATION, "if owner_kind is distinct from 'HUMAN' then", "if false then", DB_TESTS],
  ["M3", "a caller-asserted governance class survives instead of being overwritten (Class A -> C downgrade)", MIGRATION, "new.governance_class := 'A';", "new.governance_class := 'C';", DB_TESTS],
  ["M4", "a real Class A change is never detected, so it is misclassified through Class C", MIGRATION, "changed_a := (head.document->'sections'->'classA') is distinct from (new.document->'sections'->'classA');", "changed_a := false;", DB_TESTS],
  ["M5", "a Class A/ROLLBACK activation no longer requires a granted approval", MIGRATION, "if new.governance_class in ('A','ROLLBACK') and new.approval_id is null then", "if false then", DB_TESTS],
  ["M6", "a resolved candidate's document can still be mutated", MIGRATION, "or new.document is distinct from old.document", "or false", DB_TESTS],
  ["M7", "a tenant can bootstrap a second identity", MIGRATION, "tenant_id uuid not null unique references public.tenants(id),", "tenant_id uuid not null references public.tenants(id),", DB_TESTS],
  ["M8", "the same candidate can be activated twice", MIGRATION, "candidate_id uuid not null unique references public.identity_candidates(id),", "candidate_id uuid not null references public.identity_candidates(id),", DB_TESTS],
  ["M9", "identity_versions rows become updatable", MIGRATION, "create trigger identity_versions_immutable before update or delete on public.identity_versions", "create trigger identity_versions_immutable before delete on public.identity_versions", DB_TESTS],
  ["M10", "identity_versions rows become deletable", MIGRATION, "create trigger identity_versions_immutable before update or delete on public.identity_versions", "create trigger identity_versions_immutable before update on public.identity_versions", DB_TESTS],
  ["M11", "identity_versions can be truncated", MIGRATION, "create trigger identity_versions_no_truncate before truncate on public.identity_versions", "create trigger identity_versions_no_truncate before truncate on public.identity_profiles", DB_TESTS],
  ["M12", "identity_activations can be truncated", MIGRATION, "create trigger identity_activations_no_truncate before truncate on public.identity_activations", "create trigger identity_activations_no_truncate before truncate on public.identity_profiles", DB_TESTS],
  ["M13", "identity_profiles can be truncated", MIGRATION, "create trigger identity_profiles_no_truncate before truncate on public.identity_profiles", "create trigger identity_profiles_no_truncate before truncate on public.identity_versions", DB_TESTS],
  [
    "M14",
    "a candidate's tenant_id no longer has to actually own the identity it names",
    MIGRATION,
    "resolved_at timestamptz,\n  foreign key (identity_id, tenant_id) references public.identity_profiles(id, tenant_id),",
    "resolved_at timestamptz,",
    DB_TESTS,
  ],
  ["M15", "the Class C/D rate cap never bites", MIGRATION, "if recent_cd >= 3 then", "if recent_cd >= 300 then", DB_TESTS],
  ["M16", "a frozen identity still accepts a Class C/D activation", MIGRATION, "if coalesce(is_frozen, false) and new.governance_class in ('C','D') then", "if false then", DB_TESTS],
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

function runTests(files) {
  const r = spawnSync("npx", ["vitest", "run", ...files], {
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
  const failed = /Tests\s+(\d+) failed/.exec(out);
  return { code: r.status, failed: failed ? Number(failed[1]) : 0, out };
}

let survivors = 0;
try {
  const base = runTests(FULL_TESTS);
  if (base.code !== 0) {
    console.error("BASELINE FAILED: the unmutated tests do not pass, so a mutation result would mean nothing.");
    console.error(base.out.split("\n").slice(-25).join("\n"));
    process.exit(2);
  }
  console.log("baseline: identity tests pass unmutated");
  for (const [id, what, file, find, replace, tests] of MUTATIONS) {
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
    const result = runTests(tests);
    restore();
    // Exit code alone, not a text-parsed failure count: verified live (2026-09-25) that combining
    // several test files under CI=true can produce a summary vitest's own reporter formats
    // differently than /Tests\s+(\d+) failed/ expects, silently reporting 0 failures on a run that
    // actually failed (or was killed by the timeout) - a false "SURVIVED". `vitest run` reliably
    // exits non-zero on any failure, crash or timeout-kill; that is the one signal this script trusts.
    const killed = result.code !== 0;
    if (!killed) survivors++;
    console.log(`${id} ${killed ? "KILLED  " : "SURVIVED"} (${result.failed} failing, exit ${result.code}) ${what}`);
  }
} finally {
  restore();
}
console.log(survivors === 0 ? "ALL MUTATIONS KILLED" : `${survivors} MUTATION(S) SURVIVED OR COULD NOT APPLY`);
process.exit(survivors === 0 ? 0 : 1);
