-- Public passport: add the provenance-reach LAYER COUNTS to v_asset_passport_public.
--
-- layers_known and layers_tracked are aggregate counts ("N of M build layers
-- traced"), a top-line verdict signal, NOT the per-layer detail. `reach` (already
-- public) is exactly round(100 * layers_known / layers_tracked), so these two
-- integers expose no information `reach` did not already; they just let the anon
-- passport render the reach ledger legibly instead of a bare percentage. The
-- per-layer `known_layers` ARRAY (which specific layers) stays gated and absent.
--
-- READ privileges only; this only adds two columns to an existing public view.
create or replace view public.v_asset_passport_public as
select
  asset_id, source_product_id, listing_url, marketplace_id, marketplace_name,
  name, publisher, tagline, overview_text,
  surfaces, categories, industries, works_with,
  pricing, acquire_using, support,
  listing_version, listing_updated,
  rating, rating_count, native_rating, native_count,
  external_source, external_rating, external_count,
  certification, cert_label, cert_url,
  function_category, delivery, price_band, price_note,
  reach, provenance, evidence_tier, risk,
  layers_known, layers_tracked,
  plans, product_links, legal_links, media,
  listing_id, last_captured_at, capture_count
from public.v_asset_passport;
alter view public.v_asset_passport_public set (security_invoker = false);

-- Self-assertions: the two counts are now present, and the gated depth columns
-- (including the per-layer known_layers array) remain absent. Catalog-only, safe
-- to run unattended against prod.
do $$
declare v_bad text;
begin
  for v_bad in select c.name from unnest(array['layers_known','layers_tracked']) as c(name)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'v_asset_passport_public'
        and column_name = v_bad
    ) then
      raise exception 'public layer counts: v_asset_passport_public is missing column %', v_bad;
    end if;
  end loop;

  for v_bad in select c.name from unnest(array[
    'evidence','known_layers','risk_basis','graph_permissions','compliance'
  ]) as c(name)
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'v_asset_passport_public'
        and column_name = v_bad
    ) then
      raise exception 'public layer counts: v_asset_passport_public still carries depth column %', v_bad;
    end if;
  end loop;
end $$;
