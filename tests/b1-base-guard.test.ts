import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assertBaseEnvironment, assertBaseTarget, baseMigrationFiles } from "../scripts/b1/base-guard.mjs";

const B1="20261002090000_runtime_least_privilege_roles.sql";
const files=readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql"));
describe("lane A refuses B1 before writing",()=>{
  it("selects exactly 22 base files and permits explicit base-only subsets",()=>{
    const base=baseMigrationFiles(files);
    expect(base).toHaveLength(22);expect(base).not.toContain(B1);
    expect(baseMigrationFiles(files,{only:[base[0]!]})).toEqual([base[0]]);
  });
  it("refuses a selected B1, a foreign file or an incomplete base directory",()=>{
    expect(()=>baseMigrationFiles(files,{only:[B1]})).toThrow("BASE_REFUSED");
    expect(()=>baseMigrationFiles([...files,"20270101000000_foreign.sql"])).toThrow("BASE_REFUSED");
    expect(()=>baseMigrationFiles(files.slice(1))).toThrow("BASE_REFUSED");
  });
  it.each(["KJ_B1_STAGE_T","KJ_B1_RUN_TOKEN","KJ_B1_RUN_DIR","KJ_B1_RUN_HEADER"])("refuses %s even in base mode",key=>{
    expect(()=>assertBaseEnvironment({KJ_RUNTIME_ROLES:"base",[key]:""})).toThrow("BASE_REFUSED");
  });
  it.each([undefined,"enforce","discover","typo"])("refuses mode %s",mode=>{
    expect(()=>assertBaseEnvironment({KJ_RUNTIME_ROLES:mode})).toThrow("BASE_REFUSED");
  });
  it.each([
    [{cluster:"kj-eph-nonce",runtime:false,ledger:false},[]],
    [{cluster:"base",runtime:true,ledger:false},[]],
    [{cluster:"base",runtime:false,ledger:true},[{version:"20261002090000"}]],
  ])("refuses a runner cluster, a runtime role or a recorded B1 using read-only queries",async(row,ledger)=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("cluster_name")?[row]:ledger}));
    await expect(assertBaseTarget({query},{KJ_RUNTIME_ROLES:"base"})).rejects.toThrow("BASE_REFUSED");
    expect(query.mock.calls.every(([sql])=>sql.startsWith("select "))).toBe(true);
  });
  it("refuses an active stage before querying",async()=>{
    const query=vi.fn(async()=>({rows:[]}));
    await expect(assertBaseTarget({query},{KJ_RUNTIME_ROLES:"base",KJ_B1_RUN_TOKEN:"active"})).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
