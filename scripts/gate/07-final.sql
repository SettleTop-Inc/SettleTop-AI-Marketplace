-- 6b. Re-ingest a BACKFILLED listing. This is the branch production runs for
-- all 6,876 existing rows: a listing that already exists and whose asset came
-- from the backfill migration rather than from ingest_capture. It must adopt
-- the existing asset, create no second asset and no second slug.
set role service_role;

create temp table before_after as
select (select asset_id from listing where source_product_id = 'seed-alpha') as asset_before,
       (select count(*) from asset)                                          as assets_before,
       (select count(*) from asset_slug)                                     as slugs_before;

select ingest_capture($p$
{
  "capture_meta": {
    "marketplace_id": "microsoft",
    "source_product_id": "seed-alpha",
    "captured_at_utc": "2026-08-19T14:00:00Z",
    "drive_file_id": "drive-seed-alpha-3"
  },
  "ingest_source": "dual_write",
  "raw": {"body": "seed alpha capture three"},
  "extract": {
    "extract_spec_version": "v2",
    "name": "Seed Alpha Agent",
    "publisher": "Seed\\_Publisher Ltd",
    "tagline": "An agent that reads Microsoft Graph and writes summaries",
    "overview_text": "Seed Alpha Agent uses GPT-4o and LangChain to summarise mail. It integrates with SharePoint and Teams.",
    "pricing": "From 22 dollars per user per month",
    "certification": "microsoft_365_certified",
    "surfaces": ["Teams", "Outlook"],
    "categories": ["Productivity"],
    "works_with": ["SharePoint", "Teams"],
    "media_image_urls": ["https://img.example/alpha-1.png"],
    "product_links": [{"label": "Docs", "url": "https://docs.example/alpha"}],
    "legal_links": [{"label": "Privacy", "url": "https://legal.example/alpha-privacy"}],
    "plans": [{"name": "Standard", "price": "22 dollars", "unit": "user", "billing": "monthly"}],
    "stated": {"models": ["GPT-4o"], "frameworks": ["LangChain"], "tools_mcp": ["Microsoft Graph"]},
    "cert_detail": {
      "hosting": "Microsoft Azure",
      "data_location": "European Union",
      "graph_permissions": ["Mail.Read", "User.Read", "Sites.Read.All", "Calendars.Read"],
      "compliance": ["ISO 27001", "SOC 2 Type II"]
    }
  }
}
$p$::jsonb) ->> 'status' as reingest_backfilled_listing;

-- A new capture carries no logo link of its own, so the logo is re-set and
-- re-archived on every harvest. That is what set_capture_logo and
-- archive-logos.mjs do on production. Skipping it here would leave seed-alpha
-- at no_logo_identified, which is a state production does not sit in, and the
-- step 7 logo assertion would then be asserting over a degraded seed.
--
-- It also exercises both functions against the renamed schema a second time,
-- after the write-path migration rather than before it.
select set_capture_logo('seed-alpha', 'https://img.example/alpha-logo.png', 'microsoft') ->> 'status'
       as alpha_logo_reset;
select record_link_archive(
         (select cl.id from capture_link cl
            join listing l on l.current_capture_id = cl.capture_id
           where l.source_product_id = 'seed-alpha' and cl.kind = 'logo'),
         'https://storage.example/logos/microsoft/seed-alpha.png',
         'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
         2048, 'image/png') ->> 'status' as alpha_logo_rearchived;

reset role;

do $$
declare a_before uuid; a_after uuid; n_a_before int; n_a_after int; n_s_before int; n_s_after int;
begin
  select asset_before, assets_before, slugs_before into a_before, n_a_before, n_s_before from before_after;
  select asset_id into a_after from listing where source_product_id = 'seed-alpha';
  select count(*) into n_a_after from asset;
  select count(*) into n_s_after from asset_slug;
  if a_before is distinct from a_after then
    raise exception 're-ingest moved a backfilled listing to a different asset: % then %', a_before, a_after;
  end if;
  if n_a_after <> n_a_before then raise exception 're-ingest created % extra assets', n_a_after - n_a_before; end if;
  if n_s_after <> n_s_before then raise exception 're-ingest created % extra slugs', n_s_after - n_s_before; end if;
  raise notice 'BACKFILLED RE-INGEST PASS: asset unchanged at %, assets still %, slugs still %', a_after, n_a_after, n_s_after;
end $$;


-- 7. Re-read everything as anon and service_role after all those writes, so the
-- gate's final state is the state a visitor would meet.
do $$
begin
  perform gate.check_rows('7. final read, after every write', 'anon', 'v_registry_card');
  perform gate.check_rows('7. final read, after every write', 'anon', 'v_asset_passport');
  perform gate.check_rows('7. final read, after every write', 'anon', 'v_asset_change_feed');
  perform gate.check_rows('7. final read, after every write', 'anon', 'v_logo_status');
  perform gate.check_rows('7. final read, after every write', 'anon', 'asset');
  perform gate.check_rows('7. final read, after every write', 'anon', 'asset_slug');
  perform gate.check_rows('7. final read, after every write', 'anon', 'asset_merge');
  perform gate.check_rows('7. final read, after every write', 'service_role', 'v_logo_status');
  perform gate.check_stats('7. final read, after every write');
  perform gate.check_logo_status('7. final read, after every write');
  perform gate.check_passport('7. final read, after every write', 'seed-alpha');

  -- Phase 2. The re-ingest above landed a third capture on seed-alpha, so the
  -- card's capture_count and last_captured_at are aggregates over a listing
  -- that has actually moved since step 3, not over a static seed.
  perform gate.check_rows('7. final read, after every write', 'anon', 'v_listing_passport');
  perform gate.check_rows('7. final read, after every write', 'anon', 'v_asset_evidence');
  perform gate.check_card_asset('7. final read, after every write', 'seed-alpha');
  perform gate.check_passport_listings('7. final read, after every write', 'seed-alpha');
  perform gate.check_listing_passport('7. final read, after every write');
  perform gate.check_listing_passport_sections('7. final read, after every write', 'seed-alpha');
  perform gate.check_asset_evidence('7. final read, after every write');
  perform gate.check_view_options('7. final read, after every write');
  perform gate.check_cert_group_coherent('7. final read, after every write');
  perform gate.check_passport_group_coherent('7. final read, after every write');
end $$;

\pset format aligned
select step, as_role, object, n_rows, verdict, note from gate.result where step like '7.%' order by seq;

-- 8. The view options and the grant matrix, read out of the catalog.
select c.relname as view,
       coalesce(array_to_string(c.reloptions, ','), '(none)') as reloptions,
       has_table_privilege('anon',          'public.' || c.relname, 'SELECT') as anon,
       has_table_privilege('authenticated', 'public.' || c.relname, 'SELECT') as authenticated,
       has_table_privilege('service_role',  'public.' || c.relname, 'SELECT') as service_role
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'v'
 order by c.relname;

select c.relname as tbl, c.relrowsecurity as rls,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
       has_table_privilege('anon',         'public.' || c.relname, 'SELECT') as anon,
       has_table_privilege('service_role', 'public.' || c.relname, 'SELECT') as service_role
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relname;

-- 9. Nothing named for the old asset survives, other than the views that are
-- deliberately named that way. v_asset_evidence joined that list in phase 2.
select 'leftover asset-named object' as finding, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname like '%asset%'
   and c.relname not in ('asset','asset_slug','asset_merge','v_asset_passport','v_asset_change_feed',
                         'v_asset_evidence',
                         'asset_merge_id_seq','asset_merged_into_idx','asset_slug_one_canonical',
                         'asset_slug_asset_idx','asset_merge_into_idx','asset_pkey','asset_slug_pkey',
                         'asset_merge_pkey','listing_asset_idx')
union all
select 'leftover asset-named constraint', conname from pg_constraint
 where conname like '%asset%' and conname not in
   ('asset_primary_listing_fk','asset_pkey','asset_slug_pkey','asset_merge_pkey',
    'asset_merged_into_fkey','asset_slug_asset_id_fkey','asset_merge_from_asset_id_fkey',
    'asset_merge_into_asset_id_fkey','listing_asset_id_fkey')
union all
select 'leftover asset-named policy', polname from pg_policy where polname like '%asset%'
   and polname not in ('asset_public_read','asset_slug_public_read','asset_merge_public_read');
