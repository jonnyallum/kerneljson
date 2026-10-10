import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabase, type TestDatabase } from "./support/database.js";
import { LOG_FIXTURE, LOG_PEEK, LOG_PREPARED } from "./support/b1-log-fixture.js";

/**
 * ADR-0023 27.12.15 case CON-48, the positive fixture, on a cluster of the pinned image inside stage T (suite
 * regression-probes, plan database kj_b1_log). Each test issues its denied statements on a genuine kj_worker login
 * session and requires SQLSTATE 42501 for each. The runner then reconciles the database log and the trace with the
 * refusals that tests/b1-required.json declares for these tests; the perturbations are applied to the extracted log
 * afterwards (scripts/b1/con48-perturb.ts).
 */
let database: TestDatabase, worker: pg.Client;
const byName = new Map(LOG_FIXTURE.map((f) => [f.name, f]));
const refused = async (run: () => Promise<unknown>) => {
  try { await run(); return "OK"; } catch (error) { return (error as { code?: string }).code ?? "NO_SQLSTATE"; }
};
beforeAll(async () => {
  database = await testDatabase("kj_b1_log");
  // The owner's fixture function in this suite's own database: an invoker SQL function reading a relation no runtime
  // role may read, executable by kj_worker only for this test, dropped afterwards.
  await database.pool.query(`create function public.kj_log_fixture_peek() returns text language sql as $f$ select rolpassword::text from pg_catalog.pg_authid limit 1 $f$`);
  await database.pool.query(`revoke all on function public.kj_log_fixture_peek() from public`);
  await database.pool.query(`grant execute on function public.kj_log_fixture_peek() to kj_worker`);
  const url = new URL(database.url); url.username = "kj_worker";
  worker = new pg.Client({ connectionString: url.toString() });
  await worker.connect();
});
afterAll(async () => {
  await worker?.end().catch(() => undefined);
  await database?.pool.query(`drop function if exists public.kj_log_fixture_peek()`).catch(() => undefined);
  await database?.close();
});
describe("CON-48 log fixture", () => {
  it("the same denied statement from a first test", async () => {
    expect(await refused(() => worker.query(byName.get("CON-48 log fixture the same denied statement from a first test")!.statements[0]!))).toBe("42501");
  });
  it("the same denied statement from a second test", async () => {
    expect(await refused(() => worker.query(byName.get("CON-48 log fixture the same denied statement from a second test")!.statements[0]!))).toBe("42501");
  });
  it("a multiline statement with a TAB and two spaces inside a literal", async () => {
    expect(await refused(() => worker.query(byName.get("CON-48 log fixture a multiline statement with a TAB and two spaces inside a literal")!.statements[0]!))).toBe("42501");
  });
  it("a denied function call writes CONTEXT before STATEMENT", async () => {
    expect(await refused(() => worker.query(LOG_PEEK))).toBe("42501");
  });
  it("a named prepared statement executed twice", async () => {
    for (let i = 0; i < 2; i++) expect(await refused(() => worker.query({ ...LOG_PREPARED, values: [`kj-${i}`] }))).toBe("42501");
  });
  it("a parameterised statement", async () => {
    const sql = byName.get("CON-48 log fixture a parameterised statement")!.statements[0]!;
    expect(await refused(() => worker.query(sql, ["kj_worker", true]))).toBe("42501");
  });
  it("a statement longer than 600 characters", async () => {
    const sql = byName.get("CON-48 log fixture a statement longer than 600 characters")!.statements[0]!;
    expect(sql.length).toBeGreaterThan(600);
    expect(await refused(() => worker.query(sql))).toBe("42501");
  });
  it("two statements differing only by whitespace inside a literal", async () => {
    for (const sql of byName.get("CON-48 log fixture two statements differing only by whitespace inside a literal")!.statements)
      expect(await refused(() => worker.query(sql))).toBe("42501");
  });
});
