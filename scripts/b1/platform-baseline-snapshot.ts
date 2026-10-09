// KJ-P8 B1 - take the frozen platform SECURITY DEFINER baseline (ADR-0023 revision 2.5, section 27.10.4).
//
//   pnpm tsx scripts/b1/platform-baseline-snapshot.ts --environment <name> --database-url-file <path> --out <path> --declaration-out <path>
//
// DEPLOYMENT AUTHORITY. Run by the deployment owner against the target environment BEFORE the B1 migration. It opens
// one READ ONLY transaction with search_path = '', reads the catalogue, and writes nothing to the database. It refuses
// if B1 is already applied or if any entry is ineligible.
//
// The connection string is read from a file (mode 600, delete it afterwards). It is never an argument, never printed,
// never logged and never written to the artefact; errors print only a fixed message and the PostgreSQL SQLSTATE.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { parseConnectionFile, scrubPgEnvironment, snapshotArtifacts } from "../../services/kernel/src/database/platform-baseline-snapshot.js";
import { loadStageManifest } from "../../services/kernel/src/database/security-definers.js";

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value || value.startsWith("--")) {
    console.error(`usage: --environment <name> --database-url-file <path> --out <path> --declaration-out <path> (missing --${name})`);
    process.exit(2);
  }
  return value;
};
const allowed=new Set(["--environment","--database-url-file","--out","--declaration-out"]);
const seen=new Set<string>();
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i]!;
  if(!allowed.has(key) || seen.has(key) || !process.argv[i+1] || process.argv[i+1]!.startsWith("--"))
    throw Error("snapshot arguments refused: unknown, duplicate or missing option");
  seen.add(key);
}
const environment = arg("environment"), urlFile = arg("database-url-file"), out = arg("out"), declarationOut=arg("declaration-out");
if(new Set([out,declarationOut,urlFile].map(p=>resolve(p))).size!==3) throw Error("snapshot input and output paths must differ");
if (!/^[A-Za-z0-9._:-]{1,80}$/.test(environment)) {
  console.error("--environment must be 1 to 80 characters of [A-Za-z0-9._:-]");
  process.exit(2);
}
// No PG* default may supply a missing parameter, and the file must hold exactly one explicit URL. Never shown.
const scrubbed = scrubPgEnvironment(process.env);
let config: pg.ClientConfig;
try {
  config = parseConnectionFile(readFileSync(urlFile, "utf8"));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
if (scrubbed.length) console.log(`ignored PG* environment variables: ${scrubbed.join(", ")}`);
const client = new pg.Client({ ...config, application_name: "kj-b1-platform-baseline-snapshot" });
try {
  await client.connect();
  const {baseline,declaration} = await snapshotArtifacts(client, environment, loadStageManifest());
  writeFileSync(out, JSON.stringify(baseline, null, 2) + "\n",{flag:"wx",mode:0o600});
  try { writeFileSync(declarationOut,JSON.stringify(declaration,null,2)+"\n",{flag:"wx",mode:0o600}); }
  catch(error) { unlinkSync(out); throw error; }
  console.log(`platform baseline for ${environment}: ${baseline.entries.length} entries, entriesSha256 ${baseline.entriesSha256}, written to ${out}`);
} catch (error) {
  const e = error as { code?: string; message?: string };
  const refusal = typeof e.message === "string" && e.message.startsWith("PLATFORM_BASELINE_REFUSED") ? e.message.slice(0, 400) : "snapshot failed";
  console.error(`${refusal}${e.code ? ` (SQLSTATE ${e.code})` : ""}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
