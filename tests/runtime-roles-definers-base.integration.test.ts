import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { testDatabase, type TestDatabase } from "./support/database.js";
import { loadStageManifest, stageFunctions } from "../services/kernel/src/database/security-definers.js";

/**
 * ADR-0023 27.12.15 lane A (base-regression): derivation A of the 27.9.3 source digest reads the stamp function from
 * a database migrated with the base chain only, never B1, exactly as the frozen definers file did before B1; the lane D
 * remainder of that file runs in stage T.
 */
const manifest = loadStageManifest();
const PIN = stageFunctions(manifest, "B1")[0]!.sourceDigest!;
const lf = (t: string) => t.replaceAll("\r\n", "\n");
const hex = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const STAMP = "kernel_private.stamp_binding_provenance()";
const DIGEST_SQL = `select encode(sha256(convert_to(replace(prosrc, E'\\r\\n', E'\\n'), 'UTF8')), 'hex') as digest, prosrc
  from pg_proc where oid = '${STAMP}'::regprocedure`;
let database: TestDatabase;
beforeAll(async () => { database = await testDatabase("kj_b1_def_base"); });
afterAll(async () => { await database?.close(); });

describe("27.9.3 source digest: two independent derivations", () => {
  it("derivation A (catalogue of main without B1) equals derivation B (migration text) and the reviewed pin", async () => {
    const a = (await database.pool.query<{ digest: string; prosrc: string }>(DIGEST_SQL)).rows[0]!;
    const pre = (await database.pool.query(`select prosecdef from pg_proc where oid = '${STAMP}'::regprocedure`)).rows[0];
    expect(pre).toEqual({ prosecdef: false });
    const text = lf(readFileSync("supabase/migrations/20260916205049_release_provenance.sql", "utf8"));
    const open = text.indexOf("create function kernel_private.stamp_binding_provenance()");
    const start = text.indexOf("$$", open) + 2;
    const derivationB = hex(text.slice(start, text.indexOf("$$", start)));
    expect(a.digest).toBe(hex(lf(a.prosrc)));
    expect(a.digest).toBe(derivationB);
    expect(PIN).toBe(derivationB);
  });
});
