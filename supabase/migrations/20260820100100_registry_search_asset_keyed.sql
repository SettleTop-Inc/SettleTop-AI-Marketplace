-- registry_search searches the whole asset, not just its primary listing.
--
-- Exactly two changes to 20260818134538_registry_search.sql, which is the live
-- function reconciled in phase 1. Everything else here is that definition
-- carried over unchanged: the twelve parameters, their defaults and their
-- order, and the jsonb_build_object('total', 'rows', 'facets') return shape.
-- lib/registry.ts reads that shape and lib/registry-search.parity.test.ts
-- compares this function against a TypeScript reimplementation of it, so
-- neither can move without breaking something that is not in this file.
--
--   1. The free-text match reads v_registry_card.search_blob, which task 2
--      built as the same nine fields concatenated across EVERY listing of the
--      asset rather than one. A product whose AWS description names vLLM and
--      whose Microsoft page does not must still answer a search for vLLM.
--
--   2. The source facet is the SET of marketplaces the asset appears on rather
--      than the single marketplace of its primary listing. An asset on two
--      marketplaces matches a filter for either, and is counted under both.
--
-- Assets and listings are 1:1 today, so neither change moves a number: every
-- asset has one listing, search_blob holds that listing's nine fields and
-- nothing else, and the set of marketplaces has one member. That is the point
-- and it is also the limit. Both changes are for phase 3, which is what first
-- gives an asset a second listing, and neither is provable before then.
--
-- Only the search predicate and the source facet change. The other six facets,
-- the self-excluding counts, the seeded-and-selected merge, the ranking, the
-- paging and the deferred row serialisation are untouched, because none of them
-- has anything to do with the grain.
--
--
-- IDS OR NAMES, and why this file maps rather than carrying both.
--
-- v_registry_card.marketplace_ids holds marketplace IDS: 'microsoft', 'drai'.
-- The source facet has always emitted marketplace NAMES: 'Microsoft
-- Marketplace'. facetValueOf() in lib/registry-query.ts reads marketplace_name
-- for the same facet on the client side, and the app sends back in p_source
-- whatever value the facet showed it. So ids and names have to meet somewhere,
-- and there are only two places to do it:
--
--   (a) add a marketplace_names column to v_registry_card alongside the ids;
--   (b) map ids to names here.
--
-- This file does (b), for two reasons. It leaves the view alone, so
-- v_registry_card keeps the column shape task 2 settled and no append-only
-- replace has to be spent on a column that carries no new fact. And the
-- mapping is a lookup against a two-row table that v_registry_card already
-- inner-joins twice, so it adds no dependency anon did not already have: if
-- anon could not read marketplace, the card would be empty before this
-- function ever ran, and total would be 0 rather than wrong.
--
-- Getting this wrong is silent, not loud. Compare p_source (names) against
-- marketplace_ids (ids) and nothing ever matches: the rail still renders its
-- names and its counts, and every click on a source filter empties the grid
-- with no error anywhere. Under 1:1 a check that only counted rows would not
-- see it either, which is why the gate asserts that filtering on a marketplace
-- NAME returns the asset, and asserts a wrong name returns none.

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
  -- The needle is matched with LIKE but comes from a text box, where % and _
  -- are ordinary characters. Escape them, or a visitor searching "100% managed"
  -- matches every row in the registry.
  --
  -- Unchanged, deliberately, including the order: the backslash goes first so
  -- that the escapes added after it are not themselves escaped. This is the
  -- model gate.like_literal() in scripts/gate/04-reads.sql copies.
  needle as (
    select case
      when nullif(btrim(p_q), '') is null then null
      else replace(replace(replace(lower(btrim(p_q)),
             '\', '\\'), '%', '\%'), '_', '\_')
    end as n
  ),

  -- Everything matching the free-text query, with each facet's value
  -- normalised once. null, the empty string and the literal 'Unknown' are one
  -- bucket, exactly as norm() in marketplace-query.ts collapses them. A third
  -- spelling means the rail offers a value the filter can never match.
  --
  -- source is the one exception and is now an ARRAY, f_sources, because a
  -- product can be sold on more than one marketplace and is not required to
  -- pick one. Every other facet stays single-valued.
  byq as (
    select
      v.asset_id, v.name, v.reach, v.rating, v.last_captured_at,
      -- Every marketplace the asset is listed on, as the NAMES the facet
      -- displays and the app filters on. See the note at the top of this file
      -- for why the mapping happens here and not in the view.
      --
      -- There is no 'Unknown' branch for the array as a whole and there cannot
      -- be one: marketplace_ids is aggregated over the asset's listings, and an
      -- asset with no listings has no row in v_registry_card at all, so this
      -- array is never empty. A branch for it could never run, and a check that
      -- cannot fail is worse than no check.
      --
      -- The per-name coalesce is a different case and does stay.
      -- marketplace.name is NOT NULL but not non-empty, and norm() on the
      -- client maps '' to 'Unknown', so dropping it would put a blank value in
      -- the rail. parseCriteria() strips empty strings out of every inbound
      -- URL, so that value could be shown and never selected.
      --
      -- distinct on the NAME, not merely on the id the view already
      -- de-duplicated: two marketplace ids sharing a display name are one
      -- bucket to the app, and without this the asset would be counted twice
      -- under the single value the rail shows.
      (select array_agg(distinct coalesce(nullif(m.name, ''), 'Unknown')
                           order by coalesce(nullif(m.name, ''), 'Unknown'))
         from marketplace m
        where m.id = any(v.marketplace_ids))               as f_sources,
      coalesce(nullif(v.function_category, ''), 'Unknown') as f_function,
      -- provenance and risk are enums (provenance_status, risk_band), so they
      -- need the text cast, and cannot carry the empty string that nullif()
      -- strips from the text columns. Casting inside nullif() instead would
      -- push '' into the enum and fail with 22P02.
      coalesce(v.provenance::text, 'Unknown')              as f_provenance,
      coalesce(v.risk::text, 'Unknown')                    as f_risk,
      coalesce(nullif(v.evidence_tier,     ''), 'Unknown') as f_tier,
      coalesce(nullif(v.delivery,          ''), 'Unknown') as f_delivery,
      coalesce(nullif(v.price_band,        ''), 'Unknown') as f_price
    from v_registry_card v, needle
    where needle.n is null
      -- search_blob is the same nine fields searchBlob() joins on the client,
      -- in the same order, concatenated across every listing of the asset. The
      -- field order that a needle spanning a boundary depends on now lives in
      -- v_registry_card, where the blob is built, rather than in this
      -- predicate: there is one definition of it and this side just matches.
      --
      -- The view lowercases the blob and coalesces it to '', so neither is
      -- repeated here. Restating the lowercasing would paper over a view that
      -- had stopped doing it; the gate asserts search_blob = lower(search_blob)
      -- against the view instead, which is where the fault would actually be.
      or v.search_blob like '%' || needle.n || '%' escape '\'
  ),

  -- One flag per facet group. An empty selection matches everything.
  --
  -- source overlaps rather than equals. && is true when ANY of the asset's
  -- marketplaces is among the selected values, which is the same "or within a
  -- group" rule = any() gives every other facet, lifted to a set on both sides.
  -- Under 1:1 f_sources has one element and the two are the same test.
  matched as (
    select b.*,
      (cardinality(p_source)     = 0 or b.f_sources    && p_source)         as m_source,
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

  -- Rank inside the window function, not in a subquery's ORDER BY: a subquery's
  -- ordering is not contractually preserved by an outer select, so row_number()
  -- over () could number the rows in a different order than they were sorted.
  --
  -- Only the branch matching p_sort/p_dir is non-null; every other branch
  -- evaluates to NULL for all rows and so contributes no ordering. Nulls sort
  -- last in BOTH directions: a missing rating is not a rating of zero and must
  -- never outrank a stated one. asset_id breaks every remaining tie, without
  -- which a row can straddle a page boundary and be shown twice or not at all.
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

  -- The row JSON is built here, for the page, and not up in byq for the whole
  -- registry. Serialising 5,106 rows to return 24 of them cost about a fifth of
  -- this function's total runtime; the join back is by primary key.
  page_cards as (
    select to_jsonb(v) as card, p.rn
    from page p
    join v_registry_card v on v.asset_id = p.asset_id
  ),

  -- Counting each group over `matched` rather than `hits` is what makes a count
  -- self-excluding. The GROUP BY over the whole q-filtered set is also the
  -- seed: a value that a sibling selection has driven to zero still gets a row,
  -- with count 0, so the rail shows "still exists, narrowed away" instead of
  -- dropping it. An absent row is indistinguishable from "never existed".
  counted as (
    -- source unnests before grouping, so an asset on two marketplaces
    -- contributes a row to BOTH counts rather than to one. Counting the array
    -- as a single value instead is the easy half of this change to miss: the
    -- match would already be right, the totals would already be right, and only
    -- the number printed beside each marketplace would be short.
    --
    -- Once assets are multi-listed these counts sum to more than `total`, and
    -- that is correct rather than a discrepancy: the number beside a value
    -- answers "how many products would selecting this show", and one product
    -- can be the answer to two of them. Under 1:1 they still sum to `total`.
    select 'source' as key, src.value as value,
           count(*) filter (where m_function and m_provenance and m_risk and m_tier and m_delivery and m_price) as n
      from matched, unnest(matched.f_sources) as src(value) group by src.value
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

  -- A selected value with no rows anywhere in the q-filtered set still has to
  -- appear, or it vanishes from the rail while active in the URL: the visitor
  -- sees results narrowed by a filter they can neither see nor clear. Zero rows
  -- here; the max() below keeps the real count wherever the value was seeded.
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

-- create or replace keeps the grants a function already has, so this line is
-- inert on production and is the one that creates the privilege on a fresh or
-- branch database. It stays because losing it is loud but total: anon hits
-- 42501 and the registry page has no results at all.
grant execute on function registry_search to anon, authenticated;
