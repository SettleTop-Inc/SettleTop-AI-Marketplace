-- The read surface becomes asset keyed.
--
-- Phase 1 put an asset above listing and left every view keyed by listing,
-- which is correct only while the two are 1:1. This migration turns the grain
-- over. v_registry_card and v_asset_passport are now one row per product,
-- sourced from that product's primary listing except where a field has to be
-- an aggregate over all of them. Two new views carry what that aggregation
-- would otherwise destroy: v_listing_passport is one row per listing,
-- unaggregated, and v_asset_evidence is one row per capture, keyed by asset.
--
-- Assets and listings are still 1:1 everywhere, so every number this migration
-- produces is identical to the number the same view produced yesterday. That
-- is the point, and it is also the limit: the grain change is provable now
-- precisely because the data cannot yet tell the two grains apart, and the
-- rules that only differ under multiple listings are unprovable for the same
-- reason. Each of those is called out where it appears.
--
-- APPEND ONLY, again. create or replace view accepts a new source for an
-- existing column and refuses a new name, a new type or a new position:
--
--   ERROR:  cannot change name of view column "x" to "y"
--
-- v_registry_card has 32 columns and v_asset_passport has 61. Every one of
-- them comes through this file unmoved; three are appended to the card and one
-- to the passport, all at the end. One trap in particular: capture_count is
-- integer on listing and sum() returns bigint, so the aggregate is cast back
-- to integer, or the replace is refused for a type change rather than a name
-- change. count(*) is the same story.
--
-- Grants sit immediately after each view, because a column compatible replace
-- keeps the grants a view already had and a drop does not, and the drop is the
-- statement anyone wanting a different column shape has to write for
-- themselves. The assertion at the end of the file now covers all seven views
-- rather than the five phase 1 knew about.
--
-- Retired assets. A merge moves a retired asset's listings to the surviving
-- asset, and asset.primary_listing_id is a plain column with nothing keeping it
-- in step, so a retired asset can still point at a listing that now belongs to
-- somebody else. Every asset keyed view below therefore joins
--
--   join listing l on l.id = a.primary_listing_id and l.asset_id = a.id
--
-- and the second half of that condition is what excludes retired assets: once
-- the listing has moved, it no longer names this asset back, and the row drops.
-- No merged_into filter is needed and none is written, which matters because a
-- merged_into filter would be a second, independent statement of the same rule
-- that could drift out of step with the listings themselves. v_registry_stats
-- keeps its own merged_into filter because it counts the asset table directly
-- and never goes through a listing.
--
-- The alias l is the primary listing, l2 is every listing of the asset, and
-- lnk is capture_link, exactly as in the phase 1 file.


-- Two rules shared by both asset keyed views ---------------------------------
--
-- 1. THE QUALIFYING LISTING, and the whole group of fields that comes from it.
--
--    certification resolves as ANY listing, not the primary one. If one
--    marketplace certifies a product and another does not, the product is
--    certified; that is already what v_registry_stats.certified says with its
--    count(distinct asset_id), and the card and the passport now agree with it.
--
--    Everything derived from certification comes from that SAME listing, and
--    this file guarantees it structurally rather than clerically. The `cert`
--    lateral in each view selects the qualifying listing once, with one
--    ordering and limit 1, and every certification-derived column is read off
--    that single row. There is no list to keep in step by hand: a field that
--    belongs to the group is added to that one select list, and it then cannot
--    come from a different listing than its siblings. The first draft of this
--    file expressed the same pick as four independent ordered aggregates, and
--    that shape is exactly what let risk_basis be left out of the group with
--    nothing noticing.
--
--    THE MEMBERSHIP RULE. Three attempts stated it as a downstream cone and
--    each was short by whatever sat one derivation further out, so it is stated
--    here as a connected component instead:
--
--      Take the relation "is a function of" over this view's columns and treat
--      it as UNDIRECTED. The certification group is the connected component
--      containing certification. A column belongs in this lateral if it is
--      computed from something in the component OR if something in the
--      component is computed from it. layers_tracked is outside, because it is
--      a constant from registry_layers() and describes no listing at all.
--
--    Direction is the whole point of that phrasing, and the reason is in the
--    next section. A downstream test asks "is this computed from the
--    certification", which is the question that admitted risk_basis, then
--    known_layers, then reach, one round at a time. The undirected test also
--    asks "does the certification's group summarise this", which is the
--    question none of those three rounds asked.
--
--    Applying it, the nine columns this lateral carries:
--
--    certification    the seed of the component.
--    provenance       registry_provenance(certification) ->> 'provenance'
--    evidence_tier    registry_provenance(certification) ->> 'tier'
--    cert_label       registry_provenance(certification) ->> 'label',
--                     computed in the view rather than stored.
--    risk             registry_risk(certification, n_layers) ->> 'risk'
--    risk_basis       registry_risk(certification, n_layers) ->> 'basis'
--    known_layers     three of its twelve entries exist only where there is a
--                     certification page to read them off.
--    layers_known     cardinality(known_layers)
--    reach            round(100.0 * cardinality(known_layers) / 12)
--
--    registry_cert_only_layers() names hosting, data residency and permission
--    scope; ingest_capture reads the first two out of cert_detail and gates the
--    third on the certification itself; and registry_risk() subtracts exactly
--    those three when working out how much of the build an uncertified listing
--    could possibly have disclosed, which is why one seed listing reads "3 of
--    9" and the other "7 of 12".
--
--
--    THE COMPONENT IS CURRENTLY CUT, AND THAT IS THE OPEN QUESTION OF THIS
--    PHASE. Read this before adding a column to either side.
--
--    known_layers is not a source. It is a twelve-entry summary of twelve
--    facts, and ELEVEN of those twelve are exact functions of columns these
--    views still take from the primary listing:
--
--      vendor identity   publisher
--      model             capture_evidence, kind 'model', verified
--      framework         capture_evidence, kind 'framework', verified
--      tools and MCP     capture_evidence kind 'tool_mcp', or capture_permission
--      data sources      capture_evidence, kind 'data_source', verified
--      integrations      capture_evidence kind 'integration', or works_with
--      hosting           cert_hosting
--      data residency    cert_data_location
--      pricing           pricing, or capture_plan
--      access model      acquire_using
--      support channel   support
--
--    Only the twelfth, permission scope, is a function of the certification and
--    travelled into this lateral with it. So the layer COUNT now describes the
--    qualifying listing while the eleven facts it summarises describe the
--    primary one, and the undirected rule above is what names that as a cut
--    rather than as a boundary.
--
--    Under two listings the passport can therefore draw a ledger reading "7 of
--    12 traced" and 58 percent directly above "Hosting: Unknown", "Data
--    residency: Unknown", no framework and no plans. That is the same
--    contradiction reach was moved to fix, over eleven columns instead of one.
--    Reproduced against a container, not predicted: a synthetic two-listing
--    asset returns layers_known 7 and reach 58 beside a null cert_hosting, a
--    null cert_data_location, a null acquire_using, a null support, one
--    evidence kind and zero plans.
--
--    NOTHING TODAY IS WRONG. Assets and listings are 1:1, the qualifying
--    listing is the primary listing, and every column above is that one
--    listing's own. What is wrong is the rule somebody will apply next.
--
--    It is deliberately not closed here, because closing it means choosing
--    between two options that have never been compared against a real merged
--    asset, and that comparison belongs to phase 3 with one in front of it:
--
--      (a) Move the whole disclosure block into this lateral: publisher,
--          cert_hosting, cert_data_location, acquire_using, support,
--          works_with, pricing, plans and the evidence subquery. The passport
--          then describes the qualifying listing almost entirely, and the
--          primary listing supplies little more than the name and the URL.
--
--      (b) Return known_layers, layers_known and reach to the primary listing
--          and accept that risk_basis states a layer count belonging to a
--          different listing, ATTRIBUTED as such in the sentence rather than
--          left to look like the ledger's own number.
--
--    Whichever is chosen, the choice is between two coherent things. What must
--    not survive phase 3 is the present arrangement, which is neither.
--
--
--    Two things are outside the component and neither is an oversight.
--
--    layers_tracked is array_length(registry_layers(), 1), a constant twelve.
--    It is not computed from any listing, so no listing can disagree about it.
--
--    search_blob takes each listing's OWN cert label rather than the
--    qualifying listing's. It is a search index over what the marketplaces
--    published, one entry per page, so resolving it to a single listing would
--    lose the words the other pages carry. It is commented where it is built.
--
--    v_listing_passport applies none of this: it resolves nothing, because its
--    whole job is to report one marketplace unresolved.
--
--    ALL OF THIS IS UNTESTABLE TODAY AND DELIBERATELY SO. Under 1:1 every
--    asset has exactly one listing, so "any listing" and "the primary listing"
--    select the same row and no assertion anywhere can tell the two rules
--    apart. It is written this way because that is the rule; a passing check
--    today is not evidence that it is right. Phase 3, which is what first gives
--    an asset two listings, is the earliest point at which it can be proved.
--
-- 2. The counts and dates aggregate: last_captured_at is the max across the
--    asset's listings, capture_count the sum, first_seen_at the min. A product
--    was first seen when the earliest marketplace first showed it, and it was
--    last captured when the most recent capture of any of its listings landed.


-- v_registry_card ------------------------------------------------------------
--
-- Appends marketplace_ids, listing_count and search_blob, in that order.
--
-- No separate uuid column for the asset is added. asset_id has held the
-- asset's own uuid since phase 1, so a second one would be the same value under
-- a different name.

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
  cert.reach, cert.risk, cert.risk_basis,
  x.price_band, x.price_note,
  x.listing_version, x.listing_updated,
  cert.known_layers,
  cardinality(cert.known_layers)         as layers_known,
  array_length(registry_layers(), 1)     as layers_tracked,
  l.id                                   as listing_id,
  agg.marketplace_ids,
  agg.listing_count,
  agg.search_blob
from asset a
join listing l         on l.id = a.primary_listing_id and l.asset_id = a.id
join marketplace m     on m.id = l.marketplace_id
join capture_extract x on x.capture_id = l.current_capture_id
-- The qualifying listing. One row, one ordering, and every field in the
-- certification group is read off it, so the group cannot come apart. See rule
-- 1 at the top of this file. The ordering is total, because l2.id breaks every
-- remaining tie, so this picks the same listing on every execution rather than
-- whichever one the planner happened to reach first.
--
-- The join to capture_extract is LEFT so a listing with no capture yet can
-- still be ranked, but the row this picks always has one: a listing without an
-- extract ranks last at cert_rank 4, and the inner join above proves the
-- primary listing has an extract, so there is always a better candidate.
-- known_layers and reach therefore come back as the not-null columns the table
-- declares rather than as nulls, and cardinality() of the array is a real
-- count.
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
  'One row per product at its primary listing''s latest capture, sized for the registry grid. asset_id is the product; listing_id is the listing the headline fields came from. last_captured_at, capture_count, marketplace_ids, listing_count and search_blob span every listing of the product; certification, cert_label, provenance, evidence_tier, risk, risk_basis, known_layers, layers_known and reach all come from the qualifying listing, which need not be the primary one. Does not carry overview text.';

grant select on public.v_registry_card to anon, authenticated;

-- What this does to v_registry_stats, which is not recreated here ------------
--
-- v_registry_stats reads v_registry_card four times and is untouched by this
-- file, but three of its numbers change basis anyway, because the card's
-- grain and sources moved underneath them. All three are identical today
-- under 1:1 and none is a defect; they are recorded because a silent change
-- of basis in a front-page number is exactly the kind of thing nobody finds
-- later.
--
--   publishers    count(distinct publisher) over the card, and the card now
--                 carries one row per asset sourced from its PRIMARY listing.
--                 A publisher named only on a secondary listing therefore
--                 stops being counted. The number becomes "publishers we show
--                 on a product's headline" rather than "publishers named
--                 anywhere in the registry".
--
--   mean_reach    avg(reach) over the card, and reach now comes from the
--                 QUALIFYING listing. It becomes the mean over qualifying
--                 listings rather than over every listing.
--
--   attested      count(distinct asset_id) where certification =
--                 'publisher_attestation', and the card now carries one row
--                 per asset holding the QUALIFYING listing's certification,
--                 not every listing's own. certified is unaffected:
--                 microsoft_365_certified ranks first in the `cert` lateral,
--                 so any listing that carries it still makes its asset the
--                 qualifying one, exactly as the any-listing rule intends.
--                 attested is not: an asset that ALSO holds a Microsoft 365
--                 certified listing elsewhere now resolves to that listing
--                 instead, so it stops being counted here even though it
--                 still carries a publisher_attestation listing somewhere.
--                 Under the spec's "any listing" rule that asset belongs in
--                 both counts; now it belongs in only one, so
--                 certified + attested <= agents holds from this file on,
--                 where before it could exceed. This is the same failure as
--                 the certification group above: an enumeration drawn one
--                 item too small.
--
-- agents and marketplaces never read the card at all, so neither is affected.


-- v_asset_passport -----------------------------------------------------------
--
-- Appends listings, and nothing else. The 61 columns above it keep their
-- names, types and positions; asset_id, first_seen_at, last_captured_at,
-- capture_count and the nine of the certification group (certification,
-- cert_label, provenance, evidence_tier, risk, risk_basis, known_layers,
-- layers_known and reach) change what they are sourced from and stay exactly
-- where they sit.
--
-- listings is what the page renders as one panel per marketplace. The fields
-- it carries are the ones the spec says must never be flattened: price,
-- certification, rating and categories are precisely where marketplaces
-- disagree, and a merged page that silently picked one of them would be
-- asserting something no marketplace said.
--
-- It reaches listing, marketplace and capture_extract, which are three of the
-- four tables the passport's own row already reaches by inner join, so it
-- cannot be emptied by a policy failure that leaves the row standing. That is
-- not true of plans, links, media, permissions, compliance and evidence below
-- it, every one of which can go hollow while the row count holds.

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
  cert.known_layers, cardinality(cert.known_layers) as layers_known,
  array_length(registry_layers(), 1)          as layers_tracked,
  cert.reach, cert.provenance, cert.evidence_tier, cert.risk, cert.risk_basis,
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
-- reason. See rule 1 at the top of this file.
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
  'Everything the agent passport renders, one row per product. The headline fields come from the primary listing''s latest capture; the dates and counts span every listing; certification, cert_label, provenance, evidence_tier, risk, risk_basis, known_layers, layers_known and reach all come from the qualifying listing, which need not be the primary one. listings carries one entry per marketplace with the four fields marketplaces are allowed to disagree about. evidence carries verified rows only.';

grant select on public.v_asset_passport to anon, authenticated;


-- v_listing_passport ---------------------------------------------------------
--
-- What v_asset_passport was before this migration, kept because aggregating it
-- away would destroy the only record of what a single marketplace actually
-- said. The merged page renders it beside the asset passport, and phase 3's
-- merge review needs exactly this: two listings side by side, neither one
-- resolved into the other.
--
-- The select list is the phase 1 passport's, verbatim and in the same order,
-- with no aggregation and no listings column. asset_id is already the first
-- column and already the product's own uuid, so the "add asset_id so a caller
-- can get back to the product" requirement is met by not removing it.
--
-- The certification group is deliberately NOT resolved here. This view's whole
-- job is to say what one marketplace published, so certification and the eight
-- fields grouped with it all come off this listing's own extract, exactly as
-- they did before phase 2. There is no `cert` lateral, and that absence is the
-- point rather than an omission.

create or replace view v_listing_passport
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

comment on view v_listing_passport is
  'One row per listing at its own latest capture, unaggregated. What one marketplace said about one product, with nothing resolved across marketplaces. asset_id is the product the listing is evidence about.';

grant select on public.v_listing_passport to anon, authenticated;


-- v_asset_evidence -----------------------------------------------------------
--
-- The spec's answer to "always point back to it or run AI over it": given an
-- asset, every marketplace's every observation of it, newest first.
--
-- It deliberately does not select raw. raw is the capture file verbatim, it is
-- large, and it is already publicly readable on capture for anyone who wants
-- it; has_raw says whether the source material is there without dragging it
-- through every read. raw is null on rows backfilled from the pre-Supabase
-- index, which is the honest state this column exists to expose.

create or replace view v_asset_evidence
with (security_invoker = true) as
select
  l.asset_id,
  l.id                as listing_id,
  l.marketplace_id,
  l.source_product_id,
  c.id                as capture_id,
  c.captured_at,
  c.content_hash,
  c.ingest_source,
  c.method,
  c.capture_complete,
  c.missing,
  (c.raw is not null) as has_raw
from capture c
join listing l on l.id = c.listing_id
order by l.asset_id, c.captured_at desc;

comment on view v_asset_evidence is
  'Every capture of every listing of a product, newest first. The evidence trail behind a passport: what was observed, when, by what method, and whether the raw capture is still held. Does not carry raw itself.';

grant select on public.v_asset_evidence to anon, authenticated;


-- The tripwire ----------------------------------------------------------------
--
-- Phase 1's block, extended from five views to seven. What it catches is one
-- specific human mistake: an explicit drop view plus create view with no
-- re-grant after it. That is the true shape of the outage that took all 6,820
-- logos off the site, and Postgres gives no warning about it because dropping
-- a view and creating another with the same name is an ordinary thing to do.
--
-- What it does NOT catch is a column shape change, which Postgres refuses
-- itself with "cannot change name of view column", aborting the migration long
-- before execution reaches here. Nothing in this file is dropped, so nothing
-- here should lose a grant; the block checks the outcome rather than trusting
-- that reasoning.
--
-- v_listing_passport and v_asset_evidence are new in this file, so their grant
-- lines above are the ones that actually create the privilege. For the other
-- five the grants are inert, exactly as they were in phase 1.

do $$
declare missing text;
begin
  select string_agg(format('%s -> %s', v, r), ', ') into missing
    from (values
      ('v_registry_card'),('v_asset_passport'),('v_listing_passport'),
      ('v_asset_evidence'),('v_asset_change_feed'),
      ('v_registry_stats'),('v_logo_status')) as views(v)
    cross join (values ('anon'),('authenticated')) as roles(r)
   where not has_table_privilege(r, 'public.' || v, 'SELECT');
  if missing is not null then
    raise exception 'grants missing after view replacement: %', missing;
  end if;
  if not has_table_privilege('service_role', 'public.v_logo_status', 'SELECT') then
    raise exception 'service_role lost SELECT on v_logo_status; archive-logos.mjs will fail with 42501';
  end if;
end $$;

-- And the same seven, checked for security_invoker. A view without it runs as
-- its owner, which on this project means RLS is evaluated against postgres
-- rather than against the visitor. Supabase's linter flags that at ERROR level,
-- and v_logo_status sat in exactly that state on production until phase 1
-- closed it, because an unrecorded SQL-editor edit dropped the option the
-- original definition had.
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('v_registry_card','v_asset_passport','v_listing_passport',
                       'v_asset_evidence','v_asset_change_feed',
                       'v_registry_stats','v_logo_status')
     and not coalesce(c.reloptions, '{}') @> array['security_invoker=true'];
  if bad is not null then
    raise exception 'views are not security_invoker, so RLS runs as the owner: %', bad;
  end if;
end $$;
