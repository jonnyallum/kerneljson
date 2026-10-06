#!/usr/bin/env bash
# KJ-P8 B1 - the qualification runs the main `validate` job does not make (ADR-0023 revision 2.5, section 27.6).
#   1. generator drift check and static inventory;
#   2. the discover run (runtime statements under SET ROLE; a refusal is recorded and retried as the owner) and its
#      dynamic inventory, which proves the frozen manifest covers every statement the suite issues;
#   3. the six environment-gated integration files, under the runtime roles (enforce), with the refusal gate.
# The enforce run of the whole suite, its refusal gate and `pnpm test:baseline` run in the `validate` job.
# Run from the repository root on a host with its own Docker daemon (CI). Writes artifacts/local/b1/.
set -euo pipefail
E=artifacts/local/b1
COMPOSE="docker --context default compose -f infrastructure/docker/validation.compose.yaml"
GATED="tests/alerting-postgres.integration.test.ts tests/canary-tooling.integration.test.ts tests/gateway-bootstrap.integration.test.ts
  tests/outbox-postgres.integration.test.ts tests/schedule-fencing.integration.test.ts tests/schedule-postgres.integration.test.ts"
rm -rf artifacts/local/b1-trace "$E"
mkdir -p "$E" artifacts/local/b1-trace

echo "== static"
node scripts/b1/build-manifest.mjs --check
node scripts/b1/static-inventory.mjs "$E/static-inventory.json" | tail -4

echo "== discover"
status=0
KJ_RUNTIME_ROLES=discover KJ_WORKER_DATABASE_URL=postgresql://postgres@db:5432/kerneljson \
  pnpm test --reporter=default --reporter=json --outputFile="$E/discover-tests.json" > "$E/discover-tests.log" 2>&1 || status=$?
$COMPOSE down --volumes > /dev/null 2>&1 || true
node scripts/b1/analyse-trace.mjs artifacts/local/b1-trace "$E/dynamic-inventory-discover.json" | tail -3
if [ "$status" -ne 0 ]; then echo "discover run failed with exit $status"; tail -80 "$E/discover-tests.log"; exit 1; fi

echo "== environment-gated files under the runtime roles"
rm -rf artifacts/local/b1-trace
mkdir -p artifacts/local/b1-trace
$COMPOSE up -d --wait db
node --import tsx --input-type=module -e "
const m = await import('./tests/support/local.ts');
const pg = (await import('pg')).default;
const admin = new pg.Pool({ connectionString: m.DATABASE, max: 1 });
await m.until(() => admin.query('select 1'), (r) => r.rowCount === 1);
await admin.query('drop database if exists kj_gated');
await admin.query('create database kj_gated');
const pool = new pg.Pool({ connectionString: m.DATABASE.replace(/\/kerneljson\$/, '/kj_gated') });
await m.migrate(pool);
await pool.end(); await admin.end();
console.log('kj_gated migrated, B1 included');
"
status=0
# shellcheck disable=SC2086
KJ_RUNTIME_ROLES=enforce KJ_TEST_PG_URL=postgresql://postgres@127.0.0.1:55432/kj_gated \
  pnpm vitest run $GATED --reporter=default --reporter=json --outputFile="$E/gated-enforce.json" > "$E/gated-enforce.log" 2>&1 || status=$?
$COMPOSE down --volumes > /dev/null 2>&1 || true
node scripts/b1/analyse-trace.mjs artifacts/local/b1-trace "$E/dynamic-inventory-gated.json" --fail-on-refusal | tail -3
if [ "$status" -ne 0 ]; then echo "gated run failed with exit $status"; tail -80 "$E/gated-enforce.log"; exit 1; fi
node -e "const r=JSON.parse(require('fs').readFileSync('$E/gated-enforce.json','utf8'));console.log(JSON.stringify({total:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests,pending:r.numPendingTests}))"
