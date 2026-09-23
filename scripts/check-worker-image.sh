#!/usr/bin/env bash
# Exercise the shipped CMD, without credentials, mounts, published ports or network access.
set -euo pipefail
image="${1:?worker image required}"
container=""
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null; fi
}
trap cleanup EXIT
for memory in false true; do
  container=$(docker run -d --network none \
    -e DATABASE_URL=postgresql://postgres@127.0.0.1:1/isolated_smoke \
    -e KJ_MEMORY_ENABLED="$memory" \
    -e KJ_ADMISSION_TENANT_ID=11111111-1111-4111-8111-111111111111 \
    -e KJ_ADMISSION_PRINCIPAL_ID=22222222-2222-4222-8222-222222222222 \
    "$image")
  ready=false
  for attempt in {1..30}; do
    if docker exec "$container" node -e "require('net').connect(9080,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
      ready=true
      break
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]]; then break; fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    docker logs "$container"
    echo "Production worker image failed to start (memory=$memory)" >&2
    exit 1
  fi
  echo "Production worker CMD listening with memory=$memory"
  cleanup
  container=""
done

# Negative control: reproduce the missing-directory defect inside a disposable container.
# Only the container's writable layer is changed; there are no host mounts or credentials.
set +e
negative=$(docker run --rm --network none --entrypoint sh "$image" -c \
  'rm -rf /app/services/memory; exec node --import tsx services/kernel/src/index.ts' 2>&1)
negative_status=$?
set -e
if [[ "$negative_status" == 0 ]] || ! grep -q 'ERR_MODULE_NOT_FOUND' <<< "$negative" || ! grep -q '/app/services/memory/' <<< "$negative"; then
  echo "Missing-memory negative control did not fail as expected" >&2
  exit 1
fi
echo "Missing-memory negative control refused startup as expected"
