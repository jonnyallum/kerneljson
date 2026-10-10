import type pg from "pg";

/**
 * Every relation in the two KernelJSON schemas, by kind. B1 creates and drops no relation (CON-32), so the base chain's
 * list is also the post-B1 list. The committed inventory (infrastructure/database/b1-relation-inventory.json) is
 * checked against a base-chain database by tests/b1-relation-inventory.integration.test.ts on every lane A run, and
 * scripts/b1/build-required.ts derives the declared refusals of the relation probes from it.
 */
export const RELATION_INVENTORY_PATH="infrastructure/database/b1-relation-inventory.json";
export const RELATIONS_SQL=`select n.nspname||'.'||c.relname as name,c.relkind::text as kind
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','kernel_private') and c.relkind in ('r','v','m','p','f')
  order by n.nspname collate "C",c.relname collate "C"`;
export interface RelationInventory {kind:"kerneljson:b1-relation-inventory/v1";relations:{name:string;kind:string}[]}
export async function readRelations(db:Pick<pg.Pool|pg.Client,"query">):Promise<RelationInventory>{
  return {kind:"kerneljson:b1-relation-inventory/v1",relations:(await db.query<{name:string;kind:string}>(RELATIONS_SQL)).rows};
}
