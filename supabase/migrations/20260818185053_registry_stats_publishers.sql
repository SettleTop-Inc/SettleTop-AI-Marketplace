-- Add a publisher count to v_registry_stats.
--
-- The front page's proof strip states how many distinct publishers the
-- registry holds. That number has to come from the same view every other
-- consumer reads, not from a second query the site invents for itself --
-- derived values have exactly one definition.
--
-- publishers is appended last on purpose: create or replace view can add
-- columns at the end but cannot insert one in the middle, so the eight
-- existing columns keep their positions and nothing downstream shifts.

create or replace view v_registry_stats
with (security_invoker = true) as
select
  (select count(*) from asset)                                        as agents,
  (select count(distinct marketplace_id) from asset)                  as marketplaces,
  (select count(*) from v_registry_card
    where certification = 'microsoft_365_certified')                  as certified,
  (select count(*) from v_registry_card
    where certification = 'publisher_attestation')                    as attested,
  (select round(avg(reach)) from v_registry_card)                     as mean_reach,
  (select count(*) from capture)                                      as captures,
  (select count(*) from asset_change)                                 as changes,
  (select max(last_captured_at) from asset)                           as last_captured_at,
  -- 'Unknown' is this registry's literal string for "the source did not say",
  -- so it is a publisher we do not know rather than a publisher named Unknown.
  -- No row carries it today; the guard is here so the count stays a count of
  -- real publishers on the day one does.
  (select count(distinct publisher) from v_registry_card
    where publisher is not null
      and btrim(publisher) <> ''
      and publisher <> 'Unknown')                                     as publishers;

grant select on v_registry_stats to anon, authenticated;
