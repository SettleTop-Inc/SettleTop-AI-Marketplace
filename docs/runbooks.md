# Runbooks

## First run after cloning

```bash
npm install
cp .env.example .env.local
npm run typecheck
npm run dev            # http://localhost:3000
```

The two public values in `.env.example` are already correct and safe to commit —
the publishable key can only read, because the database has public SELECT
policies and no write policies at all.

> **This app has never been built.** It was authored in an environment without
> access to the npm registry, so `next build` has not run against it once. Treat
> the first `npm run typecheck && npm run build` as part of the handoff, not as
> a regression check. Anything it finds is expected to be small — import paths,
> a React 19 type signature — not structural.

## Deploy

Vercel is already connected to the GitHub repo. Push to `main` and it builds.

`vercel.json` pins the framework to `nextjs` deliberately. The Vercel project was
created while this repo still contained only a README, so Vercel auto-detected no
framework and the first real application build failed. Repo-level settings win
over the project's auto-detection — do not delete that file expecting the
dashboard to know better.

Set these in Vercel → Project → Settings → Environment Variables, for **all**
environments. Production-only is not enough: PR previews build too, and a preview
without these fails exactly the way a missing key fails locally.

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://atevamimariwlpidgvog.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the `sb_publishable_...` key |

Do **not** put `SUPABASE_SERVICE_ROLE_KEY` in Vercel. Nothing the website does
needs it, and the registry has no write path from the browser by design.

## Schema change

```bash
supabase migration new add_whatever
# edit supabase/migrations/<timestamp>_add_whatever.sql
git commit && git push
```

The GitHub → Supabase integration applies it. Existing migration files carry the
timestamps already recorded in `supabase_migrations.schema_migrations`, so they
are skipped rather than re-run.

Never change the schema from the Supabase dashboard — the repo stops being the
truth the moment you do. See `docs/schema-divergence-2026-08-19.md` for what
happened the one time that rule was not followed and how it was reconciled.

## Ingest a batch of capture files

```bash
export SUPABASE_SERVICE_ROLE_KEY=...      # from Supabase → Settings → API
node scripts/ingest.mjs ./path/to/captures
```

Safe to re-run: anything already stored returns `already_ingested`.

## Health checks

```sql
-- coverage: how much of the registry actually discloses each layer
select
  count(*)                                                   as agents,
  count(*) filter (where certification = 'microsoft_365_certified') as certified,
  round(avg(reach))                                          as mean_reach,
  count(*) filter (where risk = 'High')                      as high_evidence_risk
from v_registry_card;

-- anything the honesty gate refused
select a.source_product_id, e.kind, e.value
  from capture_evidence e
  join capture c on c.id = e.capture_id
  join asset a   on a.id = c.asset_id
 where not e.verified
 order by e.kind;

-- what moved recently, newest first
select name, field, old_value, new_value, observed_at
  from v_asset_change_feed limit 25;

-- assets captured more than once, i.e. where change tracking is live
select source_product_id, capture_count, last_captured_at
  from asset where capture_count > 1 order by capture_count desc;
```

## Recomputing derived values after changing a rule

The derivation functions are pure, but `capture_extract` stores their output, so
changing a rule does not retroactively change stored rows. Either re-ingest the
affected captures from `capture.raw`, or write a migration that updates
`capture_extract` in place using the new function. Prefer the former: it keeps
the stored value and the function that produced it in agreement.

Note that `capture.raw` is NULL for the 140 backfilled rows, so those cannot be
re-derived from source until each listing is captured again under template 2.0.
