// KJ-P8 ledger drift adjudication: classify each audited migration from a production footprint against the canonical
// reference built migration by migration.
//
//   node scripts/drift/compare.mjs --reference <reference-steps.json> --production <production.json> --out <prefix>
//
// For audited migration k (reference step k):
//   OWNED      keys whose last change in the canonical chain is step k: production must equal the final reference value;
//   SUPERSEDED keys step k created or changed that a later migration j redefined: production must hold them (j owns the value);
//   DROPPED    keys step k removed that stay absent: production must not hold them;
//   SEEDS      the rows step k must insert.
// Each value is compared field by field, and privilege fields (acl, aclDefault) are reported apart from structure.
// Writes <prefix>.json and <prefix>.md. Reads files only; never connects to a database.
import { readFileSync, writeFileSync } from "node:fs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) { console.error(`missing --${name}`); process.exit(2); }
  return process.argv[i + 1];
};
const ref = JSON.parse(readFileSync(arg("reference"), "utf8"));
const prod = JSON.parse(readFileSync(arg("production"), "utf8"));
const prefix = arg("out");

export const AUDITED = ["20260920120000", "20260920150000", "20260920180000", "20260921180000", "20260923150000", "20260925120000"];
const PRIVILEGE_FIELDS = new Set(["acl", "aclDefault"]);
const SEEDS = { "20260920120000": { "kernel_private.telegram_operator_state": { rows: 1, singleton_rows: 1 } } };

const steps = ref.steps;
const files = steps.slice(1).map((s) => s.file);
const versionOf = (f) => f.slice(0, 14);
const canon = (v) => JSON.stringify(v, Object.keys(v ?? {}).sort());
const eq = (a, b) => canon(a) === canon(b);
const final = steps.at(-1).objects;
const live = prod.objects;

// History of every key through the canonical chain.
const allKeys = new Set(steps.flatMap((s) => Object.keys(s.objects)));
const changes = new Map(); // key -> [step indices where it was added, changed or removed]
for (const key of allKeys) {
  const at = [];
  for (let k = 1; k < steps.length; k++) {
    const before = steps[k - 1].objects[key], after = steps[k].objects[key];
    if ((before === undefined) !== (after === undefined) || (before !== undefined && !eq(before, after))) at.push(k);
  }
  changes.set(key, at);
}

const fieldDiff = (expected, observed) => {
  const out = [];
  for (const f of [...new Set([...Object.keys(expected), ...Object.keys(observed)])].sort())
    if (!eq(expected[f] ?? null, observed[f] ?? null)) out.push({ field: f, privilege: PRIVILEGE_FIELDS.has(f), expected: expected[f] ?? null, observed: observed[f] ?? null });
  return out;
};

const majorRef = Math.floor(Number(steps.at(-1).meta.serverVersionNum) / 10000);
const majorProd = Math.floor(Number(prod.meta.serverVersionNum) / 10000);

const results = [];
for (const version of AUDITED) {
  const k = files.findIndex((f) => versionOf(f) === version) + 1;
  if (k < 1) throw new Error(`audited migration ${version} is not in the reference`);
  const touched = [...allKeys].filter((key) => changes.get(key).includes(k)).sort();
  const owned = [], superseded = [], dropped = [];
  for (const key of touched) {
    const last = changes.get(key).at(-1);
    const inFinal = key in final;
    if (last === k) (inFinal ? owned : dropped).push(key);
    else if (inFinal) superseded.push({ key, by: files[last - 1] });
    // created at k and dropped later: nothing remains for k to own
  }
  const matched = [], missing = [], mismatched = [], privilegeOnly = [], unexpectedPresent = [];
  for (const key of owned) {
    if (!(key in live)) { missing.push(key); continue; }
    const d = fieldDiff(final[key], live[key]);
    if (!d.length) matched.push(key);
    else if (d.every((x) => x.privilege)) privilegeOnly.push({ key, diff: d });
    else mismatched.push({ key, diff: d });
  }
  const supersededPresent = superseded.filter((s) => s.key in live).map((s) => s.key);
  for (const s of superseded) if (!(s.key in live)) missing.push(`${s.key} (value owned by ${s.by})`);
  for (const key of dropped) if (key in live) unexpectedPresent.push(key);
  const seeds = [];
  for (const [table, expected] of Object.entries(SEEDS[version] ?? {})) {
    const observed = prod.seeds?.[table] ?? null;
    seeds.push({ table, expected, observed, ok: eq(expected, observed) });
  }
  const functions = owned.filter((key) => key.startsWith("fn:")).map((key) => ({
    key, expectedSrcSha256: final[key].srcSha256, observedSrcSha256: live[key]?.srcSha256 ?? null,
    equal: live[key]?.srcSha256 === final[key].srcSha256,
    expected: { lang: final[key].lang, securityDefiner: final[key].securityDefiner, config: final[key].config, result: final[key].result },
    observed: live[key] ? { lang: live[key].lang, securityDefiner: live[key].securityDefiner, config: live[key].config, result: live[key].result } : null,
  }));
  const rls = owned.filter((key) => key.startsWith("rel:")).map((key) => ({
    key, expected: { rls: final[key].rls, forceRls: final[key].forceRls, acl: final[key].acl, options: final[key].options },
    observed: live[key] ? { rls: live[key].rls, forceRls: live[key].forceRls, acl: live[key].acl, options: live[key].options } : null,
  }));
  const expectedCount = owned.length + superseded.length;
  const presentCount = owned.filter((key) => key in live).length + supersededPresent.length;
  const exact = !missing.length && !mismatched.length && !privilegeOnly.length && !unexpectedPresent.length && seeds.every((s) => s.ok);
  const classification = exact ? "EXACTLY_APPLIED"
    : presentCount * 2 < expectedCount ? "ABSENT_OR_DRIFTED"
    : "PARTIALLY_APPLIED";
  results.push({ migration: files[k - 1], classification, counts: { owned: owned.length, superseded: superseded.length, dropped: dropped.length,
    matched: matched.length, missing: missing.length, mismatched: mismatched.length, privilegeOnly: privilegeOnly.length },
    expected: owned, supersededPresent, matched, missing, mismatched, privilegeOnly, unexpectedPresent, functions, rls, seeds });
}

// Objects production holds in the governed KernelJSON schemas that the canonical chain never produces.
const unexpectedObjects = Object.keys(live).filter((key) => !(key in final)).sort();
// Objects the canonical final state holds that production lacks, outside the audited migrations' ownership.
const auditedKeys = new Set(results.flatMap((r) => [...r.expected, ...r.supersededPresent, ...r.missing.map((m) => m.split(" ")[0])]));
const otherMissing = Object.keys(final).filter((key) => !(key in live) && !auditedKeys.has(key)).sort();
const otherMismatched = Object.keys(final).filter((key) => key in live && !auditedKeys.has(key) && !eq(final[key], live[key]))
  .map((key) => ({ key, diff: fieldDiff(final[key], live[key]) }));

const ledger = prod.ledger ?? [];
const expectedLedger = files.map(versionOf);
const report = {
  target: "production", mode: "READ_ONLY", productionMeta: prod.meta, productionCapturedAt: prod.capturedAt,
  reference: { commit: ref.commit, capturedAt: ref.capturedAt, serverVersionNum: steps.at(-1).meta.serverVersionNum, migrations: files.length,
    migrationSha256: Object.fromEntries(steps.slice(1).map((s) => [s.file, s.sqlSha256])) },
  deparseComparable: majorRef === majorProd,
  ledger: { versions: ledger, expected: expectedLedger.length, missing: expectedLedger.filter((v) => !ledger.includes(v)),
    unexpected: ledger.filter((v) => !expectedLedger.includes(v)), records20260929120000: ledger.includes("20260929120000"),
    duplicates: ledger.length !== new Set(ledger).size },
  migrations: results, unexpectedObjects, otherMissing, otherMismatched,
  platform: { defaultAcl: prod.defaultAcl, extensions: prod.extensions },
};
writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 2) + "\n");

const j = (v) => "`" + JSON.stringify(v) + "`";
const L = [];
L.push(`TARGET: production`, `MODE: READ_ONLY`, ``,
  `Production: database ${prod.meta.database}, user ${prod.meta.user}, server ${prod.meta.serverVersionNum}, ${prod.meta.transaction.isolation}, read_only=${prod.meta.transaction.readOnly}, captured ${prod.capturedAt}`,
  `Reference: commit ${ref.commit}, server ${steps.at(-1).meta.serverVersionNum}, ${files.length} canonical migrations${report.deparseComparable ? "" : " (DIFFERENT MAJOR VERSION: deparsed definitions may differ in text only)"}`, ``,
  `LEDGER_VERSIONS: ${ledger.join(", ")}`, `EXPECTED_PRE_B1_VERSIONS: ${expectedLedger.length}`,
  `MISSING_LEDGER_VERSIONS: ${report.ledger.missing.join(", ") || "none"}`, `UNEXPECTED_LEDGER_VERSIONS: ${report.ledger.unexpected.join(", ") || "none"}`,
  `20260929120000 RECORDED: ${report.ledger.records20260929120000 ? "yes" : "no"}`, ``);
for (const r of results) {
  L.push(`## ${r.migration}`, ``, `CLASSIFICATION (mechanical): ${r.classification}`,
    `COUNTS: ${j(r.counts)}`, ``, `EXPECTED_OBJECTS (${r.expected.length} owned, ${r.supersededPresent.length + r.missing.filter((m) => m.includes("owned by")).length} redefined later):`,
    ...r.expected.map((k) => `- ${k}`), ``,
    `MATCHED: ${r.matched.length} of ${r.expected.length}`, `MISSING: ${r.missing.length ? "" : "none"}`, ...r.missing.map((k) => `- ${k}`),
    `MISMATCHED: ${r.mismatched.length ? "" : "none"}`, ...r.mismatched.flatMap((m) => [`- ${m.key}`, ...m.diff.map((d) => `  - ${d.field}: expected ${j(d.expected)} observed ${j(d.observed)}`)]),
    `PRIVILEGE_ONLY_DIFFERENCES: ${r.privilegeOnly.length ? "" : "none"}`, ...r.privilegeOnly.flatMap((m) => [`- ${m.key}`, ...m.diff.map((d) => `  - ${d.field}: expected ${j(d.expected)} observed ${j(d.observed)}`)]),
    `DROPPED_BUT_PRESENT: ${r.unexpectedPresent.join(", ") || "none"}`,
    `FUNCTION_DIGESTS:`, ...(r.functions.length ? r.functions.map((f) => `- ${f.key}: expected ${f.expectedSrcSha256} observed ${f.observedSrcSha256 ?? "ABSENT"} ${f.equal ? "EQUAL" : "DIFFERENT"}; ${j(f.observed)}`) : ["- none owned"]),
    `RLS_AND_PRIVILEGES:`, ...(r.rls.length ? r.rls.map((x) => `- ${x.key}: expected ${j(x.expected)} observed ${j(x.observed)}`) : ["- none owned"]),
    `SEED_STATE: ${r.seeds.length ? r.seeds.map((s) => `${s.table} expected ${j(s.expected)} observed ${j(s.observed)} ${s.ok ? "OK" : "MISMATCH"}`).join("; ") : "none required"}`, ``);
}
L.push(`## Outside the audited migrations`, ``,
  `UNEXPECTED_OBJECTS (in production, not produced by the canonical chain): ${unexpectedObjects.length ? "" : "none"}`, ...unexpectedObjects.map((k) => `- ${k}`),
  `OTHER_MISSING (canonical, absent in production, not owned by an audited migration): ${otherMissing.length ? "" : "none"}`, ...otherMissing.map((k) => `- ${k}`),
  `OTHER_MISMATCHED: ${otherMismatched.length ? "" : "none"}`, ...otherMismatched.flatMap((m) => [`- ${m.key}`, ...m.diff.map((d) => `  - ${d.field}: expected ${j(d.expected)} observed ${j(d.observed)}`)]),
  ``, `PLATFORM DEFAULT ACL:`, ...prod.defaultAcl.map((d) => `- ${d.role} ${d.schema} ${d.objtype}: ${d.acl.join(" ")}`));
writeFileSync(`${prefix}.md`, L.join("\n") + "\n");
console.log(results.map((r) => `${r.migration}: ${r.classification} ${JSON.stringify(r.counts)}`).join("\n"));
console.log(`ledger missing ${report.ledger.missing.length}, unexpected ${report.ledger.unexpected.length}; unexpected objects ${unexpectedObjects.length}; other missing ${otherMissing.length}; other mismatched ${otherMismatched.length}`);
