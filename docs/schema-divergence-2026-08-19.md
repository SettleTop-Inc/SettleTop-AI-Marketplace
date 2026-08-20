# Schema divergence, 2026-08-19

Before Phase 1 of the asset layer plan could touch the schema, the repo had to
be able to rebuild what production is actually running. It could not: the
Supabase branch used for that plan reported `MIGRATIONS_FAILED`, and checking
why turned up three migrations that were applied to production on 2026-08-18
but never committed to this repo.

## What was found

Comparing the live database (project `atevamimariwlpidgvog`) against the repo
on 2026-08-19 turned up three unrecorded migrations:

- **`20260818134538` (registry_search).** Live and the repo's own
  `20260818120000_registry_search.sql` are token-identical once comments and
  whitespace are normalised: 4,910 tokens on both sides. This was a
  SQL-editor round trip that stripped the function's comments without
  changing its behaviour. No functional divergence.

- **`20260818192216` (drai marketplace and publisher_document).** Live holds
  a `drai` marketplace row, a `publisher_document` table and an
  `ingest_publisher_document` function that the repo had no file for at all.

- **`20260818192550` (v_logo_status, marketplace-aware).** Live's
  `v_logo_status` carries `marketplace_id` and `listing_url`, which the
  repo's only definition of that view (in
  `20260816195128_logo_capture_and_archive.sql`) never had. Rebuilding the
  schema from the repo as it stood would have silently reverted the view and
  broken `archive-logos.mjs` and every logo on the site, the same failure
  mode `20260818210000_v_logo_status_grants.sql` already documents for a
  dropped grant on this same view.

All three are now committed as
`supabase/migrations/20260818134538_registry_search.sql`,
`supabase/migrations/20260818192216_add_drai_marketplace_and_publisher_document.sql`
and `supabase/migrations/20260818192550_v_logo_status_marketplace_aware.sql`,
each reconstructed from the running database and each carrying the version
stamp already recorded in production, so the Supabase integration skips them
there and applies them only on a fresh or branch database. That is the rule
`docs/runbooks.md` already states under "Schema change": existing migration
files carry the timestamps already recorded in
`supabase_migrations.schema_migrations`, so they are skipped rather than
re-run.

## Two things beyond a missing file

Reconciling turned up two problems that were not simply "no file exists,"
recorded here so they are not lost.

**`v_logo_status` lost `security_invoker = true` on the way to production.**
The repo's version, and every other view in this schema, sets
`with (security_invoker = true)`. The unrecorded `20260818192550` did not, so
the live view runs with its creator's permissions and bypasses row level
security, which Supabase's database linter flags at ERROR level. The
reconstruction file restores `security_invoker = true`, which is a
deliberate, noted difference from what production currently holds, not an
oversight: since the reconstruction file's version stamp is already recorded
on production, it is skipped there and this does not fix live. Production
stays on the definer-style view until a later task in the asset layer plan
recreates every view with `security_invoker = true`.

**`ingest_publisher_document` had no revoke/grant block.** Every other write
function in this schema (`ingest_capture`, `set_capture_logo`,
`record_link_archive`) explicitly revokes EXECUTE from `public`, `anon` and
`authenticated` and grants it only to `service_role`. `ingest_publisher_document`
was created without that pair, so Postgres left EXECUTE granted to `public`
by default, and the browser publishable key could call it. Verified against
production on 2026-08-19: an anon call reached the function's own input
validation, which only runs after the permission check passes. This is fixed
on production by a new migration,
`supabase/migrations/20260819095000_revoke_public_execute_on_publisher_document.sql`,
because the reconstruction file's version stamp is already recorded and would
be skipped. The same revoke/grant pair is also added at the end of the
reconstruction file itself, so a database built from scratch is never
exposed either.

## Left alone, on purpose

`publisher_document` has row level security enabled, no policy, and no
SELECT grant to `anon`, `authenticated` or `service_role`, in production and
in the reconstruction. Nothing can read the table today. That is a real gap,
but changing it is not what this reconciliation is for: the job here is to
match what production runs, not to redesign it.

## Why this could happen

Nothing in this repo enforces that a change applied through the Supabase SQL
editor also lands as a committed migration file. `docs/runbooks.md` already
says "never change the schema from the Supabase dashboard, the repo stops
being the truth the moment you do," but that rule was not followed for these
three changes, and the drift was invisible until something needed to rebuild
the schema from scratch.
