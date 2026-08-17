-- Read surface for the app. security_invoker so RLS still applies through them.

create or replace view v_registry_card
with (security_invoker = true) as
select
  a.id                                   as asset_id,
  a.source_product_id,
  a.listing_url,
  a.marketplace_id,
  m.name                                 as marketplace_name,
  a.last_captured_at,
  a.capture_count,
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
  array_length(registry_layers(), 1)     as layers_tracked
from asset a
join marketplace m       on m.id = a.marketplace_id
join capture_extract x   on x.capture_id = a.current_capture_id;

comment on view v_registry_card is
  'One row per asset at its latest capture, sized for the registry grid. Does not carry overview text.';

create or replace view v_asset_passport
with (security_invoker = true) as
select
  a.id                                   as asset_id,
  a.source_product_id,
  a.listing_url,
  a.marketplace_id,
  m.name                                 as marketplace_name,
  a.first_seen_at, a.last_captured_at, a.capture_count,
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
  (select coalesce(jsonb_agg(jsonb_build_object('label', l.label, 'url', l.url)
          order by l.position), '[]'::jsonb)
     from capture_link l where l.capture_id = c.id and l.kind = 'product')  as product_links,
  (select coalesce(jsonb_agg(jsonb_build_object('label', l.label, 'url', l.url)
          order by l.position), '[]'::jsonb)
     from capture_link l where l.capture_id = c.id and l.kind = 'legal')    as legal_links,
  (select coalesce(jsonb_agg(l.url order by l.position), '[]'::jsonb)
     from capture_link l where l.capture_id = c.id and l.kind = 'media')    as media,
  (select coalesce(array_agg(q.permission order by q.permission), '{}')
     from capture_permission q where q.capture_id = c.id)           as graph_permissions,
  (select coalesce(array_agg(k.certification order by k.certification), '{}')
     from capture_compliance k where k.capture_id = c.id)           as compliance
from asset a
join marketplace m     on m.id = a.marketplace_id
join capture c         on c.id = a.current_capture_id
join capture_extract x on x.capture_id = c.id;

comment on view v_asset_passport is
  'Everything the agent passport renders, at the latest capture. evidence carries verified rows only.';

create or replace view v_asset_change_feed
with (security_invoker = true) as
select
  ch.id, ch.asset_id, a.source_product_id, x.name, x.publisher,
  ch.field, ch.old_value, ch.new_value, ch.observed_at
from asset_change ch
join asset a           on a.id = ch.asset_id
join capture_extract x on x.capture_id = a.current_capture_id
order by ch.observed_at desc, ch.id desc;

comment on view v_asset_change_feed is
  'What moved, newest first. The reason this is a provenance registry and not a directory.';

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
  (select max(last_captured_at) from asset)                           as last_captured_at;

grant select on v_registry_card, v_asset_passport, v_asset_change_feed, v_registry_stats
  to anon, authenticated;;