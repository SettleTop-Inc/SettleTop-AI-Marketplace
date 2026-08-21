-- v_registry_stats: exclude retired (merged) assets from the card-derived
-- scalars, so all nine values agree on what a live asset is. Issue #44.
--
-- WHAT CHANGED. One line: card_lite gains `where a.merged_into is null`. Nothing
-- else in the view moves. The cert lateral, the nine scalars, the publisher
-- guard, the reloptions and the grant are the 20260820150000 definition byte for
-- byte; only the CTE's row set is narrowed to live assets.
--
-- WHY. v_registry_stats has nine scalar values. `agents` is
-- `count(*) from asset where merged_into is null`, so it already excludes a
-- retired asset. Four others read from card_lite: `certified`, `attested`,
-- `mean_reach` and `publishers`. Before this migration card_lite did NOT filter
-- merged_into, so those four counted an asset that `agents` did not.
--
-- Today that gap is invisible, because production carries zero retired assets
-- (select count(*) from asset where merged_into is not null is 0), so card_lite
-- and `agents` range over the same 12,044 assets and every value is unchanged by
-- this guard. Measured read-only against production (project atevamimariwlpidgvog)
-- by computing the guarded definition beside the live view: to_jsonb(old) is
-- identical to to_jsonb(new) for all nine keys.
--
-- The gap becomes a self-contradiction the first time an asset is retired
-- WITHOUT its listings being relocated: a merge that sets asset.merged_into but
-- leaves the asset's primary listing still pointing back at it. `agents` drops
-- that asset; the unguarded card_lite keeps it, because its
-- `join listing l on l.id = a.primary_listing_id and l.asset_id = a.id` still
-- matches. `certified + attested` would then exceed `agents`, the front page
-- would count an agent it also says does not exist, and no row-count assertion
-- would see it: the view returns one row either way. The guard makes the
-- exclusion structural: all four card-derived scalars now range over exactly the
-- assets `agents` counts, and `certified + attested <= agents` holds by
-- construction rather than by luck.
--
-- WHY THE JOIN IS NOT ENOUGH HERE, THOUGH IT IS FOR v_registry_card. The asset
-- keyed views (20260820100000) deliberately carry NO merged_into filter and lean
-- on that same primary-listing join to drop retired assets: after a PROPER merge
-- relocates a retired asset's listings, the listing no longer names the asset
-- back, `l.asset_id = a.id` fails, and the row drops on its own. That reasoning
-- holds only while the listings actually move. A partial merge is exactly the
-- case where they do not, so the join keeps matching and the filter is the only
-- thing left to drop the asset. card_lite counts the asset table for `agents`
-- directly and already filters merged_into there; this migration simply extends
-- the same filter to the CTE so the two halves of the view cannot disagree.
--
-- TWO ROUTES, THIS IS THE GUARD ONE. #44 can be closed two ways and both are
-- wanted. This migration is the GUARD route: the view refuses to count a retired
-- asset no matter how it was retired, so a partial or hand-written merge cannot
-- make the numbers lie. The CONSTRAINT route, making merge_assets relocate the
-- listings so a partial merge cannot exist in the first place, is #63's job and
-- lives in merge_assets, not here. The guard is deliberately kept even once the
-- constraint lands: it costs nothing at zero retired assets and it is the
-- backstop for any future write path that sets merged_into directly.
--
-- THE CERT LATERAL IS UNCHANGED. Its ORDER BY and LIMIT 1 pick the qualifying
-- listing that certified, attested and mean_reach are counted and averaged over.
-- It is reproduced from 20260820150000 byte for byte, including the full
-- seven-column select list. Do not touch it.
--
-- GRANTS AND security_invoker. The output column set is identical to the current
-- view (same nine columns, same names, same types, same order), so this
-- create or replace does NOT drop the view: Postgres refuses a shape change and
-- redefines in place otherwise, which preserves the anon/authenticated SELECT
-- grants and the reloptions. The grant is reissued regardless, and
-- (security_invoker = true) is restated, so the view is correct whether it is
-- redefined in place or genuinely recreated. The tripwire at the end asserts
-- both, so a silent loss of anon SELECT or of security_invoker fails the
-- migration rather than reaching production.
--
-- v_registry_card itself is NOT touched by this file.

create or replace view v_registry_stats
with (security_invoker = true) as
with card_lite as materialized (
  -- One row per LIVE asset: identical in shape to v_registry_card, carrying only
  -- the columns the four card-derived stats read, and now filtered to
  -- non-retired assets so those stats exclude a merged asset exactly as `agents`
  -- does. The cert lateral is v_registry_card's, unchanged.
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
  where a.merged_into is null
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
