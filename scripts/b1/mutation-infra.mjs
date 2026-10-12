// KJ-P8 B1 A10.7 2-R4e: the shared G7 infrastructure-result module. CLASSIFICATION ONLY, NO AUTHENTICITY (2-R4e(0)):
// test code runs with the same OS permissions as the verifier and the driver and can write any file they can; the
// per-invocation nonce detects stale or crossed results, it authenticates nobody. Stays within F-4.
//
// The verifier (scripts/b1/verify-engine-image.ts) writes one attempt record per file (started, then completed or
// failed). After the vitest child exits, a driver accepts an invocation only if the records and the JSON report are
// complete and consistent (acceptInvocation). Otherwise it restores, prints INFRASTRUCTURE FAILURE and tallies nothing.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const INFRA_EXIT = 3;
export const VERIFIER_PREFIX = "ENGINE_IMAGE_REFUSED";
export const RECORD_KIND = "kerneljson:g7-attempt/v1";
export const ENV = { nonce: "KJ_G7_NONCE", label: "KJ_G7_LABEL", dir: "KJ_G7_RESULTS" };

/**
 * Committed G7 database-backed test files, by the route they reach the lane A database. Each list is held equal to a
 * scan of the committed sources (databaseFileProblems, a static G1 check in tests/b1-gates.test.ts): checked, not
 * trusted. 2-R4e(1) names only the first route; the other two reach the same engine and are covered as well.
 */
export const G7_DB_FILES = Object.freeze({
  /** the source calls testDatabase( (the base factory, tests/support/base-database.ts) */
  testDatabase: ["tests/alert-runner.integration.test.ts", "tests/b1-relation-inventory.integration.test.ts", "tests/control-signing-store.integration.test.ts", "tests/database.test.ts", "tests/health-collect-postgres.integration.test.ts", "tests/identity-cognition-restate.integration.test.ts", "tests/identity-cognition.integration.test.ts", "tests/identity-workflow.integration.test.ts", "tests/mission-workflow.integration.test.ts", "tests/recovery.test.ts", "tests/runtime-roles-catalogue.integration.test.ts", "tests/runtime-roles-connection.integration.test.ts", "tests/runtime-roles-coresident-probes.integration.test.ts", "tests/runtime-roles-definers-base.integration.test.ts", "tests/runtime-roles-definers.integration.test.ts", "tests/runtime-roles-log-fixture.integration.test.ts", "tests/runtime-roles-negative.integration.test.ts", "tests/telegram-approvals-store.integration.test.ts", "tests/telegram-approvals.integration.test.ts", "tests/telegram-channel.integration.test.ts", "tests/telegram-memory.integration.test.ts", "tests/test-notification.integration.test.ts"],
  /** the source imports tests/support/knowledge-db.ts, which calls testDatabase( */
  knowledgeDb: ["tests/authority.test.ts", "tests/controls.test.ts", "tests/evaluation-db.test.ts", "tests/execution-binding.test.ts", "tests/gateway.test.ts", "tests/identity-migration.integration.test.ts", "tests/memory-canonical.integration.test.ts", "tests/memory.test.ts", "tests/mission-control.test.ts", "tests/release-provenance-base.integration.test.ts", "tests/release-provenance-postgres.test.ts", "tests/schedule-db.test.ts", "tests/terminal-hardening.test.ts", "tests/world.test.ts"],
  /** the source calls migrate( from tests/support/local.ts on its own DATABASE pool (verified inside migrate) */
  migrate: ["tests/gate3-executor.integration.test.ts", "tests/identity-cognition-base.integration.test.ts", "tests/identity-migration-base.integration.test.ts", "tests/schedule-restate-live.integration.test.ts", "tests/schedule-restate-rearm-live.integration.test.ts", "tests/schedule-restate-runtime.integration.test.ts"],
});
export const allDatabaseFiles = () => [...new Set(Object.values(G7_DB_FILES).flat())].sort();

/** Static check: each committed list equals the scan of tests/*.test.ts for its route. */
export function scanDatabaseFiles(root) {
  const files = readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `tests/${f}`);
  const src = (f) => readFileSync(join(root, f), "utf8");
  return {
    testDatabase: files.filter((f) => src(f).includes("testDatabase(")),
    knowledgeDb: files.filter((f) => /from\s+["']\.\/support\/knowledge-db\.js["']/.test(src(f))),
    migrate: files.filter((f) => /\bmigrate\(/.test(src(f)) && /from\s+["']\.\/support\/local\.js["']/.test(src(f))),
  };
}
export function databaseFileProblems(root, lists = G7_DB_FILES) {
  const scan = scanDatabaseFiles(root), out = [];
  for (const key of ["testDatabase", "knowledgeDb", "migrate"]) {
    const want = [...(lists[key] ?? [])].sort(), have = scan[key];
    if (JSON.stringify(want) !== JSON.stringify(have)) out.push(`G7 database file list ${key} differs from the committed sources: listed ${JSON.stringify(want)}, found ${JSON.stringify(have)}`);
  }
  if (Object.keys(lists).some((k) => !(k in scan))) out.push("G7 database file list has an unknown route");
  return out;
}

const posix = (p) => p.split(sep).join("/");
export const repoRelative = (root, file) => posix(isAbsolute(file) ? relative(root, file) : file);

// ---------- attempt records (written by the verifier, read by the driver) ----------
const STR = (v) => typeof v === "string" && v.length > 0;
const ISO = (v) => STR(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const HEX64 = /^[0-9a-f]{64}$/;
const FIELDS = {
  started: ["kind", "phase", "nonce", "label", "attemptId", "file", "startedAt"],
  completed: ["kind", "phase", "nonce", "label", "attemptId", "file", "containerId", "imageId", "digest", "repoDigestMatch", "binding", "version", "serverPort", "systemIdentifier", "completedAt"],
  failed: ["kind", "phase", "nonce", "label", "attemptId", "file", "check", "error", "failedAt"],
};
/** Strict schema; returns problems ([] when the record is well formed). */
export function recordShapeProblems(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return ["record is not an object"];
  const fields = FIELDS[r.phase];
  if (!fields) return [`record phase ${JSON.stringify(r.phase)} is unknown`];
  const keys = Object.keys(r).sort(), want = [...fields].sort();
  if (JSON.stringify(keys) !== JSON.stringify(want)) return [`record fields differ: ${JSON.stringify(keys)}`];
  const p = [];
  if (r.kind !== RECORD_KIND) p.push("record kind differs");
  for (const k of ["nonce", "label", "attemptId", "file"]) if (!STR(r[k])) p.push(`record ${k} is empty`);
  if (!/^[0-9a-f]{32}$/.test(r.nonce ?? "")) p.push("record nonce is malformed");
  if (!/^[0-9a-f-]{36}$/.test(r.attemptId ?? "")) p.push("record attemptId is malformed");
  const at = r.startedAt ?? r.completedAt ?? r.failedAt;
  if (!ISO(at)) p.push("record timestamp is malformed");
  if (r.phase === "completed") {
    if (!HEX64.test(r.containerId)) p.push("record containerId is malformed");
    if (!/^sha256:[0-9a-f]{64}$/.test(r.imageId)) p.push("record imageId is malformed");
    if (!/^postgres@sha256:[0-9a-f]{64}$/.test(r.digest)) p.push("record digest is malformed");
    if (r.repoDigestMatch !== true) p.push("record repoDigestMatch is not true");
    if (!/^127\.0\.0\.1:[0-9]{1,5}$/.test(r.binding)) p.push("record binding is malformed");
    if (!STR(r.version)) p.push("record version is empty");
    if (!Number.isInteger(r.serverPort)) p.push("record serverPort is not an integer");
    if (!/^[0-9]{1,20}$/.test(r.systemIdentifier)) p.push("record systemIdentifier is malformed");
  }
  if (r.phase === "failed" && (!STR(r.check) || typeof r.error !== "string")) p.push("failed record lacks check or error");
  return p;
}
/** Atomic write (write, fsync, rename), one file per record. Throws when the directory is absent or unwritable. */
export function writeAttemptRecord(dir, record) {
  const problems = recordShapeProblems(record);
  if (problems.length) throw Error(`${VERIFIER_PREFIX}: attempt record: ${problems.join("; ")}`);
  const final = join(dir, `${record.attemptId}.${record.phase}.json`), temp = `${final}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx");
  try { writeSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, final);
}
/** The record context of the current process, or null when no G7 driver started it. Partial context is refused. */
export function attemptContext(env = process.env) {
  const v = [ENV.nonce, ENV.label, ENV.dir].map((k) => env[k]);
  if (v.every((x) => x === undefined)) return null;
  if (v.some((x) => !STR(x))) throw Error(`${VERIFIER_PREFIX}: partial G7 attempt context`);
  return { nonce: v[0], label: v[1], dir: v[2] };
}
export const newAttemptId = () => randomUUID();

// ---------- invocation context ----------
/** Fresh nonce and a fresh, empty results directory outside the working tree (2-R4e(1)). */
export function createInvocation(label, root = process.cwd()) {
  const dir = mkdtempSync(join(tmpdir(), "kj-g7-"));
  const rel = relative(resolve(root), dir);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw Error("INFRASTRUCTURE FAILURE: results directory is inside the working tree");
  const createdAt = new Date(statSync(dir).birthtimeMs || statSync(dir).mtimeMs);
  const nonce = randomBytes(16).toString("hex");
  return { label, nonce, dir, createdAt: new Date(Math.floor(createdAt.getTime() / 1000) * 1000), env: { [ENV.nonce]: nonce, [ENV.label]: label, [ENV.dir]: dir } };
}
export function readRecords(dir) {
  const out = [], problems = [];
  let names;
  try { names = readdirSync(dir).sort(); } catch (e) { return { records: out, problems: [`results directory unreadable: ${e.message}`] }; }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.(started|completed|failed)\.json$/.test(name)) { problems.push(`unexpected file in results directory: ${name}`); continue; }
    let r;
    try { r = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { problems.push(`malformed record ${name}`); continue; }
    const shape = recordShapeProblems(r);
    if (shape.length) { problems.push(`malformed record ${name}: ${shape.join("; ")}`); continue; }
    if (name !== `${r.attemptId}.${r.phase}.json`) { problems.push(`record ${name} is misnamed`); continue; }
    out.push(r);
  }
  return { records: out, problems };
}

/**
 * 2-R4e(2). `files` are the files passed to this invocation, `dbFiles` the expected database-backed subset, `pre` the
 * driver's own pre-invocation check ({containerId, digest, binding, systemIdentifier}).
 */
export function recordProblems(records, inv, { files, dbFiles, pre }) {
  const p = [], inFiles = new Set(files);
  for (const r of records) {
    if (r.nonce !== inv.nonce || r.label !== inv.label) p.push(`stale or crossed record ${r.attemptId} (${r.phase}): nonce or label differs`);
    const at = Date.parse(r.startedAt ?? r.completedAt ?? r.failedAt);
    if (at < inv.createdAt.getTime()) p.push(`stale record ${r.attemptId}: older than the results directory`);
    if (!inFiles.has(r.file)) p.push(`record ${r.attemptId} names a file outside the invocation: ${r.file}`);
  }
  const by = (phase) => records.filter((r) => r.phase === phase);
  for (const f of by("failed")) p.push(`verification failed in ${f.file}: ${f.check}: ${f.error}`);
  const starts = by("started"), done = by("completed");
  const ids = new Map();
  for (const r of records) { const k = `${r.attemptId}.${r.phase}`; if (ids.has(k)) p.push(`duplicate record ${k}`); ids.set(k, r); }
  for (const s of starts) {
    const c = done.filter((d) => d.attemptId === s.attemptId);
    const f = by("failed").filter((d) => d.attemptId === s.attemptId);
    if (c.length + f.length === 0) p.push(`unmatched start ${s.attemptId} in ${s.file} (interrupted or crashed verification)`);
    if (c.some((d) => d.file !== s.file)) p.push(`attempt ${s.attemptId} changes file`);
  }
  for (const d of [...done, ...by("failed")]) if (!starts.some((s) => s.attemptId === d.attemptId)) p.push(`${d.phase} record ${d.attemptId} has no started record`);
  for (const f of dbFiles) if (inFiles.has(f) && !done.some((d) => d.file === f)) p.push(`missing coverage: no completed verification for ${f}`);
  for (const d of done) {
    for (const k of ["containerId", "digest", "binding", "systemIdentifier"])
      if (!pre || d[k] !== pre[k]) { p.push(`record ${d.attemptId} ${k} differs from the driver's pre-invocation check`); break; }
  }
  return p;
}

const nameOf = (a) => [...(a.ancestorTitles ?? []), a.title].join(" > ");
/**
 * 2-R4e(3), regardless of `success`. `tests` maps each file to its test names from `vitest list --json` on the
 * unmutated tree with the same filter. A report test absent from `tests` must be statically skipped (vitest list omits
 * skipIf'd tests; measured on 5.0.0).
 */
export function reportProblems(report, { root, files, tests }) {
  const p = [];
  if (!report || typeof report !== "object") return ["vitest JSON report missing or not an object"];
  const nums = ["numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites", "numPendingTestSuites", "numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"];
  for (const k of nums) if (!Number.isInteger(report[k]) || report[k] < 0) p.push(`report ${k} is missing or invalid`);
  if (typeof report.success !== "boolean" || !Array.isArray(report.testResults)) { p.push("report success or testResults missing"); return p; }
  const results = report.testResults.map((t) => ({ ...t, rel: repoRelative(root, String(t.name ?? "")) }));
  const names = results.map((t) => t.rel).sort(), want = [...files].sort();
  if (JSON.stringify(names) !== JSON.stringify(want)) p.push(`report files ${JSON.stringify(names)} differ from the invocation's ${JSON.stringify(want)}`);
  let sum = 0;
  for (const t of results) {
    if (!Array.isArray(t.assertionResults)) { p.push(`report ${t.rel} lacks assertionResults`); continue; }
    sum += t.assertionResults.length;
    const got = t.assertionResults.map(nameOf), expected = tests.get(t.rel) ?? [];
    for (const n of expected) if (!got.includes(n)) p.push(`report ${t.rel} lacks test ${JSON.stringify(n)}`);
    for (const a of t.assertionResults) if (!expected.includes(nameOf(a)) && !["skipped", "pending", "todo"].includes(a.status)) p.push(`report ${t.rel} has an unlisted test ${JSON.stringify(nameOf(a))}`);
    if (got.length !== new Set(got).size) p.push(`report ${t.rel} has duplicate test names`);
    for (const a of t.assertionResults) for (const m of a.failureMessages ?? []) if (fatalMessage(m)) p.push(`report ${t.rel} test ${JSON.stringify(nameOf(a))}: ${fatalMessage(m)}`);
    if (t.message && fatalMessage(t.message)) p.push(`report ${t.rel}: ${fatalMessage(t.message)}`);
  }
  if (p.some((x) => x.includes("missing or invalid"))) return p;
  if (report.numTotalTests !== sum) p.push(`report numTotalTests ${report.numTotalTests} differs from the ${sum} listed assertions`);
  if (report.numPassedTests + report.numFailedTests + report.numPendingTests + report.numTodoTests !== report.numTotalTests) p.push("report test counts are inconsistent");
  if (report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites !== report.numTotalTestSuites) p.push("report suite counts are inconsistent");
  const failedFiles = results.filter((t) => t.status === "failed").length;
  if (report.numFailedTestSuites < failedFiles || report.numTotalTestSuites < results.length) p.push("report suite counts disagree with the per-file statuses");
  const failedAssertions = results.flatMap((t) => t.assertionResults ?? []).filter((a) => a.status === "failed").length;
  if (failedAssertions !== report.numFailedTests) p.push("report numFailedTests disagrees with the assertions");
  if (report.success !== (report.numFailedTests === 0 && report.numFailedTestSuites === 0)) p.push("report success disagrees with its counts");
  return p;
}
/** 2-R4e(4)(b): the verifier's error prefix or vitest's process.exit interception is FATAL wherever it appears. */
export function fatalMessage(text) {
  const s = String(text ?? "").replace(/\s+/g, " ");
  if (s.includes(VERIFIER_PREFIX)) return `verifier error: ${s.slice(s.indexOf(VERIFIER_PREFIX), s.indexOf(VERIFIER_PREFIX) + 200)}`;
  if (s.includes("process.exit unexpectedly called")) return "process.exit unexpectedly called in a worker";
  return null;
}

/** 2-R4e(2)-(4) for one finished invocation. Returns {ok, problems}; never reads a worker exit code. */
export function acceptInvocation({ inv, root, files, dbFiles, tests, reportPath, pre, spawnError }) {
  const p = [];
  if (spawnError) p.push(`vitest child did not complete: ${spawnError}`);
  const { records, problems } = readRecords(inv.dir);
  p.push(...problems, ...recordProblems(records, inv, { files, dbFiles, pre }));
  let report = null;
  if (!existsSync(reportPath)) p.push("vitest JSON report is missing");
  else try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { p.push("vitest JSON report does not parse"); }
  if (report) p.push(...reportProblems(report, { root, files, tests }));
  return { ok: p.length === 0, problems: p, report, records };
}

// ---------- process helpers used by the four drivers ----------
/** process.env plus overrides; an undefined override removes the variable (spawn would pass the text "undefined"). */
export function childEnv(overrides) {
  const env = { ...process.env, DOCKER_CONTEXT: "default", CI: "true" };
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete env[k]; else env[k] = v;
  return env;
}
/** Runs the repository vitest with a JSON report. Returns {code, signal, error, out}. */
export function runVitest(args, { cwd = process.cwd(), env = {}, timeout = 900_000, vitest = join(cwd, "node_modules/vitest/vitest.mjs") } = {}) {
  const r = spawnSync(process.execPath, [vitest, ...args], { cwd, encoding: "utf8", env: childEnv(env), timeout, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  const error = r.error ? r.error.message : r.signal ? `terminated by ${r.signal}` : null;
  return { code: r.status, signal: r.signal, error, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
/** `vitest list --json` once, on the unmutated tree, with the same files and filter: Map<file, testName[]>. */
export function listTests(files, { cwd = process.cwd(), filter = [], env = {}, vitest } = {}) {
  const out = join(mkdtempSync(join(tmpdir(), "kj-g7-list-")), "list.json");
  try {
    const r = runVitest(["list", ...files, ...filter, `--json=${out}`], { cwd, env: { ...env, [ENV.nonce]: undefined, [ENV.label]: undefined, [ENV.dir]: undefined }, timeout: 300_000, vitest });
    if (r.error || r.code !== 0 || !existsSync(out)) throw Error(`INFRASTRUCTURE FAILURE: vitest list failed (${r.error ?? `exit ${r.code}`}): ${r.out.slice(-400)}`);
    const rows = JSON.parse(readFileSync(out, "utf8"));
    const map = new Map(files.map((f) => [f, []]));
    for (const row of rows) { const f = repoRelative(cwd, row.file); if (!map.has(f)) throw Error(`INFRASTRUCTURE FAILURE: vitest list named ${f}`); map.get(f).push(row.name); }
    return map;
  } finally { rmSync(join(out, ".."), { recursive: true, force: true }); }
}
/** The driver's pre-invocation check (2-R4a, 2-R4b): the same verifier module, as its CLI, against `docker compose ps -q db`. */
export function preInvocationCheck({ cwd = process.cwd(), command } = {}) {
  const [cmd, ...args] = command ?? [process.execPath, "--import", "tsx", "scripts/b1/verify-engine-image.ts", "--json"];
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 180_000, windowsHide: true, env: childEnv({ [ENV.nonce]: undefined, [ENV.label]: undefined, [ENV.dir]: undefined }) });
  if (r.error || r.status !== 0) throw Error(`engine verification failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 400)}`);
  const v = JSON.parse(r.stdout);
  for (const k of ["containerId", "digest", "binding", "systemIdentifier"]) if (!STR(v[k])) throw Error(`engine verification output lacks ${k}`);
  return v;
}

/**
 * Crash-safe restore (generalised from mutation-check-identity.mjs): the pristine text is written to a backup file
 * before each mutation and recovered on the next start; restore() runs in finally and in SIGINT/SIGTERM/SIGHUP.
 */
const ACTIVE = Object.assign(new Set(), { installed: false });
export function createRestorer(backup, { log = console.error } = {}) {
  if (existsSync(backup)) {
    const saved = JSON.parse(readFileSync(backup, "utf8"));
    for (const [file, text] of saved.files ?? [[saved.file, saved.text]]) writeFileSync(file, text);
    rmSync(backup);
    log(`RECOVERED ${(saved.files ?? [[saved.file]]).map(([f]) => f).join(", ")} from ${backup}: a previous run was killed while a mutation was applied.`);
  }
  const originals = new Map();
  const restore = () => { for (const [file, text] of originals) writeFileSync(file, text); originals.clear(); rmSync(backup, { force: true }); };
  const save = (file, text) => { if (!originals.has(file)) originals.set(file, text); writeFileSync(backup, JSON.stringify({ files: [...originals] })); };
  ACTIVE.add(restore);
  if (!ACTIVE.installed) {
    ACTIVE.installed = true;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { for (const r of ACTIVE) r(); process.exit(130); });
  }
  return { save, restore, originals };
}

/** 2-R4e(6): restore first, then print and exit with the distinct code. Never tallied. */
export function infrastructureFailure(label, reason, restore, exit = (c) => process.exit(c)) {
  restore?.();
  console.log(`INFRASTRUCTURE FAILURE: ${label} ${reason}`);
  return exit(INFRA_EXIT);
}

/**
 * One relevant invocation, end to end: pre-invocation check, fresh context, vitest with a JSON report, then
 * restore and classification. `restore` is called before classification (2-R4e(6) step 1). On FATAL this exits via
 * infrastructureFailure; otherwise it returns the existing verdict inputs {code, failed, total, report}.
 */
export function runClassified({ label, files, filter = [], tests, root = process.cwd(), restore, logDir, timeout, check = preInvocationCheck, vitest, exit, extraEnv = {}, dbFiles: expectedDb }) {
  let pre;
  try { pre = check({ cwd: root }); } catch (e) { return infrastructureFailure(label, `pre-invocation verification: ${e.message}`, restore, exit); }
  const inv = createInvocation(label, root);
  const reportPath = join(inv.dir, "..", `${inv.dir.split(sep).pop()}-report.json`);
  let r;
  try { r = runVitest(["run", ...files, ...filter, "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`], { cwd: root, env: { ...extraEnv, ...inv.env }, timeout, vitest }); }
  finally { restore?.(); }
  if (logDir) writeFileSync(join(logDir, `${label}.log`), r.out);
  const dbFiles = (expectedDb ?? allDatabaseFiles()).filter((f) => files.includes(f));
  const result = acceptInvocation({ inv, root, files, dbFiles, tests, reportPath, pre, spawnError: r.error });
  try { if (logDir && existsSync(reportPath)) writeFileSync(join(logDir, `${label}.json`), readFileSync(reportPath)); } catch { /* evidence copy only */ }
  rmSync(inv.dir, { recursive: true, force: true }); rmSync(reportPath, { force: true });
  if (!result.ok) return infrastructureFailure(label, result.problems.slice(0, 6).join(" | "), restore, exit);
  const failed = result.report.numFailedTests, total = result.report.numTotalTests;
  if (r.code === 0 && failed > 0) return infrastructureFailure(label, "exit status 0 with failed tests", restore, exit);
  return { code: r.code, failed, total, report: result.report, pre, records: result.records.length };
}
