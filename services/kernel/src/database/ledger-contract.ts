import type { StageManifest } from "./security-definers.js";

export const SEALED_BASE_VERSIONS = [
  "20260905153656","20260905153700","20260905153704","20260905153708","20260905173500",
  "20260905173800","20260905174200","20260908233816","20260908234518","20260908234711",
  "20260908234849","20260910180000","20260915220000","20260916205049","20260917120000",
  "20260920120000","20260920150000","20260920180000","20260921180000","20260923150000",
  "20260925120000","20260929120000",
] as const;

export function expectedLedgerVersions(manifest: StageManifest): string[] {
  const versions = manifest.baseMigrations.map((m) => /^([0-9]{14})_/.exec(m.file)?.[1]);
  if (!versions.length || versions.some((v) => !v)) throw new Error("stage manifest has a base migration without a version");
  return [...new Set(versions as string[])].sort();
}

export function ledgerSetProblems(recorded: readonly string[], expected: readonly string[]): string | null {
  const have = new Set(recorded), want = new Set(expected);
  const missing = expected.filter((v) => !have.has(v)), extra = [...have].filter((v) => !want.has(v)).sort();
  const duplicated = recorded.length !== have.size;
  if (!missing.length && !extra.length && !duplicated) return null;
  return `the migration ledger does not record exactly the ${expected.length} base migrations before B1` +
    `${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; unexpected ${extra.join(", ")}` : ""}${duplicated ? "; duplicated versions" : ""}`;
}

export function expectedLedgerHead(manifest: StageManifest): string {
  const last = manifest.baseMigrations.at(-1)?.file ?? "";
  const version = /^([0-9]{14})_/.exec(last)?.[1];
  if (!version) throw new Error("stage manifest has no base migration version");
  return version;
}
