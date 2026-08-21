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
say "3. Every migration before 20260819100000, in filename order, one transaction each"
#
# The threshold is the rename migration itself, 20260819100000_listing_rename.sql.
# Everything before it needs the pre-rename schema (the name `asset` still
# meaning the old listings table); everything from it onward depends on the
# rename having already run, and the seed below goes in through the OLD
# ingest_capture between the two loops. Comparing basenames as strings against
# a fixed threshold, rather than a prefix skip or an explicit file list, keeps
# this correct as later phases add migrations with prefixes of their own: a
# 20260820* file sorts below nothing here and lands in the second loop, a
# 20260901* file does too, and neither has to be named.
for f in "$MIGRATIONS"/*.sql; do
  b=$(basename "$f")
  [[ "$b" < "20260819100000" ]] || continue
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

say "5. Every migration from 20260819100000 onward, in filename order"
for f in "$MIGRATIONS"/*.sql; do
  b=$(basename "$f")
  [[ "$b" < "20260819100000" ]] && continue
  printf '%-50s ' "$b"
  if ! psql_file -q -1 < "$f" >/dev/null; then
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

say "11. Slug chain: three levels, and the unguarded-collision-no-longer-aborts proof"
psql_file -q < "$HERE/08-slug-chain.sql"

say "12. Merged-into guard: a partial merge excludes the asset from every stat together"
psql_file -q < "$HERE/09-merged-guard.sql"

say "13. Merge candidates: cross-marketplace detection, and the same-market exclusion proof"
psql_file -q < "$HERE/10-merge-candidates.sql"

say "14. Known layers: a two-listing asset proves the ledger reads the PRIMARY listing"
psql_file -q < "$HERE/11-known-layers.sql"

say "15. Rate limiter: a bucket allows its burst then denies"
psql_file -q < "$HERE/12-rate-limit.sql"

say "16. Verdict"
if verdict; then status=0; else status=1; fi

echo
echo "Container '$CONTAINER' is left running for inspection. Remove it with:"
echo "  docker rm -f $CONTAINER"

exit "$status"
