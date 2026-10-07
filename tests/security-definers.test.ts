import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INVENTORY_SQL, INVENTORY_SQL_SHA256, SEALED_DESIGN, STAGES, baselineEligibilityProblems, baselineEntry, baselineProblems, canonicalJson,
  compareDefiners, excludedSchemaSql, expectedDefiners, identityKey, isExcludedSchema, loadStageManifest, sha256, sortEntries,
  stageBindingProblems, stageFunctions, type DefinerEntry, type PlatformBaseline, type StageManifest,
} from "../services/kernel/src/database/security-definers.js";
import { expectedLedgerHead, expectedLedgerVersions, ledgerSetProblems, parseConnectionFile, scrubPgEnvironment } from "../services/kernel/src/database/platform-baseline-snapshot.js";
import { TABLE_PRIVILEGES, loadManifest } from "../services/kernel/src/database/runtime-roles.js";

/**
 * KJ-P8 B1 - the stage-aware SECURITY DEFINER inventory of ADR-0023 revision 2.5, section 27.10, without a database:
 * the schema predicate, the static stage binding, the stage sets, the equality rule and the baseline rules. Every rule
 * has a negative case that makes it fail on purpose. The catalogue side is tests/runtime-roles-definers.integration.test.ts.
 */
const manifest = loadStageManifest();
const lf = (t: string) => t.replaceAll("\r\n", "\n");
const hex = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const MIGRATIONS = "supabase/migrations";
const B1 = "20261002090000_runtime_least_privilege_roles.sql";
const releaseMigrations = (): Map<string, string> =>
  new Map(readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().map((f) => [f, hex(lf(readFileSync(`${MIGRATIONS}/${f}`, "utf8")))]));
const clone = (): StageManifest => JSON.parse(JSON.stringify(manifest)) as StageManifest;

describe("27.10.2 governed and excluded schemas", () => {
  it("excludes exactly pg_catalog, information_schema, pg_toast, pg_temp_<n> and pg_toast_temp_<n>", () => {
    for (const s of ["pg_catalog", "information_schema", "pg_toast", "pg_temp_1", "pg_temp_42", "pg_toast_temp_7"]) expect(isExcludedSchema(s), s).toBe(true);
  });
  it("governs every other schema, whatever its name: platform-looking, KernelJSON, near-misses and case variants", () => {
    for (const s of ["public", "kernel_private", "auth", "storage", "extensions", "graphql", "vault", "realtime", "supabase_migrations",
      "pg_temp_", "pg_temp_1x", "pg_temp_-1", "xpg_temp_1", "pg_toast_temp_", "pg_toastx", "PG_CATALOG", "pg_catalog_x", "information_schema2"])
      expect(isExcludedSchema(s), s).toBe(false);
  });
  it("the SQL predicate is the sealed text", () => {
    expect(excludedSchemaSql("n.nspname")).toBe(
      "(n.nspname in ('pg_catalog', 'information_schema', 'pg_toast') or n.nspname ~ '^pg_temp_[0-9]+$' or n.nspname ~ '^pg_toast_temp_[0-9]+$')");
    expect(INVENTORY_SQL).toContain(`where p.prosecdef and not ${excludedSchemaSql("n.nspname")}`);
    expect(INVENTORY_SQL_SHA256).toBe(sha256(INVENTORY_SQL));
  });
});

describe("27.10.3 the KernelJSON stage manifest", () => {
  it("is bound to the sealed design and lists the six stages in rollout order", () => {
    expect(manifest.design).toEqual({ adr: "ADR-0023", revision: "2.6", sha: SEALED_DESIGN });
    expect(SEALED_DESIGN).toBe("7712702020ef5d3d841f68f4d425d9707fb703eb");
    expect(manifest.stages.map((s) => s.stage)).toEqual([...STAGES]);
    expect(manifest.declaredStage).toBe("B1");
  });
  it("has exact stage sets: 1 at B1, 2 from P8A-0 to P8A-2, 3 at P8B", () => {
    const at = (stage: (typeof STAGES)[number]) => stageFunctions(manifest, stage).map((f) => `${identityKey(f)} -> ${f.returns}`);
    const stamp = "kernel_private.stamp_binding_provenance() -> pg_catalog.trigger";
    const freeze = "kernel_private.freeze_reflection(pg_catalog.uuid) -> pg_catalog.void";
    const close = "kernel_private.close_growth_window_by_owner(pg_catalog.uuid, pg_catalog.uuid) -> kernel_private.identity_growth_window_closures";
    expect(at("B1")).toEqual([stamp]);
    for (const s of ["P8A-0", "B2", "P8A-1", "P8A-2"] as const) expect(at(s), s).toEqual([stamp, freeze]);
    expect(at("P8B")).toEqual([stamp, freeze, close]);
  });
  it("pins the section 27.9 exception exactly", () => {
    const [stamp] = stageFunctions(manifest, "B1");
    expect(stamp).toMatchObject({
      retset: false, kind: "f", owner: "<deployment owner>", securityDefiner: true, language: "plpgsql",
      config: ['search_path=""'], acl: ["<deployment owner>=X/<deployment owner>"],
    });
    expect(manifest.stampTrigger).toEqual({
      name: "execution_bindings_provenance", relation: "kernel_private.execution_bindings", tgtype: 7, tgenabled: "O", tgqual: null, tgisinternal: false, tgnargs: 0, tgattr: "",
    });
  });
  it("the stamp source digest pin equals derivation B, recomputed here independently from the applied migration", () => {
    const text = lf(readFileSync(`${MIGRATIONS}/20260916205049_release_provenance.sql`, "utf8"));
    const open = text.indexOf("create function kernel_private.stamp_binding_provenance()");
    const start = text.indexOf("$$", open) + 2, end = text.indexOf("$$", start);
    const derivationB = hex(text.slice(start, end));
    const decisions = JSON.parse(readFileSync("infrastructure/database/runtime-role-decisions.json", "utf8")) as { securityDefinerTriggers: { sourceDigest: string }[] };
    expect(stageFunctions(manifest, "B1")[0]!.sourceDigest).toBe(derivationB);
    expect(decisions.securityDefinerTriggers[0]!.sourceDigest).toBe(derivationB);
  });
  it("the B1 migration does not recreate the stamp function (body immutability, 27.9.2 item 2)", () => {
    const b1 = lf(readFileSync(`${MIGRATIONS}/${B1}`, "utf8")).replace(/--[^\n]*/g, "");
    expect(b1).not.toMatch(/create\s+(or\s+replace\s+)?function\s+kernel_private\.stamp_binding_provenance/i);
    expect(b1).toContain("alter function kernel_private.stamp_binding_provenance() security definer;");
    expect(b1).toContain("alter function kernel_private.stamp_binding_provenance() set search_path = '';");
    // B1 creates no function at all, no later-stage function, and turns exactly one function into a definer.
    expect(b1).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(b1).not.toMatch(/freeze_reflection|close_growth_window_by_owner/);
    expect(b1.match(/alter\s+function\s+[^;]*\bsecurity\s+definer\s*;/gi)).toEqual(["alter function kernel_private.stamp_binding_provenance() security definer;"]);
  });
});

describe("27.10.5 the declared stage is not a free label", () => {
  it("this release carries exactly the B1 stage", () => {
    expect(stageBindingProblems(manifest, releaseMigrations())).toEqual([]);
  });
  it("a release claiming B1 without the B1 migration fails", () => {
    const m = releaseMigrations();
    m.delete(B1);
    expect(stageBindingProblems(manifest, m)).toEqual([`stage B1 migration ${B1} is not in the release`]);
  });
  it("a changed B1 migration, or a changed base migration, fails", () => {
    const m = releaseMigrations();
    m.set(B1, "0".repeat(64));
    m.set("20260916205049_release_provenance.sql", "1".repeat(64));
    const problems = stageBindingProblems(manifest, m);
    expect(problems.some((p) => p.startsWith(`stage B1 migration ${B1} has SHA-256 ${"0".repeat(64)}`))).toBe(true);
    expect(problems.some((p) => p.startsWith("base migration 20260916205049_release_provenance.sql has SHA-256"))).toBe(true);
  });
  it("a release carrying a migration that no implemented stage lists fails (a later stage cannot ride along)", () => {
    const m = releaseMigrations();
    m.set("20261101000000_p8a0_reflection.sql", "2".repeat(64));
    expect(stageBindingProblems(manifest, m)).toEqual(["migration 20261101000000_p8a0_reflection.sql belongs to no implemented stage of B1"]);
  });
  it("relabelling the release as a later stage fails: the stage is not implemented and its pins are empty", () => {
    for (const later of ["P8A-0", "B2", "P8A-1", "P8A-2", "P8B"] as const) {
      const m = clone();
      m.declaredStage = later;
      const problems = stageBindingProblems(m, releaseMigrations());
      expect(problems.some((p) => p.includes("is declared") && p.includes("not implemented")), later).toBe(true);
    }
    const p8a0 = clone();
    p8a0.declaredStage = "P8A-0";
    expect(stageBindingProblems(p8a0, releaseMigrations())).toEqual(expect.arrayContaining([
      "stage P8A-0 declares kernel_private.freeze_reflection(pg_catalog.uuid) with no language pin",
      "stage P8A-0 declares kernel_private.freeze_reflection(pg_catalog.uuid) with no sourceDigest pin",
    ]));
  });
  it("marking a later stage implemented without declaring it fails, and so does an unknown label", () => {
    const m = clone();
    m.stages[1]!.implemented = true;
    expect(stageBindingProblems(m, releaseMigrations())).toEqual(["stage P8A-0 is implemented but the release declares only B1"]);
    const bogus = clone();
    (bogus as unknown as { declaredStage: string }).declaredStage = "P8Z";
    expect(stageBindingProblems(bogus, releaseMigrations())).toEqual([`declared stage P8Z is not one of ${STAGES.join(", ")}`]);
  });
  it("a manifest bound to another design, or with stages out of order, fails", () => {
    const m = clone();
    m.design.sha = "8a17de18b26edd12a9f3af7ab6179552ff0cd20e";
    [m.stages[2], m.stages[3]] = [m.stages[3]!, m.stages[2]!];
    const problems = stageBindingProblems(m, releaseMigrations());
    expect(problems).toContain(`stage manifest is bound to design 8a17de18b26edd12a9f3af7ab6179552ff0cd20e, not ${SEALED_DESIGN}`);
    expect(problems.some((p) => p.startsWith("stage manifest lists stages"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
const OWNER = "postgres";
const row = (o: Partial<DefinerEntry> & { schema: string; name: string; args: string[] }): DefinerEntry => ({
  returns: "pg_catalog.int4", retset: false, kind: "f", owner: "supabase_admin", securityDefiner: true, language: "sql",
  config: null, acl: null, sourceDigest: "a".repeat(64), ...o,
});
const stampRow = row({
  schema: "kernel_private", name: "stamp_binding_provenance", args: [], returns: "pg_catalog.trigger", owner: OWNER, language: "plpgsql",
  config: ['search_path=""'], acl: [`${OWNER}=X/${OWNER}`], sourceDigest: stageFunctions(manifest, "B1")[0]!.sourceDigest!,
});
const platform = [row({ schema: "auth", name: "uid", args: [], returns: "pg_catalog.uuid" }), row({ schema: "storage", name: "search", args: ["pg_catalog.text"] })];
const baselineOf = (entries: DefinerEntry[]): PlatformBaseline => {
  const e = sortEntries(entries).map(baselineEntry);
  return {
    contract: "kerneljson:security-definer-platform-baseline/v1", design: SEALED_DESIGN, environment: "unit",
    provenance: {
      systemIdentifier: "1", database: "x", serverVersion: "PostgreSQL 17", snapshotAt: "2026-10-06T00:00:00.000000Z", snapshotUser: OWNER,
      transaction: { readOnly: true, searchPath: '""' },
      migrationLedger: { table: "supabase_migrations.schema_migrations", present: true, head: "20260929120000", b1Recorded: false, versions: [] },
      stampSecurityDefiner: false, querySha256: INVENTORY_SQL_SHA256,
    },
    entries: e, entriesSha256: sha256(canonicalJson(e)),
  };
};
const baseline = baselineOf(platform);
const actual = sortEntries([...platform, stampRow]);
const diff = (rows: DefinerEntry[], b: PlatformBaseline | null = baseline) => compareDefiners(sortEntries(rows), expectedDefiners(manifest, b, OWNER));

describe("27.10.1 ACTUAL equals EXPECTED(stage), both directions", () => {
  it("passes when ACTUAL is exactly the baseline plus the B1 stage set", () => {
    expect(diff(actual)).toEqual({ missing: [], extra: [], mismatched: [] });
  });
  it("an extra definer fails, wherever it is", () => {
    for (const extra of [row({ schema: "public", name: "x", args: [] }), row({ schema: "auth", name: "late", args: [] }), row({ schema: "kj_app", name: "x", args: [] })])
      expect(diff([...actual, extra]).extra, identityKey(extra)).toEqual([identityKey(extra)]);
  });
  it("a later-stage function present at B1 is extra", () => {
    const freeze = row({ schema: "kernel_private", name: "freeze_reflection", args: ["pg_catalog.uuid"], returns: "pg_catalog.void" });
    expect(diff([...actual, freeze]).extra).toEqual(["kernel_private.freeze_reflection(pg_catalog.uuid)"]);
  });
  it("a missing definer fails, platform or KernelJSON", () => {
    expect(diff(actual.filter((r) => r.name !== "uid")).missing).toEqual(["auth.uid()"]);
    expect(diff(actual.filter((r) => r !== stampRow)).missing).toEqual(["kernel_private.stamp_binding_provenance()"]);
  });
  it("a moved function or changed arguments is missing and extra", () => {
    const moved = actual.map((r) => (r.name === "uid" ? { ...r, schema: "extensions" } : r));
    expect(diff(moved)).toMatchObject({ missing: ["auth.uid()"], extra: ["extensions.uid()"] });
    const reargued = actual.map((r) => (r.name === "search" ? { ...r, args: ["pg_catalog.varchar"] } : r));
    expect(diff(reargued)).toMatchObject({ missing: ["storage.search(pg_catalog.text)"], extra: ["storage.search(pg_catalog.varchar)"] });
  });
  it.each([
    ["returns", "pg_catalog.text"], ["retset", true], ["kind", "p"], ["owner", "someone_else"], ["language", "plpgsql"],
    ["config", ["search_path=public"]], ["sourceDigest", "b".repeat(64)],
  ] as const)("a platform entry with a changed %s fails", (field, value) => {
    const changed = actual.map((r) => (r.name === "uid" ? { ...r, [field]: value } : r));
    expect(diff(changed).mismatched.some((m) => m.startsWith(`auth.uid() ${field}:`))).toBe(true);
  });
  it.each([
    ["owner", "kj_worker"], ["language", "sql"], ["config", null], ["config", ['search_path=""', "work_mem=1MB"]],
    ["acl", null], ["acl", [`${OWNER}=X/${OWNER}`, `kj_worker=X/${OWNER}`]], ["acl", [`${OWNER}=X/${OWNER}`, `=X/${OWNER}`]], ["sourceDigest", "c".repeat(64)],
  ] as const)("the stamp function with %s = %j fails", (field, value) => {
    const changed = actual.map((r) => (r === stampRow ? { ...r, [field]: value } : r));
    expect(diff(changed).mismatched.some((m) => m.startsWith(`kernel_private.stamp_binding_provenance() ${field}:`))).toBe(true);
  });
});

describe("27.10.4 the frozen platform baseline", () => {
  it("a well-formed baseline has no problems", () => {
    expect(baselineProblems(baseline, manifest)).toEqual([]);
  });
  it("tampered entries, a different query, a post-B1 snapshot and a non-canonical order are each refused", () => {
    expect(baselineProblems({ ...baseline, entries: baseline.entries.map((e) => ({ ...e, owner: "x" })) }, manifest)).toContain("platform baseline entries do not match entriesSha256");
    expect(baselineProblems({ ...baseline, provenance: { ...baseline.provenance, querySha256: "0".repeat(64) } }, manifest)).toContain("platform baseline was taken with a different inventory query");
    expect(baselineProblems({ ...baseline, provenance: { ...baseline.provenance, stampSecurityDefiner: true } }, manifest)).toContain("platform baseline was taken after B1");
    const reversed = [...baseline.entries].reverse();
    expect(baselineProblems({ ...baseline, entries: reversed, entriesSha256: sha256(canonicalJson(reversed)) }, manifest)).toContain("platform baseline entries are not in canonical order");
  });
  it("cannot contain public or kernel_private, the stamp name, or a stage-manifest identity", () => {
    const ineligible = [
      row({ schema: "public", name: "helper", args: [] }),
      row({ schema: "kernel_private", name: "x", args: [] }),
      row({ schema: "auth", name: "stamp_binding_provenance", args: [] }),
      row({ schema: "kernel_private", name: "close_growth_window_by_owner", args: ["pg_catalog.uuid", "pg_catalog.uuid"] }),
    ];
    const problems = baselineEligibilityProblems(ineligible, manifest);
    expect(problems).toEqual([
      "public.helper() is in KernelJSON schema public",
      "kernel_private.x() is in KernelJSON schema kernel_private",
      "auth.stamp_binding_provenance() is named stamp_binding_provenance",
      "kernel_private.close_growth_window_by_owner(pg_catalog.uuid, pg_catalog.uuid) is in KernelJSON schema kernel_private",
      "kernel_private.close_growth_window_by_owner(pg_catalog.uuid, pg_catalog.uuid) is a KernelJSON stage-manifest function",
    ]);
    // ...and a baseline that slipped one in is refused as a whole.
    expect(baselineProblems(baselineOf([...platform, ineligible[2]!]), manifest)).toContain("auth.stamp_binding_provenance() is named stamp_binding_provenance");
  });
  it("without a baseline nothing is learned: the platform half is unknown and stays red (see definerInventoryProblems)", () => {
    expect(diff(actual, null).extra).toEqual(["auth.uid()", "storage.search(pg_catalog.text)"]);
  });
});

describe("RFC 8785 canonical JSON", () => {
  it("sorts keys at every depth and is stable", () => {
    expect(canonicalJson({ b: [true, null, { z: "1", a: "2" }], a: "x" })).toBe('{"a":"x","b":[true,null,{"a":"2","z":"1"}]}');
    expect(() => canonicalJson({ n: 1 })).toThrow(/unsupported/);
  });
});

describe("27.11 runtime capability facts (static)", () => {
  it("the table privilege vocabulary is exactly the seven PostgreSQL defines", () => {
    expect([...TABLE_PRIVILEGES]).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);
  });
  it("manifest function facts are exact identities and the migration grants exactly those, never by name", () => {
    const runtime = loadManifest();
    const identity = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\((?:[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*(?:, [a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)*)?\)$/;
    const keys = Object.values(runtime.roles).flatMap((r) => Object.keys(r.functions));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k, k).toMatch(identity);
    const b1 = lf(readFileSync(`${MIGRATIONS}/${B1}`, "utf8"));
    for (const k of Object.keys(runtime.roles.kj_worker.functions)) expect(b1).toContain(`grant execute on function ${k} to kj_worker;`);
    expect(b1).not.toContain("grant execute on function %s"); // no grant loop over every overload of a name
  });
});

describe("27.11.6 snapshot hardening (static)", () => {
  const ok = "postgresql://owner@db.example.internal:5432/postgres";
  it("accepts exactly one explicit postgres URL, with or without one trailing newline", () => {
    expect(parseConnectionFile(ok)).toEqual({ connectionString: ok });
    expect(parseConnectionFile(`${ok}\n`)).toEqual({ connectionString: ok });
    expect(parseConnectionFile(`\uFEFF${ok}\r\n`)).toEqual({ connectionString: ok });
  });
  it.each([
    ["an empty file", "", "empty or whitespace only"],
    ["a whitespace-only file", "   \n", "empty or whitespace only"],
    ["a NUL byte", `${ok}\0`, "NUL byte"],
    ["two lines", `${ok}\n${ok}`, "more than one line"],
    ["a trailing blank line", `${ok}\n\n`, "more than one line"],
    ["surrounding spaces", ` ${ok} `, "leading or trailing whitespace"],
    ["not a URL", "host=db user=owner", "does not hold a URL"],
    ["another scheme", "mysql://owner@db/x", "not a postgres URL"],
    ["no host (socket or PGHOST fallback)", "postgresql:///postgres", "must name the host, the user and the database"],
    ["no user (PGUSER fallback)", "postgresql://db.example.internal/postgres", "must name the host, the user and the database"],
    ["no database (PGDATABASE fallback)", "postgresql://owner@db.example.internal", "must name the host, the user and the database"],
  ])("refuses %s, without echoing the content", (_label, raw, message) => {
    let error: Error | undefined;
    try { parseConnectionFile(raw); } catch (e) { error = e as Error; }
    expect(error?.message).toMatch(/^CONNECTION_FILE_REFUSED: /);
    expect(error?.message).toContain(message);
    expect(error?.message).not.toContain("owner@");
  });
  it("scrubs every PG* variable so no default can fill a gap", () => {
    const env: NodeJS.ProcessEnv = { PGHOST: "x", PGPASSWORD: "y", PGSSLMODE: "z", PATH: "p", KJ: "k" };
    expect(scrubPgEnvironment(env)).toEqual(["PGHOST", "PGPASSWORD", "PGSSLMODE"]);
    expect(env).toEqual({ PATH: "p", KJ: "k" });
  });
  it("the expected ledger head is the final base migration before B1", () => {
    const last = manifest.baseMigrations.at(-1)!.file;
    expect(expectedLedgerHead(manifest)).toBe(last.slice(0, 14));
    expect(last < B1).toBe(true);
  });
});

describe("snapshot ledger gate: the exact base migration version set, not only the head", () => {
  const expected = expectedLedgerVersions(manifest);
  it("is the 22 base migrations of the stage manifest, ending at the expected head", () => {
    expect(expected).toHaveLength(manifest.baseMigrations.length);
    expect(expected).toHaveLength(22);
    expect(expected.at(-1)).toBe(expectedLedgerHead(manifest));
  });
  it("accepts exactly that set, in any order", () => {
    expect(ledgerSetProblems([...expected].reverse(), expected)).toBeNull();
  });
  it("refuses a gapped ledger whose head is still correct (manually applied, unrecorded migrations)", () => {
    const gapped = expected.filter((_, i) => i < 10 || i > 13);
    expect(gapped.at(-1)).toBe(expected.at(-1));
    expect(ledgerSetProblems(gapped, expected)).toBe(
      `the migration ledger does not record exactly the 22 base migrations before B1; missing ${expected.slice(10, 14).join(", ")}`);
  });
  it("refuses an extra row, a duplicated row and an empty ledger", () => {
    expect(ledgerSetProblems([...expected, "20261101000000"], expected)).toContain("; unexpected 20261101000000");
    expect(ledgerSetProblems([...expected, expected[0]!], expected)).toContain("; duplicated versions");
    expect(ledgerSetProblems([], expected)).toContain(`; missing ${expected.join(", ")}`);
  });
});
