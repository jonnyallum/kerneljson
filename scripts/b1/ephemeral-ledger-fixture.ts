import type pg from "pg";
import { SEALED_BASE_VERSIONS } from "../../services/kernel/src/database/ledger-contract.js";
import type { LedgerEffect } from "./hooks.js";

export async function ledgerFixtureFacts(client:pg.Client){
  const exists=(await client.query(`select to_regclass('supabase_migrations.schema_migrations') is not null as visible,
    to_regclass('supabase_migrations.fixture_hidden_ledger') is not null as hidden`)).rows[0];
  const rows=async(table:string)=>(await client.query(`select version,name,encode(sha256(convert_to(array_to_json(statements)::text,'UTF8')),'hex') as digest
    from supabase_migrations.${table} order by version collate "C"`)).rows;
  return {visible:exists.visible?await rows("schema_migrations"):null,hidden:exists.hidden?await rows("fixture_hidden_ledger"):null,
    stamp:(await client.query(`select p.proname as name,p.prosecdef as definer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='kernel_private' and p.proname in ('stamp_binding_provenance','fixture_hidden_stamp') order by p.proname`)).rows,
    roles:(await client.query("select rolname from pg_roles where rolname in ('kj_worker','kj_door') order by rolname")).rows};
}
export function ledgerFixturePrecondition(effect:LedgerEffect,facts:Awaited<ReturnType<typeof ledgerFixtureFacts>>):boolean{
  let versions:string[]=[...SEALED_BASE_VERSIONS];
  if(effect==="ledger-wrong-head") versions=versions.slice(0,-1);
  if(effect==="ledger-gap") versions=versions.filter((_,i)=>i<10||i>12);
  if(effect==="ledger-extra") versions.push("20250101000000");
  if(effect==="ledger-b1-recorded") versions.push("20261002090000");
  const ledgerMatches=effect==="ledger-absent"?facts.visible===null:
    JSON.stringify(facts.visible?.map(r=>r.version))===JSON.stringify(versions.sort());
  return ledgerMatches && facts.hidden===null && facts.roles.length===0 &&
    JSON.stringify(facts.stamp)===JSON.stringify([{name:effect==="stamp-missing"?"fixture_hidden_stamp":"stamp_binding_provenance",definer:false}]);
}
