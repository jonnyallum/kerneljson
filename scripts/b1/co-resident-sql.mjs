// ADR-0023 27.12.7. These checks are emitted into B1, never installed as functions.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const pins = JSON.parse(readFileSync(new URL('../../infrastructure/database/co-resident-platform-pins.json', import.meta.url), 'utf8'));
const pin = pins.entries[0];
if (pins.kind !== 'kerneljson:co-resident-platform-pins/v1' || pins.entries.length !== 1 ||
    pin.sourceDigest !== '2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1') throw Error('unsealed co-resident pin');
export const golden = `evt|ensure_rls|postgres|ddl_command_end|public.rls_auto_enable()|O|CREATE TABLE,CREATE TABLE AS,SELECT INTO\nfn|public|rls_auto_enable||pg_catalog.event_trigger|f|f|postgres|t|plpgsql|v|f|f|u|{search_path=pg_catalog}|NULL|${pin.sourceDigest}`;
export const populatedDigest = createHash('sha256').update(golden).digest('hex');
if (populatedDigest !== '80d365b875ba65ae543e351a47c09f66c6df756db772f6fa494a36639291d721') throw Error('co-resident golden vector drift');
export const settingsCheck = `do $b1_settings$
declare
  digest text := pg_catalog.current_setting('kj.b1.co_resident_set_sha256', true);
  sysid text := pg_catalog.current_setting('kj.b1.target_system_identifier', true);
  db text := pg_catalog.current_setting('kj.b1.target_database', true);
begin
  if digest is null or digest = '' or sysid is null or sysid = '' or db is null or db = '' then
    raise exception 'B1 P3 step 1: three declaration settings are required' using errcode = '23514';
  end if;
  if digest !~ '^[0-9a-f]{64}$' or sysid !~ '^(0|-?[1-9][0-9]{0,18})$'
     or pg_catalog.octet_length(db) not between 1 and 63 or db ~ '[\\x01-\\x1f]' then
    raise exception 'B1 P3 step 2: malformed declaration settings' using errcode = '23514';
  end if;
end $b1_settings$;`;
export const enumeratedCleanup = `do $b1_acl$
declare f record;
begin
  for f in select p.oid::pg_catalog.regprocedure::text as identity
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'kernel_private') and p.prokind in ('f', 'a', 'w')
      and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
    order by p.oid::pg_catalog.regprocedure::text collate "C"
  loop
    execute pg_catalog.format('revoke execute on function %s from public', f.identity);
    execute pg_catalog.format('revoke all on function %s from kj_worker, kj_door', f.identity);
  end loop;
end $b1_acl$;`;
export const equalityChecks = `-- Sealed pins: ${JSON.stringify(pins)}
do $b1_equality$
declare f record; e record; helper oid; expected text; observed text; violations text[] := '{}';
begin
  -- P1 compares exact identities, independently of P2 and the declaration.
  select pg_catalog.string_agg(n.nspname || '.' || p.proname || '(' ||
    coalesce((select pg_catalog.string_agg(tn.nspname || '.' || t.typname, ',' order by a.i)
      from pg_catalog.unnest(p.proargtypes::oid[]) with ordinality a(oid,i)
      join pg_catalog.pg_type t on t.oid=a.oid join pg_catalog.pg_namespace tn on tn.oid=t.typnamespace), '') || ')', E'\\n'
    order by n.nspname collate "C", p.proname collate "C", p.oid)
    into observed from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','kernel_private') and p.prosecdef
    and not (n.nspname='public' and p.proname='rls_auto_enable' and p.pronargs=0);
  if observed is distinct from 'kernel_private.stamp_binding_provenance()' then
    violations := violations || 'P1: KernelJSON definer identity set differs'::text;
  end if;
  -- P1 and P2 are decided from the catalogue and the embedded pins alone, before P3. Every violated clause is named,
  -- in the order P1, P2 (a) to (d), in one 23514, so a fixture that breaks several clauses at once (for example
  -- ensure_rls re-bound to another public function, or an unpinned definer event-trigger function) is reported by
  -- each of them rather than only by whichever clause happens to be evaluated first.
  -- P2(a), E1: every skipped event-trigger function is checked, even an invoker.
  for f in select p.*, n.nspname, l.lanname, pg_catalog.pg_get_userbyid(p.proowner) as owner,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex') as digest
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    join pg_catalog.pg_language l on l.oid=p.prolang
    where n.nspname in ('public','kernel_private')
      and (p.prosecdef or p.prorettype='pg_catalog.event_trigger'::pg_catalog.regtype)
      and not (n.nspname='kernel_private' and p.proname='stamp_binding_provenance' and p.pronargs=0)
  loop
    if f.nspname <> 'public' or f.proname <> 'rls_auto_enable' or f.pronargs <> 0
      or f.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype or f.proretset or f.prokind <> 'f'
      or f.owner <> 'postgres' or not f.prosecdef or f.lanname <> 'plpgsql'
      or f.proconfig is distinct from array['search_path=pg_catalog'] or f.proacl is not null
      or f.provolatile <> 'v' or f.proisstrict or f.proleakproof or f.proparallel <> 'u'
      or f.probin is not null or f.prosqlbody is not null
      or f.digest <> '${pin.sourceDigest}'
      or pg_catalog.octet_length(pg_catalog.replace(f.prosrc,E'\\r\\n',E'\\n')) <> 953 then
      violations := violations || 'P2 (a) E1: co-resident function differs from sealed pin'::text;
    else
      helper := f.oid;
    end if;
  end loop;
  -- P2(b), E2: every event trigger bound into either governed application schema is the sealed binding of the pin.
  for e in select t.* from pg_catalog.pg_event_trigger t join pg_catalog.pg_proc p on p.oid=t.evtfoid
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','kernel_private')
  loop
    if helper is null or e.evtfoid <> helper or e.evtname <> 'ensure_rls'
      or pg_catalog.pg_get_userbyid(e.evtowner) <> 'postgres' or e.evtevent <> 'ddl_command_end'
      or e.evtenabled <> 'O' or (select pg_catalog.array_agg(tag order by tag collate "C")
        from pg_catalog.unnest(e.evttags) tag) is distinct from array['CREATE TABLE','CREATE TABLE AS','SELECT INTO'] then
      violations := violations || 'P2 (b) E2: event-trigger binding differs'::text;
    end if;
  end loop;
  -- P2(c), E3: a present pinned function carries exactly its complete sealed topology, every column, no other row.
  if helper is not null and ((select pg_catalog.count(*) from pg_catalog.pg_event_trigger where evtfoid=helper) <> 1
    or not exists (select 1 from pg_catalog.pg_event_trigger e where e.evtfoid=helper and e.evtname='ensure_rls'
      and pg_catalog.pg_get_userbyid(e.evtowner)='postgres' and e.evtevent='ddl_command_end' and e.evtenabled='O'
      and (select pg_catalog.array_agg(tag order by tag collate "C") from pg_catalog.unnest(e.evttags) tag)
        is not distinct from array['CREATE TABLE','CREATE TABLE AS','SELECT INTO'])) then
    violations := violations || 'P2 (c) E3: sealed topology of the pinned function is incomplete or extended'::text;
  end if;
  -- P2(d): name uniqueness is global, not limited to definers. The pinned name may be carried only by the pinned
  -- identity, and by that only while it is in CR_ACTUAL (a definer or an event-trigger function); (a) judges its
  -- attributes, so a drifted body at the pinned identity is an (a) finding, not a (d) one.
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where p.proname='rls_auto_enable'
      and not (n.nspname in ('pg_catalog','information_schema','pg_toast')
        or n.nspname ~ '^pg_temp_[0-9]+$' or n.nspname ~ '^pg_toast_temp_[0-9]+$')
      and not (n.nspname='public' and p.pronargs=0
        and (p.prosecdef or p.prorettype='pg_catalog.event_trigger'::pg_catalog.regtype))) then
    violations := violations || 'P2 (d): co-resident name uniqueness differs'::text;
  end if;
  if pg_catalog.cardinality(violations) > 0 then
    raise exception 'B1 %', pg_catalog.array_to_string(violations, '; ') using errcode='23514';
  end if;
  -- P3 presence and format were just rechecked after all authority mutations.
  if pg_catalog.current_setting('kj.b1.target_database',true) <> pg_catalog.current_database() then
    raise exception 'B1 P3 step 3: target database differs' using errcode='23514';
  end if;
  if pg_catalog.current_setting('kj.b1.target_system_identifier',true) <>
      (pg_catalog.pg_control_system()).system_identifier::text then
    raise exception 'B1 P3 step 4: target system identifier differs' using errcode='23514';
  end if;
  -- Serialisation is defined only over P2-admitted values; no arbitrary catalogue text is encoded.
  expected := case when helper is null then '' else '${golden.replaceAll("'", "''")}' end;
  if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(expected,'UTF8')),'hex') <>
      pg_catalog.current_setting('kj.b1.co_resident_set_sha256',true) then
    raise exception 'B1 P3 step 5: co-resident set digest differs' using errcode='23514';
  end if;
end $b1_equality$;`;
