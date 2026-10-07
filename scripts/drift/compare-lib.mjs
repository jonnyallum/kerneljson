// KJ-P8 ledger drift adjudication: classify the CURRENT state of each audited migration's surviving footprint in a
// database footprint against the canonical reference (reference-lib.mjs), and give one overall verdict.
//
// What this can and cannot say. Catalogue state proves CURRENT equivalence with the canonical chain; it cannot prove
// that a migration was historically executed as written. So the per-migration labels are current-state labels, and
// HISTORICAL_APPLICATION is always UNPROVEN here: this tool takes no historical evidence. CURRENT_STATE_EQUIVALENT does
// NOT authorise ledger repair, and LEDGER_REPAIR_AUTHORISED is always NO.
//
// Structure (per-field ownership). Every field of every object in the canonical final state, plus each object's
// existence, is owned by the LAST migration that changed it. Each final field is checked exactly once against the
// FINAL canonical value, and a difference is charged to its owner, whichever migration that is. Objects a migration
// dropped (and nothing recreated) must be absent, charged to the dropper.
//
// Privileges (reference-lib.mjs ZERO and MAX regimes). A privilege present in ZERO is a GRANT the chain owns: it must be
// present. A privilege MAX covers but lacks is a REVOKE the chain owns: it must be absent. Ownership is again the last
// migration that changed that requirement. Every other privilege the database holds on a canonical object is classified:
//   PLATFORM      in MAX and explained by the database's own pg_default_acl or acldefault(): reported, never a failure;
//   INSUFFICIENT  explained by the database's own defaults but outside what MAX covers: cannot be separated, so neither
//                 equivalence nor drift can be claimed;
//   VIOLATION     explained by nothing: a privilege the chain never granted and no default produced.
// No expected platform ACL is assumed.
//
// Version policy. Same PostgreSQL major as the reference: everything is compared. Different major: the overall verdict
// is INSUFFICIENT_EVIDENCE, no migration is CURRENT_STATE_EQUIVALENT, every deparse-dependent field and every
// privilege is INSUFFICIENT, and only the stable facts (existence, kind, owner, RLS flags, types, nullability, function
// source digests, language, SECURITY DEFINER, proconfig, volatility, ...) are compared.
import { maxCoverage, MAX_GRANTEES } from "./reference-lib.mjs";

export const AUDITED = Object.freeze(["20260920120000", "20260920150000", "20260920180000", "20260921180000", "20260923150000", "20260925120000"]);
// The ledger difference already observed by the refused B1 snapshot (2026-10): exactly the six audited versions.
export const OBSERVED_MISSING = AUDITED;
// Reviewed platform allowlist of exact footprint keys that may exist without being canonical. Deliberately empty.
export const PLATFORM_ALLOWLIST = Object.freeze([]);
export const SEEDS = Object.freeze({ "20260920120000": { "kernel_private.telegram_operator_state": { rows: 1, singleton_rows: 1 } } });

export const LABELS = Object.freeze(["CURRENT_STATE_EQUIVALENT", "PARTIAL_CURRENT_STATE", "ABSENT_OR_DRIFTED", "NO_OBSERVABLE_FOOTPRINT", "INSUFFICIENT_EVIDENCE"]);
export const HISTORICAL = Object.freeze(["UNPROVEN", "CONSISTENT_WITH_RECORDS"]);
export const VERDICTS = Object.freeze(["LEDGER_ONLY_DRIFT", "NOT_LEDGER_ONLY", "INSUFFICIENT_EVIDENCE"]);

const PRIVILEGE_FIELDS = new Set(["acl", "aclBuiltin"]);
const DEPARSE = { col: ["default"], con: ["def"], idx: ["def"], trg: ["def"], rel: ["viewdefSha256"], pol: ["qual", "withCheck"], type: ["checks"], fn: ["sqlbodySha256"] };
const EXISTS = "@exists";
const SEP = "\u0000";

// Recursive canonical form: object keys sorted at every level; array order is significant (the footprint sorts
// every order-insensitive array itself).
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const eq = (a, b) => canonical(a) === canonical(b);

const kindOf = (key) => key.slice(0, key.indexOf(":"));
const nameOf = (key) => key.slice(key.indexOf(":") + 1);
const schemaOf = (key) => (kindOf(key) === "schema" ? null : nameOf(key).split(".")[0]);
const major = (v) => Math.floor(Number(v) / 10000);
const versionOf = (file) => file.slice(0, 14);
const base = (entry) => entry.replace(/\*$/, "");
const grantee = (entry) => entry.slice(0, entry.lastIndexOf("="));
const privilege = (entry) => base(entry).slice(base(entry).lastIndexOf("=") + 1);

// Kinds MAX's default privileges reach, and the pg_default_acl objtype for each.
const DEFACL_TYPE = (key, value) => {
  const k = kindOf(key);
  if (k === "rel") return value.kind === "S" ? "S" : "r";
  return { fn: "f", type: "T", schema: "n" }[k] ?? null;
};
const privilegeClass = (key, value) => (kindOf(key) === "rel" ? (value.kind === "S" ? "seq" : "table") : kindOf(key));

function structuralFields(objects) {
  const out = new Map();
  for (const [key, value] of Object.entries(objects)) {
    out.set(key + SEP + EXISTS, true);
    for (const [f, v] of Object.entries(value)) if (!PRIVILEGE_FIELDS.has(f)) out.set(key + SEP + f, v);
  }
  return out;
}

export function validateReference(ref) {
  const steps = ref?.steps;
  if (!Array.isArray(steps) || steps.length < 2 || steps[0].file !== null) throw new Error("REFERENCE_REFUSED: malformed reference");
  for (const s of steps) {
    const z = structuralFields(s.zero.objects), m = structuralFields(s.max.objects);
    if (z.size !== m.size || [...z].some(([k, v]) => !m.has(k) || !eq(v, m.get(k))))
      throw new Error(`REFERENCE_REFUSED: ZERO and MAX differ structurally at ${s.file ?? "the base"}`);
    if (!eq(s.zero.meta.serverVersionNum, s.max.meta.serverVersionNum)) throw new Error("REFERENCE_REFUSED: regimes on different servers");
  }
}

// Privilege requirements of one reference step: Map(key SEP entry -> 'present' | 'absent').
function requirements(step, baseObjects, potential) {
  const out = new Map();
  for (const [key, z] of Object.entries(step.zero.objects)) {
    if (!("acl" in z)) continue;
    const created = !(key in baseObjects);
    const zero = new Set(z.acl), max = new Set((step.max.objects[key]?.acl ?? []).map(base));
    for (const e of zero) out.set(key + SEP + e, "present");
    const type = DEFACL_TYPE(key, z);
    if (!created || !type) continue;
    for (const g of maxCoverage(type === "n" ? null : schemaOf(key), type))
      for (const p of potential.get(privilegeClass(key, z)) ?? []) {
        const e = `${g}=${p}`;
        if (!max.has(e) && !zero.has(e) && !zero.has(e + "*")) out.set(key + SEP + e, "absent");
      }
  }
  return out;
}

// Last step index at which each entry of a per-step map changed (appeared, changed value or disappeared).
function ownership(perStep) {
  const owner = new Map();
  const keys = new Set(perStep.flatMap((m) => [...m.keys()]));
  for (const k of keys)
    for (let i = 1; i < perStep.length; i++) {
      const a = perStep[i - 1].get(k), b = perStep[i].get(k);
      if ((a === undefined) !== (b === undefined) || (a !== undefined && !eq(a, b))) owner.set(k, i);
    }
  return owner;
}

function explainedByDefaults(db, key, value, entry) {
  const b = base(entry);
  if ((value.aclBuiltin ?? []).map(base).includes(b)) return true;
  const type = DEFACL_TYPE(key, value);
  if (!type || !value.owner) return false;
  const schema = schemaOf(key);
  return (db.defaultAcl ?? []).some((d) => d.role === value.owner && d.objtype === type
    && (d.schema === "*" || d.schema === schema) && d.acl.map(base).includes(b));
}

// The parent relation an unexpected object hangs off, when its key makes that unambiguous.
function parentOf(key, value, finalObjects) {
  const k = kindOf(key), parts = nameOf(key).split(".");
  if (["col", "con", "idx", "trg", "pol"].includes(k) && parts.length >= 3) return `rel:${parts[0]}.${parts[1]}`;
  if (k === "seq" && value?.ownedBy) return `rel:${parts[0]}.${value.ownedBy.split(".")[0]}`;
  if (k === "rel" && value?.kind === "S") return null;
  if (k === "fn") {
    const same = Object.keys(finalObjects).find((f) => f.startsWith("fn:") && f.slice(0, f.indexOf("(")) === key.slice(0, key.indexOf("(")));
    return same ?? null;
  }
  return null;
}

export function compareFootprints(ref, db, { audited = AUDITED, observedMissing = OBSERVED_MISSING, allowlist = PLATFORM_ALLOWLIST } = {}) {
  validateReference(ref);
  const steps = ref.steps;
  const files = steps.slice(1).map((s) => s.file);
  const label = (i) => files[i - 1];
  const finalStep = steps.at(-1);
  const final = finalStep.zero.objects;
  const live = db.objects;
  const sameMajor = major(finalStep.zero.meta.serverVersionNum) === major(db.meta.serverVersionNum);
  const auditedIdx = new Map(audited.map((v) => {
    const i = files.findIndex((f) => versionOf(f) === v) + 1;
    if (i < 1) throw new Error(`audited migration ${v} is not in the reference`);
    return [i, v];
  }));
  const bucket = new Map(); // step index -> checks, 0 = outside the audited migrations
  const charge = (i, check) => {
    const b = auditedIdx.has(i) ? i : 0;
    if (!bucket.has(b)) bucket.set(b, []);
    bucket.get(b).push({ ...check, owner: label(i) ?? "base" });
  };

  // Structure.
  const sFields = steps.map((s) => structuralFields(s.zero.objects));
  const sOwner = ownership(sFields);
  const finalFields = sFields.at(-1);
  for (const [fk, expected] of finalFields) {
    const owner = sOwner.get(fk);
    if (owner === undefined) continue; // present before any migration: not a migration's footprint
    const [key, field] = fk.split(SEP);
    let result;
    if (!(key in live)) result = "missing";
    else if (field === EXISTS) result = "match";
    else if (!sameMajor && (DEPARSE[kindOf(key)] ?? []).includes(field)) result = "insufficient";
    else result = eq(expected, live[key][field]) ? "match" : "mismatch";
    charge(owner, { surface: "structure", key, field, result, expected, observed: key in live ? (field === EXISTS ? true : live[key][field] ?? null) : null });
  }
  for (const [fk, owner] of sOwner) {
    const [key, field] = fk.split(SEP);
    if (field !== EXISTS || finalFields.has(fk)) continue;
    charge(owner, { surface: "structure", key, field: "@dropped", result: key in live ? "unexpected" : "match", expected: false, observed: key in live });
  }

  // Privileges.
  const potential = new Map();
  for (const s of steps) for (const [key, v] of Object.entries(s.max.objects)) {
    if (!("acl" in v) || !DEFACL_TYPE(key, v)) continue;
    const cls = privilegeClass(key, v);
    if (!potential.has(cls)) potential.set(cls, new Set());
    for (const e of v.acl) if (MAX_GRANTEES.includes(grantee(e))) potential.get(cls).add(privilege(e));
  }
  const pReq = steps.map((s) => requirements(s, steps[0].zero.objects, potential));
  const pOwner = ownership(pReq);
  const finalReq = pReq.at(-1);
  const addressed = new Map(); // key -> Set(base entries settled by a requirement)
  for (const [rk, status] of finalReq) {
    const owner = pOwner.get(rk);
    const [key, entry] = rk.split(SEP);
    if (!addressed.has(key)) addressed.set(key, new Set());
    addressed.get(key).add(base(entry));
    if (owner === undefined) continue;
    let result;
    if (!(key in live)) result = "missing";
    else if (!sameMajor) result = "insufficient";
    else {
      const have = live[key].acl ?? [];
      result = status === "present" ? (have.includes(entry) ? "match" : "violation") : (have.map(base).includes(base(entry)) ? "violation" : "match");
    }
    charge(owner, { surface: "privilege", key, entry, requirement: status, result });
  }
  const platform = [];
  for (const [key, value] of Object.entries(live)) {
    if (!(key in final) || !("acl" in value)) continue;
    const owner = sOwner.get(key + SEP + EXISTS);
    if (owner === undefined) continue; // existed before every migration (e.g. schema public): platform, not a footprint
    for (const e of value.acl) {
      if (addressed.get(key)?.has(base(e))) continue;
      if (grantee(e) === value.owner && grantee(e) === final[key].owner) continue; // owner's own privileges, owner compared structurally
      const inMax = (finalStep.max.objects[key]?.acl ?? []).map(base).includes(base(e));
      const explained = explainedByDefaults(db, key, value, e);
      const cls = !sameMajor ? "insufficient" : inMax && explained ? "platform" : explained ? "insufficient" : "violation";
      if (cls === "platform") { platform.push({ key, entry: e }); continue; }
      charge(owner, { surface: "privilege", key, entry: e, requirement: "none", result: cls === "violation" ? "violation" : "insufficient" });
    }
  }

  // Unexpected objects: attributed to the migration owning their parent where the key makes that unambiguous.
  const allow = new Set(allowlist);
  for (const key of Object.keys(live).filter((k) => !(k in final)).sort()) {
    if (allow.has(key)) continue;
    const parent = parentOf(key, live[key], final);
    const owner = parent ? sOwner.get(parent + SEP + EXISTS) : undefined;
    const check = { surface: "structure", key, field: "@unexpected", result: "unexpected", parent: parent ?? null, observed: live[key] };
    if (owner !== undefined) charge(owner, check); else charge(0, check);
  }

  // Seeds.
  for (const [i, v] of auditedIdx)
    for (const [table, expected] of Object.entries(SEEDS[v] ?? {})) {
      const observed = db.seeds?.[table] ?? null;
      const result = !observed ? "missing" : !observed.rlsVisible ? "insufficient"
        : eq(expected, { rows: observed.rows, singleton_rows: observed.singleton_rows }) ? "match" : "mismatch";
      charge(i, { surface: "seed", key: table, result, expected, observed });
    }

  const FAIL = new Set(["missing", "mismatch", "violation", "unexpected"]);
  const verdictOf = (checks, surface) => {
    const c = checks.filter((x) => surface.includes(x.surface));
    if (!c.length) return "NOT_APPLICABLE";
    if (c.some((x) => FAIL.has(x.result))) return "FAIL";
    if (c.some((x) => x.result === "insufficient")) return "INSUFFICIENT_EVIDENCE";
    return "PASS";
  };
  const migrations = [...auditedIdx].sort((a, b) => a[0] - b[0]).map(([i, v]) => {
    const checks = bucket.get(i) ?? [];
    const structural = verdictOf(checks, ["structure", "seed"]), privileges = verdictOf(checks, ["privilege"]);
    let classification;
    if (!checks.length) classification = "NO_OBSERVABLE_FOOTPRINT";
    else if (checks.some((x) => FAIL.has(x.result))) classification = checks.some((x) => x.result === "match") ? "PARTIAL_CURRENT_STATE" : "ABSENT_OR_DRIFTED";
    else if (!sameMajor || checks.some((x) => x.result === "insufficient")) classification = "INSUFFICIENT_EVIDENCE";
    else classification = "CURRENT_STATE_EQUIVALENT";
    const failing = checks.filter((x) => FAIL.has(x.result) || x.result === "insufficient");
    return { migration: label(i), version: v, classification, historicalApplication: "UNPROVEN",
      structuralEquivalence: structural, privilegeEquivalence: privileges,
      counts: Object.fromEntries(["match", "missing", "mismatch", "violation", "unexpected", "insufficient"].map((r) => [r, checks.filter((x) => x.result === r).length])),
      objects: [...new Set(checks.filter((x) => x.surface === "structure" && x.field === EXISTS).map((x) => x.key))].sort(),
      failing, checks };
  });
  const outside = bucket.get(0) ?? [];

  const ledger = db.ledger;
  const expectedLedger = files.map(versionOf);
  const ledgerReport = ledger === null || ledger === undefined ? null : {
    versions: ledger, expected: expectedLedger.length,
    missing: expectedLedger.filter((v) => !ledger.includes(v)), unexpected: [...new Set(ledger.filter((v) => !expectedLedger.includes(v)))],
    duplicates: ledger.length !== new Set(ledger).size, recorded20260929120000: ledger.includes("20260929120000"),
  };

  const reasons = [];
  let verdict;
  if (!sameMajor) { verdict = "INSUFFICIENT_EVIDENCE"; reasons.push(`server major ${major(db.meta.serverVersionNum)} differs from the reference's ${major(finalStep.zero.meta.serverVersionNum)}`); }
  else if (!ledgerReport) { verdict = "INSUFFICIENT_EVIDENCE"; reasons.push("no migration ledger to compare"); }
  else {
    const material = [];
    for (const m of migrations) if (["PARTIAL_CURRENT_STATE", "ABSENT_OR_DRIFTED"].includes(m.classification)) material.push(`${m.migration}: ${m.classification}`);
    const outFail = outside.filter((x) => FAIL.has(x.result));
    if (outFail.length) material.push(`${outFail.length} drift finding(s) outside the audited migrations`);
    if (!eq(ledgerReport.missing, [...observedMissing].sort())) material.push(`ledger missing ${ledgerReport.missing.join(", ") || "nothing"}, not exactly the observed ${observedMissing.join(", ")}`);
    if (ledgerReport.unexpected.length) material.push(`unexpected ledger versions ${ledgerReport.unexpected.join(", ")}`);
    if (ledgerReport.duplicates) material.push("duplicate ledger versions");
    const unsure = [];
    for (const m of migrations) if (["INSUFFICIENT_EVIDENCE", "NO_OBSERVABLE_FOOTPRINT"].includes(m.classification)) unsure.push(`${m.migration}: ${m.classification}`);
    const outUnsure = outside.filter((x) => x.result === "insufficient");
    if (outUnsure.length) unsure.push(`${outUnsure.length} unseparable finding(s) outside the audited migrations`);
    if (material.length) { verdict = "NOT_LEDGER_ONLY"; reasons.push(...material, ...unsure); }
    else if (unsure.length) { verdict = "INSUFFICIENT_EVIDENCE"; reasons.push(...unsure); }
    else if (migrations.every((m) => m.classification === "CURRENT_STATE_EQUIVALENT" && m.historicalApplication === "UNPROVEN"
      && m.structuralEquivalence === "PASS" && ["PASS", "NOT_APPLICABLE"].includes(m.privilegeEquivalence))) verdict = "LEDGER_ONLY_DRIFT";
    else { verdict = "INSUFFICIENT_EVIDENCE"; reasons.push("equivalence could not be established for every audited migration"); }
  }

  return {
    target: db.target ?? "production", mode: "READ_ONLY",
    database: db.meta, capturedAt: db.capturedAt ?? null,
    reference: { commit: ref.commit ?? null, capturedAt: ref.capturedAt ?? null, serverVersionNum: finalStep.zero.meta.serverVersionNum,
      migrations: files.length, migrationSha256: Object.fromEntries(steps.slice(1).map((s) => [s.file, s.sqlSha256])) },
    versionPolicy: { reference: finalStep.zero.meta.serverVersionNum, database: db.meta.serverVersionNum, sameMajor,
      rule: "same PostgreSQL major: compare everything; different major: INSUFFICIENT_EVIDENCE, deparse-dependent fields and privileges INSUFFICIENT, stable facts still compared" },
    ledger: ledgerReport, migrations, outside, platformPrivileges: platform,
    platform: { defaultAcl: db.defaultAcl ?? [], extensions: db.extensions ?? [] },
    overall: { verdict, reasons },
    ledgerRepairAuthorised: "NO", b1TargetBaselineAuthorised: "NO",
    notice: "CURRENT_STATE_EQUIVALENT describes current catalogue state only. It does NOT authorise ledger repair. Repair needs separate historical evidence: deployment and release records; when and by whom each migration was applied; whether SQL was applied manually; the digest and history of the SQL actually executed; whether the canonical files changed after production application; and an adjudication record for every discrepancy.",
  };
}

export function renderMarkdown(r) {
  const j = (v) => "`" + JSON.stringify(v) + "`";
  const L = [`TARGET: ${r.target}`, `MODE: ${r.mode}`, ``,
    `DATABASE: ${r.database.database}, user ${r.database.user}, server ${r.database.serverVersionNum}, system identifier ${r.database.systemIdentifier}, ${r.database.transaction.isolation}, read_only=${r.database.transaction.readOnly}`,
    `REFERENCE: commit ${r.reference.commit}, server ${r.reference.serverVersionNum}, ${r.reference.migrations} canonical migrations`,
    `VERSION_POLICY: ${r.versionPolicy.sameMajor ? "same major, comparable" : "DIFFERENT MAJOR, INSUFFICIENT_EVIDENCE"} (${r.versionPolicy.rule})`, ``];
  if (r.ledger) L.push(`LEDGER_VERSIONS: ${r.ledger.versions.join(", ")}`, `EXPECTED_PRE_B1_VERSIONS: ${r.ledger.expected}`,
    `MISSING_LEDGER_VERSIONS: ${r.ledger.missing.join(", ") || "none"}`, `UNEXPECTED_LEDGER_VERSIONS: ${r.ledger.unexpected.join(", ") || "none"}`,
    `DUPLICATE_LEDGER_VERSIONS: ${r.ledger.duplicates ? "yes" : "no"}`, `20260929120000_RECORDED: ${r.ledger.recorded20260929120000 ? "yes" : "no"}`, ``);
  else L.push(`LEDGER_VERSIONS: ledger absent`, ``);
  const show = (x) => x.surface === "privilege" ? `${x.key} ${x.entry} (${x.requirement}): ${x.result} [owner ${x.owner}]`
    : x.surface === "seed" ? `${x.key}: ${x.result} expected ${j(x.expected)} observed ${j(x.observed)}`
    : `${x.key} ${x.field}: ${x.result}${x.result === "mismatch" ? ` expected ${j(x.expected)} observed ${j(x.observed)}` : ""}${x.parent ? ` (parent ${x.parent})` : ""} [owner ${x.owner}]`;
  for (const m of r.migrations) {
    const fns = m.checks.filter((x) => x.surface === "structure" && x.key.startsWith("fn:") && x.field === "srcSha256");
    L.push(`## ${m.migration}`, ``, `MIGRATION: ${m.migration}`, `CLASSIFICATION: ${m.classification}`, `HISTORICAL_APPLICATION: ${m.historicalApplication}`,
      `STRUCTURAL_EQUIVALENCE: ${m.structuralEquivalence}`, `PRIVILEGE_EQUIVALENCE: ${m.privilegeEquivalence}`, `COUNTS: ${j(m.counts)}`,
      `EXPECTED_OBJECTS (${m.objects.length}, existence owned by this migration):`, ...m.objects.map((k) => `- ${k}`),
      `NON_MATCHING (${m.failing.length}):`, ...(m.failing.length ? m.failing.map((x) => `- ${show(x)}`) : ["- none"]),
      `FUNCTION_DIGESTS:`, ...(fns.length ? fns.map((x) => `- ${x.key}: expected ${x.expected} observed ${x.observed ?? "ABSENT"} ${x.result}`) : ["- none owned"]),
      `SEED_STATE: ${m.checks.filter((x) => x.surface === "seed").map(show).join("; ") || "none required"}`, ``);
  }
  L.push(`## Outside the audited migrations`, ``, ...(r.outside.filter((x) => x.result !== "match").map((x) => `- ${show(x)}`)), ...(r.outside.some((x) => x.result !== "match") ? [] : ["- no drift"]), ``,
    `PLATFORM_PRIVILEGES (reported, not failures): ${r.platformPrivileges.length}`, ...r.platformPrivileges.slice(0, 200).map((p) => `- ${p.key} ${p.entry}`),
    `PLATFORM_DEFAULT_ACL:`, ...r.platform.defaultAcl.map((d) => `- ${d.role} ${d.schema} ${d.objtype}: ${d.acl.join(" ")}`), ``,
    `OVERALL_CLASSIFICATION: ${r.overall.verdict}`, ...r.overall.reasons.map((x) => `- ${x}`), ``,
    `LEDGER_REPAIR_AUTHORISED: NO`, `B1_TARGET_BASELINE_AUTHORISED: NO`, ``, r.notice);
  return L.join("\n") + "\n";
}
