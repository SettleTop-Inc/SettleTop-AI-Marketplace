-- Server-side registry search: one round trip returns the page of rows, all
-- seven facet groups and the total.
--
-- Why this is a function rather than a PostgREST query. Filtering, sorting and
-- paging are all expressible over v_registry_card directly. Facet counts are
-- not: PostgREST has no GROUP BY, and these counts are self-excluding — each
-- group is counted with its own selection removed, so a count reads as "what
-- selecting this adds" rather than printing 0 beside every unselected sibling.
-- They cannot be precomputed either, because they depend on the current
-- selection. Without this function the client would need one count request per
-- facet value.
--
-- This is the SQL half of a contract whose reference implementation is
-- runQuery() in lib/marketplace-query.ts. The two are checked against each
-- other over live data by test/registry-search-parity.test.mjs. Change the
-- semantics in one and you must change the other, or that test fails.

-- Matches Intl.Collator("en", { sensitivity: "base", numeric: true }), which
-- orders agent names and facet values on the client: ks-level1 ignores case
-- and accents, kn-true makes "Agent 10" sort after "Agent 9" rather than
-- before it. Without this, Postgres and JavaScript disagree about ordering and
-- which page a row lands on depends on which of them produced the list.
do $$
begin
  create collation registry_name_ci (
    provider = icu, locale = 'en-u-ks-level1-kn-true', deterministic = false
  );
exception
  when duplicate_object then null;
end
$$;

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
  needle as (
    select case
      when nullif(btrim(p_q), '') is null then null
      else replace(replace(replace(lower(btrim(p_q)),
             '\', '\\'), '%', '\%'), '_', '\_')
    end as n
  ),

  -- Everything matching the free-text query, with each facet's value
  -- normalised once. null, the empty string and the literal 'Unknown' are one
  -- bucket, exactly as norm() in marketplace-query.ts collapses them — a third
  -- spelling means the rail offers a value the filter can never match.
  byq as (
    select
      v.asset_id, v.name, v.reach, v.rating, v.last_captured_at,
      coalesce(nullif(v.marketplace_name,  ''), 'Unknown') as f_source,
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
      -- The same nine fields in the same order as searchBlob(), so a needle
      -- spanning a field boundary behaves identically on both surfaces.
      -- nullif('') on each because JS .filter(Boolean) drops empty strings
      -- where concat_ws drops only nulls — otherwise an empty field leaves a
      -- double space here that the client never produced.
      or lower(concat_ws(' ',
           nullif(v.name, ''), nullif(v.publisher, ''),
           nullif(v.function_category, ''), nullif(v.tagline, ''),
           nullif(v.marketplace_name, ''), nullif(v.evidence_tier, ''),
           nullif(v.delivery, ''), nullif(v.cert_label, ''),
           nullif(array_to_string(v.surfaces, ' '), '')
         )) like '%' || needle.n || '%' escape '\'
  ),

  -- One flag per facet group. An empty selection matches everything.
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

  -- Rank inside the window function, not in a subquery's ORDER BY: a subquery's
  -- ordering is not contractually preserved by an outer select, so row_number()
  -- over () could number the rows in a different order than they were sorted.
  --
  -- Only the branch matching p_sort/p_dir is non-null; every other branch
  -- evaluates to NULL for all rows and so contributes no ordering. Nulls sort
  -- last in BOTH directions — a missing rating is not a rating of zero and must
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
  -- dropping it — an absent row is indistinguishable from "never existed".
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

comment on function registry_search is
  'One page of the registry with self-excluding facet counts and the total, in a single call. Reference implementation: runQuery() in lib/marketplace-query.ts; parity is tested.';

grant execute on function registry_search to anon, authenticated;
