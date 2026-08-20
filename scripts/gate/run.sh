#!/usr/bin/env bash
#
# The phase 1 gate, run against a throwaway local Postgres container.
#
# This replaces the Supabase branch database the plan and the spec originally
# called for. The project does not have branching, so there is no preview
# database to point a harness at. What a container can reproduce faithfully is
# the layer where this project's silent failure lives: roles, grants and RLS are
# plain Postgres, not Supabase. What it cannot reproduce is recorded in
# docs/superpowers/plans/2026-08-19-asset-layer-phase-1.md, Task 8.
#
# Usage:  bash scripts/gate/run.sh
#
# Nothing here touches production. There is no network access and no Supabase
# credential anywhere in this script.

set -euo pipefail

CONTAINER=${CONTAINER:-asset-layer-gate}
IMAGE=${IMAGE:-postgres:17-alpine}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/../../supabase/migrations"

# Everything is piped over stdin rather than copied in, so no path translation
# happens on Windows.
psql_file() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 "$@"; }

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "1. Fresh $IMAGE container"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && break
  sleep 1
done
docker exec "$CONTAINER" psql -U postgres -Atc 'select version();'

say "2. Roles, as production has them"
psql_file -q -1 < "$HERE/01-roles.sql"
docker exec "$CONTAINER" psql -U postgres -c \
  "select rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper from pg_roles
    where rolname in ('anon','authenticated','service_role','postgres') order by rolname;"

# The rename migration and everything after it are held back so the seed can go
# in through the OLD write path. That ordering is what production will do: the
# rows the later checks read are rows the backfill produced, not rows the new
# code made.
say "3. Every migration before the rename, in filename order, one transaction each"
for f in "$MIGRATIONS"/*.sql; do
  b=$(basename "$f")
  case "$b" in 2026081910*) continue ;; esac
  printf '%-72s ' "$b"
  psql_file -q -1 < "$f" >/dev/null && echo OK
done

say "4. Seed through the OLD ingest_capture, as service_role"
psql_file -1 < "$HERE/02-seed.sql"

say "5. The five asset-layer migrations"
for b in 20260819100000_listing_rename.sql \
         20260819100100_asset_layer_tables.sql \
         20260819100200_asset_layer_backfill.sql \
         20260819100300_asset_layer_write_path.sql \
         20260819100400_asset_layer_views.sql; do
  printf '%-50s ' "$b"
  psql_file -q -1 < "$MIGRATIONS/$b" >/dev/null && echo OK
done

say "6. Harness"
psql_file -q < "$HERE/03-harness.sql"

say "7. Reads as anon and as service_role, asserting non-zero rows"
psql_file -q < "$HERE/04-reads.sql"

say "8. Deliberate breakage, so the assertions above are known to be able to fail"
psql_file -q < "$HERE/05-negative.sql"

say "9. Sentinel ingest against the renamed schema"
psql_file -q < "$HERE/06-sentinel.sql"

say "10. Final reads, catalog audit, leftover-name scan"
psql_file -q < "$HERE/07-final.sql"

say "11. Verdict"
docker exec "$CONTAINER" psql -U postgres -Atc "
  select case when count(*) = 0 then 'GATE PASS: no unexpected failures'
              else 'GATE FAIL: ' || count(*) || ' unexpected results' end
    from gate.result
   where verdict not like 'PASS%'
     and step not like '4b.%'
     and step not like '5b.%'
     and step not like '5d.%'
     and step not like '5e.%';"

echo
echo "Container '$CONTAINER' is left running for inspection. Remove it with:"
echo "  docker rm -f $CONTAINER"
