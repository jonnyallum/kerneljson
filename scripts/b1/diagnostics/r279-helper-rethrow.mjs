#!/usr/bin/env node
// Disposable diagnostic of ADR-0023 R2.7.9 section 27.12.4. Never applies B1.
// No target argument, host mount, published port, network, credential or migration ledger.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

if (process.argv.length !== 2) throw new Error('This diagnostic accepts no arguments');
const image = 'postgres@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929';
const version = 'PostgreSQL 17.6 (Debian 17.6-2.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit';
const digest = '2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1';
const fixture = readFileSync(new URL('../../../docs/operations/evidence/kj-p8-r279-contradiction/pinned-helper.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const body = fixture.split('$$')[1];
assert.equal(Buffer.byteLength(body), 953);
assert.equal(createHash('sha256').update(body).digest('hex'), digest);
const name = `kj-r279-helper-${randomBytes(8).toString('hex')}`;
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', timeout: 60000 });
const checked = (args) => {
  const result = docker(args);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
};
const result = {
  diagnostic: 'R279-HELPER-RETHROW', design: 'af2f7320aae32eaa0ce699b1c09d015371f156d5',
  image, sourceDigest: digest, sourceBytes: 953,
  b1Applied: false, productionConnected: false, qualified: false,
};
let created = false;
try {
  // Check the local daemon rather than accepting inherited remote Docker selectors.
  assert.equal(process.env.DOCKER_HOST ?? '', '', 'DOCKER_HOST is forbidden');
  const context = JSON.parse(checked(['context', 'inspect']))[0];
  assert.match(context.Endpoints.docker.Host, /^(npipe:\/\/|unix:\/\/)/, 'local Docker daemon required');
  checked(['run', '-d', '--name', name, '--network', 'none', '--label', 'kj.r279.source-probe=true',
    '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
  created = true;
  const inspection = JSON.parse(checked(['inspect', name]))[0];
  assert.equal(inspection.Config.Image, image);
  assert.deepEqual(inspection.Mounts, []);
  assert.deepEqual(inspection.HostConfig.Tmpfs, { '/var/lib/postgresql/data': 'rw' });
  assert.equal(inspection.HostConfig.NetworkMode, 'none');
  assert.ok(!inspection.HostConfig.PortBindings || Object.keys(inspection.HostConfig.PortBindings).length === 0);
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (docker(['exec', name, 'pg_isready', '-U', 'postgres']).status === 0) { ready = true; break; }
    await delay(250);
  }
  assert.ok(ready, 'database did not become ready');
  const sql = (text, expectedStatus = 0) => {
    const r = docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-v', 'VERBOSITY=verbose', '-U', 'postgres', '-d', 'postgres'], text);
    assert.equal(r.status, expectedStatus, r.stderr || r.error?.message);
    return { stdout: r.stdout.trim(), stderr: r.stderr };
  };
  result.serverVersion = sql('select version();').stdout;
  assert.equal(result.serverVersion, version);
  sql(fixture);
  const pinSql = `select json_build_object(
    'owner',pg_get_userbyid(p.proowner),'returns',p.prorettype::regtype::text,'retset',p.proretset,
    'kind',p.prokind,'securityDefiner',p.prosecdef,'language',l.lanname,'config',p.proconfig,
    'acl',p.proacl::text,'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,
    'parallel',p.proparallel,'binary',p.probin,'sqlBody',p.prosqlbody::text,
    'sourceBytes',octet_length(prosrc),'sourceDigest',encode(sha256(convert_to(prosrc,'UTF8')),'hex'),
    'bindings',(select json_agg(json_build_object('name',evtname,'owner',pg_get_userbyid(evtowner),
      'event',evtevent,'enabled',evtenabled,'tags',evttags)) from pg_event_trigger where evtfoid=p.oid))
    from pg_proc p join pg_language l on l.oid=p.prolang where p.oid='public.rls_auto_enable()'::regprocedure;`;
  const pin = JSON.parse(sql(pinSql).stdout);
  assert.deepEqual(pin, { owner:'postgres',returns:'event_trigger',retset:false,kind:'f',securityDefiner:true,
    language:'plpgsql',config:['search_path=pg_catalog'],acl:null,volatility:'v',strict:false,leakproof:false,
    parallel:'u',binary:null,sqlBody:null,sourceBytes:953,sourceDigest:digest,
    bindings:[{name:'ensure_rls',owner:'postgres',event:'ddl_command_end',enabled:'O',
      tags:['CREATE TABLE','CREATE TABLE AS','SELECT INTO']}] });
  result.sealedPin = pin;
  // Positive control: the unmodified helper enables RLS when ALTER TABLE succeeds.
  sql('create table public.r279_positive_control(id integer);');
  assert.equal(sql("select relrowsecurity from pg_class where oid='public.r279_positive_control'::regclass;").stdout, 't');
  result.positiveControlRls = true;
  // E4 places this external, SECURITY INVOKER diagnostic trigger outside the co-resident topology rule.
  // It changes no attribute, ACL, body or binding of the pinned helper.
  sql(`create schema diagnostic;
    create function diagnostic.deny_rls() returns event_trigger language plpgsql security invoker as $guard$
    begin raise insufficient_privilege using message = 'R279_DIAGNOSTIC_RLS_ENABLE_DENIED'; end;
    $guard$;
    create event trigger diagnostic_deny_rls on ddl_command_start when tag in ('ALTER TABLE')
      execute function diagnostic.deny_rls();`);
  sql('begin; create table public.r279_failure_control(id integer); commit;');
  result.creationCommitted = sql("select to_regclass('public.r279_failure_control') is not null;").stdout === 't';
  result.failureControlRls = sql("select relrowsecurity from pg_class where oid='public.r279_failure_control'::regclass;").stdout === 't';
  assert.equal(result.creationCommitted, true);
  assert.equal(result.failureControlRls, false);
  const denied = sql('alter table public.r279_failure_control enable row level security;', 3);
  assert.match(denied.stderr, /42501: R279_DIAGNOSTIC_RLS_ENABLE_DENIED/);
  result.directControlSqlstate = '42501';
  assert.deepEqual(JSON.parse(sql(pinSql).stdout), pin);
  result.pinUnchanged = true;
  const logs = docker(['logs', name]);
  assert.equal(logs.status, 0);
  const log = logs.stdout + logs.stderr;
  assert.match(log, /rls_auto_enable: failed to enable RLS on public\.r279_failure_control/);
  result.failureLogObserved = true;
  result.contradictionReproduced = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  if (created) {
    const removed = docker(['rm', '-f', name]);
    const inspect = docker(['inspect', name]);
    result.teardownPassed = removed.status === 0 && inspect.status !== 0 && /No such (object|container)/i.test(inspect.stderr);
    if (!result.teardownPassed) process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
}
