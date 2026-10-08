# KJ-P8 ADR-0023 revision 2.7.3: disposable evidence for ephemeral targets and engine pins (09/10/2026)

Evidence for ADR-0023 sections 27.12.13 and 27.12.14 (findings R272-EPHEMERAL and R272-ENGINE-PLATFORM). Everything
here ran on disposable containers on the author's workstation, and every container and network was removed afterwards.
No production system was contacted and no credential was used: every cluster used trust authentication and lived on
`tmpfs`.

## Environment

- Docker 29.1.5, Docker Desktop, Linux engine, context `desktop-linux`. Docker Desktop was started by the owner;
  the session only checked `docker info`.
- Image `postgres:17.6`, `RepoDigests` `postgres@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929`.
  This is the image `infrastructure/docker/validation.compose.yaml` names by tag.
- Supabase CLI release `v2.120.0` of `supabase/cli`, published 2026-10-06T16:40:05Z, downloaded with
  `gh release download`.
- Node `v25.2.1`, `pg@8` (the 2.7.2 evidence environment).

## 1. Fresh databases get fresh system identifiers

```sh
for i in 1 2; do docker run -d --rm --name kj-sysid-probe-$i -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17.6; done
for i in 1 2; do docker exec kj-sysid-probe-$i psql -U postgres -Atc \
  "select system_identifier::text, version() from pg_control_system()"; done
```

```text
7694443709250187303|PostgreSQL 17.6 (Debian 17.6-2.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
7694443715115663398|PostgreSQL 17.6 (Debian 17.6-2.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
```

Reading: a database created after a commit cannot be named by a declaration committed in it. This is finding
R272-EPHEMERAL.

## 2. A cluster created as ADR 27.12.13.3 L2 describes

```sh
RS=$(date -u +%s)
NONCE=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
CID=$(docker run -d --rm --label kj.ephemeral.run=$NONCE --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 postgres:17.6 -c cluster_name=kj-eph-$NONCE)
docker inspect $CID --format 'created={{.Created}} image={{.Image}} mounts={{json .Mounts}} tmpfs={{json .HostConfig.Tmpfs}} labels={{json .Config.Labels}} port={{json .NetworkSettings.Ports}}'
docker exec $CID psql -U postgres -Atc "select system_identifier::text, (system_identifier >> 32)::text,
  extract(epoch from pg_postmaster_start_time())::bigint, current_setting('cluster_name'),
  (select rolsuper from pg_roles where rolname=current_user), version() from pg_control_system()"
docker exec $CID psql -U postgres -Atc "alter system set cluster_name='x'"
docker exec $CID psql -U postgres -Atc "select setting, context from pg_settings where name='cluster_name'"
```

```text
runStart 1791502777
nonce 8ab1b3d741ea63815df942744b9e351c
created=2026-10-08T23:39:38.772781325Z image=sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929 mounts=[] tmpfs={"/var/lib/postgresql/data":"rw"} labels={"kj.ephemeral.run":"8ab1b3d741ea63815df942744b9e351c"} port={"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"57092"}]}
7694445847632744488|1791502779|1791502780|kj-eph-8ab1b3d741ea63815df942744b9e351c|t|PostgreSQL 17.6 (Debian 17.6-2.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
ALTER SYSTEM
kj-eph-8ab1b3d741ea63815df942744b9e351c|postmaster
```

The timestamps above are UTC. The container's `Created` time (2026-10-08T23:39:38Z, epoch 1791502778) is the
08/10 evening in UTC, which was 09/10 local time when the probe ran.

Reading:
- The initdb time encoded in the system identifier (1791502779) is one second after `Created`, and the postmaster
  started one second later.
- `cluster_name` carries the nonce. Its context is `postmaster`: `ALTER SYSTEM` was accepted but the live value did
  not change without a restart.
- The data directory is `tmpfs` and `Mounts` is empty.
- The connecting role is a superuser.

A container created by digest reference (`docker create postgres@sha256:00bc8661...2929 postgres -c
cluster_name=kj-eph-test`, then removed) reports `Config.Image`
`postgres@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929`, `Config.Cmd`
`["postgres","-c","cluster_name=kj-eph-test"]` and `Config.Entrypoint` `["docker-entrypoint.sh"]`.

Identifier layout, decoded with `s >> 32` for seconds, `(s >> 12) & 0xFFFFF` for microseconds and `s & 0xFFF` for the
low PID bits:

| system identifier | initdb time (UTC) | microseconds | PID bits |
|---|---|---|---|
| `7678069749886157684` (production, ADR 27.12.1) | 2026-08-25T20:32:01 | 928304 | 884 |
| `7694443709250187303` (section 1) | 2026-10-08T23:31:21 | 401803 | 39 |
| `7694445847632744488` (this section) | 2026-10-08T23:39:39 | 277009 | 40 |

## 3. Loopback is not evidence: a tunnel to a cluster that existed before the run

Probe script `eph_probe.mjs`:

```js
import pg from "pg";
const c = new pg.Client({ host: "127.0.0.1", port: Number(process.argv[2]), user: "postgres", database: "postgres", ssl: false });
await c.connect();
const r = await c.query(`select system_identifier::text as sysid, (system_identifier >> 32)::text as initdb_epoch,
  extract(epoch from pg_postmaster_start_time())::bigint::text as postmaster_start, current_setting('cluster_name') as cluster_name,
  (select rolsuper from pg_roles where rolname = current_user) as superuser, version() as version from pg_control_system()`);
console.log(JSON.stringify(r.rows[0])); await c.end();
```

```sh
docker network create kjeph-probe-net
docker run -d --rm --network kjeph-probe-net --name kjeph-persistent --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17.6
# wait for the server, then mark the start of the "run"
RS=$(date -u +%s)
docker run -d --rm --network kjeph-probe-net --name kjeph-tunnel -p 127.0.0.1::5432 alpine/socat:1.8.0.3 \
  TCP-LISTEN:5432,fork,reuseaddr TCP:kjeph-persistent:5432
node eph_probe.mjs <tunnel host port>
```

```text
runStart 1791502883
tunnel loopback port 53280
{"sysid":"7694446261159780392","initdb_epoch":"1791502875","postmaster_start":"1791502876","cluster_name":"","superuser":true,"version":"PostgreSQL 17.6 (Debian 17.6-2.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit"}
```

Reading:
- **What did not distinguish it.** A loopback port answered by the same server version, as a superuser, from a
  container created after the run started. Neither loopback reachability nor superuser status tells it apart.
- **What did.** Its `cluster_name` holds no nonce, and its initdb time is eight seconds before the run started. The
  daemon would also show that the container holding the port runs `alpine/socat` with a forwarding command, not the
  pinned image and command.

## 4. Engine pins

```sh
gh release download v2.120.0 -R supabase/cli -p checksums.txt \
  -p 'supabase_2.120.0_linux_amd64.tar.gz' -p 'supabase_2.120.0_windows_amd64.tar.gz'
grep -E "supabase_2.120.0_(linux|windows)_amd64.tar.gz" checksums.txt
sha256sum supabase_2.120.0_*_amd64.tar.gz
# each archive extracted into its own new directory
sha256sum linux/* windows/*
sha256sum <2.7.2 npm package>/node_modules/@supabase/cli-windows-x64/bin/*.exe
./windows/supabase.exe --version
```

```text
7074584113aa00495beeac661c41fb09f1ddd0a483cd7333894b0d080086dc6e  supabase_2.120.0_linux_amd64.tar.gz
53920013d24bc9e66180f35ceeea9ddc20e65a7afa883421e9c0ba60ad7457ee  supabase_2.120.0_windows_amd64.tar.gz
7074584113aa00495beeac661c41fb09f1ddd0a483cd7333894b0d080086dc6e *supabase_2.120.0_linux_amd64.tar.gz
53920013d24bc9e66180f35ceeea9ddc20e65a7afa883421e9c0ba60ad7457ee *supabase_2.120.0_windows_amd64.tar.gz
e4e5d910546d7eda3bc3c63affce09a12b9954a00685dce5236080cd45f43eda *linux/supabase
3a2239de4dddd58040920fdb9706a11c7f9b396e0f2975d65b3829cf375834f4 *linux/supabase-go
fa2ba7fb02b01d98fa5a3c6d92632239b10c6974dbc42c65b698b6a479847343 *windows/supabase-go.exe
1cbedd6e494581a1c1d90113660113a06798d9967d19c857127b66b8a428e836 *windows/supabase.exe
fa2ba7fb02b01d98fa5a3c6d92632239b10c6974dbc42c65b698b6a479847343 *../sbcli/node_modules/@supabase/cli-windows-x64/bin/supabase-go.exe
1cbedd6e494581a1c1d90113660113a06798d9967d19c857127b66b8a428e836 *../sbcli/node_modules/@supabase/cli-windows-x64/bin/supabase.exe
2.120.0
```

Sizes: Linux `supabase` 112027104 bytes and `supabase-go` 40579234; Windows `supabase.exe` 112564224 and
`supabase-go.exe` 41535488.

The launcher alone: `supabase.exe` copied into an otherwise empty directory printed the `migration up` help. Pointed at
a closed port, it reached the connection stage:

```text
Connecting to remote database...
{"_tag":"Error","error":{"code":"DbConnectError","message":"failed to connect to postgres: failed to connect to `host=127.0.0.1 user=x database=x`: dial error (connect ECONNREFUSED 127.0.0.1:1)", ...}}
```

So it is not established which executable runs migration statements when both are present. ADR 27.12.13.7 therefore
pins and supplies both.

## 5. The Linux engine reproduces the ledger contract

The test project of the 2.7.2 evidence (section 2.1 there: `base_a`, `base_b`, `settings_probe`, `fail`) was used
against a fresh container on a private network:

```sh
docker network create kjeph-cli-net
docker run -d --rm --network kjeph-cli-net --name kjeph-db --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17.6
docker run --rm --network kjeph-cli-net -v <linux executables>:/cli:ro -v <ledgerproj>:/proj:ro -e HOME=/tmp \
  debian:bookworm-slim sh -c 'sha256sum /cli/supabase /cli/supabase-go; /cli/supabase --version; cp -r /proj /tmp/p; cd /tmp/p;
  /cli/supabase migration up --workdir /tmp/p --db-url "postgresql://postgres@kjeph-db:5432/postgres?sslmode=disable&options=-c%20kj.b1.probe%3Dlinux-startup" --agent no'
docker exec kjeph-db psql -U postgres -Atc "select version, name, array_length(statements,1), xmin from supabase_migrations.schema_migrations order by 1" \
  -c "select string_agg(attname||':'||format_type(atttypid,atttypmod)||':'||attnotnull, ',' order by attnum) from pg_attribute where attrelid='supabase_migrations.schema_migrations'::regclass and attnum>0 and not attisdropped" \
  -c "select * from public.probe" -c "select to_regclass('public.fail_t')"
```

```text
e4e5d910546d7eda3bc3c63affce09a12b9954a00685dce5236080cd45f43eda  /cli/supabase
3a2239de4dddd58040920fdb9706a11c7f9b396e0f2975d65b3829cf375834f4  /cli/supabase-go
2.120.0
Applying migration 20990101000000_base_a.sql...
Applying migration 20990101000001_base_b.sql...
Applying migration 20990101000002_settings_probe.sql...
Applying migration 20990101000003_fail.sql...
ERROR: division by zero (SQLSTATE 22012)
At statement: 1
select 1/0
20990101000000|base_a|1|740
20990101000001|base_b|2|741
20990101000002|settings_probe|1|742
version:text:true,statements:text[]:false,name:text:false
linux-startup|read committed|742|"$user", public

```

Reading:
- the ledger has the three columns of ADR 27.12.11;
- `settings_probe`'s `txid` (742) equals its ledger row's `xmin`, so the row is written in the migration's own
  transaction;
- the startup option reached the migration;
- the failing migration left neither `fail_t` (the last query returned null) nor a row.

The probe's own `cli_exit=0` line is the exit status of `tail` in the wrapper, not of the CLI, and is omitted.

## 6. Not established here

- **Hosted behaviour.** Nothing about hosted Supabase was tested. That its `postgres` role is not a superuser is
  INFERENCE from the platform's documented role model. The eligibility predicate does not rely on it alone.
- **CI host.** The runner's L3 attestation was exercised by hand with `docker inspect`, not by committed code; that is
  the B1 remediation's work. The CI host's Docker uses the classic image store, so `docker inspect .Image` may report
  the image configuration digest there. For this reason ADR 27.12.13.3 compares `Config.Image`, the reference the
  runner passed by digest, rather than `.Image`.
- **The remaining platforms.** The darwin and arm64 executables were not pinned. Under ADR 27.12.13.7 they refuse.
