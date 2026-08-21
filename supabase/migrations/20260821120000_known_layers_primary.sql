-- Return known_layers, layers_known and reach to the PRIMARY listing. Issue #43,
-- resolved as option (b).
--
-- THE PROBLEM. v_registry_card and v_asset_passport resolve the certification
-- group from the QUALIFYING listing (the best certification tier), chosen by the
-- `cert` lateral. Among that group travelled known_layers, layers_known
-- (= cardinality(known_layers)) and reach. But the DISCLOSURE facts the ledger
-- summarises (hosting, data residency, publisher, pricing, plans, access model,
-- support) are read from the PRIMARY listing's extract, joined as `x`. So the
-- layer COUNT described the qualifying listing while the eleven facts it
-- summarises described the primary one. Once an asset has two listings a passport
-- could read "7 of 12 traced" above "Hosting: Unknown". This is the cut component
-- documented in 20260820100000_asset_keyed_views.sql (rule 1) and in
-- docs/asset-layer-phase-2-handoff.md.
--
-- OPTION (b), THE FIX. Move known_layers, layers_known and reach to the PRIMARY
-- listing's extract (the one already inner-joined as `x`), so the ledger count
-- and the disclosure facts it summarises come from the same listing and cannot
-- contradict each other. Everything else in the certification group stays on the
-- qualifying listing (the `cert` lateral), unchanged: certification, cert_label
-- (registry_provenance(cert.certification)), provenance, evidence_tier, risk and
-- risk_basis. risk_basis stays with the qualifying listing and may embed a layer
-- count that differs from the primary's layers_known once the listings differ, so
-- components/PassportView.tsx now ATTRIBUTES risk_basis to its own listing by name
-- whenever the asset has more than one listing. layers_tracked is
-- array_length(registry_layers(), 1), a constant, and is unchanged.
--
-- A PROVABLE NO-OP AT 1:1. Every asset on production has exactly one listing, so
-- the qualifying listing IS the primary listing and cert.known_layers / cert.reach
-- already equal x.known_layers / x.reach for every row. to_jsonb of both views is
-- therefore byte-identical before and after this change for the whole registry.
-- Verified read-only against production (project atevamimariwlpidgvog) by building
-- the new views under temp names in a rolled-back transaction and diffing
-- to_jsonb row by row: zero differing rows on a representative sample and on the
-- full set. The divergence this fix removes is exercised only against a synthetic
-- two-listing asset in the container gate (scripts/gate/11-known-layers.sql), never
-- on production.
--
-- WHAT DOES NOT CHANGE.
--   * ingest_capture and the evidence gate are untouched. known_layers and reach
--     are computed at ingest and stored on capture_extract; this migration only
--     changes which listing's stored value the two VIEWS read. The write path does
--     not move.
--   * v_registry_stats is not recreated here and is unaffected: it reads its own
--     card_lite CTE built from the base tables (20260820180000), not these views,
--     and its reach still comes from its own cert lateral (the qualifying listing).
--   * The `cert` lateral is reproduced BYTE FOR BYTE, ordering and select list
--     included, so the certification group's other members and the resolver
--     v_registry_stats and the gate replicate stay in step. cert.known_layers and
--     cert.reach are now unreferenced by the outer select; they are left in the
--     lateral so it remains identical to its siblings rather than pruned into a
--     third, subtly different shape.
--   * Column names, types, positions and count are unchanged in both views, so
--     create or replace redefines in place, the anon/authenticated grants and the
--     security_invoker option survive, and the tripwire below has nothing to fire
--     on. The grants are reissued and security_invoker restated regardless.


-- v_registry_card ------------------------------------------------------------
--
-- Reproduced from 20260820170000_slug_fallback_chain.sql (the definition that
-- appended canonical_slug), with exactly three source changes and nothing else:
--   cert.reach          -> x.reach
--   cert.known_layers   -> x.known_layers
--   cardinality(cert.known_layers) -> cardinality(x.known_layers)
-- All three now read the PRIMARY listing's extract `x`
-- (join capture_extract x on x.capture_id = l.current_capture_id).

create or replace view v_registry_card
with (security_invoker = true) as
select
  a.id                                   as asset_id,
  l.source_product_id,
  l.listing_url,
  l.marketplace_id,
  m.name                                 as marketplace_name,
  agg.last_captured_at,
  agg.capture_count,
  x.name, x.publisher, x.tagline,
  x.function_category, x.delivery, x.surfaces,
  x.rating, x.rating_count, x.external_source, x.external_rating,
  cert.certification,
  registry_provenance(cert.certification) ->> 'label' as cert_label,
  cert.provenance, cert.evidence_tier,
  x.reach, cert.risk, cert.risk_basis,
  x.price_band, x.price_note,
  x.listing_version, x.listing_updated,
  x.known_layers,
  cardinality(x.known_layers)            as layers_known,
  array_length(registry_layers(), 1)     as layers_tracked,
  l.id                                   as listing_id,
  agg.marketplace_ids,
  agg.listing_count,
  agg.search_blob,
  -- The asset's canonical URL slug, appended for phase 2 task 45. One row per
  -- asset by the partial unique index asset_slug_one_canonical, so this scalar
  -- subquery cannot multiply the card. The grid links /agent/ from this rather
  -- than from source_product_id, so an asset that fell to a fallback slug is
  -- reachable at the URL it actually answers to instead of at another asset's.
  (select s.slug from asset_slug s where s.asset_id = a.id and s.is_canonical)
                                         as canonical_slug
from asset a
join listing l         on l.id = a.primary_listing_id and l.asset_id = a.id
join marketplace m     on m.id = l.marketplace_id
join capture_extract x on x.capture_id = l.current_capture_id
-- The qualifying listing. One row, one ordering, and every field in the
-- certification group is read off it, so the group cannot come apart. See rule
-- 1 at the top of 20260820100000_asset_keyed_views.sql. The ordering is total,
-- because l2.id breaks every remaining tie, so this picks the same listing on
-- every execution rather than whichever one the planner happened to reach first.
--
-- The join to capture_extract is LEFT so a listing with no capture yet can
-- still be ranked, but the row this picks always has one: a listing without an
-- extract ranks last at cert_rank 4, and the inner join above proves the
-- primary listing has an extract, so there is always a better candidate.
--
-- known_layers and reach are selected here for byte-for-byte parity with the
-- resolver v_registry_stats and the gate replicate use; the outer select now
-- reads them from the PRIMARY listing's `x` instead (issue #43, option (b)), so
-- cert.known_layers and cert.reach are deliberately unreferenced. The remaining
-- certification-group members (certification, provenance, evidence_tier, risk,
-- risk_basis) still come off this single qualifying row.
cross join lateral (
  select x2.certification, x2.provenance, x2.evidence_tier, x2.risk, x2.risk_basis,
         x2.known_layers, x2.reach
    from listing l2
    left join capture_extract x2 on x2.capture_id = l2.current_capture_id
   where l2.asset_id = a.id
   order by case x2.certification
              when 'microsoft_365_certified' then 0
              when 'publisher_attestation'   then 1
              when 'none'                    then 2
              when 'not_eligible'            then 3
              else                                4   -- no extract, so nothing stated
            end,
            (l2.id = a.primary_listing_id) desc,
            l2.id
   limit 1
) cert
cross join lateral (
  select
    max(l2.last_captured_at)                                as last_captured_at,
    sum(l2.capture_count)::integer                          as capture_count,
    count(*)::integer                                       as listing_count,
    -- Every marketplace the product is listed on, sorted and de-duplicated.
    -- Two listings CAN share a marketplace: the uniqueness constraint is on
    -- (marketplace_id, source_product_id), so one marketplace publishing the
    -- same product under two ids and a merge joining them is allowed. A
    -- repeated id in this array would be noise in a source facet, so distinct.
    array_agg(distinct m2.id order by m2.id)                as marketplace_ids,
    -- search_blob: the same nine fields, in the same order, as searchBlob() in
    -- lib/registry-query.ts and as registry_search's own concat_ws, but
    -- concatenated across EVERY listing of the asset rather than one.
    --
    -- That span is the point of it. A product whose AWS description names vLLM
    -- and whose Microsoft page does not must still answer a search for vLLM;
    -- picking one listing's text would be exactly the flattening this whole
    -- layer exists to prevent.
    --
    -- nullif('') on each field because JS .filter(Boolean) drops empty strings
    -- where concat_ws drops only nulls. Without it an empty field leaves a
    -- double space here that the client never produced, and a needle spanning
    -- a field boundary stops matching on one surface and not the other.
    --
    -- The case guard keeps a listing with no current capture out of the blob
    -- entirely. Without it such a listing would still contribute its
    -- marketplace name and a "No attestation published" label from
    -- registry_provenance(null), which is text no marketplace ever published.
    --
    -- Each listing contributes its OWN cert label here, not the qualifying
    -- listing's. This is a search index over what the marketplaces published,
    -- one entry per page, and it is the one place in these views where the
    -- certification group deliberately does not resolve to a single listing:
    -- a visitor searching for the words on the AWS page should find the
    -- product whether or not the Microsoft page carries the same words.
    --
    -- coalesce to '' rather than leaving null, so a search predicate over this
    -- column never has to reason about three-valued logic.
    coalesce(string_agg(
      case when x2.capture_id is null then null else
        nullif(lower(concat_ws(' ',
          nullif(x2.name, ''),
          nullif(x2.publisher, ''),
          nullif(x2.function_category, ''),
          nullif(x2.tagline, ''),
          nullif(m2.name, ''),
          nullif(x2.evidence_tier, ''),
          nullif(x2.delivery, ''),
          nullif(registry_provenance(x2.certification) ->> 'label', ''),
          nullif(array_to_string(x2.surfaces, ' '), '')
        )), '')
      end,
      ' ' order by (l2.id = a.primary_listing_id) desc, m2.name, l2.id), '') as search_blob
  from listing l2
  join marketplace m2          on m2.id = l2.marketplace_id
  -- LEFT, so listing_count and marketplace_ids count a listing that has no
  -- capture yet. The card's own columns come from the primary listing, which
  -- the inner join above proves has one.
  left join capture_extract x2 on x2.capture_id = l2.current_capture_id
  where l2.asset_id = a.id
) agg;

comment on view v_registry_card is
  'One row per product at its primary listing''s latest capture, sized for the registry grid. asset_id is the product; listing_id is the listing the headline fields came from. last_captured_at, capture_count, marketplace_ids, listing_count and search_blob span every listing of the product; known_layers, layers_known and reach come from the PRIMARY listing (issue #43, option b), so the layer count agrees with the disclosure facts it summarises; certification, cert_label, provenance, evidence_tier, risk and risk_basis come from the qualifying listing, which need not be the primary one. Does not carry overview text. canonical_slug is the asset''s canonical URL slug, what the grid links /agent/ from.';

grant select on public.v_registry_card to anon, authenticated;


-- v_asset_passport -----------------------------------------------------------
--
-- Reproduced from 20260820100000_asset_keyed_views.sql, with exactly three
-- source changes and nothing else:
--   cert.known_layers   -> x.known_layers
--   cardinality(cert.known_layers) -> cardinality(x.known_layers)
--   cert.reach          -> x.reach
-- All three now read the PRIMARY listing's extract `x`
-- (join capture_extract x on x.capture_id = c.id, where c is the primary
-- listing's current capture).

create or replace view v_asset_passport
with (security_invoker = true) as
select
  a.id                                   as asset_id,
  l.source_product_id,
  l.listing_url,
  l.marketplace_id,
  m.name                                 as marketplace_name,
  agg.first_seen_at, agg.last_captured_at, agg.capture_count,
  c.id                                   as capture_id,
  c.captured_at, c.capture_complete, c.missing, c.ingest_source,
  x.name, x.publisher, x.tagline, x.overview_text,
  x.surfaces, x.categories, x.industries, x.works_with,
  x.pricing, x.acquire_using, x.support,
  x.listing_version, x.listing_updated,
  x.rating, x.rating_count, x.native_rating, x.native_count,
  x.external_source, x.external_rating, x.external_count,
  cert.certification,
  registry_provenance(cert.certification) ->> 'label' as cert_label,
  x.cert_url, x.cert_hosting, x.cert_data_location, x.cert_data_handling,
  x.cert_developer_updated, x.cert_page_updated,
  x.function_category, x.delivery, x.price_band, x.price_note,
  x.known_layers, cardinality(x.known_layers) as layers_known,
  array_length(registry_layers(), 1)          as layers_tracked,
  x.reach, cert.provenance, cert.evidence_tier, cert.risk, cert.risk_basis,
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
  l.id                                        as listing_id,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'listing_id', l2.id,
            'marketplace_id', l2.marketplace_id,
            'marketplace_name', m2.name,
            'source_product_id', l2.source_product_id,
            'listing_url', l2.listing_url,
            'is_primary', l2.id = a.primary_listing_id,
            'last_captured_at', l2.last_captured_at,
            'pricing', x2.pricing,
            'certification', x2.certification,
            'rating', x2.rating,
            'categories', to_jsonb(x2.categories))
          order by (l2.id = a.primary_listing_id) desc, m2.name), '[]'::jsonb)
     from listing l2
     join marketplace m2 on m2.id = l2.marketplace_id
     join capture_extract x2 on x2.capture_id = l2.current_capture_id
    where l2.asset_id = a.id)                 as listings
from asset a
join listing l         on l.id = a.primary_listing_id and l.asset_id = a.id
join marketplace m     on m.id = l.marketplace_id
join capture c         on c.id = l.current_capture_id
join capture_extract x on x.capture_id = c.id
-- The qualifying listing, written identically to the card's, for the same
-- reason. See rule 1 at the top of 20260820100000_asset_keyed_views.sql.
-- known_layers and reach are selected here for parity with the card and the
-- v_registry_stats replicate; the outer select reads them from the PRIMARY
-- listing's `x` instead (issue #43, option (b)), leaving cert.known_layers and
-- cert.reach unreferenced. certification, provenance, evidence_tier, risk and
-- risk_basis still come off this single qualifying row.
cross join lateral (
  select x2.certification, x2.provenance, x2.evidence_tier, x2.risk, x2.risk_basis,
         x2.known_layers, x2.reach
    from listing l2
    left join capture_extract x2 on x2.capture_id = l2.current_capture_id
   where l2.asset_id = a.id
   order by case x2.certification
              when 'microsoft_365_certified' then 0
              when 'publisher_attestation'   then 1
              when 'none'                    then 2
              when 'not_eligible'            then 3
              else                                4   -- no extract, so nothing stated
            end,
            (l2.id = a.primary_listing_id) desc,
            l2.id
   limit 1
) cert
-- The dates and counts need nothing but listing, so this one does not touch
-- capture_extract at all.
cross join lateral (
  select
    min(l2.first_seen_at)          as first_seen_at,
    max(l2.last_captured_at)       as last_captured_at,
    sum(l2.capture_count)::integer as capture_count
  from listing l2
  where l2.asset_id = a.id
) agg;

comment on view v_asset_passport is
  'Everything the agent passport renders, one row per product. The headline fields come from the primary listing''s latest capture; the dates and counts span every listing; known_layers, layers_known and reach come from the PRIMARY listing (issue #43, option b), so the layer ledger agrees with the disclosure rows it summarises; certification, cert_label, provenance, evidence_tier, risk and risk_basis come from the qualifying listing, which need not be the primary one. risk_basis may therefore state a layer count belonging to the qualifying listing rather than the primary one; PassportView attributes it to its listing by name when the asset has more than one listing. listings carries one entry per marketplace with the four fields marketplaces are allowed to disagree about. evidence carries verified rows only.';

grant select on public.v_asset_passport to anon, authenticated;


-- The tripwire ----------------------------------------------------------------
--
-- Same block the asset-keyed view migrations carry, scoped to the two views this
-- file recreates. Neither is dropped (a column-compatible create or replace
-- redefines in place), so nothing here should fire; the block checks the outcome
-- rather than trusting that reasoning. It catches the one shape Postgres does not:
-- a drop-and-recreate that forgets to re-grant.
do $$
declare missing text;
begin
  select string_agg(format('%s -> %s', v, r), ', ') into missing
    from (values ('v_registry_card'),('v_asset_passport')) as views(v)
    cross join (values ('anon'),('authenticated')) as roles(r)
   where not has_table_privilege(r, 'public.' || v, 'SELECT');
  if missing is not null then
    raise exception 'grants missing after view replacement: %', missing;
  end if;
end $$;

do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('v_registry_card','v_asset_passport')
     and not coalesce(c.reloptions, '{}') @> array['security_invoker=true'];
  if bad is not null then
    raise exception 'views are not security_invoker, so RLS runs as the owner: %', bad;
  end if;
end $$;
