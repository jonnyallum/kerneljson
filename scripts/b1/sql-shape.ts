/**
 * Static reading of migration SQL for the repository guards of ADR-0023 27.12.8 item 12 and case CON-32. It splits a
 * file into top-level statements, respecting single-quoted literals, double-quoted identifiers, dollar quotes and
 * both comment forms, so a keyword inside a DO body or a string is never mistaken for a top-level statement.
 */
export interface Statement {text:string;index:number}
export function topLevelStatements(sql:string):Statement[]{
  const out:Statement[]=[];let start=0,i=0;
  while(i<sql.length){
    const c=sql[i]!,next=sql[i+1];
    if(c==="-" && next==="-"){const end=sql.indexOf("\n",i);i=end<0?sql.length:end+1;continue;}
    if(c==="/" && next==="*"){const end=sql.indexOf("*/",i+2);if(end<0) throw Error("unterminated block comment");i=end+2;continue;}
    if(c==="'" || c==='"'){let j=i+1;for(;j<sql.length;j++){if(sql[j]===c){if(sql[j+1]===c){j++;continue;}break;}}
      if(j>=sql.length) throw Error("unterminated quote");i=j+1;continue;}
    if(c==="$"){const m=/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if(m && !/[A-Za-z0-9_]/.test(sql[i-1] ?? "")){const end=sql.indexOf(m[0],i+m[0].length);if(end<0) throw Error("unterminated dollar quote");i=end+m[0].length;continue;}}
    if(c===";"){const text=sql.slice(start,i).trim();if(text) out.push({text,index:out.length});start=i+1;}
    i++;
  }
  const tail=sql.slice(start).trim();
  if(tail && !/^(--[^\n]*\n?\s*)*$/.test(tail)) out.push({text:tail,index:out.length});
  return out;
}
/** Comments stripped from the start of a statement, whitespace normalised, lower case: for keyword checks. */
export function head(statement:string):string{
  return statement.replace(/^(\s*--[^\n]*\n)+/,"").replace(/\s+/g," ").trim().toLowerCase();
}
/** The 27.12.8 item 12 forms, over the whole text including comments and string literals. */
export function forbiddenMigrationForms(sql:string):string[]{
  const t=sql.replace(/\s+/g," ").toLowerCase(),found:string[]=[];
  for(const kind of ["functions","routines","procedures"]) if(t.includes(`on all ${kind} in schema`)) found.push(`ON ALL ${kind.toUpperCase()} IN SCHEMA`);
  if(/alter default privileges[^;]*\b(functions|routines)\b/.test(t)) found.push("ALTER DEFAULT PRIVILEGES on functions or routines");
  if(/\b(grant|revoke)\b[^;]*\brls_auto_enable\b/.test(t)) found.push("GRANT or REVOKE naming a sealed pin name");
  for(const s of topLevelStatements(sql)){
    const h=head(s.text);
    if(/^(begin|start transaction|commit|end|rollback|savepoint|release|prepare transaction)\b/.test(h)) found.push(`top-level transaction control: ${h.slice(0,30)}`);
  }
  return found;
}

/** CON-32: the whole shape of B1. Each statement must be one of the pinned forms; DO blocks are recognised by structure. */
const DO_CATEGORIES:[string,RegExp,number][]=[
  ["role creation",/^do \$\$ begin if not exists \(select 1 from pg_roles where rolname = 'kj_(worker|door)'\) then create role kj_(worker|door); end if; end \$\$$/,2],
  ["membership cleanup loop (inherited cleanup loop)",/^do \$\$ declare r record; begin for r in select m\.roleid::regrole as granted, m\.member::regrole as member from pg_auth_members m where .*execute format\('revoke %s from %s', r\.granted, r\.member\); end loop; end \$\$$/,1],
  ["enumerated function cleanup",/^do \$b1_acl\$ declare f record; begin for f in select p\.oid::pg_catalog\.regprocedure::text as identity .* execute pg_catalog\.format\('revoke execute on function %s from public', f\.identity\); execute pg_catalog\.format\('revoke all on function %s from kj_worker, kj_door', f\.identity\); end loop; end \$b1_acl\$$/,1],
  ["TEMPORARY by format",/^do \$\$ begin execute format\('revoke temporary on database %i from public', current_database\(\)\); end \$\$$/,1],
  ["runtime policy drop loop (inherited cleanup loop)",/^do \$\$ declare p record; begin for p in select schemaname, tablename, policyname from pg_policies where policyname ~ '\^kj_\(worker\|door\)_' loop execute format\('drop policy %i on %i\.%i', p\.policyname, p\.schemaname, p\.tablename\); end loop; end \$\$$/,1],
  ["CONNECT by format",/^do \$\$ begin execute format\('grant connect on database %i to kj_(worker|door)', current_database\(\)\); end \$\$$/,2],
  ["stamp ACL cleanup",/^do \$\$ declare g record; begin for g in select distinct pg_get_userbyid\(a\.grantee\) as grantee from pg_proc p, aclexplode\(p\.proacl\) a where p\.oid = 'kernel_private\.stamp_binding_provenance\(\)'::regprocedure .* execute format\('revoke all on function kernel_private\.stamp_binding_provenance\(\) from %i', g\.grantee\); end loop; end \$\$$/,1],
  ["pre-COMMIT stamp check",/^do \$\$ declare f record; n int; begin select p\.oid, p\.proowner.*raise exception 'b1: % functions are named stamp_binding_provenance; exactly one is sealed', n using errcode = '23514'; end if; end \$\$$/,1],
  ["pre-COMMIT role check",/^do \$\$ declare bad text; begin select string_agg\(rolname, ', '\) into bad from pg_roles where .*raise exception 'b1: a runtime role has a role membership' using errcode = '23514'; end if; end \$\$$/,1],
  ["P3 presence and format",/^do \$b1_settings\$ declare digest text := .*raise exception 'b1 p3 step 2: malformed declaration settings' using errcode = '23514'; end if; end \$b1_settings\$$/,2],
  ["P1, P2 and P3",/^(-- sealed pins: .* )?do \$b1_equality\$ declare .*raise exception 'b1 p3 step 5: co-resident set digest differs' using errcode='23514'; end if; end \$b1_equality\$$/,1],
];
const VERBS="select|insert|update|delete";
const PLAIN:RegExp[]=[
  /^alter role kj_(worker|door) with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit connection limit (40|20)$/,
  /^alter function kernel_private\.stamp_binding_provenance\(\) security definer$/,
  /^alter function kernel_private\.stamp_binding_provenance\(\) set search_path = ''$/,
  /^revoke create on schema public from public$/,
  /^revoke all on function kernel_private\.stamp_binding_provenance\(\) from public$/,
  /^revoke all on all (tables|sequences) in schema public, kernel_private from kj_worker, kj_door$/,
  /^revoke all on schema public, kernel_private from kj_worker, kj_door$/,
  /^grant usage on schema (public|kernel_private) to kj_(worker|door)$/,
  new RegExp(`^grant (${VERBS})( \\([a-z_, ]+\\))? on (public|kernel_private)\\.[a-z0-9_]+ to kj_(worker|door)$`),
  /^grant (usage|select|update)( \([a-z_, ]+\))? on sequence (public|kernel_private)\.[a-z0-9_]+ to kj_(worker|door)$/,
  /^grant execute on function (public|kernel_private)\.[a-z0-9_]+\([a-z0-9_., ]*\) to kj_(worker|door)$/,
  new RegExp(`^create policy kj_(worker|door)_(${VERBS}|rowlock) on (public|kernel_private)\\.[a-z0-9_]+ for (${VERBS}) to kj_\\1 (using \\(true\\)( with check \\((true|false)\\))?|with check \\(true\\))$`),
];
const BODY_FORBIDDEN=/\b(create|alter) (or replace )?(table|function|view|sequence|schema|index|trigger|type|extension|event trigger)\b/;
export function b1ShapeProblems(sql:string):string[]{
  const problems:string[]=[],counts=new Map<string,number>();
  for(const s of topLevelStatements(sql)){
    const h=head(s.text).replace(/^-- sealed pins: .*? do \$b1_equality\$/,"do $b1_equality$");
    if(h.startsWith("do ")){
      const category=DO_CATEGORIES.find(([,re])=>re.test(h));
      if(!category) problems.push(`DO block outside the pinned set: ${h.slice(0,80)}`);
      else counts.set(category[0],(counts.get(category[0]) ?? 0)+1);
      if(category && !["P1, P2 and P3","P3 presence and format","pre-COMMIT stamp check","pre-COMMIT role check"].includes(category[0]) && BODY_FORBIDDEN.test(h))
        problems.push(`DO block creates or alters an object: ${h.slice(0,80)}`);
      continue;
    }
    if(/ with grant option/.test(h) || !PLAIN.some(re=>re.test(h))) problems.push(`statement outside the pinned shape: ${h.slice(0,100)}`);
  }
  for(const [name,,n] of DO_CATEGORIES) if((counts.get(name) ?? 0)!==n) problems.push(`${name}: ${counts.get(name) ?? 0} DO blocks, pinned ${n}`);
  return problems;
}
