import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { strictJson } from "../services/kernel/src/database/strict-json.js";
import { PartitionSchema, partitionProblems, type Partition } from "../scripts/b1/coverage.js";
import { COLLECTION_ARGS, COLLECTION_FLAGS, collectTests, collectionEnvironment, type CollectedEntry } from "../scripts/b1/collection.js";
import { REGRESSION_SUITES, SUITE_PLANS } from "../scripts/b1/plans.js";

/**
 * ADR-0023 27.12.15 coverage partition and the pinned collection (CON-24, CON-25, CON-26, CON-47), each rule with a
 * failing fixture. The collection runs the Vitest of the lockfile with the repository's Node, exactly as pinned, with a
 * listener on the placeholder that must accept no connection.
 */
const PARTITION_PATH = "tests/lanes.json";
const committed = () => readdirSync("tests").filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`).sort();
const partition = (): Partition => PartitionSchema.parse(strictJson(readFileSync(PARTITION_PATH, "utf8")));
let collection: CollectedEntry[] = [];
let acceptedConnections = -1;
beforeAll(async () => {
  const result = await collectTests(process.cwd());
  collection = result.entries; acceptedConnections = result.acceptedConnections;
}, 900_000);

describe("CON-47 the pinned collection", () => {
  it("runs exactly the pinned command and environment", () => {
    expect(COLLECTION_ARGS).toEqual(["node_modules/vitest/vitest.mjs", "list", "--no-static-parse", "--includeTaskLocation", "--json"]);
    expect(COLLECTION_FLAGS).toEqual({ S1R_LIVE: "1", S1B_REARM_LIVE: "1", S1R_RUNTIME: "1", KJ_GATE3_LIVE: "1",
      KJ_TEST_PG_URL: "postgresql://kj_collect_placeholder@127.0.0.1:54999/kj_collect_placeholder" });
    const env = collectionEnvironment("linux", { PATH: "/p", HOME: "/h", TMPDIR: "/t", DATABASE_URL: "x", PGHOST: "y", KJ_OTHER: "z" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "KJ_GATE3_LIVE", "KJ_TEST_PG_URL", "PATH", "S1B_REARM_LIVE", "S1R_LIVE", "S1R_RUNTIME", "TMPDIR"]);
  });
  it("collects every committed test file, every entry located, with no connection to the placeholder", () => {
    expect(acceptedConnections).toBe(0);
    expect([...new Set(collection.map((e) => e.file))].sort()).toEqual(committed());
    expect(collection.every((e) => e.location.line > 0 && e.location.column > 0)).toBe(true);
  });
});

describe("the coverage partition (tests/lanes.json)", () => {
  const registry = REGRESSION_SUITES.map((s) => ({ id: s.id, files: [...s.files] }));
  it("assigns every committed test file to exactly one primary suite, and matches the registry and collection", () => {
    expect(partitionProblems(partition(), committed(), collection, registry)).toEqual([]);
  });
  it("CON-26 refuses a file listed twice (duplicate key)", () => {
    const text = readFileSync(PARTITION_PATH, "utf8").replace('"tests/world.test.ts": "regression-enforce"', '"tests/world.test.ts": "regression-enforce",\n    "tests/world.test.ts": "base-regression"');
    expect(() => strictJson(text)).toThrow();
  });
  it("CON-24 refuses a new test file with no entry, and an entry with no file", () => {
    expect(partitionProblems(partition(), [...committed(), "tests/new-file.test.ts"], collection, registry)).toContain("committed test file partition differs");
    const p = partition(); p.files["tests/vanished.test.ts"] = "base-regression";
    expect(partitionProblems(p, committed(), collection, registry)).toContain("committed test file partition differs");
  });
  it("CON-26 refuses a stage T suite whose registry files differ from its partition files", () => {
    const changed = registry.map((s) => s.id === "regression-gated" ? { ...s, files: s.files.slice(1) } : s);
    expect(partitionProblems(partition(), committed(), collection, changed)).toContain("registry files differ: regression-gated");
  });
  it("binds the four notRunInCi files and no other", () => {
    const p = partition(); p.notRunInCi = p.notRunInCi.slice(1);
    expect(partitionProblems(p, committed(), collection, registry)).toContain("notRunInCi differs");
  });
});

describe("CON-25 and plan selection: what a stage T file may use", () => {
  const lanes = partition();
  const stageT = Object.entries(lanes.files).filter(([, s]) => s.startsWith("regression-")).map(([f]) => f);
  const laneA = Object.entries(lanes.files).filter(([, s]) => s === "base-regression").map(([f]) => f);
  const helpersImported = (text: string) => {
    const local = /import \{([^}]*)\} from "\.\/support\/local\.js"/.exec(text)?.[1] ?? "";
    return local.split(",").map((n) => n.trim()).filter((n) => ["migrate", "DATABASE"].includes(n));
  };
  it("no stage T file imports a lane A helper or the base adapter", () => {
    for (const file of stageT) {
      const text = readFileSync(file, "utf8");
      expect(helpersImported(text), file).toEqual([]);
      expect(text, file).not.toMatch(/support\/base-database|create database|drop database|createDatabase/i);
    }
  });
  it("a lane D file importing a lane A helper fails the rule", () => {
    expect(helpersImported('import { DATABASE, until } from "./support/local.js";')).toEqual(["DATABASE"]);
  });
  // A stage T suite runs in a fresh empty working directory (27.12.15 "Process"): a repository path is resolved through
  // tests/support/repo.ts, a child process is given cwd REPO_ROOT, and nothing names a file under supabase/migrations/.
  const cwdRelative = (text: string) => [
    ...[...text.matchAll(/\b(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|execFileSync|execSync)\(\s*["'`](?:apps|services|packages|runtimes|scripts|supabase|tests|infrastructure|docs|evals)\b[^"'`]*["'`]/g)].map((m) => m[0]),
    ...[...text.matchAll(/\bspawn(?:Sync)?\([^;]*?\[\s*"--import",\s*"tsx",\s*"(?:tests|services|apps|scripts)\/[^"]+"[^\]]*\]\s*,\s*\{(?![^}]*\bcwd:)/g)].map((m) => m[0].slice(0, 80)),
    ...[...text.matchAll(/build-manifest\.mjs/g)].map((m) => m[0]),
  ];
  it("no stage T file resolves a repository path against the working directory or reads a migration", () => {
    for (const file of stageT) expect(cwdRelative(readFileSync(file, "utf8")), file).toEqual([]);
  });
  it("a cwd-relative read, a spawn without cwd and a migration path each fail the rule", () => {
    expect(cwdRelative('readFileSync("tests/fixtures/x.json", "utf8")')).toHaveLength(1);
    expect(cwdRelative('spawn(process.execPath, ["--import", "tsx", "tests/support/w.ts"], { env: {} })')).toHaveLength(1);
    expect(cwdRelative('spawn(process.execPath, ["--import", "tsx", "tests/support/w.ts"], { cwd: REPO_ROOT, env: {} })')).toHaveLength(0);
    expect(cwdRelative('execFileSync("node", ["scripts/b1/build-manifest.mjs", "--check"])')).toHaveLength(1);
    expect(cwdRelative('readFile(`supabase/migrations/${f}`)')).toHaveLength(1);
  });
  it("no lane A database-backed file names a runtime role", () => {
    for (const file of laneA) {
      const text = readFileSync(file, "utf8");
      if (!/testDatabase\(|knowledgeDatabase\(|from "\.\/support\/local\.js"/.test(text)) continue;
      expect(text.match(/\bkj_(worker|door)\b/g) ?? [], file).toEqual([]);
    }
  });
  it("every stage T suite's plan holds exactly the databases its files name, each by string literal", () => {
    for (const suite of REGRESSION_SUITES) {
      const named = new Set<string>();
      for (const file of suite.files) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/"(kj_[a-z0-9_]+)"/g)) named.add(m[1]!);
        // The six gated files name their shared plan database through tests/support/database.ts gatedDatabaseUrl().
        if (text.includes("gatedDatabaseUrl()")) named.add("kj_gated");
      }
      const plan = SUITE_PLANS[suite.id]!.entries.map((e) => e.database);
      for (const db of plan) expect(named.has(db), `${suite.id}: ${db} not named by its files`).toBe(true);
      expect(new Set(plan).size).toBe(plan.length);
    }
  });
});
