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

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH. This gate needs Docker to build its throwaway" >&2
  echo "Postgres container; there is no other way to run it. Install Docker or" >&2
  echo "start Docker Desktop, then re-run." >&2
  exit 127
fi

CONTAINER=${CONTAINER:-asset-layer-gate}
IMAGE=${IMAGE:-postgres:17-alpine}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/../../supabase/migrations"

# Everything is piped over stdin rather than copied in, so no path translation
# happens on Windows.
psql_file() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 "$@"; }

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# The verdict, as a function, so a container that is already populated can be
# re-judged without a full rebuild: bash scripts/gate/run.sh --verdict-only
#
# The excluded steps are the ones whose FAIL *is* the assertion. Each is proved
# somewhere else in the same run, so excluding it here loses no coverage:
#
#   4b.              service_role hitting 42501 on the four views it was never
#                    granted. That is the designed grant surface, not a fault.
#   5b.              the loud breakage. Excluded wholesale rather than asserted,
#                    because 5a covers the same revocation in its silent form
#                    and 5a IS asserted. 5b exists to show the operator that a
#                    revoked grant errors rather than emptying, not to gate.
#   5d, 5e, 5g, 5i.  deliberate breakages whose whole point is a red line.
#
# Everything else must be PASS, and the script exits non-zero when it is not.
# A gate whose exit code cannot say no is a report, not a gate.
EXCLUDED="step not like '4b.%'
      and step not like '5b.%'
      and step not like '5d.%'
      and step not like '5e.%'
      and step not like '5g.%'
      and step not like '5i.%'"

verdict() {
  local unexpected
  unexpected=$(docker exec "$CONTAINER" psql -U postgres -Atc \
    "select count(*) from gate.result where verdict not like 'PASS%' and $EXCLUDED;")

  if [ "$unexpected" = "0" ]; then
    echo "GATE PASS: no unexpected failures"
    return 0
  fi

  echo "GATE FAIL: $unexpected unexpected results"
  docker exec "$CONTAINER" psql -U postgres -P pager=off -c \
    "select step, as_role, object, n_rows, verdict, note from gate.result
      where verdict not like 'PASS%' and $EXCLUDED order by seq;"
  return 1
}

if [ "${1:-}" = "--verdict-only" ]; then
  verdict
  exit $?
fi

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
#
# WARNING, and it will bite phase 2. This glob takes everything in the directory
# and the case below skips only the five phase 1 files by their 2026081910
# prefix. Any migration added later sorts AFTER those five and has a different
# prefix, so it lands in THIS loop and is applied BEFORE the rename, against a
# schema that does not have `listing` yet.
#
# When phase 2 adds a migration, this needs an explicit cutoff rather than a
# prefix skip: apply files whose name sorts below 20260819100000, seed, then
# apply the rest in order. Left as a prefix match for now because it is exact
# for the set of files that exist today, and a wrong cutoff is harder to spot
# than this comment.
for f in "$MIGRATIONS"/*.sql; do
  b=$(basename "$f")
  case "$b" in 2026081910*) continue ;; esac
  printf '%-72s ' "$b"
  if ! psql_file -q -1 < "$f" >/dev/null; then
    echo "FAILED"
    echo "Migration $b did not apply. Everything after this would run against a" >&2
    echo "half-migrated database, so the gate stops here." >&2
    exit 1
  fi
  echo OK
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
  if ! psql_file -q -1 < "$MIGRATIONS/$b" >/dev/null; then
    echo "FAILED"
    echo "Migration $b did not apply. The gate stops here." >&2
    exit 1
  fi
  echo OK
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
if verdict; then status=0; else status=1; fi

echo
echo "Container '$CONTAINER' is left running for inspection. Remove it with:"
echo "  docker rm -f $CONTAINER"

exit "$status"
