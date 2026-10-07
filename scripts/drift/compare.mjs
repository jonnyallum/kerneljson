// KJ-P8 ledger drift adjudication: classify a database footprint against the canonical reference.
//
//   node scripts/drift/compare.mjs --reference <reference-steps.json> --production <footprint.json> --out <prefix>
//
// Writes <prefix>.json and <prefix>.md (rules in compare-lib.mjs). Reads files only; never connects to a database.
// Never authorises ledger repair.
import { readFileSync, writeFileSync } from "node:fs";
import { compareFootprints, renderMarkdown } from "./compare-lib.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) { console.error(`missing --${name}`); process.exit(2); }
  return process.argv[i + 1];
};
const ref = JSON.parse(readFileSync(arg("reference"), "utf8"));
const db = JSON.parse(readFileSync(arg("production"), "utf8"));
const prefix = arg("out");
const report = compareFootprints(ref, db);
writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 2) + "\n");
writeFileSync(`${prefix}.md`, renderMarkdown(report));
for (const m of report.migrations)
  console.log(`${m.migration}: ${m.classification} (historical ${m.historicalApplication}; structure ${m.structuralEquivalence}, privileges ${m.privilegeEquivalence}) ${JSON.stringify(m.counts)}`);
console.log(`OVERALL: ${report.overall.verdict}${report.overall.reasons.length ? ` - ${report.overall.reasons.join("; ")}` : ""}`);
console.log("LEDGER_REPAIR_AUTHORISED: NO");
