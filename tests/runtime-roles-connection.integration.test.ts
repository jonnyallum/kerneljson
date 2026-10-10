import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabase, type TestDatabase } from "./support/database.js";
import { RuntimeRoleRefusal, assertRuntimeRole, runtimePool } from "../services/kernel/src/database/runtime-roles.js";

/**
 * KJ-P8 B1 gate 5 - no fallback to the owner. A runtime pool proves its session is exactly its sealed role before the
 * first statement; any other session (the owner above all) is refused and never runs a statement.
 */
// ADR-0023 27.12.15: the plan database kj_b1_con, to which the runner applied B1 in this run (stage T), or in lane A
// the base adapter's database; this file never creates, migrates or drops a database.
let database: TestDatabase;
const url = (user: string) => { const u = new URL(database.url); u.username = user; return u.toString(); };
let owner: pg.Pool;
const pools: pg.Pool[] = [];
const guarded = (user: string, role: "kj_worker" | "kj_door") => { const p = runtimePool({ connectionString: url(user), max: 2 }, role); pools.push(p); return p; };

beforeAll(async () => {
  database = await testDatabase("kj_b1_con");
  owner = new pg.Pool({ connectionString: url("postgres"), max: 2 });
  owner.on("error", () => {});
});
afterAll(async () => {
  for (const p of pools) await p.end().catch(() => undefined);
  await owner?.end();
  await database?.close();
});

describe("B1 runtime pool guard", () => {
  it("serves the sealed role", async () => {
    expect((await guarded("kj_worker", "kj_worker").query("select current_user::text as u, session_user::text as s")).rows).toEqual([{ u: "kj_worker", s: "kj_worker" }]);
    expect((await guarded("kj_door", "kj_door").query("select current_user::text as u")).rows).toEqual([{ u: "kj_door" }]);
  });

  it("refuses the owner on query and on connect, and runs no statement", async () => {
    const pool = guarded("postgres", "kj_worker");
    await expect(pool.query("create table public.kj_b1_owner_fallback (i int)")).rejects.toBeInstanceOf(RuntimeRoleRefusal);
    await expect(pool.connect()).rejects.toThrow("RUNTIME_DATABASE_ROLE_REFUSED: this process must connect as kj_worker");
    // Refused again on the next use: a refusal is never cached as a pass.
    await expect(pool.query("select 1")).rejects.toBeInstanceOf(RuntimeRoleRefusal);
    const made = await owner.query("select to_regclass('public.kj_b1_owner_fallback') as t");
    expect(made.rows[0].t).toBeNull();
  });

  it("refuses the other runtime role", async () => {
    await expect(guarded("kj_door", "kj_worker").query("select 1")).rejects.toThrow("must connect as kj_worker");
    await expect(guarded("kj_worker", "kj_door").query("select 1")).rejects.toThrow("must connect as kj_door");
  });

  it("refuses a role that has been widened, even under the right name", async () => {
    for (const widen of ["createdb", "createrole", "bypassrls", "inherit"]) {
      await owner.query(`alter role kj_door ${widen}`);
      try {
        await expect(guarded("kj_door", "kj_door").query("select 1")).rejects.toThrow("kj_door is not least-privilege as sealed");
      } finally { await owner.query(`alter role kj_door no${widen}`); }
    }
    await owner.query(`create role kj_b1_con_group nologin`);
    await owner.query(`grant kj_b1_con_group to kj_door`);
    try {
      await expect(guarded("kj_door", "kj_door").query("select 1")).rejects.toThrow("not least-privilege");
    } finally { await owner.query(`revoke kj_b1_con_group from kj_door`); await owner.query(`drop role kj_b1_con_group`); }
    await expect(guarded("kj_door", "kj_door").query("select 1")).resolves.toBeTruthy();
  });

  it("the refusal message never contains the connection string", async () => {
    const error = await guarded("postgres", "kj_door").query("select 1").catch((e: Error) => e);
    expect(String((error as Error).message)).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("SET ROLE does not satisfy the guard: the session itself must be the role", async () => {
    const client = await owner.connect();
    try {
      await client.query("set role kj_worker");
      await expect(assertRuntimeRole(client, "kj_worker")).rejects.toBeInstanceOf(RuntimeRoleRefusal);
    } finally { await client.query("reset role"); client.release(); }
  });
});
