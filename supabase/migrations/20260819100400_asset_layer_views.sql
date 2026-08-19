-- The read surface learns about assets.
--
-- Task 3 renamed asset to listing. Views record their dependencies by object
-- identity, so all five of these followed the rename without being touched and
-- have been reading the listing table ever since. This migration makes that
-- explicit and adds the layer above it: asset_id stops being a listing id
-- wearing the wrong name and becomes the real product, and the listing id gets
-- a column of its own.
--
-- APPEND ONLY. create or replace view requires the replacement to produce the
-- existing columns with the same names, the same types and the same positions,
-- and permits new columns only at the end. Changing what an existing column is
-- sourced from is fine; moving or renaming one is not. So asset_id stays
-- exactly where it sits in each select list and only its source changes, and
-- listing_id is appended last. Task 1 of this plan hit the refusal this rule
-- exists to avoid:
--
--   ERROR:  cannot change name of view column "source_product_id" to
--   "marketplace_id"
--
-- Staying column compatible also keeps the drop order out of this file.
-- v_registry_stats selects from v_registry_card, so a shape change to the card
-- would mean dropping the stats view first or cascading through it. Neither
-- happens here. (registry_search also reads v_registry_card, but it is a
-- text bodied SQL function, which Postgres does not dependency track.)
--
-- Grants sit immediately after each view. A column compatible create or
-- replace preserves them; what loses them is a drop view, which is what anyone
-- wanting a column shape change has to write for themselves, since create or
-- replace refuses one outright. That is what took all 6,820 logos off the site:
-- getLogos returns {} on error, so anon losing SELECT on v_logo_status surfaced
-- as initials everywhere rather than as an error. Nothing in this file needs a
-- drop, so nothing here should lose a grant. The block at the end of the file
-- checks the outcome anyway, rather than trusting the reasoning above.
--
-- Every view is recreated with (security_invoker = true). v_logo_status in
-- production is currently SECURITY DEFINER, because the unrecorded migration
-- that added marketplace_id dropped the security_invoker the original had, and
-- Supabase's linter flags that at ERROR level. This migration closes it.
--
-- The alias l means listing throughout. capture_link, which the old
-- definitions also called l, is lnk here: in v_logo_status both are in the
-- same FROM clause, and one alias cannot name two of them.


-- v_registry_card ------------------------------------------------------------

create or replace view v_registry_card
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

comment on view v_registry_card is
  'One row per listing at its latest capture, sized for the registry grid. asset_id is the product the listing is evidence about; listing_id is the listing itself. Does not carry overview text.';

grant select on public.v_registry_card to anon, authenticated;


-- v_asset_passport -----------------------------------------------------------

create or replace view v_asset_passport
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

comment on view v_asset_passport is
  'Everything the agent passport renders, at the latest capture of one listing. asset_id is the product; listing_id is the listing that supplied these fields. evidence carries verified rows only.';

grant select on public.v_asset_passport to anon, authenticated;


-- v_asset_change_feed --------------------------------------------------------
--
-- The first eight columns keep their names and their order because
-- lib/types.ts ChangeRow names them: id, asset_id, source_product_id, name,
-- publisher, field, old_value, new_value, observed_at. asset_id stays second
-- and is now the product rather than the listing.

create or replace view v_asset_change_feed
with (security_invoker = true) as
select
  ch.id,
  l.asset_id                             as asset_id,
  l.source_product_id,
  x.name, x.publisher,
  ch.field, ch.old_value, ch.new_value, ch.observed_at,
  l.id                                   as listing_id
from listing_change ch
join listing l         on l.id = ch.listing_id
join capture_extract x on x.capture_id = l.current_capture_id
order by ch.observed_at desc, ch.id desc;

comment on view v_asset_change_feed is
  'What moved, newest first. One row per observed change on one listing, attributed to the asset it is evidence about. The reason this is a provenance registry and not a directory.';

grant select on public.v_asset_change_feed to anon, authenticated;


-- v_registry_stats -----------------------------------------------------------
--
-- agents counts assets, not listings, and excludes retired ones. An asset with
-- merged_into set has been merged away and is kept only so the merge log stays
-- valid, so counting the table without that filter would freeze the headline
-- number no matter how many merges landed.
--
-- marketplaces counts distinct marketplace_id over listing, because
-- marketplace membership is a property of a listing and always was. The asset
-- table carries no marketplace at all.
--
-- certified and attested resolve certification as any listing, not the primary
-- one: if one marketplace certifies a product and another does not, the
-- product is certified. count(distinct asset_id) is what states that. Assets
-- and listings are 1:1 for all of phase 1, so these return exactly the numbers
-- they returned before; they keep returning the right ones once they are not.
-- A retired asset cannot be counted here either, because a merge moves its
-- listings to the surviving asset and leaves it with none.
--
-- Every other field keeps the expression it had, with asset renamed to
-- listing where it appeared. publishers stays last: it was appended by
-- 20260818185053 and moving it now would be exactly the reorder this file
-- must not do.

create or replace view v_registry_stats
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
  -- 'Unknown' is this registry's literal string for "the source did not say",
  -- so it is a publisher we do not know rather than a publisher named Unknown.
  -- No row carries it today; the guard is here so the count stays a count of
  -- real publishers on the day one does.
  (select count(distinct publisher) from v_registry_card
    where publisher is not null
      and btrim(publisher) <> ''
      and publisher <> 'Unknown')                                     as publishers;

grant select on public.v_registry_stats to anon, authenticated;


-- v_logo_status --------------------------------------------------------------
--
-- Ten columns, unchanged. archive-logos.mjs builds its storage keys from
-- marketplace_id and source_product_id, so neither may move. Only the table
-- name, the alias and security_invoker change here.

create or replace view v_logo_status
with (security_invoker = true) as
select
  l.marketplace_id,
  l.source_product_id,
  l.listing_url,
  x.name,
  x.publisher,
  lnk.id           as link_id,
  lnk.url          as logo_url,
  lnk.archived_url,
  lnk.content_hash,
  case
    when lnk.id is null           then 'no_logo_identified'::text
    when lnk.archived_url is null then 'url_only_not_archived'::text
    else 'archived'::text
  end              as state
from listing l
join capture_extract x on x.capture_id = l.current_capture_id
left join capture_link lnk
       on lnk.capture_id = l.current_capture_id and lnk.kind = 'logo';

comment on view v_logo_status is
  'Every listing and whether its logo is unidentified, referenced only, or actually held. url_only_not_archived is not done.';

-- service_role as well, because archive-logos.mjs reads this view with the
-- service role key. It is the only pass that reads a relation directly rather
-- than going through a definer function, so it is the only one a missing grant
-- reaches, and it fails with 42501 when it does.
grant select on public.v_logo_status to anon, authenticated, service_role;


-- The tripwire ----------------------------------------------------------------
--
-- First, what the five grant statements above are not. They are inert on any
-- database that has run the earlier migrations. Every view in this file is a
-- column compatible create or replace, which preserves the grants the view
-- already had, so not one of those lines changes a single privilege today. They
-- are there so the grant is never further away than the view it belongs to, and
-- for the day someone genuinely does need a drop. Nobody should read them as
-- the line that kept the logos on the page.
--
-- Second, what this block is for. It catches one specific human mistake: an
-- explicit drop view plus create view with no re-grant after it. That is the
-- true shape of the outage that took all 6,820 logos off the site. Postgres
-- gives no warning about it, because dropping a view and creating another with
-- the same name is an ordinary thing to do, and getLogos returns {} on error,
-- so the site renders initials instead of failing.
--
-- Third, what this block is NOT for, because getting this backwards is exactly
-- the error the rest of this plan set out to correct. A column shape change is
-- caught earlier, and by Postgres itself, which refuses the statement:
--
--   ERROR:  cannot change name of view column "x" to "y"
--
-- Nothing is dropped, no grant is lost, and execution never reaches this block.
-- create or replace does not silently drop and recreate a view. It is the
-- explicit drop, whether a person writes it or a column shape change forces
-- them to, that takes the grants.
--
-- Verified by making it fail rather than by assuming it works. Rewriting the
-- v_logo_status replacement above as a drop and create with its grant line
-- deleted, then replaying against postgres:17-alpine, aborted the migration
-- here:
--
--   ERROR:  grants missing after view replacement:
--           v_logo_status -> anon, v_logo_status -> authenticated

do $$
declare missing text;
begin
  select string_agg(format('%s -> %s', v, r), ', ') into missing
    from (values
      ('v_registry_card'),('v_asset_passport'),('v_asset_change_feed'),
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
