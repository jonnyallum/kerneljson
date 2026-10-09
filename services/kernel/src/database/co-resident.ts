import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type pg from "pg";
import { strictJson } from "./strict-json.js";

export const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const HASH = z.string().regex(/^[0-9a-f]{64}$/);
export const SYSTEM_ID = z.string().regex(/^(0|-?[1-9][0-9]{0,18})$/);
export const DB_NAME = z.string().min(1).refine((s) => Buffer.byteLength(s) <= 63 && Array.from(s).every(c=>c.charCodeAt(0)>=32));
const identity = { schema: z.string(), name: z.string(), args: z.array(z.string()) };
export const Binding = z.strictObject({ name:z.string(), owner:z.string(), event:z.string(), function:z.string(), enabled:z.string(), tags:z.array(z.string()).nullable() });
export const CoEntry = z.strictObject({ ...identity, returns:z.string(), retset:z.boolean(), kind:z.string(), owner:z.string(),
  securityDefiner:z.boolean(), language:z.string(), config:z.array(z.string()).nullable(), acl:z.array(z.string()).nullable(),
  volatility:z.string(), strict:z.boolean(), leakproof:z.boolean(), parallel:z.string(), binary:z.string().nullable(),
  sqlBody:z.string().nullable(), sourceDigest:HASH, sourceBytes:z.number().int().nonnegative(), bindings:z.array(Binding) });
export const ObservedCoEntry = CoEntry.extend({ rawDigest:HASH, rawBytes:z.number().int().nonnegative(), hasCR:z.boolean() });
export const RunBinding = z.strictObject({runId:z.string().regex(/^[0-9a-f]{32}$/),clusterNonce:z.string().regex(/^[0-9a-f]{32}$/),
  containerId:z.string().regex(/^[0-9a-f]{64}$/),containerCreated:z.string().min(1),application:z.number().int().positive()});
export const Provenance = z.strictObject({systemIdentifier:SYSTEM_ID,database:DB_NAME,serverVersion:z.string().min(1),
  snapshotAt:z.string().min(1),snapshotUser:z.string().min(1),transaction:z.strictObject({readOnly:z.literal(true),searchPath:z.enum(["",'""'])}),
  migrationLedger:z.strictObject({table:z.literal("supabase_migrations.schema_migrations"),present:z.literal(true),head:z.string().regex(/^[0-9]{14}$/),
    b1Recorded:z.literal(false),versions:z.array(z.string().regex(/^[0-9]{14}$/))}),stampSecurityDefiner:z.literal(false),querySha256:HASH});
const fields = {kind:z.literal("kerneljson:co-resident-platform-exceptions/v1"),environment:z.string().min(1),provenance:Provenance,
  pinsSha256:HASH,setSha256:HASH,entries:z.array(ObservedCoEntry)};
export const DeclarationSchema = z.discriminatedUnion("mode",[
  z.strictObject({...fields,mode:z.literal("HOSTED_COMMITTED")}),
  z.strictObject({...fields,mode:z.literal("EPHEMERAL_RUN_BOUND"),run:RunBinding}),
]);
export type CoResidentEntry = z.infer<typeof ObservedCoEntry>;
export type Declaration = z.infer<typeof DeclarationSchema>;
export const PINS_PATH = "infrastructure/database/co-resident-platform-pins.json";
export const DECLARATION_PATH = "infrastructure/database/co-resident-platform-exceptions.json";
export const pinText = readFileSync(new URL(`../../../../${PINS_PATH}`,import.meta.url),"utf8");
export const pins = z.strictObject({kind:z.literal("kerneljson:co-resident-platform-pins/v1"),entries:z.array(CoEntry).length(1)}).parse(strictJson(pinText));
export const EMPTY_SET_DIGEST = hash("");
export const GOLDEN = "evt|ensure_rls|postgres|ddl_command_end|public.rls_auto_enable()|O|CREATE TABLE,CREATE TABLE AS,SELECT INTO\n" +
  "fn|public|rls_auto_enable||pg_catalog.event_trigger|f|f|postgres|t|plpgsql|v|f|f|u|{search_path=pg_catalog}|NULL|2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1";
const same = (a:unknown,b:unknown):boolean => JSON.stringify(a)===JSON.stringify(b);
export function pinProblems(entry: CoResidentEntry): string[] {
  const {rawDigest,rawBytes,hasCR,...actual}=entry;
  void rawDigest; void rawBytes; void hasCR;
  const p=pins.entries[0]!;
  return Object.keys(p).filter(k=>!same(actual[k as keyof typeof actual],p[k as keyof typeof p])).map(k=>`co-resident pin differs: ${k}`);
}
export function setDigest(entries: readonly CoResidentEntry[]): string {
  if(entries.length>1 || entries.some(e=>pinProblems(e).length)) throw Error("P2: non-admitted serialisation member");
  return hash(entries.length ? GOLDEN : "");
}
export function parseDeclaration(text:string):Declaration {
  const d=DeclarationSchema.parse(strictJson(text));
  if(d.pinsSha256!==hash(pinText)) throw Error("co-resident pinsSha256 mismatch");
  if(d.setSha256!==setDigest(d.entries)) throw Error("co-resident setSha256 mismatch");
  if(d.provenance.querySha256!==hash(CO_RESIDENT_SQL)) throw Error("co-resident querySha256 mismatch");
  for(const e of d.entries) if(!e.hasCR && (e.rawDigest!==e.sourceDigest || e.rawBytes!==e.sourceBytes))
    throw Error("co-resident forensic fields are inconsistent");
  return d;
}
export const CO_RESIDENT_SQL = `select n.nspname as schema,p.proname as name,
  array(select tn.nspname||'.'||t.typname from unnest(p.proargtypes::oid[]) with ordinality a(oid,i)
    join pg_type t on t.oid=a.oid join pg_namespace tn on tn.oid=t.typnamespace order by a.i)::text[] as args,
  rn.nspname||'.'||rt.typname as returns,p.proretset as retset,p.prokind::text as kind,
  pg_get_userbyid(p.proowner) as owner,p.prosecdef as "securityDefiner",l.lanname as language,
  p.proconfig as config,p.proacl::text[] as acl,p.provolatile::text as volatility,p.proisstrict as strict,
  p.proleakproof as leakproof,p.proparallel::text as parallel,p.probin as binary,p.prosqlbody::text as "sqlBody",
  encode(sha256(convert_to(replace(p.prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex') as "sourceDigest",
  octet_length(replace(p.prosrc,E'\\r\\n',E'\\n')) as "sourceBytes",
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as "rawDigest",octet_length(p.prosrc) as "rawBytes",
  position(E'\\r' in p.prosrc)>0 as "hasCR",
  coalesce((select json_agg(json_build_object('name',e.evtname,'owner',pg_get_userbyid(e.evtowner),'event',e.evtevent,
    'function',n.nspname||'.'||p.proname||'('||coalesce((select string_agg(tn.nspname||'.'||t.typname,',' order by a.i)
      from unnest(p.proargtypes::oid[]) with ordinality a(oid,i) join pg_type t on t.oid=a.oid
      join pg_namespace tn on tn.oid=t.typnamespace),'')||')','enabled',e.evtenabled,
    'tags',array(select tag from unnest(e.evttags) tag order by tag collate "C")) order by e.evtname collate "C")
    from pg_event_trigger e where e.evtfoid=p.oid),'[]'::json) as bindings
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
  join pg_type rt on rt.oid=p.prorettype join pg_namespace rn on rn.oid=rt.typnamespace
  where not (n.nspname in ('pg_catalog','information_schema','pg_toast') or n.nspname ~ '^pg_temp_[0-9]+$' or n.nspname ~ '^pg_toast_temp_[0-9]+$')
    and (p.proname='rls_auto_enable' or (n.nspname in ('public','kernel_private')
      and (p.prosecdef or p.prorettype='pg_catalog.event_trigger'::regtype or exists(select 1 from pg_event_trigger e where e.evtfoid=p.oid))
      and not(n.nspname='kernel_private' and p.proname='stamp_binding_provenance' and p.pronargs=0)))
  order by n.nspname collate "C",p.proname collate "C",p.oid`;
export async function readCoResident(db:Pick<pg.Client|pg.Pool|pg.PoolClient,"query">):Promise<CoResidentEntry[]> {
  const rows=(await db.query(CO_RESIDENT_SQL)).rows.map(r=>ObservedCoEntry.parse(r));
  setDigest(rows); // E1–E3 and global name uniqueness before any serialisation or snapshot acceptance.
  return rows;
}
