import type pg from "pg";

/**
 * The owner re-read of 27.12.9: what a refused case must show unchanged. Read through the runner's factory only.
 * It covers the ledger, everything B1 creates or alters (the runtime roles, the stamp function, policies, ACLs in the
 * two KernelJSON schemas, database privileges) and the co-resident surface (helper ACL, event triggers, definers).
 */
export interface CatalogueFacts {
  ledger:string[]|null;stampDefiner:boolean|null;helperPresent:boolean;helperAcl:string[]|null;roles:string[];
  eventTriggers:string[];definers:string[];aclDigest:string;policies:number;databaseAcl:string|null;
}
export async function catalogueFacts(client:pg.Client):Promise<CatalogueFacts>{
  const present=(await client.query("select pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null as p")).rows[0].p as boolean;
  const ledger=present?(await client.query<{v:string}>("select version as v from supabase_migrations.schema_migrations order by version collate \"C\"")).rows.map(r=>r.v):null;
  const row=(await client.query(`select
    (select p.prosecdef from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure('kernel_private.stamp_binding_provenance()')) as "stampDefiner",
    pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null as "helperPresent",
    (select p.proacl::pg_catalog.text[] from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure('public.rls_auto_enable()')) as "helperAcl",
    coalesce((select pg_catalog.array_agg(rolname::pg_catalog.text order by rolname collate "C") from pg_catalog.pg_roles where rolname in ('kj_worker','kj_door')),'{}') as roles,
    coalesce((select pg_catalog.array_agg(e.evtname||':'||e.evtenabled||':'||e.evtfoid::pg_catalog.regprocedure::pg_catalog.text||':'||coalesce(e.evttags::pg_catalog.text,'')
      order by e.evtname collate "C") from pg_catalog.pg_event_trigger e),'{}') as "eventTriggers",
    coalesce((select pg_catalog.array_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text order by p.oid::pg_catalog.regprocedure::pg_catalog.text collate "C")
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where p.prosecdef and n.nspname not in ('pg_catalog','information_schema')),'{}') as definers,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce((select pg_catalog.string_agg(
      p.oid::pg_catalog.regprocedure::pg_catalog.text||'='||coalesce(p.proacl::pg_catalog.text,'NULL'),E'\\n' order by p.oid::pg_catalog.regprocedure::pg_catalog.text collate "C")
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','kernel_private')),''),'UTF8')),'hex') as "aclDigest",
    (select pg_catalog.count(*)::int from pg_catalog.pg_policies where policyname ~ '^kj_') as policies,
    (select d.datacl::pg_catalog.text from pg_catalog.pg_database d where d.datname=pg_catalog.current_database()) as "databaseAcl"`)).rows[0];
  return {ledger,...row} as CatalogueFacts;
}
export const noB1Effect=(f:CatalogueFacts)=>f.stampDefiner===false && !(f.ledger ?? []).includes("20261002090000");
