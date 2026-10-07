// KJ-P8 migration-ledger drift adjudication: a structural, read-only catalogue footprint.
//
// footprint(client) reads, inside ONE transaction that is REPEATABLE READ and READ ONLY with search_path = '', the
// durable catalogue state of the KernelJSON schemas (public, kernel_private) and returns it as a flat map of stable
// keys to canonical values, plus the Supabase migration ledger, the default ACLs and the one seed row the audited
// migrations require. It never writes: no temp table, no persistent SET, no function with side effects; the
// transaction is always rolled back.
//
// Values carry no OIDs and no timestamps, so two databases built from the same SQL produce identical maps. Function
// bodies are compared by sha256 of prosrc; deparsed definitions (defaults, constraints, indexes, triggers, views,
// policies, domain checks, SQL-standard bodies) are kept verbatim or digested and are only comparable between servers
// of the same PostgreSQL major version (see compare-lib.mjs).
//
// ACLs are EFFECTIVE ACLs: a NULL acl is expanded with acldefault() for the object's kind and owner, so "no explicit
// ACL" and "the built-in default" compare as what they mean. aclBuiltin is acldefault() itself, computed by the server
// being read: privilege context only, never compared.
//
// `client` needs only query(sql, params) returning { rows }.

export const SCHEMAS = ["public", "kernel_private"];

const q = (client, sql, params = []) => client.query(sql, params).then((r) => r.rows);

// Objects belonging to an extension are platform state, never a migration's footprint.
const NOT_EXT = (classOid, objOid) =>
  `not exists (select 1 from pg_catalog.pg_depend d where d.classid = ${classOid} and d.objid = ${objOid} and d.deptype = 'e')`;
const REL = "'pg_catalog.pg_class'::pg_catalog.regclass";

const ACL = (col) => `(select coalesce(pg_catalog.array_agg(x order by x), '{}') from (
    select case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end || '=' || a.privilege_type
           || case when a.is_grantable then '*' else '' end as x
      from pg_catalog.aclexplode(${col}) a) s)`;
const KIND = (kind) => (kind.length === 1 ? `'${kind}'::pg_catalog."char"` : kind);
const EFFECTIVE = (col, kind, owner) => ACL(`coalesce(${col}, pg_catalog.acldefault(${KIND(kind)}, ${owner}))`);
const BUILTIN = (kind, owner) => ACL(`pg_catalog.acldefault(${KIND(kind)}, ${owner})`);
const RELKIND = `(case when c.relkind = 'S' then 's' else 'r' end)::pg_catalog."char"`;
const SHA = (text) => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${text}, 'UTF8')), 'hex')`;

export async function footprint(client) {
  await client.query("begin isolation level repeatable read read only");
  try {
    await client.query("set local search_path = ''");
    const [guard] = await q(client, `select pg_catalog.current_setting('transaction_read_only') as ro,
      pg_catalog.current_setting('transaction_isolation') as iso, pg_catalog.current_setting('search_path') as sp,
      pg_catalog.current_setting('server_version_num') as v, pg_catalog.current_database() as db, current_user as usr`);
    if (guard.ro !== "on" || guard.iso !== "repeatable read" || (guard.sp !== '""' && guard.sp !== ""))
      throw new Error(`FOOTPRINT_REFUSED: transaction is not REPEATABLE READ READ ONLY with empty search_path`);
    // Bind the footprint to the cluster where readable; a refusal is recorded, never fatal (savepoints are read-only safe).
    let systemIdentifier = null;
    await client.query("savepoint sysid");
    try {
      [{ systemIdentifier }] = await q(client, `select system_identifier::text as "systemIdentifier" from pg_catalog.pg_control_system()`);
      await client.query("release savepoint sysid");
    } catch (error) {
      await client.query("rollback to savepoint sysid");
      systemIdentifier = `UNREADABLE${error?.code ? ` (SQLSTATE ${error.code})` : ""}`;
    }

    const objects = {};
    const put = (key, value) => {
      if (key in objects) throw new Error(`duplicate footprint key ${key}`);
      objects[key] = value;
    };
    const S = `array['${SCHEMAS.join("','")}']`;

    for (const r of await q(client, `select n.nspname, pg_catalog.pg_get_userbyid(n.nspowner) as owner,
          ${EFFECTIVE("n.nspacl", "n", "n.nspowner")} as acl, ${BUILTIN("n", "n.nspowner")} as builtin
        from pg_catalog.pg_namespace n where n.nspname = any(${S})`))
      put(`schema:${r.nspname}`, { owner: r.owner, acl: r.acl, aclBuiltin: r.builtin });

    for (const r of await q(client, `select n.nspname || '.' || c.relname as name, c.relkind::text as kind,
          pg_catalog.pg_get_userbyid(c.relowner) as owner, c.relpersistence::text as persistence,
          c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
          coalesce((select pg_catalog.array_agg(o order by o) from pg_catalog.unnest(c.reloptions) o), '{}') as options,
          ${EFFECTIVE("c.relacl", RELKIND, "c.relowner")} as acl, ${BUILTIN(RELKIND, "c.relowner")} as builtin,
          case when c.relkind in ('v','m') then ${SHA("pg_catalog.pg_get_viewdef(c.oid, true)")} end as viewdef_sha256
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(${S}) and c.relkind in ('r','p','v','m','S','f') and ${NOT_EXT(REL, "c.oid")}`))
      put(`rel:${r.name}`, { kind: r.kind, owner: r.owner, persistence: r.persistence, rls: r.rls, forceRls: r.force_rls,
        options: r.options, acl: r.acl, aclBuiltin: r.builtin, ...(r.viewdef_sha256 ? { viewdefSha256: r.viewdef_sha256 } : {}) });

    for (const r of await q(client, `select n.nspname || '.' || c.relname || '.' || a.attname as name, a.attnum as num,
          pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
          pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) as def, a.attidentity::text as identity, a.attgenerated::text as generated,
          case when a.attcollation <> t.typcollation then (select co.collname from pg_catalog.pg_collation co where co.oid = a.attcollation) end as collation,
          ${ACL("a.attacl")} as acl
        from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace join pg_catalog.pg_type t on t.oid = a.atttypid
        left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
       where n.nspname = any(${S}) and c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped
         and ${NOT_EXT(REL, "c.oid")}`))
      put(`col:${r.name}`, { num: r.num, type: r.type, notNull: r.notnull, default: r.def, identity: r.identity,
        generated: r.generated, collation: r.collation, acl: r.acl });

    for (const r of await q(client, `select n.nspname || '.' || c.relname || '.' || k.conname as name, k.contype::text as type,
          pg_catalog.pg_get_constraintdef(k.oid, true) as def, k.condeferrable as deferrable, k.condeferred as deferred, k.convalidated as validated
        from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(${S}) and ${NOT_EXT(REL, "c.oid")}`))
      put(`con:${r.name}`, { type: r.type, def: r.def, deferrable: r.deferrable, deferred: r.deferred, validated: r.validated });

    // Keyed by parent table, so an unexpected index is attributable to the migration that owns its table.
    for (const r of await q(client, `select n.nspname || '.' || t.relname || '.' || i.relname as name, pg_catalog.pg_get_indexdef(x.indexrelid) as def,
          x.indisvalid as valid, x.indisready as ready
        from pg_catalog.pg_index x join pg_catalog.pg_class i on i.oid = x.indexrelid
        join pg_catalog.pg_class t on t.oid = x.indrelid join pg_catalog.pg_namespace n on n.oid = i.relnamespace
       where n.nspname = any(${S}) and ${NOT_EXT(REL, "x.indrelid")}`))
      put(`idx:${r.name}`, { def: r.def, valid: r.valid, ready: r.ready });

    for (const r of await q(client, `select n.nspname || '.' || s.relname as name, pg_catalog.format_type(q.seqtypid, null) as type,
          q.seqstart::text as start, q.seqincrement::text as inc, q.seqmin::text as min, q.seqmax::text as max, q.seqcycle as cycle,
          (select ot.relname || '.' || oa.attname from pg_catalog.pg_depend d join pg_catalog.pg_class ot on ot.oid = d.refobjid
             join pg_catalog.pg_attribute oa on oa.attrelid = d.refobjid and oa.attnum = d.refobjsubid
            where d.classid = ${REL} and d.objid = s.oid and d.deptype in ('a','i') limit 1) as owned_by
        from pg_catalog.pg_sequence q join pg_catalog.pg_class s on s.oid = q.seqrelid
        join pg_catalog.pg_namespace n on n.oid = s.relnamespace
       where n.nspname = any(${S}) and ${NOT_EXT(REL, "s.oid")}`))
      put(`seq:${r.name}`, { type: r.type, start: r.start, inc: r.inc, min: r.min, max: r.max, cycle: r.cycle, ownedBy: r.owned_by });

    for (const r of await q(client, `select n.nspname || '.' || c.relname || '.' || p.polname as name, p.polcmd::text as cmd,
          p.polpermissive as permissive,
          (select coalesce(pg_catalog.array_agg(case when x = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x) end order by 1), '{}')
             from pg_catalog.unnest(p.polroles) x) as roles,
          pg_catalog.pg_get_expr(p.polqual, p.polrelid) as qual, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as with_check
        from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = any(${S}) and ${NOT_EXT(REL, "c.oid")}`))
      put(`pol:${r.name}`, { cmd: r.cmd, permissive: r.permissive, roles: r.roles, qual: r.qual, withCheck: r.with_check });

    for (const r of await q(client, `select n.nspname || '.' || p.proname || '(' || coalesce((select pg_catalog.string_agg(pg_catalog.format_type(t, null), ', ' order by o)
             from pg_catalog.unnest(p.proargtypes::pg_catalog.oid[]) with ordinality as u(t, o)), '') || ')' as name,
          p.prokind::text as kind, l.lanname as lang, pg_catalog.pg_get_function_arguments(p.oid) as args,
          pg_catalog.pg_get_function_result(p.oid) as result, p.prosecdef as secdef, p.provolatile::text as volatile,
          p.proisstrict as strict, p.proleakproof as leakproof, p.proparallel::text as parallel, p.proretset as retset,
          p.procost::text as cost, p.prorows::text as rows, p.probin as bin,
          coalesce((select pg_catalog.array_agg(c order by c) from pg_catalog.unnest(p.proconfig) c), '{}') as config,
          ${SHA("p.prosrc")} as src_sha256, pg_catalog.length(p.prosrc) as src_len,
          case when p.prosqlbody is not null then ${SHA("pg_catalog.pg_get_function_sqlbody(p.oid)")} end as sqlbody_sha256,
          pg_catalog.pg_get_userbyid(p.proowner) as owner, ${EFFECTIVE("p.proacl", "f", "p.proowner")} as acl,
          ${BUILTIN("f", "p.proowner")} as builtin
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        join pg_catalog.pg_language l on l.oid = p.prolang
       where n.nspname = any(${S}) and ${NOT_EXT("'pg_catalog.pg_proc'::pg_catalog.regclass", "p.oid")}`))
      put(`fn:${r.name}`, { kind: r.kind, lang: r.lang, args: r.args, result: r.result, securityDefiner: r.secdef,
        volatile: r.volatile, strict: r.strict, leakproof: r.leakproof, parallel: r.parallel, retset: r.retset,
        cost: r.cost, rows: r.rows, bin: r.bin, config: r.config, srcSha256: r.src_sha256, srcLen: r.src_len,
        sqlbodySha256: r.sqlbody_sha256, owner: r.owner, acl: r.acl, aclBuiltin: r.builtin });

    for (const r of await q(client, `select n.nspname || '.' || c.relname || '.' || t.tgname as name,
          pg_catalog.pg_get_triggerdef(t.oid, true) as def, t.tgenabled::text as enabled
        from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(${S}) and not t.tgisinternal and ${NOT_EXT(REL, "c.oid")}`))
      put(`trg:${r.name}`, { def: r.def, enabled: r.enabled });

    // User-defined types other than the implicit row types of relations: enums, domains, composites, ranges.
    for (const r of await q(client, `select n.nspname || '.' || t.typname as name, t.typtype::text as type,
          case when t.typtype = 'e' then (select pg_catalog.array_agg(e.enumlabel order by e.enumsortorder) from pg_catalog.pg_enum e where e.enumtypid = t.oid) end as labels,
          case when t.typtype = 'd' then pg_catalog.format_type(t.typbasetype, t.typtypmod) end as base,
          case when t.typtype = 'd' then (select pg_catalog.array_agg(pg_catalog.pg_get_constraintdef(k.oid, true) order by k.conname) from pg_catalog.pg_constraint k where k.contypid = t.oid) end as checks,
          case when t.typtype = 'c' then (select pg_catalog.array_agg(a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) order by a.attnum)
             from pg_catalog.pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped) end as attrs,
          pg_catalog.pg_get_userbyid(t.typowner) as owner, ${EFFECTIVE("t.typacl", "T", "t.typowner")} as acl,
          ${BUILTIN("T", "t.typowner")} as builtin
        from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace
       where n.nspname = any(${S}) and t.typtype in ('e','d','c','r') and t.typelem = 0
         and (t.typtype <> 'c' or (select c.relkind from pg_catalog.pg_class c where c.oid = t.typrelid) = 'c')
         and ${NOT_EXT("'pg_catalog.pg_type'::pg_catalog.regclass", "t.oid")}`))
      put(`type:${r.name}`, { type: r.type, labels: r.labels, base: r.base, checks: r.checks, attrs: r.attrs, owner: r.owner, acl: r.acl, aclBuiltin: r.builtin });

    // Platform context, reported, never part of a migration's footprint.
    const defaultAcl = await q(client, `select pg_catalog.pg_get_userbyid(d.defaclrole) as role, coalesce(n.nspname, '*') as schema,
        d.defaclobjtype::text as objtype, ${ACL("d.defaclacl")} as acl
      from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace order by 1, 2, 3`);
    const extensions = await q(client, `select e.extname as name, n.nspname as schema from pg_catalog.pg_extension e
      join pg_catalog.pg_namespace n on n.oid = e.extnamespace order by 1`);

    let ledger = null, ledgerRows = null;
    const [lp] = await q(client, `select pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null as present`);
    if (lp.present) {
      const cols = (await q(client, `select a.attname from pg_catalog.pg_attribute a
        where a.attrelid = 'supabase_migrations.schema_migrations'::pg_catalog.regclass and a.attnum > 0 and not a.attisdropped`)).map((r) => r.attname);
      const name = cols.includes("name") ? "name" : "null::text";
      const stmts = cols.includes("statements") ? SHA("pg_catalog.array_to_string(statements, chr(10))") : "null::text";
      ledgerRows = await q(client, `select version::text as version, ${name} as name, ${stmts} as "statementsSha256"
        from supabase_migrations.schema_migrations order by 1`);
      ledger = ledgerRows.map((r) => r.version);
    }

    // The only seed any audited migration writes: the telegram_operator_state singleton (20260920120000). RLS is on, so
    // the count is trusted only if this role bypasses it (owner without FORCE, superuser, or BYPASSRLS).
    let seeds = {};
    const [sp] = await q(client, `select c.oid is not null as present,
        (select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user)
          or (pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') and not c.relforcerowsecurity) or not c.relrowsecurity as visible
      from (select pg_catalog.to_regclass('kernel_private.telegram_operator_state') as oid) o
      left join pg_catalog.pg_class c on c.oid = o.oid`);
    if (sp.present) {
      const [s] = await q(client, `select count(*)::int as rows, count(*) filter (where singleton)::int as singleton_rows
        from kernel_private.telegram_operator_state`);
      seeds["kernel_private.telegram_operator_state"] = { ...s, rlsVisible: sp.visible === true };
    }

    const sorted = Object.fromEntries(Object.keys(objects).sort().map((k) => [k, objects[k]]));
    return {
      meta: { serverVersionNum: guard.v, database: guard.db, user: guard.usr, systemIdentifier,
        transaction: { isolation: guard.iso, readOnly: guard.ro, searchPath: guard.sp } },
      ledger, ledgerRows, objects: sorted, defaultAcl, extensions, seeds,
    };
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
}
