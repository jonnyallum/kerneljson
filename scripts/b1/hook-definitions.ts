import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SEALED_BASE_VERSIONS } from "../../services/kernel/src/database/ledger-contract.js";
import type { Expectation, Hook, Post, Profile, Step, RUNNER_FACTS } from "./hooks.js";

/**
 * The closed set of B1 runner hooks (ADR-0023 27.12.13.8) and their mechanics. scripts/b1/build-hook-registry.ts
 * writes the registry fields of these definitions to infrastructure/database/b1-runner-hooks.json; the runner reads
 * that file only as a blob of R and refuses unless it equals what this file generates.
 *
 * Mechanics never receive an address, a credential or an engine path. SQL mechanics are executed by the runner on a
 * connection from its own factory (L3 and L5 already passed); settings mechanics only describe startup values.
 */
const sha=(t:string)=>createHash("sha256").update(t,"utf8").digest("hex");
const root=new URL("../../",import.meta.url);
const read=(path:string)=>readFileSync(new URL(path,root),"utf8");
const HELPER_SQL=read("docs/operations/evidence/kj-p8-r279-contradiction/pinned-helper.sql");
const HELPER_FUNCTION=HELPER_SQL.slice(0,HELPER_SQL.indexOf("DROP EVENT TRIGGER"));
const PIN_BODY=HELPER_FUNCTION.split("$$")[1]!;
const UPSTREAM_BODY=read("infrastructure/database/b1-fixtures/rls-auto-enable-536fbd5.body");
if(sha(PIN_BODY)!=="2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1" || Buffer.byteLength(PIN_BODY)!==953)
  throw Error("pinned helper fixture differs from the sealed pin");
if(!sha(UPSTREAM_BODY).startsWith("325ae266") || Buffer.byteLength(UPSTREAM_BODY)!==1055) throw Error("upstream 536fbd5 fixture differs");
const BYTE_BODY=PIN_BODY.replace("rls_auto_enable: skip","rls_auto_enable: Skip");
if(BYTE_BODY===PIN_BODY || Buffer.byteLength(BYTE_BODY)!==953) throw Error("one-byte variant not formed");
const replaceHelper=(body:string,identity="public.rls_auto_enable()")=>
  `CREATE OR REPLACE FUNCTION ${identity}\nRETURNS EVENT_TRIGGER\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = pg_catalog\nAS $$${body}$$;`;
const helperDigest=`(select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex')
  from pg_catalog.pg_proc p where p.oid='public.rls_auto_enable()'::pg_catalog.regprocedure)`;
const HELPER="(select p from pg_catalog.pg_proc p where p.oid='public.rls_auto_enable()'::pg_catalog.regprocedure)";
const ensure=(clause:string)=>`select coalesce((select ${clause} from pg_catalog.pg_event_trigger e where e.evtname='ensure_rls'),false) as effective`;
const EFFECTIVE=[{effective:true}];
const sqlPre=(condition:string)=>({kind:"sql" as const,sql:condition.startsWith("select")?condition:`select coalesce((${condition}),false) as effective`,expected:EFFECTIVE});
const runnerPre=(fact:typeof RUNNER_FACTS[number],expected:unknown)=>({kind:"runner" as const,fact,expected});

export const CALLERS={
  coResident:"tests/b1-runner-coresident.test.ts",
  settings:"tests/b1-runner-settings.test.ts",
  ledger:"tests/b1-runner-ledger.test.ts",
  lifecycle:"tests/b1-runner-lifecycle.test.ts",
} as const;
const CO=CALLERS.coResident,SE=CALLERS.settings,LE=CALLERS.ledger,LI=CALLERS.lifecycle;
const BOTH:Profile[]=["none","pinned-helper"],HELPER_ONLY:Profile[]=["pinned-helper"],NONE:Profile[]=["none"];
const UNCHANGED:Post[]=["catalogue-unchanged","no-b1-effect"];

const refused=(step:Step,refusal:{sqlstate?:string|null;message?:string;pattern?:string},b1EngineInvoked:boolean,post:Post[],profiles:Profile[],withHooks:string[]=[]):Expectation=>({
  with:[...withHooks].sort(),profiles,end:{step,outcome:"refused"},
  refusal:{sqlstate:refusal.sqlstate ?? null,message:refusal.message ?? null,pattern:refusal.pattern ?? null},b1EngineInvoked,post});
const completed=(post:Post[],profiles:Profile[],withHooks:string[]=[]):Expectation=>({
  with:[...withHooks].sort(),profiles,end:{step:"L6",outcome:"completed"},refusal:null,b1EngineInvoked:true,post});
const esc=(t:string)=>t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const B1=(message:string,profiles:Profile[],withHooks:string[]=[])=>refused("S6",{sqlstate:"23514",message:`B1 ${message}`},true,UNCHANGED,profiles,withHooks);
const GATE=(check:string,profiles:Profile[],detail="",withHooks:string[]=[])=>
  refused("S6",{pattern:`^LEDGER_GATE_REFUSED: ${esc(check)}: ${detail}`},false,UNCHANGED,profiles,withHooks);
const SNAPSHOT=(message:string,profiles:Profile[]=NONE)=>refused("S3",{message:`PLATFORM_BASELINE_REFUSED: ${message}`},false,UNCHANGED,profiles);
const SNAPSHOT_PATTERN=(pattern:string,profiles:Profile[])=>refused("S3",{pattern},false,UNCHANGED,profiles);

const P2A="P2 (a) E1: co-resident function differs from sealed pin";
const P2B="P2 (b) E2: event-trigger binding differs";
const P2C="P2 (c) E3: sealed topology of the pinned function is incomplete or extended";
const P2D="P2 (d): co-resident name uniqueness differs";
const P1="P1: KernelJSON definer identity set differs";
// 27.12.7 P2: CR_ACTUAL is every function in public and kernel_private that is a definer or returns event_trigger,
// other than the stamp function. An extra KernelJSON definer is therefore in CR_ACTUAL and equals no pin: it breaks
// P1 and P2 (a) together, and B1 names both. The gate's read of the co-resident surface reports it first.
const P3=(step:number,text:string)=>`P3 step ${step}: ${text}`;
const STEP1=P3(1,"three declaration settings are required"),STEP2=P3(2,"malformed declaration settings");
const STEP3=P3(3,"target database differs"),STEP4=P3(4,"target system identifier differs"),STEP5=P3(5,"co-resident set digest differs");
const SKIP="gate-inventory-skip";

export type SettingValue={from:"declaration"}|{omit:true}|{value:string};
export type Settings={digest:SettingValue;sysid:SettingValue;database:SettingValue};
export type FileTransform="edit-environment"|"delete"|"invalid-json"|"bom"|"drop-mode"|"hosted-with-run"|"ephemeral-without-run"|
  "run-unknown-field"|"baseline-mode-hosted"|"baseline-drop-mode"|"run-runId"|"run-clusterNonce"|"run-containerId"|"run-containerCreated"|
  "run-application"|"foreign-run"|"foreign-baseline"|"sysid"|"entry-digest"|"set-sha";
export type Mechanics=
  |{kind:"sql";sql:string}
  |{kind:"settings";settings:Settings}
  |{kind:"variant";after:string;statement:string}
  |{kind:"outside-engine"}
  |{kind:"post-commit";sql:string}
  |{kind:"export-tamper"}
  |{kind:"record-altered"}
  |{kind:"files";when:"after-S3"|"after-S4"|"after-S6";target:"declaration"|"baseline"|"both";transform:FileTransform;rerecord:boolean}
  |{kind:"skip";check:"S4"|"gate-inventory"|"L3"}
  |{kind:"target";fixture:"foreign-container"|"preexisting-tunnel"};
export interface HookDefinition {hook:Hook;mechanics:Mechanics}
const definitions:HookDefinition[]=[];
const add=(hook:Hook,mechanics:Mechanics)=>{definitions.push({hook,mechanics});};

// --- S2: the six frozen _ledger snapshot refusals (CON-45), and EPH-13 at S2 ---------------------------------------
const V=SEALED_BASE_VERSIONS;
const ledgerRows=(versions:readonly string[])=>sqlPre(`select coalesce((select pg_catalog.array_agg(version order by version collate "C")::text
  from supabase_migrations.schema_migrations),'') = '${`{${versions.join(",")}}`}' as effective`);
add({id:"ledger-absent",point:"S2",effect:"the owner drops supabase_migrations.schema_migrations before the snapshot",callers:[LE],
  expected:[SNAPSHOT("the migration ledger supabase_migrations.schema_migrations does not exist")],
  precondition:sqlPre("select pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null as effective"),cases:["CON-45","27.11.6 item 3"]},
  {kind:"sql",sql:"drop table supabase_migrations.schema_migrations"});
add({id:"ledger-wrong-head",point:"S2",effect:"the owner deletes the newest base ledger row before the snapshot",callers:[LE],
  expected:[SNAPSHOT(`the migration ledger head is ${V.at(-2)}, not ${V.at(-1)}, the final base migration before B1`)],
  precondition:ledgerRows(V.slice(0,-1)),cases:["CON-45","EPH-13 newest","27.11.6 item 3"]},
  {kind:"sql",sql:`delete from supabase_migrations.schema_migrations where version='${V.at(-1)}'`});
add({id:"ledger-gap",point:"S2",effect:"the owner deletes the 11th to 13th base ledger rows before the snapshot",callers:[LE],
  expected:[SNAPSHOT(`the migration ledger does not record exactly the 22 base migrations before B1; missing ${V.slice(10,13).join(", ")}`)],
  precondition:ledgerRows(V.filter((_,i)=>i<10 || i>12)),cases:["CON-45"]},
  {kind:"sql",sql:`delete from supabase_migrations.schema_migrations where version in (${V.slice(10,13).map(v=>`'${v}'`).join(",")})`});
add({id:"ledger-extra",point:"S2",effect:"the owner inserts ledger version 20250101000000 before the snapshot",callers:[LE],
  expected:[SNAPSHOT("the migration ledger does not record exactly the 22 base migrations before B1; unexpected 20250101000000")],
  precondition:ledgerRows(["20250101000000",...V]),cases:["CON-45"]},
  {kind:"sql",sql:"insert into supabase_migrations.schema_migrations(version) values ('20250101000000')"});
add({id:"ledger-b1-recorded",point:"S2",effect:"the owner inserts ledger version 20261002090000 before the snapshot",callers:[LE],
  expected:[SNAPSHOT("B1 is already applied to this database; a baseline must be taken before B1")],
  precondition:ledgerRows([...V,"20261002090000"]),cases:["CON-45"]},
  {kind:"sql",sql:"insert into supabase_migrations.schema_migrations(version) values ('20261002090000')"});
add({id:"stamp-missing",point:"S2",effect:"the owner renames kernel_private.stamp_binding_provenance() before the snapshot",callers:[LE],
  expected:[SNAPSHOT("kernel_private.stamp_binding_provenance() does not exist")],
  precondition:sqlPre("select pg_catalog.to_regprocedure('kernel_private.stamp_binding_provenance()') is null and pg_catalog.to_regprocedure('kernel_private.fixture_hidden_stamp()') is not null as effective"),
  cases:["CON-45"]},
  {kind:"sql",sql:"alter function kernel_private.stamp_binding_provenance() rename to fixture_hidden_stamp"});
add({id:"ledger-oldest-missing",point:"S2",effect:"the owner deletes the oldest base ledger row before the snapshot",callers:[LE],
  expected:[SNAPSHOT(`the migration ledger does not record exactly the 22 base migrations before B1; missing ${V[0]}`)],
  precondition:ledgerRows(V.slice(1)),cases:["EPH-13 oldest"]},
  {kind:"sql",sql:`delete from supabase_migrations.schema_migrations where version='${V[0]}'`});
add({id:"ledger-middle-missing",point:"S2",effect:"the owner deletes the 11th base ledger row before the snapshot",callers:[LE],
  expected:[SNAPSHOT(`the migration ledger does not record exactly the 22 base migrations before B1; missing ${V[10]}`)],
  precondition:ledgerRows(V.filter((_,i)=>i!==10)),cases:["EPH-13 middle"]},
  {kind:"sql",sql:`delete from supabase_migrations.schema_migrations where version='${V[10]}'`});

// --- S2: co-resident fixtures before the snapshot -------------------------------------------------------------------
add({id:"helper-crlf",point:"S2",effect:"the owner replaces the pinned helper body by the same text with every LF as CRLF before the snapshot",callers:[CO],
  expected:[completed(["s7-passed","declaration-crlf-forensic"],HELPER_ONLY)],
  precondition:sqlPre(`select ${helperDigest}='2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1'
    and (select pg_catalog.strpos(p.prosrc,E'\\r')>0 from pg_catalog.pg_proc p where p.oid='public.rls_auto_enable()'::pg_catalog.regprocedure)
    and (select p.proacl is null from pg_catalog.pg_proc p where p.oid='public.rls_auto_enable()'::pg_catalog.regprocedure) as effective`),
  cases:["18"]},
  {kind:"sql",sql:replaceHelper(PIN_BODY.replaceAll("\n","\r\n"))});
add({id:"helper-copy-extensions",point:"S2",effect:"the owner creates a definer copy extensions.rls_auto_enable() before the snapshot",callers:[CO],
  expected:[SNAPSHOT_PATTERN("^PLATFORM_BASELINE_REFUSED: co-resident surface not admitted: ",HELPER_ONLY)],
  precondition:sqlPre("select pg_catalog.to_regprocedure('extensions.rls_auto_enable()') is not null as effective"),cases:["14 before snapshot","27.12.8 item 4"]},
  {kind:"sql",sql:`create schema if not exists extensions;\n${replaceHelper(PIN_BODY,"extensions.rls_auto_enable()")}`});
add({id:"unpinned-event-trigger-before",point:"S2",effect:"the owner creates an invoker event-trigger function public.kj_fixture_et() before the snapshot",callers:[CO],
  expected:[SNAPSHOT_PATTERN("^PLATFORM_BASELINE_REFUSED: co-resident surface not admitted: ",BOTH)],
  precondition:sqlPre("select pg_catalog.to_regprocedure('public.kj_fixture_et()') is not null as effective"),cases:["ACL-C before snapshot","27.12.8 item 4"]},
  {kind:"sql",sql:"create function public.kj_fixture_et() returns event_trigger language plpgsql as $f$ begin end $f$"});
add({id:"stamp-foreign-grants",point:"S2",effect:"the owner grants EXECUTE on the stamp function to anon and authenticated before the snapshot",callers:[LI],
  expected:[completed(["s7-passed"],["none"])],
  precondition:{kind:"sql",sql:`select pg_catalog.array_agg(a::pg_catalog.text order by a::pg_catalog.text collate "C") as acl
    from pg_catalog.pg_proc p, pg_catalog.unnest(p.proacl) a where p.oid='kernel_private.stamp_binding_provenance()'::pg_catalog.regprocedure`,
    expected:[{acl:["anon=X/postgres","authenticated=X/postgres","postgres=X/postgres"]}]},
  cases:["27.9.4 ACL (frozen _acl hook)","CON-43 positive"]},
  {kind:"sql",sql:"grant execute on function kernel_private.stamp_binding_provenance() to anon, authenticated"});
add({id:"stamp-body-tamper",point:"S2",effect:"the owner appends one space to the stamp function's body before the snapshot",callers:[LI],
  expected:[refused("S6",{sqlstate:"23514",pattern:"^B1: source digest of kernel_private\\.stamp_binding_provenance\\(\\) is [0-9a-f]{64}, pinned 468979611a28ca8e2ec7b46f16402e90ae6622a228e186e1acc7ac45186e439b$"},
    true,UNCHANGED,["none","platform-definer-fixture"])],
  precondition:sqlPre(`select (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex')
    from pg_catalog.pg_proc p where p.oid='kernel_private.stamp_binding_provenance()'::pg_catalog.regprocedure)
    <> '468979611a28ca8e2ec7b46f16402e90ae6622a228e186e1acc7ac45186e439b' as effective`),cases:["27.9.4 tamper (frozen _tamper hook)","27.9.3"]},
  {kind:"sql",sql:`do $f$ declare src text; begin
  select p.prosrc into src from pg_catalog.pg_proc p where p.oid='kernel_private.stamp_binding_provenance()'::pg_catalog.regprocedure;
  execute pg_catalog.format('create or replace function kernel_private.stamp_binding_provenance() returns trigger language plpgsql as %L', src || ' ');
end $f$`});
add({id:"stamp-and-head",point:"S2",effect:"the owner renames the stamp function and deletes the newest base ledger row before the snapshot",callers:[LI],
  expected:[SNAPSHOT("kernel_private.stamp_binding_provenance() does not exist")],
  precondition:sqlPre("select pg_catalog.to_regprocedure('kernel_private.stamp_binding_provenance()') is null as effective"),cases:["CON-44"]},
  {kind:"sql",sql:`alter function kernel_private.stamp_binding_provenance() rename to fixture_hidden_stamp;
delete from supabase_migrations.schema_migrations where version='${V.at(-1)}'`});

// --- S5: drift after the snapshot, two layers (27.12.9 rev 2.7.4) ---------------------------------------------------
const drift=(id:string,effect:string,sql:string,precondition:string,cases:string[],_profiles:Profile[],gate:Expectation,skipped:Expectation,callers:string[]=[CO])=>
  add({id,point:"S5",effect,callers,expected:[gate,skipped],precondition:sqlPre(precondition),cases},{kind:"sql",sql});
const CO_GATE=(profiles:Profile[])=>GATE("co-resident surface",profiles);
const CO_SKIP=(message:string,profiles:Profile[])=>B1(message,profiles,[SKIP]);
const AB=`${P2A}; ${P2B}`;
drift("drift-helper-body-byte","the owner changes one byte of the pinned helper body after the snapshot",replaceHelper(BYTE_BODY),
  `${helperDigest}='${sha(BYTE_BODY)}'`,["2","EPH-8 helper body"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(AB,HELPER_ONLY));
drift("drift-helper-body-upstream","the owner replaces the helper body by the upstream 536fbd5 text after the snapshot",replaceHelper(UPSTREAM_BODY),
  `${helperDigest}='${sha(UPSTREAM_BODY)}'`,["2 upstream"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(AB,HELPER_ONLY));
drift("drift-helper-owner","the owner changes the helper's owner to kj_fixture_owner after the snapshot",
  "create role kj_fixture_owner nologin;\nalter function public.rls_auto_enable() owner to kj_fixture_owner",
  `select pg_catalog.pg_get_userbyid((${HELPER}).proowner)='kj_fixture_owner' as effective`,["3"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(AB,HELPER_ONLY));
drift("drift-helper-invoker","the owner makes the helper SECURITY INVOKER after the snapshot","alter function public.rls_auto_enable() security invoker",
  `select not (${HELPER}).prosecdef as effective`,["4"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(AB,HELPER_ONLY));
drift("drift-helper-config-reset","the owner resets the helper's search_path after the snapshot","alter function public.rls_auto_enable() reset search_path",
  `select (${HELPER}).proconfig is null as effective`,["5 reset"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(AB,HELPER_ONLY));
drift("drift-helper-config-public","the owner sets the helper's search_path to public, pg_catalog after the snapshot",
  "alter function public.rls_auto_enable() set search_path = public, pg_catalog",
  `select (${HELPER}).proconfig::pg_catalog.text='{"search_path=public, pg_catalog"}' as effective`,["5 public"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(AB,HELPER_ONLY));
drift("drift-helper-acl-revoke-public","the owner revokes EXECUTE on the helper from PUBLIC after the snapshot",
  "revoke execute on function public.rls_auto_enable() from public",
  `select (${HELPER}).proacl::pg_catalog.text[] = array['postgres=X/postgres'] as effective`,["6 revoke"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(AB,HELPER_ONLY));
drift("drift-helper-acl-grant-worker","the owner creates role kj_worker and grants it EXECUTE on the helper after the snapshot",
  "create role kj_worker;\ngrant execute on function public.rls_auto_enable() to kj_worker",
  `select (select pg_catalog.array_agg(a order by a collate "C") from pg_catalog.unnest((${HELPER}).proacl::pg_catalog.text[]) a)
    = array['=X/postgres','kj_worker=X/postgres','postgres=X/postgres'] as effective`,["6 grant"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(AB,HELPER_ONLY));
drift("drift-ensure-rls-dropped","the owner drops event trigger ensure_rls after the snapshot","drop event trigger ensure_rls",
  "select not exists(select 1 from pg_catalog.pg_event_trigger where evtname='ensure_rls') as effective",["7","EPH-8 ensure_rls dropped","26"],
  HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(P2C,HELPER_ONLY),[CO,SE]);
for(const [mode,clause,label] of [["disable","D","disabled"],["enable replica","R","replica"],["enable always","A","always"]] as const)
  drift(`drift-ensure-rls-${label}`,`the owner sets ensure_rls to ${label} after the snapshot`,`alter event trigger ensure_rls ${mode}`,
    ensure(`e.evtenabled='${clause}'`),[`8 ${label}`],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(`${P2B}; ${P2C}`,HELPER_ONLY));
const rebind=(tags:string,fn="public.rls_auto_enable()")=>`drop event trigger ensure_rls;\ncreate event trigger ensure_rls on ddl_command_end when tag in (${tags}) execute function ${fn}`;
drift("drift-tags-create-table-only","the owner re-creates ensure_rls with the tag CREATE TABLE only after the snapshot",rebind("'CREATE TABLE'"),
  ensure("e.evttags::pg_catalog.text='{\"CREATE TABLE\"}'"),["9 one tag"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(`${P2B}; ${P2C}`,HELPER_ONLY));
drift("drift-tags-alter-table-added","the owner re-creates ensure_rls with ALTER TABLE added to its tags after the snapshot",
  rebind("'CREATE TABLE','CREATE TABLE AS','SELECT INTO','ALTER TABLE'"),ensure("pg_catalog.cardinality(e.evttags)=4"),["9 extra tag"],
  HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(`${P2B}; ${P2C}`,HELPER_ONLY));
const ET="returns event_trigger language plpgsql as $f$ begin end $f$";
drift("drift-ensure-rls-rebound-public","the owner re-binds ensure_rls to a new invoker event-trigger function in public after the snapshot",
  `create function public.kj_fixture_et() ${ET};\n${rebind("'CREATE TABLE','CREATE TABLE AS','SELECT INTO'","public.kj_fixture_et()")}`,
  ensure("e.evtfoid='public.kj_fixture_et()'::pg_catalog.regprocedure"),["10 public"],HELPER_ONLY,CO_GATE(HELPER_ONLY),
  CO_SKIP(`${P2A}; ${P2B}; ${P2C}`,HELPER_ONLY));
drift("drift-ensure-rls-rebound-extensions","the owner re-binds ensure_rls to a new event-trigger function in schema extensions after the snapshot",
  `create schema if not exists extensions;\ncreate function extensions.kj_fixture_et() ${ET};\n${rebind("'CREATE TABLE','CREATE TABLE AS','SELECT INTO'","extensions.kj_fixture_et()")}`,
  ensure("e.evtfoid='extensions.kj_fixture_et()'::pg_catalog.regprocedure"),["10 other schema"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(P2C,HELPER_ONLY));
drift("drift-second-event-trigger","the owner adds a second event trigger kj_fixture_second on the helper after the snapshot",
  "create event trigger kj_fixture_second on ddl_command_end when tag in ('CREATE TABLE') execute function public.rls_auto_enable()",
  "select (select pg_catalog.count(*) from pg_catalog.pg_event_trigger where evtfoid='public.rls_auto_enable()'::pg_catalog.regprocedure)=2 as effective",
  ["11"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(`${P2B}; ${P2C}`,HELPER_ONLY));
drift("drift-definer-copy-public","the owner creates an exact definer copy public.rls_auto_enable_copy() after the snapshot",
  replaceHelper(PIN_BODY,"public.rls_auto_enable_copy()"),"select pg_catalog.to_regprocedure('public.rls_auto_enable_copy()') is not null as effective",
  ["12 definer copy","ACL-C definer copy"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(`${P1}; ${P2A}`,HELPER_ONLY));
drift("drift-invoker-event-trigger-public","the owner creates an invoker event-trigger function public.kj_fixture_et() after the snapshot",
  `create function public.kj_fixture_et() ${ET}`,"select pg_catalog.to_regprocedure('public.kj_fixture_et()') is not null as effective",
  ["12 invoker","ACL-C invoker"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(P2A,HELPER_ONLY));
drift("drift-overload-text","the owner creates an overload public.rls_auto_enable(text) after the snapshot",
  "create function public.rls_auto_enable(text) returns void language plpgsql as $f$ begin end $f$",
  "select pg_catalog.to_regprocedure('public.rls_auto_enable(text)') is not null as effective",["13"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(P2D,HELPER_ONLY));
drift("drift-copy-extensions","the owner creates a definer copy extensions.rls_auto_enable() after the snapshot",
  `create schema if not exists extensions;\n${replaceHelper(PIN_BODY,"extensions.rls_auto_enable()")}`,
  "select pg_catalog.to_regprocedure('extensions.rls_auto_enable()') is not null as effective",["14 after snapshot"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(P2D,HELPER_ONLY));
drift("drift-set-schema-extensions","the owner moves the helper to schema extensions after the snapshot",
  "create schema if not exists extensions;\nalter function public.rls_auto_enable() set schema extensions",
  "select pg_catalog.to_regprocedure('public.rls_auto_enable()') is null and pg_catalog.to_regprocedure('extensions.rls_auto_enable()') is not null as effective",
  ["14 set schema"],HELPER_ONLY,CO_GATE(HELPER_ONLY),CO_SKIP(P2D,HELPER_ONLY));
const DEF="returns void language plpgsql security definer set search_path = '' as $f$ begin end $f$";
drift("drift-extra-definer-kernel-private","the owner creates a definer kernel_private.kj_fixture_definer() after the snapshot",
  `create function kernel_private.kj_fixture_definer() ${DEF}`,"select (select prosecdef from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('kernel_private.kj_fixture_definer()')) as effective",
  ["15 kernel_private"],NONE,CO_GATE(NONE),CO_SKIP(`${P1}; ${P2A}`,NONE));
drift("drift-extra-definer-public","the owner creates a definer public.kj_fixture_definer() after the snapshot",
  `create function public.kj_fixture_definer() ${DEF}`,"select (select prosecdef from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('public.kj_fixture_definer()')) as effective",
  ["15 public","EPH-8 extra definer in public"],NONE,CO_GATE(NONE),CO_SKIP(`${P1}; ${P2A}`,NONE));
add({id:"drift-extra-definer-extensions",point:"S5",effect:"the owner creates a definer extensions.kj_fixture_definer() after the snapshot",callers:[CO],
  expected:[GATE("definer inventory",NONE,"extra extensions\\.kj_fixture_definer\\(\\)"),
    refused("S7",{pattern:"^POST_LEDGER_REFUSED: inventory: unlisted SECURITY DEFINER function extensions\\.kj_fixture_definer\\(\\)"},true,[],NONE,[SKIP])],
  precondition:sqlPre("select (select prosecdef from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('extensions.kj_fixture_definer()')) as effective"),
  cases:["EPH-8 extra definer in extensions"]},
  {kind:"sql",sql:`create schema if not exists extensions;\ncreate function extensions.kj_fixture_definer() ${DEF}`});

// --- S5: ledger states after the snapshot (LEDGER-C to LEDGER-F) ----------------------------------------------------
const LEDGER_GATE=(detail:string)=>GATE("ledger set",NONE,`the migration ledger does not record exactly the 22 base migrations before B1; ${esc(detail)}$`);
add({id:"ledger-b1-row-after-snapshot",point:"S5",effect:"the owner records ledger version 20261002090000 after the snapshot",callers:[LE],
  expected:[LEDGER_GATE("unexpected 20261002090000")],precondition:ledgerRows([...V,"20261002090000"]),cases:["LEDGER-C"]},
  {kind:"sql",sql:"insert into supabase_migrations.schema_migrations(version,name) values ('20261002090000','runtime_least_privilege_roles')"});
add({id:"ledger-commit-failure",point:"S5",effect:"the owner adds a deferred constraint trigger on the ledger that raises at COMMIT for version 20261002090000",callers:[LE],
  expected:[refused("S6",{sqlstate:"P0001",message:"LEDGER-D fixture: commit-time failure"},true,UNCHANGED,NONE)],
  precondition:sqlPre("select exists(select 1 from pg_catalog.pg_trigger where tgname='kj_fixture_commit_failure' and tgdeferrable and tginitdeferred) as effective"),
  cases:["LEDGER-D"]},
  {kind:"sql",sql:`create function supabase_migrations.kj_fixture_commit_failure() returns trigger language plpgsql as $f$
begin
  if new.version = '20261002090000' then raise exception 'LEDGER-D fixture: commit-time failure' using errcode = 'P0001'; end if;
  return null;
end $f$;
create constraint trigger kj_fixture_commit_failure after insert on supabase_migrations.schema_migrations
  deferrable initially deferred for each row execute function supabase_migrations.kj_fixture_commit_failure()`});
for(const [label,index] of [["oldest",0],["middle",10],["newest",21]] as const)
  add({id:`ledger-${label}-missing-after-snapshot`,point:"S5",effect:`the owner deletes the ${label} base ledger row after the snapshot`,callers:[LE],
    expected:[LEDGER_GATE(`missing ${V[index]}`)],precondition:ledgerRows(V.filter((_,i)=>i!==index)),cases:[`LEDGER-E ${label}`]},
    {kind:"sql",sql:`delete from supabase_migrations.schema_migrations where version='${V[index]}'`});
add({id:"ledger-extra-after-snapshot",point:"S5",effect:"the owner inserts ledger version 20250101000000 after the snapshot",callers:[LE],
  expected:[LEDGER_GATE("unexpected 20250101000000")],precondition:ledgerRows(["20250101000000",...V]),cases:["LEDGER-F"]},
  {kind:"sql",sql:"insert into supabase_migrations.schema_migrations(version) values ('20250101000000')"});
add({id:"noop-precondition",point:"S5",effect:"the owner runs select 1 and changes nothing",callers:[LI],
  expected:[completed(["s7-passed"],NONE)],
  precondition:{kind:"sql",sql:`select pg_catalog.array_agg(a::pg_catalog.text order by a::pg_catalog.text collate "C") as acl
    from pg_catalog.pg_proc p, pg_catalog.unnest(p.proacl) a where p.oid='kernel_private.stamp_binding_provenance()'::pg_catalog.regprocedure`,
    expected:[{acl:["anon=X/postgres","authenticated=X/postgres","postgres=X/postgres"]}]},cases:["CON-43"]},
  {kind:"sql",sql:"select 1"});

// --- skips -----------------------------------------------------------------------------------------------------------
add({id:SKIP,point:"S6-gate-inventory-skip",effect:"the gate omits its inventory, co-resident and name-uniqueness part once",callers:[CO,SE,LI],
  expected:[completed(["s7-passed"],["none","pinned-helper","platform-definer-fixture"])],
  precondition:runnerPre("skipped-check",{check:"gate-inventory"}),cases:["27.12.9 two layers","EPH-8","EPH-24"]},{kind:"skip",check:"gate-inventory"});
add({id:"s4-skip",point:"S4-skip",effect:"S4 validation of the run files is omitted once",callers:[LI],
  expected:[completed(["s7-passed"],NONE)],precondition:runnerPre("skipped-check",{check:"S4"}),cases:["EPH-18","EPH-24"]},{kind:"skip",check:"S4"});
add({id:"l3-skip",point:"L3-skip",effect:"the daemon attestation is omitted for the next connection only",callers:[LI],
  expected:[completed(["s7-passed"],NONE)],precondition:runnerPre("skipped-check",{check:"L3"}),cases:["EPH-21","EPH-24"]},{kind:"skip",check:"L3"});

// --- L2-target ---------------------------------------------------------------------------------------------------------
add({id:"l2-foreign-container",point:"L2-target",effect:"the factory's container and port are replaced by a foreign cluster container without the nonce",callers:[LI],
  expected:[refused("L3",{pattern:"^LIFECYCLE_REFUSED: L3: container image, command, label, state or mounts differ$"},false,["fixture-removed"],NONE),
    refused("L5",{pattern:"^L5: cluster nonce differs$"},false,["fixture-removed"],NONE,["l3-skip"])],
  precondition:runnerPre("target-substituted",{fixture:"foreign-container"}),cases:["EPH-3"]},{kind:"target",fixture:"foreign-container"});
add({id:"l2-preexisting-tunnel",point:"L2-target",effect:"the factory's container and port are replaced by a forwarding container to a cluster created before the run container",callers:[LI],
  expected:[refused("L3",{pattern:"^LIFECYCLE_REFUSED: L3: container image, command, label, state or mounts differ$"},false,["fixture-removed"],NONE),
    refused("L5",{pattern:"^L5: cluster nonce differs; cluster predates container or initdb follows postmaster start$"},false,["fixture-removed"],NONE,["l3-skip"])],
  precondition:runnerPre("target-substituted",{fixture:"preexisting-tunnel"}),cases:["EPH-4"]},{kind:"target",fixture:"preexisting-tunnel"});

// --- S3-files ----------------------------------------------------------------------------------------------------------
const files=(id:string,effect:string,mechanics:Extract<Mechanics,{kind:"files"}>,expected:Expectation[],cases:string[],callers:string[]=[LI])=>
  add({id,point:"S3-files",effect,callers,expected,precondition:runnerPre("run-files",{when:mechanics.when,target:mechanics.target,transform:mechanics.transform,rerecorded:mechanics.rerecord}),cases},mechanics);
const S4_REFUSED=(pattern:string,profiles:Profile[]=NONE)=>refused("S4",{pattern},false,UNCHANGED,profiles);
files("files-declaration-after-s4","the run-bound declaration's bytes are changed after S4 and its digest is not re-recorded",
  {kind:"files",when:"after-S4",target:"declaration",transform:"edit-environment",rerecord:false},
  [refused("S6",{pattern:"^ARTIFACT_REFUSED: declaration bytes changed after S3$"},false,UNCHANGED,NONE)],["EPH-6 before S6"]);
files("files-declaration-after-s6","the run-bound declaration's bytes are changed after S6 and its digest is not re-recorded",
  {kind:"files",when:"after-S6",target:"declaration",transform:"edit-environment",rerecord:false},
  [refused("S7",{pattern:"^ARTIFACT_REFUSED: declaration bytes changed after S3$"},true,[],NONE)],["EPH-6 after S6","37 ephemeral form"]);
files("files-declaration-deleted","the run-bound declaration is deleted after S3",
  {kind:"files",when:"after-S3",target:"declaration",transform:"delete",rerecord:false},[S4_REFUSED("^ARTIFACT_REFUSED: declaration is missing$")],["EPH-7 deleted"]);
for(const [transform,label] of [["invalid-json","invalid JSON"],["bom","a byte-order mark"],["drop-mode","no mode"],["hosted-with-run","HOSTED_COMMITTED with run"],
  ["ephemeral-without-run","EPHEMERAL_RUN_BOUND without run"],["run-unknown-field","an unknown field in run"]] as const)
  files(`files-declaration-${transform}`,`the run-bound declaration is rewritten with ${label} after S3 and its digest re-recorded`,
    {kind:"files",when:"after-S3",target:"declaration",transform,rerecord:true},[S4_REFUSED("^ARTIFACT_REFUSED: declaration invalid: ")],[`EPH-7 ${label}`]);
for(const [transform,label] of [["baseline-mode-hosted","mode HOSTED_COMMITTED"],["baseline-drop-mode","no mode"]] as const)
  files(`files-${transform}`,`the run-bound baseline is rewritten with ${label} after S3 and its digest re-recorded`,
    {kind:"files",when:"after-S3",target:"baseline",transform,rerecord:true},[S4_REFUSED("^ARTIFACT_REFUSED: baseline invalid: ")],[`EPH-19 ${label}`]);
for(const field of ["runId","clusterNonce","containerId","containerCreated","application"] as const)
  files(`files-baseline-run-${field.toLowerCase()}`,`the run-bound baseline's run.${field} is changed after S3 and its digest re-recorded`,
    {kind:"files",when:"after-S3",target:"baseline",transform:`run-${field}`,rerecord:true},
    [S4_REFUSED("^ARTIFACT_REFUSED: run binding differs from this run and application: baseline$")],[`EPH-20 ${field}`]);
files("files-foreign-run","both run files are replaced by another run's binding and system identifier, digests re-recorded",
  {kind:"files",when:"after-S3",target:"both",transform:"foreign-run",rerecord:true},
  [S4_REFUSED("^ARTIFACT_REFUSED: run binding differs from this run and application: baseline, declaration$"),
    GATE("target identity",NONE,"live system identifier",["s4-skip"])],["EPH-2","EPH-15"]);
files("files-foreign-baseline","the baseline is replaced by another run's baseline (run and system identifier), digest re-recorded",
  {kind:"files",when:"after-S3",target:"baseline",transform:"foreign-baseline",rerecord:true},
  [S4_REFUSED("^ARTIFACT_REFUSED: run binding differs from this run and application: baseline$"),GATE("artifacts",NONE,"",["s4-skip"])],["EPH-18"]);
files("files-sysid","both run files carry another system identifier, digests re-recorded",
  {kind:"files",when:"after-S3",target:"both",transform:"sysid",rerecord:true},
  [S4_REFUSED("^ARTIFACT_REFUSED: system identifier or database differs from the live values read at L5$"),
    GATE("target identity",NONE,"live system identifier",["s4-skip"])],["EPH-5"]);
files("files-entry-digest","the declared helper entry's sourceDigest is edited to another value, digest re-recorded",
  {kind:"files",when:"after-S3",target:"declaration",transform:"entry-digest",rerecord:true},
  [S4_REFUSED("^ARTIFACT_REFUSED: declaration invalid: ",HELPER_ONLY)],["17 entry"],[CO]);
files("files-set-sha","the declaration's setSha256 is edited, digest re-recorded",
  {kind:"files",when:"after-S3",target:"declaration",transform:"set-sha",rerecord:true},
  [S4_REFUSED("^ARTIFACT_REFUSED: declaration invalid: ",HELPER_ONLY)],["17 setSha256"],[CO]);

// --- S6-apply: startup settings (27.12.9 cases 16, 19, 24 to 30, 38; 26) ------------------------------------------------
const D={from:"declaration"} as const,O={omit:true} as const,val=(value:string)=>({value});
const describe=(s:Settings)=>Object.fromEntries(Object.entries(s).map(([k,v])=>[k,"from" in v?"<declaration>":"omit" in v?"<absent>":v.value]));
const settings=(id:string,effect:string,s:Settings,expected:Expectation[],cases:string[])=>
  add({id,point:"S6-apply",effect,callers:[SE],expected,precondition:runnerPre("engine-settings",describe(s)),cases},{kind:"settings",settings:s});
settings("settings-none","the engine connection carries none of the three settings",{digest:O,sysid:O,database:O},[B1(STEP1,BOTH)],["19 none","24"]);
for(const [id,s] of [["only-digest",{digest:D,sysid:O,database:O}],["only-sysid",{digest:O,sysid:D,database:O}],["only-database",{digest:O,sysid:O,database:D}],
  ["without-digest",{digest:O,sysid:D,database:D}],["without-sysid",{digest:D,sysid:O,database:D}],["without-database",{digest:D,sysid:D,database:O}]] as const)
  settings(`settings-${id}`,`the engine connection carries a partial setting combination: ${id}`,s,[B1(STEP1,BOTH)],[`19 ${id}`,`25 ${id}`]);
for(const key of ["digest","sysid","database"] as const)
  settings(`settings-empty-${key}`,`the engine connection sets ${key} to the empty string`,{digest:D,sysid:D,database:D,[key]:val("")},[B1(STEP1,BOTH)],[`25 empty ${key}`]);
for(const [id,value] of [["abc","abc"],["leading-zero","0123"],["leading-space"," 1"],["trailing-space","1 "],["twenty-digits","12345678901234567890"],["decimal","7678069749886157684.0"]] as const)
  settings(`settings-sysid-${id}`,`the engine connection carries a malformed system identifier: ${id}`,{digest:D,sysid:val(value),database:D},[B1(STEP2,BOTH)],[`27 ${id}`]);
const EMPTY="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",GOLD="80d365b875ba65ae543e351a47c09f66c6df756db772f6fa494a36639291d721";
for(const [id,value] of [["uppercase",EMPTY.toUpperCase()],["sixty-three",EMPTY.slice(0,63)],["sixty-five",EMPTY+"0"],["non-hex","g"+EMPTY.slice(1)]] as const)
  settings(`settings-digest-${id}`,`the engine connection carries a malformed set digest: ${id}`,{digest:val(value),sysid:D,database:D},[B1(STEP2,BOTH)],[`28 ${id}`]);
for(const [id,value] of [["sixty-four-bytes","k".repeat(64)],["control-character","kj_b1\u0001"]] as const)
  settings(`settings-database-${id}`,`the engine connection carries a malformed database name: ${id}`,{digest:D,sysid:D,database:val(value)},[B1(STEP2,BOTH)],[`29 ${id}`]);
settings("settings-database-other","the engine connection names another database",{digest:D,sysid:D,database:val("kj_other")},[B1(STEP3,BOTH)],["30"]);
settings("settings-sysid-other","the engine connection names the production system identifier",{digest:D,sysid:val("7678069749886157684"),database:D},[B1(STEP4,BOTH)],
  ["16","EPH-2 forced","EPH-5 forced","EPH-15 forced"]);
settings("settings-digest-empty-set","the engine connection carries the empty-serialisation digest on a target holding the helper",{digest:val(EMPTY),sysid:D,database:D},
  [B1(STEP5,HELPER_ONLY)],["38"]);
settings("settings-digest-golden","the engine connection carries the helper target's set digest on a target without the helper",{digest:val(GOLD),sysid:D,database:D},
  [B1(STEP5,NONE)],["19 helper declaration on empty target"]);
const FN_ONLY=sha("fn|public|rls_auto_enable||pg_catalog.event_trigger|f|f|postgres|t|plpgsql|v|f|f|u|{search_path=pg_catalog}|NULL|2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1");
settings("settings-digest-fn-only","the engine connection carries the digest of the helper's fn line alone",{digest:val(FN_ONLY),sysid:D,database:D},
  [B1(STEP5,HELPER_ONLY),B1(P2C,HELPER_ONLY,["drift-ensure-rls-dropped",SKIP])],["26"]);

// --- S6-apply: other perturbations -----------------------------------------------------------------------------------
const CLEANUP_END="end $b1_acl$;";
add({id:"b1-variant-runtime-blanket",point:"S6-apply",effect:"the exported B1 file gains the frozen per-role blanket function revoke after its enumerated cleanup",callers:[CO],
  expected:[refused("S6",{sqlstate:"23514",message:`B1 ${AB}`},true,[...UNCHANGED,"helper-proacl-null"],HELPER_ONLY)],
  precondition:runnerPre("export-variant",{statement:"revoke all on all functions in schema public, kernel_private from kj_worker, kj_door;"}),cases:["ACL-B"]},
  {kind:"variant",after:CLEANUP_END,statement:"revoke all on all functions in schema public, kernel_private from kj_worker, kj_door;"});
add({id:"b1-variant-public-blanket",point:"S6-apply",effect:"the exported B1 file gains the frozen PUBLIC blanket function revoke after its enumerated cleanup",callers:[CO],
  expected:[refused("S6",{sqlstate:"23514",message:`B1 ${AB}`},true,[...UNCHANGED,"helper-proacl-null"],HELPER_ONLY)],
  precondition:runnerPre("export-variant",{statement:"revoke execute on all functions in schema public, kernel_private from public;"}),cases:["6 old blanket revoke"]},
  {kind:"variant",after:CLEANUP_END,statement:"revoke execute on all functions in schema public, kernel_private from public;"});
add({id:"b1-outside-engine",point:"S6-apply",effect:"the B1 blob is applied in an owner transaction instead of through the engine, so no ledger row is written",callers:[LE],
  expected:[refused("S7",{pattern:"^POST_LEDGER_REFUSED: ledger set: .*missing 20261002090000$"},false,[],NONE)],
  precondition:sqlPre(`select (select prosecdef from pg_catalog.pg_proc where oid='kernel_private.stamp_binding_provenance()'::pg_catalog.regprocedure)
    and not exists(select 1 from supabase_migrations.schema_migrations where version='20261002090000') as effective`),cases:["LEDGER-B"]},
  {kind:"outside-engine"});
add({id:"post-commit-drop-ensure-rls",point:"S6-apply",effect:"after the engine commits B1, the owner drops event trigger ensure_rls",callers:[CO],
  expected:[refused("S7",{pattern:"^POST_LEDGER_REFUSED: inventory: "},true,[],HELPER_ONLY)],
  precondition:sqlPre("select not exists(select 1 from pg_catalog.pg_event_trigger where evtname='ensure_rls') as effective"),cases:["37 live surface changed after COMMIT"]},
  {kind:"post-commit",sql:"drop event trigger ensure_rls"});
add({id:"export-tamper",point:"S6-apply",effect:"one exported base migration file is changed after the export, before the engine runs",callers:[LI],
  expected:[refused("S6",{pattern:"^RELEASE_REFUSED: exported bytes differ: "},false,UNCHANGED,NONE)],
  precondition:runnerPre("export-variant",{tampered:"20260905153656_identity.sql"}),cases:["EPH-14 exported file","40 exported file"]},{kind:"export-tamper"});
add({id:"migration-blob-record",point:"S6-apply",effect:"after the engine commits, the runner's recorded migrationBlob is replaced by another blob id",callers:[LI],
  expected:[refused("S7",{pattern:"^S7_REFUSED: migrationBlob differs from the B1 blob at R$"},true,[],NONE)],
  precondition:runnerPre("record-altered",{field:"migrationBlob"}),cases:["EPH-14 migrationBlob at S7"]},{kind:"record-altered"});

export const HOOK_DEFINITIONS:readonly HookDefinition[]=Object.freeze(definitions);
export const definition=(id:string)=>HOOK_DEFINITIONS.find(d=>d.hook.id===id);
