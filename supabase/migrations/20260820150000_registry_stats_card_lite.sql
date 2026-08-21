-- v_registry_stats gets cheaper without changing a single value.
--
-- WHAT CHANGED. v_registry_stats reads four of its nine values from
-- v_registry_card: certified, attested, mean_reach and publishers. Each of
-- those four subqueries re-ran the whole of v_registry_card independently, and
-- v_registry_card is expensive: per asset it joins asset to its primary
-- listing, to the marketplace table, and to capture_extract, runs the cert
-- lateral that picks the qualifying listing, and runs a second aggregate
-- lateral that spans every listing to build last_captured_at, capture_count,
-- marketplace_ids, listing_count and search_blob. The four stats subqueries
-- read none of that second lateral and none of the marketplace join, yet paid
-- for both, four times over. Against the live 12,044-row registry that made a
-- warm read of the view cost ~915 ms and a cold read enough to trip anon's 3s
-- statement_timeout: SQLSTATE 57014 has fired on it three times.
--
-- This migration computes those four scalars from ONE materialised CTE,
-- card_lite, evaluated a single time and then counted and averaged four ways.
-- card_lite keeps the cert lateral verbatim and drops the two things stats
-- never reads: the marketplace join and the all-listings aggregate lateral.
-- The other five values (agents, marketplaces, captures, changes,
-- last_captured_at) keep the exact expressions they already had; they never
-- touched the card and are unchanged here.
--
-- Measured read-only against production (project atevamimariwlpidgvog) at the
-- live 12,044-asset size, by running the new definition under a throwaway name
-- inside a rolled-back transaction:
--   values      to_jsonb(old) = to_jsonb(new) for all nine keys: identical.
--   timing      explain (analyze, timing off), three runs each, warm cache:
--                 old 953.3 / 913.1 / 913.1 ms
--                 new 195.7 / 194.6 / 195.4 ms   (about 4.7x faster)
--   buffers     explain (analyze, buffers): shared hit 639,066 -> 116,892
--                 (about 5.5x fewer, read=0 on both).
--
-- WHY THE TWO REMOVALS CANNOT CHANGE ANY VALUE. card_lite must have exactly the
-- same row set as v_registry_card, one row per non-retired asset, or the four
-- derived numbers could move. It does, because both removed constructs are
-- provably non-filtering:
--
--   1. The marketplace join. v_registry_card joins marketplace m on
--      m.id = l.marketplace_id only to read m.name. listing.marketplace_id is
--      NOT NULL and carries FK listing_marketplace_id_fkey to marketplace(id),
--      so every listing row has exactly one matching marketplace row and the
--      inner join can neither drop a row nor multiply one. card_lite reads no
--      marketplace column (certified, attested, mean_reach and publishers do
--      not depend on marketplace name), so the join is pure cost and is dropped.
--
--   2. The all-listings aggregate lateral. In v_registry_card it is a
--      CROSS JOIN LATERAL over an aggregate query with no GROUP BY, which by
--      definition returns exactly one row for every driving row, so it too can
--      never drop or multiply a row. card_lite reads none of its outputs
--      (last_captured_at, capture_count, marketplace_ids, listing_count,
--      search_blob are not among the four scalars), so it is dropped.
--
-- Removing two constructs that each always contribute exactly one matching row
-- leaves the row set untouched: card_lite is still one row per asset whose
-- primary listing still names it back (the l.asset_id = a.id half of the primary
-- join, which is what excludes retired assets, is kept verbatim). The values
-- proof above confirms it empirically at production scale.
--
-- THE CERT LATERAL IS KEPT DELIBERATELY AND UNCHANGED. Its ORDER BY and LIMIT 1
-- are what pick the qualifying listing, and that pick is what certified,
-- attested and mean_reach are counted and averaged over. Altering the ordering
-- would move those three numbers, so it is reproduced here byte for byte from
-- v_registry_card, including the full seven-column select list (only
-- certification and reach are read, but selecting the rest is harmless and
-- keeps the lateral identical to the card's). Do not touch it.
--
-- GRANTS AND security_invoker. The output column set is identical to the
-- current view (same nine columns, same names, same types, same order), so this
-- create or replace does NOT drop the view: Postgres refuses a shape change
-- outright and performs an in-place redefinition otherwise, which preserves both
-- the anon/authenticated SELECT grants and the reloptions. The grant is
-- reissued below regardless, and (security_invoker = true) is restated in the
-- definition, so the view is correct whether it is redefined in place or, on
-- some future database, genuinely recreated. The tripwire at the end asserts
-- both, in the same shape as 20260819100400_asset_layer_views.sql, so a silent
-- loss of anon SELECT (the class of bug that once took every logo off the site)
-- or of security_invoker (which would run the view as its owner and bypass RLS)
-- fails the migration rather than reaching production.
--
-- v_registry_card itself is NOT touched by this file.

create or replace view v_registry_stats
with (security_invoker = true) as
with card_lite as materialized (
  -- One row per non-retired asset, identical in row set to v_registry_card,
  -- carrying only the columns the four card-derived stats read. The cert
  -- lateral is v_registry_card's, unchanged; the marketplace join and the
  -- all-listings aggregate lateral are dropped as proven non-filtering above.
  select
    a.id            as asset_id,
    x.publisher,
    cert.certification,
    cert.reach
  from asset a
  join listing l         on l.id = a.primary_listing_id and l.asset_id = a.id
  join capture_extract x on x.capture_id = l.current_capture_id
  cross join lateral (
    select x2.certification, x2.provenance, x2.evidence_tier, x2.risk,
           x2.risk_basis, x2.known_layers, x2.reach
      from listing l2
      left join capture_extract x2 on x2.capture_id = l2.current_capture_id
     where l2.asset_id = a.id
     order by case x2.certification
                when 'microsoft_365_certified'::certification_status then 0
                when 'publisher_attestation'::certification_status   then 1
                when 'none'::certification_status                    then 2
                when 'not_eligible'::certification_status            then 3
                else                                                      4
              end,
              (l2.id = a.primary_listing_id) desc,
              l2.id
     limit 1
  ) cert
)
select
  (select count(*) from asset where merged_into is null)              as agents,
  (select count(distinct marketplace_id) from listing)                as marketplaces,
  (select count(distinct asset_id) from card_lite
    where certification = 'microsoft_365_certified')                  as certified,
  (select count(distinct asset_id) from card_lite
    where certification = 'publisher_attestation')                    as attested,
  (select round(avg(reach)) from card_lite)                           as mean_reach,
  (select count(*) from capture)                                      as captures,
  (select count(*) from listing_change)                               as changes,
  (select max(last_captured_at) from listing)                         as last_captured_at,
  -- 'Unknown' is this registry's literal string for "the source did not say",
  -- so it is a publisher we do not know rather than a publisher named Unknown.
  -- The guard is carried over from the prior definition unchanged.
  (select count(distinct publisher) from card_lite
    where publisher is not null
      and btrim(publisher) <> ''
      and publisher <> 'Unknown')                                     as publishers;

grant select on public.v_registry_stats to anon, authenticated;


-- The tripwire. Same shape as the asset-layer view migrations: prove anon and
-- authenticated still hold SELECT, and that the view is still security_invoker.
-- Nothing above drops the view, so nothing here should fire; the block checks
-- the outcome rather than trusting the reasoning.
do $$
begin
  if not has_table_privilege('anon', 'public.v_registry_stats', 'SELECT') then
    raise exception 'anon lost SELECT on v_registry_stats';
  end if;
  if not has_table_privilege('authenticated', 'public.v_registry_stats', 'SELECT') then
    raise exception 'authenticated lost SELECT on v_registry_stats';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'v_registry_stats'
       and coalesce(c.reloptions, '{}') @> array['security_invoker=true']
  ) then
    raise exception 'v_registry_stats is not security_invoker, so RLS would run as the owner';
  end if;
end $$;
