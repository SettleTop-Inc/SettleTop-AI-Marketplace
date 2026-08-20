-- Step 6: the sentinel ingest.
--
-- This is the only place ingest_capture is proved to resolve the renamed
-- tables. Postgres only syntax-checks a plpgsql body; it does not resolve
-- object names until a statement actually runs, and ingest_capture('{}')
-- raises at its first guard before touching any relation. A version still
-- saying "from asset" would pass that probe and fail here.
--
-- Called as service_role, which is how the capture worker calls it.
set role service_role;

create temp table sentinel (label text, result jsonb);

insert into sentinel
select 'call 1 (create)', ingest_capture($p$
{
  "capture_meta": {
    "marketplace_id": "microsoft",
    "source_product_id": "sentinel-does-not-exist-0001",
    "listing_url": "https://marketplace.microsoft.com/en-us/product/sentinel-does-not-exist-0001",
    "captured_at_utc": "2026-08-19T12:00:00Z",
    "template_version": "2.0",
    "capture_complete": true,
    "drive_file_id": "drive-sentinel-1",
    "drive_file_name": "sentinel-1.md",
    "source_view_url": "https://drive.example/sentinel-1"
  },
  "ingest_source": "dual_write",
  "raw": {"body": "sentinel capture one"},
  "extract": {
    "extract_spec_version": "v2",
    "name": "Sentinel Probe Agent",
    "publisher": "Sentinel Labs",
    "tagline": "Proves ingest_capture resolves listing rather than asset",
    "overview_text": "Sentinel Probe Agent uses GPT-4o with LangGraph and reads SharePoint.",
    "support": "https://support.example/sentinel",
    "pricing": "From 30 dollars per user per month",
    "acquire_using": "Subscription",
    "version": "2.0.0",
    "updated": "2026-08-18",
    "rating": 4.2, "rating_count": 11,
    "certification": "microsoft_365_certified",
    "cert_url": "https://cert.example/sentinel",
    "surfaces": ["Teams"],
    "categories": ["Productivity"],
    "industries": ["Healthcare"],
    "works_with": ["SharePoint"],
    "media_image_urls": ["https://img.example/sentinel-1.png"],
    "product_links": [{"label": "Docs", "url": "https://docs.example/sentinel"}],
    "legal_links": [{"label": "Terms", "url": "https://legal.example/sentinel-terms"}],
    "plans": [{"name": "Standard", "price": "30 dollars", "unit": "user", "billing": "monthly"}],
    "stated": {
      "models": ["GPT-4o"],
      "frameworks": ["LangGraph"],
      "integrations": ["SharePoint"],
      "tools_mcp": ["Microsoft Graph"]
    },
    "cert_detail": {
      "hosting": "Microsoft Azure",
      "data_location": "United Kingdom",
      "data_handling": "Data is not used for training",
      "developer_last_updated": "2026-08-01",
      "page_last_updated": "2026-08-05",
      "graph_permissions": ["Mail.Read", "Files.Read.All"],
      "compliance": ["ISO 27001"]
    }
  }
}
$p$::jsonb);

-- Same source_product_id, one changed field: pricing.
insert into sentinel
select 'call 2 (update)', ingest_capture($p$
{
  "capture_meta": {
    "marketplace_id": "microsoft",
    "source_product_id": "sentinel-does-not-exist-0001",
    "listing_url": "https://marketplace.microsoft.com/en-us/product/sentinel-does-not-exist-0001",
    "captured_at_utc": "2026-08-19T13:00:00Z",
    "template_version": "2.0",
    "capture_complete": true,
    "drive_file_id": "drive-sentinel-2",
    "drive_file_name": "sentinel-2.md",
    "source_view_url": "https://drive.example/sentinel-2"
  },
  "ingest_source": "dual_write",
  "raw": {"body": "sentinel capture two"},
  "extract": {
    "extract_spec_version": "v2",
    "name": "Sentinel Probe Agent",
    "publisher": "Sentinel Labs",
    "tagline": "Proves ingest_capture resolves listing rather than asset",
    "overview_text": "Sentinel Probe Agent uses GPT-4o with LangGraph and reads SharePoint.",
    "support": "https://support.example/sentinel",
    "pricing": "From 45 dollars per user per month",
    "acquire_using": "Subscription",
    "version": "2.0.0",
    "updated": "2026-08-18",
    "rating": 4.2, "rating_count": 11,
    "certification": "microsoft_365_certified",
    "cert_url": "https://cert.example/sentinel",
    "surfaces": ["Teams"],
    "categories": ["Productivity"],
    "industries": ["Healthcare"],
    "works_with": ["SharePoint"],
    "media_image_urls": ["https://img.example/sentinel-1.png"],
    "product_links": [{"label": "Docs", "url": "https://docs.example/sentinel"}],
    "legal_links": [{"label": "Terms", "url": "https://legal.example/sentinel-terms"}],
    "plans": [{"name": "Standard", "price": "45 dollars", "unit": "user", "billing": "monthly"}],
    "stated": {
      "models": ["GPT-4o"],
      "frameworks": ["LangGraph"],
      "integrations": ["SharePoint"],
      "tools_mcp": ["Microsoft Graph"]
    },
    "cert_detail": {
      "hosting": "Microsoft Azure",
      "data_location": "United Kingdom",
      "data_handling": "Data is not used for training",
      "developer_last_updated": "2026-08-01",
      "page_last_updated": "2026-08-05",
      "graph_permissions": ["Mail.Read", "Files.Read.All"],
      "compliance": ["ISO 27001"]
    }
  }
}
$p$::jsonb);

-- set_capture_logo against the renamed schema. Its probe selects
-- l.current_capture_id from listing, so a version still naming asset dies here.
insert into sentinel
select 'set_capture_logo (sentinel)',
       set_capture_logo('sentinel-does-not-exist-0001', 'https://img.example/sentinel-logo.png', 'microsoft');
insert into sentinel
select 'set_capture_logo (absent product)',
       set_capture_logo('no-such-product-at-all', 'https://img.example/nope.png', 'microsoft');

reset role;

\pset format aligned
select label, result ->> 'status' as status, result ->> 'asset_id' as asset_id,
       result ->> 'listing_id' as listing_id, result ->> 'slug_fallback' as slug_fallback,
       result ->> 'changes' as changes
  from sentinel order by label;

-- The assertions.
select
  (select count(*) from listing where source_product_id = 'sentinel-does-not-exist-0001')            as listings,
  (select count(*) from asset a join listing l on l.asset_id = a.id
     where l.source_product_id = 'sentinel-does-not-exist-0001')                                      as assets,
  (select count(*) from asset_slug s join listing l on l.asset_id = s.asset_id
     where l.source_product_id = 'sentinel-does-not-exist-0001' and s.is_canonical)                   as canonical_slugs,
  (select count(*) from capture c join listing l on l.id = c.listing_id
     where l.source_product_id = 'sentinel-does-not-exist-0001')                                      as captures,
  (select slug from asset_slug s join listing l on l.asset_id = s.asset_id
     where l.source_product_id = 'sentinel-does-not-exist-0001' and s.is_canonical)                   as canonical_slug;

do $$
declare a1 uuid; a2 uuid; s1 text; s2 text; n_l int; n_a int; n_s int;
begin
  select (result ->> 'asset_id')::uuid, result ->> 'status' into a1, s1 from sentinel where label = 'call 1 (create)';
  select (result ->> 'asset_id')::uuid, result ->> 'status' into a2, s2 from sentinel where label = 'call 2 (update)';
  select count(*) into n_l from listing where source_product_id = 'sentinel-does-not-exist-0001';
  select count(*) into n_a from asset a join listing l on l.asset_id = a.id where l.source_product_id = 'sentinel-does-not-exist-0001';
  select count(*) into n_s from asset_slug s join listing l on l.asset_id = s.asset_id where l.source_product_id = 'sentinel-does-not-exist-0001' and s.is_canonical;

  if s1 <> 'created'      then raise exception 'call 1 returned % not created', s1; end if;
  if s2 <> 'updated'      then raise exception 'call 2 returned % not updated', s2; end if;
  if a1 is distinct from a2 then raise exception 'asset_id changed between calls: % then %', a1, a2; end if;
  if n_l <> 1 then raise exception 'expected 1 listing, found %', n_l; end if;
  if n_a <> 1 then raise exception 'expected 1 asset, found %', n_a; end if;
  if n_s <> 1 then raise exception 'expected 1 canonical slug, found %', n_s; end if;
  raise notice 'SENTINEL PASS: created then updated, one listing, one asset, one canonical slug, asset_id stable at %', a1;
end $$;

-- And the whole-registry invariants the backfill is responsible for, re-checked
-- after a live write landed on top of it.
do $$
declare n_l int; n_a int; n_s int; n_bad int;
begin
  select count(*) into n_l from listing;
  select count(*) into n_a from asset where merged_into is null;
  select count(*) into n_s from asset_slug where is_canonical;
  select count(*) into n_bad from (select asset_id from listing group by 1 having count(*) > 1) d;
  if not (n_l = n_a and n_a = n_s and n_bad = 0) then
    raise exception 'registry invariant broken: % listings, % assets, % canonical slugs, % shared assets', n_l, n_a, n_s, n_bad;
  end if;
  raise notice 'REGISTRY 1:1 HOLDS: % listings, % assets, % canonical slugs, 0 shared', n_l, n_a, n_s;
end $$;
