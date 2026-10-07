// KJ-P8 ledger drift adjudication: READ-ONLY structural footprint of a live database.
//
//   node scripts/drift/production-footprint.mjs --database-url-file <path> --out <path>
//
// DEPLOYMENT AUTHORITY, READ ONLY. One transaction, REPEATABLE READ READ ONLY, search_path = ''; the transaction is
// rolled back, never committed. No migration SQL, no temp table, no persistent SET, nothing written to the database.
//
// The connection string is read from a file (mode 600, shred it afterwards). It is never an argument, never printed,
// never logged and never written to the output; errors print only a fixed message and the PostgreSQL SQLSTATE.
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { footprint } from "./footprint-lib.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value || value.startsWith("--")) {
    console.error(`usage: --database-url-file <path> --out <path> (missing --${name})`);
    process.exit(2);
  }
  return value;
};
const urlFile = arg("database-url-file"), out = arg("out");
if (existsSync(out)) { console.error("refusing to overwrite an existing output file"); process.exit(2); }

// No PG* default may supply a missing parameter.
const scrubbed = Object.keys(process.env).filter((k) => /^PG[A-Z]/.test(k)).sort();
for (const k of scrubbed) delete process.env[k];

let connectionString;
try {
  const mode = statSync(urlFile).mode & 0o777;
  if (process.platform !== "win32" && (mode & 0o077) !== 0) throw new Error(`connection file must be mode 600 (is ${mode.toString(8)})`);
  const raw = readFileSync(urlFile, "utf8");
  const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const fixed = "connection file must hold exactly one postgres:// URL with an explicit user, host and database, and nothing else";
  if (!text || /[\s\0]/.test(text)) throw new Error(fixed);
  let u;
  try { u = new URL(text); } catch { throw new Error(fixed); } // never echo the parser's message: it may quote the input
  if (!["postgres:", "postgresql:"].includes(u.protocol) || !u.username || !u.hostname || u.pathname.length < 2) throw new Error(fixed);
  connectionString = text;
} catch (error) {
  console.error(`connection file refused: ${error.code === "ENOENT" ? "not found" : String(error.message).slice(0, 160)}`);
  process.exit(2);
}
if (scrubbed.length) console.log(`ignored PG* environment variables: ${scrubbed.join(", ")}`);

const client = new pg.Client({ connectionString, application_name: "kj-p8-ledger-drift-footprint" });
connectionString = undefined;
try {
  await client.connect();
  const fp = await footprint(client);
  const body = JSON.stringify({ capturedAt: new Date().toISOString(), ...fp }, null, 2) + "\n";
  writeFileSync(out, body, { flag: "wx", mode: 0o600 }); // never overwrite; readable by the owner only
  console.log(`footprint: database ${fp.meta.database}, user ${fp.meta.user}, server ${fp.meta.serverVersionNum}, ` +
    `${fp.meta.transaction.isolation} / read_only=${fp.meta.transaction.readOnly}; ${Object.keys(fp.objects).length} objects; ` +
    `ledger ${fp.ledger ? fp.ledger.length + " rows" : "absent"}; sha256 ${createHash("sha256").update(body).digest("hex")}; written to ${out}`);
} catch (error) {
  const refusal = typeof error?.message === "string" && error.message.startsWith("FOOTPRINT_REFUSED") ? error.message.slice(0, 200) : "footprint failed";
  console.error(`${refusal}${error?.code ? ` (SQLSTATE ${error.code})` : ""}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
