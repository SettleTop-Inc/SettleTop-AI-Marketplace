# Runbooks

## Vocabulary

An **asset** is the registry's unit: one real product. A **listing** is one
marketplace's page for that product, one row per marketplace it appears on. A
**capture** is one immutable observation of one listing. One product can hold
several listings, so `asset` and `listing` are not interchangeable below.

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

## Rollback: reverting phase 2's asset-keyed views

Nothing before this section said how to undo `20260820100000_asset_keyed_views.sql`
and `20260820100100_registry_search_asset_keyed.sql`. This is that answer, and
it is written down because a naive `create or replace view` cannot do it.

**Why a plain `create or replace` refuses.** `create or replace view` accepts a
new source for an existing column, and appends new columns at the end. It
refuses to remove one:

```
ERROR:  cannot drop columns from view
```

Phase 2 appended three columns to `v_registry_card` (32 -> 35) and one to
`v_asset_passport` (61 -> 62). Reverting each is therefore a column
*removal*, which `create or replace view` will not do. The only way to shrink
a view's column list is `drop view ... ; create view ...`, and `drop view`
takes the view's grants with it, silently, with no warning that anything was
lost. That is the exact shape of the outage that once took all 6,820 logos off
this site: a drop-and-recreate with no re-grant after it, discovered only
because `getLogos()` returns `{}` on error and the missing logos rendered as
blank initials with nothing in the logs pointing at 42501.

`v_registry_card` also has a dependent: `v_registry_stats` selects from it
four times, so `drop view v_registry_card` on its own fails with
`ERROR: cannot drop view v_registry_card because other objects depend on it`,
and the fix most people reach for at speed is `cascade`, which drops
`v_registry_stats` too, silently, along with both views' grants. That is the
"dangerous shape" this section exists to name: the revert of the card cannot
avoid taking the stats view with it, and both need their grants and their
`security_invoker` restored afterward or the outage repeats with a second
view.

**The script below was run against the gate's container, not reasoned about.**
`scripts/gate/run.sh` leaves a fully-migrated `asset-layer-gate` Postgres
container running after every `npm run gate`. This script was piped into that
container (`docker exec -i asset-layer-gate psql -U postgres -v ON_ERROR_STOP=1`)
against the live phase 2 schema, and afterward: `v_registry_card` had 32
columns and `v_asset_passport` had 61; `v_listing_passport` and
`v_asset_evidence` no longer existed; `anon` could run `registry_search()` and
read every reverted view; and both `do $$ ... $$` blocks at the end, copied
from the forward migration's own tripwire, passed. Re-verify the same way
before relying on it again: a schema drift between this doc and a later
migration would not announce itself otherwise.

**Order matters.** `registry_search` is reverted *first*, while the card is
still in its 35-column shape. The pre-phase-2 `registry_search` only reads
columns that exist on both the 32- and 35-column card (it never reads
`marketplace_ids` or `search_blob`), so this step is safe to run before the
card changes and leaves no window in which the live `registry_search`
references a column the card lacks. Reverting the card first would not: the
phase 2 `registry_search` reads `v.marketplace_ids` and `v.search_blob`,
neither of which exist on the reverted 32-column card, so every search would
fail with `42703 column "marketplace_ids" does not exist` until the function
was also reverted: a live, loud outage on the busiest read path in the app,
for however long the two steps are apart.

`v_asset_passport`, `v_listing_passport` and `v_asset_evidence` have no
dependents (checked against `pg_depend` on the gate container), so those three
steps are plain drops with no cascade and nothing else to take down.

```sql
-- Step 0: registry_search back to its pre-phase-2 body, first.
create or replace function registry_search(
  p_q          text   default '',
  p_source     text[] default '{}',
  p_function   text[] default '{}',
  p_provenance text[] default '{}',
  p_risk       text[] default '{}',
  p_tier       text[] default '{}',
  p_delivery   text[] default '{}',
  p_price      text[] default '{}',
  p_sort       text   default 'reach',
  p_dir        text   default 'desc',
  p_limit      int    default 24,
  p_offset     int    default 0
) returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
with
  needle as (
    select case
      when nullif(btrim(p_q), '') is null then null
      else replace(replace(replace(lower(btrim(p_q)),
             '\', '\\'), '%', '\%'), '_', '\_')
    end as n
  ),
  byq as (
    select
      v.asset_id, v.name, v.reach, v.rating, v.last_captured_at,
      coalesce(nullif(v.marketplace_name,  ''), 'Unknown') as f_source,
      coalesce(nullif(v.function_category, ''), 'Unknown') as f_function,
      coalesce(v.provenance::text, 'Unknown')              as f_provenance,
      coalesce(v.risk::text, 'Unknown')                    as f_risk,
      coalesce(nullif(v.evidence_tier,     ''), 'Unknown') as f_tier,
      coalesce(nullif(v.delivery,          ''), 'Unknown') as f_delivery,
      coalesce(nullif(v.price_band,        ''), 'Unknown') as f_price
    from v_registry_card v, needle
    where needle.n is null
      or lower(concat_ws(' ',
           nullif(v.name, ''), nullif(v.publisher, ''),
           nullif(v.function_category, ''), nullif(v.tagline, ''),
           nullif(v.marketplace_name, ''), nullif(v.evidence_tier, ''),
           nullif(v.delivery, ''), nullif(v.cert_label, ''),
           nullif(array_to_string(v.surfaces, ' '), '')
         )) like '%' || needle.n || '%' escape '\'
  ),
  matched as (
    select b.*,
      (cardinality(p_source)     = 0 or b.f_source     = any(p_source))     as m_source,
      (cardinality(p_function)   = 0 or b.f_function   = any(p_function))   as m_function,
      (cardinality(p_provenance) = 0 or b.f_provenance = any(p_provenance)) as m_provenance,
      (cardinality(p_risk)       = 0 or b.f_risk       = any(p_risk))       as m_risk,
      (cardinality(p_tier)       = 0 or b.f_tier       = any(p_tier))       as m_tier,
      (cardinality(p_delivery)   = 0 or b.f_delivery   = any(p_delivery))   as m_delivery,
      (cardinality(p_price)      = 0 or b.f_price      = any(p_price))      as m_price
    from byq b
  ),
  hits as (
    select * from matched
    where m_source and m_function and m_provenance
      and m_risk and m_tier and m_delivery and m_price
  ),
  ranked as (
    select asset_id, row_number() over (
      order by
        case when p_sort = 'reach'    and p_dir = 'desc' then reach            end desc nulls last,
        case when p_sort = 'reach'    and p_dir = 'asc'  then reach            end asc  nulls last,
        case when p_sort = 'rating'   and p_dir = 'desc' then rating           end desc nulls last,
        case when p_sort = 'rating'   and p_dir = 'asc'  then rating           end asc  nulls last,
        case when p_sort = 'captured' and p_dir = 'desc' then last_captured_at end desc nulls last,
        case when p_sort = 'captured' and p_dir = 'asc'  then last_captured_at end asc  nulls last,
        case when p_sort = 'name' and p_dir = 'desc' then name collate registry_name_ci end desc nulls last,
        case when p_sort = 'name' and p_dir = 'asc'  then name collate registry_name_ci end asc  nulls last,
        asset_id asc
    ) as rn
    from hits
  ),
  page as (
    select asset_id, rn from ranked
    where rn >  greatest(p_offset, 0)
      and rn <= greatest(p_offset, 0) + greatest(p_limit, 0)
  ),
  page_cards as (
    select to_jsonb(v) as card, p.rn
    from page p
    join v_registry_card v on v.asset_id = p.asset_id
  ),
  counted as (
    select 'source' as key, f_source as value,
           count(*) filter (where m_function and m_provenance and m_risk and m_tier and m_delivery and m_price) as n
      from matched group by f_source
    union all select 'function', f_function,
           count(*) filter (where m_source and m_provenance and m_risk and m_tier and m_delivery and m_price)
      from matched group by f_function
    union all select 'provenance', f_provenance,
           count(*) filter (where m_source and m_function and m_risk and m_tier and m_delivery and m_price)
      from matched group by f_provenance
    union all select 'risk', f_risk,
           count(*) filter (where m_source and m_function and m_provenance and m_tier and m_delivery and m_price)
      from matched group by f_risk
    union all select 'tier', f_tier,
           count(*) filter (where m_source and m_function and m_provenance and m_risk and m_delivery and m_price)
      from matched group by f_tier
    union all select 'delivery', f_delivery,
           count(*) filter (where m_source and m_function and m_provenance and m_risk and m_tier and m_price)
      from matched group by f_delivery
    union all select 'price', f_price,
           count(*) filter (where m_source and m_function and m_provenance and m_risk and m_tier and m_delivery)
      from matched group by f_price
  ),
  selected as (
    select 'source' as key, s as value from unnest(p_source) s
    union all select 'function',   s from unnest(p_function) s
    union all select 'provenance', s from unnest(p_provenance) s
    union all select 'risk',       s from unnest(p_risk) s
    union all select 'tier',       s from unnest(p_tier) s
    union all select 'delivery',   s from unnest(p_delivery) s
    union all select 'price',      s from unnest(p_price) s
  ),
  merged as (
    select key, value, max(n) as n
    from (
      select key, value, n from counted
      union all
      select key, value, 0 from selected
    ) u
    group by key, value
  ),
  grouped as (
    select key, jsonb_agg(
             jsonb_build_object(
               'value',    value,
               'count',    n,
               'selected', value = any(
                 case key
                   when 'source'     then p_source
                   when 'function'   then p_function
                   when 'provenance' then p_provenance
                   when 'risk'       then p_risk
                   when 'tier'       then p_tier
                   when 'delivery'   then p_delivery
                   else                   p_price
                 end)
             )
             order by value collate registry_name_ci
           ) as vals
    from merged group by key
  )
select jsonb_build_object(
  'total',  (select count(*) from hits),
  'rows',   coalesce((select jsonb_agg(card order by rn) from page_cards), '[]'::jsonb),
  'facets', coalesce((select jsonb_object_agg(key, vals) from grouped), '{}'::jsonb)
);
$fn$;

grant execute on function registry_search to anon, authenticated;


-- Step 1: v_registry_card, 35 columns -> 32, is a column removal. Must drop.
-- CASCADE takes v_registry_stats with it -- that is the one dependent, per
-- pg_depend on the gate container -- and CASCADE drops both views' grants
-- along with them. Both are restored explicitly below.
drop view public.v_registry_card cascade;


-- Step 2: recreate v_registry_card in its pre-phase-2 shape, verbatim from
-- 20260819100400_asset_layer_views.sql.
create view public.v_registry_card
with (security_invoker = true) as
select
  l.asset_id                             as asset_id,
  l.source_product_id,
  l.listing_url,
  l.marketplace_id,
  m.name                                 as marketplace_name,
  l.last_captured_at,
  l.capture_count,
  x.name, x.publisher, x.tagline,
  x.function_category, x.delivery, x.surfaces,
  x.rating, x.rating_count, x.external_source, x.external_rating,
  x.certification,
  registry_provenance(x.certification) ->> 'label' as cert_label,
  x.provenance, x.evidence_tier,
  x.reach, x.risk, x.risk_basis,
  x.price_band, x.price_note,
  x.listing_version, x.listing_updated,
  x.known_layers,
  cardinality(x.known_layers)            as layers_known,
  array_length(registry_layers(), 1)     as layers_tracked,
  l.id                                   as listing_id
from listing l
join marketplace m       on m.id = l.marketplace_id
join capture_extract x   on x.capture_id = l.current_capture_id;

comment on view public.v_registry_card is
  'One row per listing at its latest capture, sized for the registry grid. asset_id is the product the listing is evidence about; listing_id is the listing itself. Does not carry overview text.';

grant select on public.v_registry_card to anon, authenticated;


-- Step 3: v_registry_stats went away in step 1's cascade. Its own definition
-- never changed in phase 2 -- only the card under it did -- so this is
-- 20260819100400_asset_layer_views.sql's text, unmodified.
create view public.v_registry_stats
with (security_invoker = true) as
select
  (select count(*) from asset where merged_into is null)              as agents,
  (select count(distinct marketplace_id) from listing)                as marketplaces,
  (select count(distinct asset_id) from v_registry_card
    where certification = 'microsoft_365_certified')                  as certified,
  (select count(distinct asset_id) from v_registry_card
    where certification = 'publisher_attestation')                    as attested,
  (select round(avg(reach)) from v_registry_card)                     as mean_reach,
  (select count(*) from capture)                                      as captures,
  (select count(*) from listing_change)                               as changes,
  (select max(last_captured_at) from listing)                         as last_captured_at,
  (select count(distinct publisher) from v_registry_card
    where publisher is not null
      and btrim(publisher) <> ''
      and publisher <> 'Unknown')                                     as publishers;

grant select on public.v_registry_stats to anon, authenticated;


-- Step 4: v_asset_passport, 62 columns -> 61, same column-removal refusal.
-- No dependents, so a plain drop -- but the grant is lost the moment it runs,
-- same as step 1.
drop view public.v_asset_passport;

create view public.v_asset_passport
with (security_invoker = true) as
select
  l.asset_id                             as asset_id,
  l.source_product_id,
  l.listing_url,
  l.marketplace_id,
  m.name                                 as marketplace_name,
  l.first_seen_at, l.last_captured_at, l.capture_count,
  c.id                                   as capture_id,
  c.captured_at, c.capture_complete, c.missing, c.ingest_source,
  x.name, x.publisher, x.tagline, x.overview_text,
  x.surfaces, x.categories, x.industries, x.works_with,
  x.pricing, x.acquire_using, x.support,
  x.listing_version, x.listing_updated,
  x.rating, x.rating_count, x.native_rating, x.native_count,
  x.external_source, x.external_rating, x.external_count,
  x.certification,
  registry_provenance(x.certification) ->> 'label' as cert_label,
  x.cert_url, x.cert_hosting, x.cert_data_location, x.cert_data_handling,
  x.cert_developer_updated, x.cert_page_updated,
  x.function_category, x.delivery, x.price_band, x.price_note,
  x.known_layers, cardinality(x.known_layers) as layers_known,
  array_length(registry_layers(), 1)          as layers_tracked,
  x.reach, x.provenance, x.evidence_tier, x.risk, x.risk_basis,
  (select coalesce(jsonb_object_agg(kind, vals), '{}'::jsonb) from (
     select e.kind::text as kind, jsonb_agg(e.value order by e.value) as vals
       from capture_evidence e
      where e.capture_id = c.id and e.verified
      group by e.kind) s)                     as evidence,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'name', p.name, 'price', p.price, 'unit', p.unit, 'billing', p.billing)
          order by p.position), '[]'::jsonb)
     from capture_plan p where p.capture_id = c.id)                 as plans,
  (select coalesce(jsonb_agg(jsonb_build_object('label', lnk.label, 'url', lnk.url)
          order by lnk.position), '[]'::jsonb)
     from capture_link lnk where lnk.capture_id = c.id and lnk.kind = 'product')  as product_links,
  (select coalesce(jsonb_agg(jsonb_build_object('label', lnk.label, 'url', lnk.url)
          order by lnk.position), '[]'::jsonb)
     from capture_link lnk where lnk.capture_id = c.id and lnk.kind = 'legal')    as legal_links,
  (select coalesce(jsonb_agg(lnk.url order by lnk.position), '[]'::jsonb)
     from capture_link lnk where lnk.capture_id = c.id and lnk.kind = 'media')    as media,
  (select coalesce(array_agg(q.permission order by q.permission), '{}')
     from capture_permission q where q.capture_id = c.id)           as graph_permissions,
  (select coalesce(array_agg(k.certification order by k.certification), '{}')
     from capture_compliance k where k.capture_id = c.id)           as compliance,
  l.id                                        as listing_id
from listing l
join marketplace m     on m.id = l.marketplace_id
join capture c         on c.id = l.current_capture_id
join capture_extract x on x.capture_id = c.id;

comment on view public.v_asset_passport is
  'Everything the agent passport renders, at the latest capture of one listing. asset_id is the product; listing_id is the listing that supplied these fields. evidence carries verified rows only.';

grant select on public.v_asset_passport to anon, authenticated;


-- Step 5: v_listing_passport and v_asset_evidence did not exist before phase
-- 2 and nothing depends on either. Plain drops, nothing to recreate.
drop view public.v_listing_passport;
drop view public.v_asset_evidence;


-- Step 6: the same two checks the forward migration runs at the end of
-- itself, run here against the reverted state instead of skipped.
do $$
declare missing text;
begin
  select string_agg(format('%s -> %s', v, r), ', ') into missing
    from (values
      ('v_registry_card'),('v_asset_passport'),
      ('v_asset_change_feed'),
      ('v_registry_stats'),('v_logo_status')) as views(v)
    cross join (values ('anon'),('authenticated')) as roles(r)
   where not has_table_privilege(r, 'public.' || v, 'SELECT');
  if missing is not null then
    raise exception 'grants missing after revert: %', missing;
  end if;
  if not has_table_privilege('service_role', 'public.v_logo_status', 'SELECT') then
    raise exception 'service_role lost SELECT on v_logo_status; archive-logos.mjs will fail with 42501';
  end if;
end $$;

do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('v_registry_card','v_asset_passport',
                       'v_asset_change_feed',
                       'v_registry_stats','v_logo_status')
     and not coalesce(c.reloptions, '{}') @> array['security_invoker=true'];
  if bad is not null then
    raise exception 'views are not security_invoker after revert, so RLS runs as the owner: %', bad;
  end if;
end $$;
```

What this script does **not** undo: the rows already written by anything that
started relying on the wider shape (`marketplace_ids`, `listing_count`,
`search_blob`, `listings`) between deploy and revert. It reverts the schema,
not application behavior that read from it in between. Check what shipped
against the phase 2 shape before running this against production.

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
select l.source_product_id, e.kind, e.value
  from capture_evidence e
  join capture c on c.id = e.capture_id
  join listing l on l.id = c.listing_id
 where not e.verified
 order by e.kind;

-- what moved recently, newest first: v_asset_change_feed exposes both
-- asset_id, the product, and listing_id, the marketplace page it moved on
select name, field, old_value, new_value, observed_at
  from v_asset_change_feed limit 25;

-- listings captured more than once, i.e. where change tracking is live
select source_product_id, capture_count, last_captured_at
  from listing where capture_count > 1 order by capture_count desc;

-- one product, every marketplace's own unresolved account of it: the question
-- v_listing_passport and v_asset_evidence exist to answer. Swap in a real
-- slug. Today this returns exactly one row, since every asset still holds one
-- listing; after the first merge it returns one row per marketplace the
-- product is actually listed on. v_asset_evidence, keyed the same way on
-- asset_id, is the capture-by-capture trail behind these rows.
select marketplace_name, certification, cert_label, reach, risk, risk_basis,
       last_captured_at
  from v_listing_passport
 where asset_id = (select asset_id from asset_slug where slug = 'some-agent-slug')
 order by marketplace_name;
```

## Recomputing derived values after changing a rule

The derivation functions are pure, but `capture_extract` stores their output, so
changing a rule does not retroactively change stored rows. Either re-ingest the
affected captures from `capture.raw`, or write a migration that updates
`capture_extract` in place using the new function. Prefer the former: it keeps
the stored value and the function that produced it in agreement.

Note that `capture.raw` is NULL for 187 of the registry's 30,900 captures: 140
backfilled from a pre-Supabase index, and 47 captured as `dual_write` on
template_version 2.0 during a two hour window on 2026-08-17, the manual
capture era. No listing's current capture is among those 187, so every
listing's newest observation is fully backed by its source material and can
be re-derived; it is only older, superseded captures that cannot be.
