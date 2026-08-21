-- ingest_capture() gets a collision proof canonical slug chain, and
-- v_registry_card carries the slug the grid must link from. Issue #45.
--
-- THE BUG. For every new asset ingest_capture claims one canonical slug. The
-- chain tried the marketplace's own product id first and, if that was taken,
-- inserted marketplace-productid with NO on conflict guard. That second insert
-- is against asset_slug.slug, the primary key, so a collision raised
-- unique_violation OUTSIDE any exception block and aborted the whole ingest:
-- no asset, no listing, no capture, with an asset_slug_pkey error that says
-- nothing about the capture that triggered it. Unreachable at 1:1, but AWS as
-- a third source is the first realistic chance of two marketplaces sharing a
-- source_product_id, which is exactly what drives the fallback.
--
-- TWO DEFECTS COME WITH IT, both fixed here because fixing the first alone
-- makes them worse:
--
--   1. The naive fix, just adding on conflict do nothing to that second insert,
--      lets the transaction commit with the asset holding NO canonical slug row
--      at all. asset_slug is the only URL to asset path (getPassportBySlug in
--      lib/registry.ts), so such an asset has no passport URL and the reader
--      returns {ok:true,data:null}, which renders a confident 404 about a
--      record that exists.
--   2. The grid did not link by slug. AgentCard.tsx and ResultList.tsx built
--      /agent/ from source_product_id, the PRIMARY listing's product id. The
--      first time two marketplaces share a product id, asset B falls back to
--      aws-P while its card still links /agent/P, which resolves to asset A: B
--      is unreachable and its own card sends the visitor to a different
--      product. This migration adds the slug the card links from; the component
--      change is in the same commit.
--
-- THE FIX, three parts:
--
--   A. A THREE LEVEL slug chain, every insert guarded with on conflict (slug)
--      do nothing, and FOUND tested after each because a skipped insert reports
--      not found, which is the only signal the slug was free. No guarded insert
--      is left as the last statement of the chain. Level 0 is the bare product
--      id, level 1 is marketplace-productid, level 2 is the asset uuid as text,
--      the terminal identity that cannot collide.
--   B. A POST CHECK after the chain: if the asset still has no canonical slug,
--      raise, naming the asset, marketplace and product id. No path reaches the
--      capture insert without a slug.
--   C. slug_fallback in the result now reports the LEVEL that was used (0, 1 or
--      2) rather than a boolean, so a sweep can surface which assets fell back
--      and how far. It stays backward compatible: nothing reads it as a boolean
--      today (only scripts/gate/06-sentinel.sql reads it, for display), and 0
--      is falsy where the old false meant no fallback while 1 and 2 are truthy
--      where the old true meant a fallback was used.
--
-- WHAT THIS RECREATES, AND WHAT MOVED. ingest_capture is recreated from its
-- current definition in 20260820140000_registry_delivery_aws.sql, not from the
-- older 20260819100300 the issue quotes: 20260820140000 is the later migration
-- and is the body production runs, carrying the delivery_ids logic. Diffed
-- against that body, exactly three regions change and nothing else moves:
--   - the declare line, v_slug_fallback boolean becomes v_slug_level int;
--   - the slug chain inside the if v_new_listing block;
--   - the slug_fallback field in the return object.
-- The update path and the 12,044 existing assets are untouched: the chain only
-- runs on the v_new_listing branch, for a brand new asset.
--
-- THE EVIDENCE VERIFICATION GATE IS UNCHANGED, byte for byte. The region from
-- the line beginning hay_listing := concat_ws( through the end if; that closes
-- the Microsoft Graph rule is copied verbatim. Over the 25 lines joined by LF
-- with no trailing newline, the git stored form, sha256 reads
--   2fe4306cffb3ca6be2fb1d323f898e0eaefd8c1c9d78edd2a1c2d51a9cbeddc7
-- the same value 20260820140000 and 20260819100300 both publish.
--
-- v_registry_card. One column is appended, canonical_slug, a scalar subquery
-- for the asset's is_canonical slug. asset_slug_one_canonical makes it at most
-- one row per asset, so it cannot multiply the card. Appending is column
-- compatible, so create or replace redefines in place, preserving the
-- anon/authenticated grants and the security_invoker option; both are restated
-- below regardless. No existing column is reordered or retyped. registry_search
-- reads the card with to_jsonb(v), so the new key flows into its rows with no
-- further change, and v_registry_stats was already decoupled from the card, so
-- nothing does select * over it that a shape change could break.
--
-- APPLYING THIS FILE. Like 20260820140000, this recreates a function body and
-- this project hashes bodies as evidence, so apply the git stored LF bytes, not
-- a CRLF working copy:
--   git show HEAD:supabase/migrations/20260820170000_slug_fallback_chain.sql \
--     | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
-- The Supabase CLI and any Linux or macOS checkout already do this.


create or replace function ingest_capture(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  meta            jsonb := payload -> 'capture_meta';
  ex              jsonb := payload -> 'extract';
  cert_d          jsonb := coalesce(ex -> 'cert_detail', '{}'::jsonb);
  v_mkt           text  := coalesce(meta ->> 'marketplace_id', 'microsoft');
  v_pid           text  := meta ->> 'source_product_id';
  v_drive         text  := meta ->> 'drive_file_id';
  v_asset         uuid;
  v_listing       uuid;
  v_new_listing   boolean := false;
  v_slug_level    int := 0;
  v_capture       uuid;
  v_prev          uuid;
  v_hash          text;
  v_captured      timestamptz := coalesce((meta ->> 'captured_at_utc')::timestamptz, now());
  hay_listing     text;
  hay_cert        text;
  perms           text[] := coalesce(array(select jsonb_array_elements_text(cert_d -> 'graph_permissions')), '{}');
  compl           text[] := coalesce(array(select jsonb_array_elements_text(cert_d -> 'compliance')), '{}');
  works           text[] := coalesce(array(select jsonb_array_elements_text(ex -> 'works_with')), '{}');
  surfaces        text[] := coalesce(array(select jsonb_array_elements_text(ex -> 'surfaces')), '{}');
  cats            text[] := coalesce(array(select jsonb_array_elements_text(ex -> 'categories')), '{}');
  inds            text[] := coalesce(array(select jsonb_array_elements_text(ex -> 'industries')), '{}');
  deliv_ids       text[] := case when jsonb_typeof(ex -> 'delivery_ids') = 'array'
                                 then coalesce(array(select jsonb_array_elements_text(ex -> 'delivery_ids')), '{}')
                                 else '{}' end;
  v_cert          certification_status := coalesce(nullif(ex ->> 'certification','')::certification_status, 'none');
  plan_count      int := coalesce(jsonb_array_length(ex -> 'plans'), 0);
  layers          text[];
  n_layers        int;
  v_reach         int;
  v_risk          jsonb;
  v_prov          jsonb;
  v_price         jsonb;
  v_fn            text;
  changes         int := 0;
  kindmap         jsonb := jsonb_build_object(
    'models','model','frameworks','framework','tools_mcp','tool_mcp',
    'data_sources','data_source','integrations','integration',
    'deployment','deployment','languages','language');
  k text; val text; new_sig jsonb; old_sig jsonb; fld text;
begin
  if v_pid is null or ex is null then
    raise exception 'ingest_capture: payload needs capture_meta.source_product_id and an extract block';
  end if;

  if v_drive is not null then
    select id into v_capture from capture where drive_file_id = v_drive;
    if found then
      return jsonb_build_object('status','already_ingested','capture_id',v_capture);
    end if;
  end if;

  select id, asset_id into v_listing, v_asset
    from listing
   where marketplace_id = v_mkt and source_product_id = v_pid;

  if v_listing is null then
    insert into asset default values returning id into v_asset;

    begin
      insert into listing (marketplace_id, source_product_id, listing_url, asset_id)
      values (v_mkt, v_pid,
              coalesce(meta ->> 'listing_url',
                       'https://marketplace.microsoft.com/en-us/product/' || v_pid),
              v_asset)
      returning id into v_listing;
      v_new_listing := true;
    exception when unique_violation then
      -- Another transaction created this listing between the select and the
      -- insert. Its asset wins; ours is discarded unused.
      delete from asset where id = v_asset;
      select id, asset_id into v_listing, v_asset
        from listing
       where marketplace_id = v_mkt and source_product_id = v_pid;
      if v_listing is null then
        -- Unreachable under READ COMMITTED, where this re-read sees the very row
        -- that caused the conflict. Under REPEATABLE READ the snapshot predates
        -- that row, so say what happened here rather than failing three
        -- statements later at the capture insert, with a not-null violation that
        -- names a column and explains nothing.
        raise exception
          'ingest_capture: listing % on marketplace % vanished between the unique violation and the re-read',
          v_pid, v_mkt;
      end if;
      v_new_listing := false;
    end;

    if v_new_listing then
      update asset set primary_listing_id = v_listing where id = v_asset;

      -- A three level canonical slug chain. Every insert is guarded, so a
      -- collision can never abort the ingest, and FOUND is tested after each,
      -- because `on conflict do nothing` reports a skipped insert as not found:
      -- that is the only signal the slug was free. No guarded insert is left as
      -- the last statement of the chain, and the level reached is reported in
      -- the result so a sweep can surface which slug an asset actually got:
      --
      --   0  the marketplace's own product id, which is what /agent/[id] carries
      --   1  marketplace-productid, the first fallback, taken when another
      --      marketplace already holds that bare product id as its own slug
      --   2  the asset uuid as text, the terminal identity that cannot collide
      insert into asset_slug (slug, asset_id, is_canonical)
      values (v_pid, v_asset, true)
      on conflict (slug) do nothing;
      if found then
        v_slug_level := 0;
      else
        insert into asset_slug (slug, asset_id, is_canonical)
        values (v_mkt || '-' || v_pid, v_asset, true)
        on conflict (slug) do nothing;
        if found then
          v_slug_level := 1;
        else
          insert into asset_slug (slug, asset_id, is_canonical)
          values (v_asset::text, v_asset, true)
          on conflict (slug) do nothing;
          if found then
            v_slug_level := 2;
          end if;
        end if;
      end if;

      -- No path reaches the capture insert without a canonical slug. The uuid is
      -- unique and this asset was just created, so level 2 cannot itself
      -- collide; this is the terminal guarantee. It names the asset, marketplace
      -- and product id rather than letting the transaction commit with an asset
      -- that has no URL, which getPassportBySlug would then render as a confident
      -- 404 about a record that exists.
      if not exists (select 1 from asset_slug
                      where asset_id = v_asset and is_canonical) then
        raise exception
          'ingest_capture: asset % (marketplace %, source_product_id %) reached the capture insert with no canonical slug',
          v_asset, v_mkt, v_pid;
      end if;
    end if;
  else
    update listing set updated_at = now() where id = v_listing;
  end if;

  select id into v_prev from capture where listing_id = v_listing order by captured_at desc limit 1;

  v_hash := encode(sha256(convert_to(ex::text, 'UTF8')), 'hex');

  insert into capture (listing_id, captured_at, template_version, capture_complete,
                       missing, source_view_url, drive_file_id, drive_file_name,
                       raw, content_hash, ingest_source)
  values (v_listing, v_captured,
          coalesce(meta ->> 'template_version','2.0'),
          coalesce((meta ->> 'capture_complete')::boolean, true),
          coalesce(array(select jsonb_array_elements_text(meta -> 'missing')), '{}'),
          meta ->> 'source_view_url', v_drive, meta ->> 'drive_file_name',
          payload -> 'raw', v_hash,
          coalesce(nullif(payload ->> 'ingest_source','')::ingest_source, 'dual_write'))
  returning id into v_capture;

  hay_listing := concat_ws(E'\n', ex ->> 'name', ex ->> 'tagline', ex ->> 'overview_text',
                           immutable_array_text(works));
  hay_cert := concat_ws(E'\n', cert_d ->> 'hosting', cert_d ->> 'data_location',
                        cert_d ->> 'data_handling',
                        immutable_array_text(perms), immutable_array_text(compl));

  for k in select jsonb_object_keys(coalesce(ex -> 'stated', '{}'::jsonb)) loop
    if kindmap ? k then
      for val in select jsonb_array_elements_text((ex -> 'stated') -> k) loop
        if val is null or btrim(val) = '' then continue; end if;
        insert into capture_evidence (capture_id, kind, value, source, verified)
        values (v_capture, (kindmap ->> k)::evidence_kind, val,
                (case when position(val in hay_listing) > 0 then 'listing'
                      else 'certification' end)::evidence_source,
                position(val in hay_listing) > 0 or position(val in hay_cert) > 0)
        on conflict (capture_id, kind, value) do nothing;
      end loop;
    end if;
  end loop;

  if coalesce(array_length(perms, 1), 0) > 0 then
    insert into capture_evidence (capture_id, kind, value, source, verified)
    values (v_capture, 'tool_mcp', 'Microsoft Graph', 'certification', true)
    on conflict (capture_id, kind, value) do nothing;
  end if;

  insert into capture_plan (capture_id, position, name, price, unit, billing)
  select v_capture, ord::int, p ->> 'name', p ->> 'price', p ->> 'unit', p ->> 'billing'
    from jsonb_array_elements(coalesce(ex -> 'plans','[]'::jsonb)) with ordinality as t(p, ord)
  on conflict (capture_id, position) do nothing;

  insert into capture_link (capture_id, kind, label, url, position)
  select v_capture, 'product', l ->> 'label', l ->> 'url', ord::int
    from jsonb_array_elements(coalesce(ex -> 'product_links','[]'::jsonb)) with ordinality as t(l, ord)
   where l ->> 'url' is not null;

  insert into capture_link (capture_id, kind, label, url, position)
  select v_capture, 'legal', l ->> 'label', l ->> 'url', ord::int
    from jsonb_array_elements(coalesce(ex -> 'legal_links','[]'::jsonb)) with ordinality as t(l, ord)
   where l ->> 'url' is not null;

  insert into capture_link (capture_id, kind, label, url, position)
  select v_capture, 'media', null, u, ord::int
    from jsonb_array_elements_text(coalesce(ex -> 'media_image_urls','[]'::jsonb)) with ordinality as t(u, ord);

  insert into capture_permission (capture_id, permission)
  select v_capture, unnest(perms) on conflict do nothing;

  insert into capture_compliance (capture_id, certification)
  select v_capture, unnest(compl) on conflict do nothing;

  layers := array_remove(array[
    case when nullif(ex ->> 'publisher','') is not null then 'vendor identity' end,
    case when exists (select 1 from capture_evidence where capture_id = v_capture and kind = 'model' and verified) then 'model' end,
    case when exists (select 1 from capture_evidence where capture_id = v_capture and kind = 'framework' and verified) then 'framework' end,
    case when exists (select 1 from capture_evidence where capture_id = v_capture and kind = 'tool_mcp' and verified)
              or coalesce(array_length(perms,1),0) > 0 then 'tools and MCP' end,
    case when exists (select 1 from capture_evidence where capture_id = v_capture and kind = 'data_source' and verified) then 'data sources' end,
    case when exists (select 1 from capture_evidence where capture_id = v_capture and kind = 'integration' and verified)
              or coalesce(array_length(works,1),0) > 0 then 'integrations' end,
    case when nullif(cert_d ->> 'hosting','') is not null then 'hosting' end,
    case when nullif(cert_d ->> 'data_location','') is not null then 'data residency' end,
    case when v_cert in ('microsoft_365_certified','publisher_attestation') then 'permission scope' end,
    case when nullif(ex ->> 'pricing','') is not null or plan_count > 0 then 'pricing' end,
    case when nullif(ex ->> 'acquire_using','') is not null then 'access model' end,
    case when nullif(ex ->> 'support','') is not null then 'support channel' end
  ]::text[], null);

  n_layers := coalesce(array_length(layers,1), 0);
  v_reach  := round(100.0 * n_layers / array_length(registry_layers(),1));
  v_risk   := registry_risk(v_cert, n_layers);
  v_prov   := registry_provenance(v_cert);
  v_price  := registry_price(ex ->> 'pricing', plan_count);

  select coalesce(
           (select fo.function_category from function_override fo
             where fo.marketplace_id = v_mkt and fo.source_product_id = v_pid),
           registry_function_category(ex ->> 'name', ex ->> 'tagline', cats))
    into v_fn;

  insert into capture_extract (
    capture_id, extract_spec_version, name, publisher, tagline,
    surfaces, categories, industries, works_with,
    pricing, acquire_using, listing_version, listing_updated, overview_text, support,
    rating, rating_count, native_rating, native_count,
    external_source, external_rating, external_count,
    certification, cert_url, cert_hosting, cert_data_location, cert_data_handling,
    cert_developer_updated, cert_page_updated,
    function_category, delivery, price_band, price_note,
    known_layers, reach, provenance, evidence_tier, risk, risk_basis)
  values (
    v_capture, coalesce(ex ->> 'extract_spec_version','v2'),
    coalesce(ex ->> 'name','Unnamed listing'), ex ->> 'publisher', ex ->> 'tagline',
    surfaces, cats, inds, works,
    ex ->> 'pricing', ex ->> 'acquire_using', ex ->> 'version',
    registry_safe_date(ex ->> 'updated'), ex ->> 'overview_text', ex ->> 'support',
    (ex ->> 'rating')::numeric, coalesce((ex ->> 'rating_count')::int, 0),
    (ex ->> 'native_rating')::numeric, (ex ->> 'native_count')::int,
    ex ->> 'external_source', (ex ->> 'external_rating')::numeric, (ex ->> 'external_count')::int,
    v_cert, ex ->> 'cert_url', cert_d ->> 'hosting', cert_d ->> 'data_location',
    cert_d ->> 'data_handling',
    registry_safe_date(cert_d ->> 'developer_last_updated'),
    registry_safe_date(cert_d ->> 'page_last_updated'),
    v_fn, registry_delivery(surfaces, cert_d ->> 'hosting', deliv_ids),
    v_price ->> 'band', v_price ->> 'note',
    layers, v_reach, (v_prov ->> 'provenance')::provenance_status,
    v_prov ->> 'tier', (v_risk ->> 'risk')::risk_band, v_risk ->> 'basis');

  if v_prev is not null then
    select jsonb_build_object(
      'pricing', e.pricing, 'price_band', e.price_band,
      'certification', e.certification, 'cert_hosting', e.cert_hosting,
      'cert_data_location', e.cert_data_location,
      'listing_version', e.listing_version, 'listing_updated', e.listing_updated,
      'rating', e.rating, 'reach', e.reach, 'risk', e.risk,
      'surfaces', to_jsonb(e.surfaces),
      'graph_permissions', (select coalesce(jsonb_agg(permission order by permission),'[]')
                              from capture_permission where capture_id = v_prev),
      'compliance', (select coalesce(jsonb_agg(certification order by certification),'[]')
                       from capture_compliance where capture_id = v_prev),
      'plans', (select coalesce(jsonb_agg(jsonb_build_object('name',name,'price',price) order by position),'[]')
                  from capture_plan where capture_id = v_prev),
      'evidence', (select coalesce(jsonb_object_agg(kind, vals),'{}') from (
                     select kind::text as kind, jsonb_agg(value order by value) as vals
                       from capture_evidence where capture_id = v_prev and verified group by kind) s)
    ) into old_sig from capture_extract e where e.capture_id = v_prev;

    select jsonb_build_object(
      'pricing', e.pricing, 'price_band', e.price_band,
      'certification', e.certification, 'cert_hosting', e.cert_hosting,
      'cert_data_location', e.cert_data_location,
      'listing_version', e.listing_version, 'listing_updated', e.listing_updated,
      'rating', e.rating, 'reach', e.reach, 'risk', e.risk,
      'surfaces', to_jsonb(e.surfaces),
      'graph_permissions', (select coalesce(jsonb_agg(permission order by permission),'[]')
                              from capture_permission where capture_id = v_capture),
      'compliance', (select coalesce(jsonb_agg(certification order by certification),'[]')
                       from capture_compliance where capture_id = v_capture),
      'plans', (select coalesce(jsonb_agg(jsonb_build_object('name',name,'price',price) order by position),'[]')
                  from capture_plan where capture_id = v_capture),
      'evidence', (select coalesce(jsonb_object_agg(kind, vals),'{}') from (
                     select kind::text as kind, jsonb_agg(value order by value) as vals
                       from capture_evidence where capture_id = v_capture and verified group by kind) s)
    ) into new_sig from capture_extract e where e.capture_id = v_capture;

    for fld in select jsonb_object_keys(new_sig) loop
      if (old_sig -> fld) is distinct from (new_sig -> fld) then
        insert into listing_change (listing_id, from_capture_id, to_capture_id,
                                    observed_at, field, old_value, new_value)
        values (v_listing, v_prev, v_capture, v_captured, fld, old_sig -> fld, new_sig -> fld);
        changes := changes + 1;
      end if;
    end loop;
  end if;

  update listing
     set current_capture_id = v_capture, last_captured_at = v_captured,
         capture_count = capture_count + 1, updated_at = now()
   where id = v_listing;

  return jsonb_build_object(
    'status', case when v_prev is null then 'created' else 'updated' end,
    'listing_id', v_listing, 'asset_id', v_asset, 'capture_id', v_capture,
    'slug_fallback', v_slug_level,
    'content_hash', v_hash, 'unchanged', (v_prev is not null and changes = 0),
    'changes', changes, 'reach', v_reach, 'risk', v_risk ->> 'risk',
    'layers_known', n_layers,
    'evidence_rejected', (select count(*) from capture_evidence
                           where capture_id = v_capture and not verified));
end $fn$;

-- 20260819100300 ends this same pair with a doubled semicolon, which Postgres
-- reads as an empty statement and ignores. It is not copied forward here. That
-- file is left alone rather than tidied: production stores a migration's full
-- text in schema_migrations.statements, so editing an applied migration makes
-- the file on disk disagree with the record of what was actually run.
revoke all on function ingest_capture(jsonb) from public, anon, authenticated;
grant execute on function ingest_capture(jsonb) to service_role;


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
  'One row per product at its primary listing''s latest capture, sized for the registry grid. asset_id is the product; listing_id is the listing the headline fields came from. last_captured_at, capture_count, marketplace_ids, listing_count and search_blob span every listing of the product; certification, cert_label, provenance, evidence_tier, risk, risk_basis, known_layers, layers_known and reach all come from the qualifying listing, which need not be the primary one. Does not carry overview text. canonical_slug is the asset''s canonical URL slug, what the grid links /agent/ from.';

grant select on public.v_registry_card to anon, authenticated;
