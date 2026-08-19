-- The write path moves onto the asset layer.
--
-- A plpgsql body is stored as text, so the rename in 20260819100000 left both
-- of these functions naming a table that no longer exists, and neither of them
-- fails until it is called. This file recreates both against the new shape. It
-- is the first point in the plan at which the write path works again.
--
-- The evidence verification gate is carried over character for character from
-- 20260816163520: the two haystacks, the loop over the stated block, and the
-- Microsoft Graph rule that follows them. What counts as verified is the one
-- thing this registry is built on, so no task that is really about table names
-- gets to touch it. The migration is generated with that region copied rather
-- than retyped, and the check in the commit message proves it came through.
--
-- listing.asset_id is not null, and NOT NULL cannot be deferred, so there is no
-- instant at which a listing exists without an asset. The asset is created
-- first and the listing is inserted already carrying it. Two harvesters racing
-- on the same product both reach that insert; the loser catches
-- unique_violation, deletes the asset it made and adopts the winner's, so a
-- race costs an unused uuid and never a duplicate product.
--
-- The canonical slug is the marketplace's own product id, which is what
-- /agent/[id] already carries. Should some other marketplace ever ship the same
-- id, the second one falls back to marketplace-productid and says so in
-- slug_fallback, rather than failing the ingest over a URL.
--
-- asset_id stays in the return object and now means the product rather than the
-- listing. No harvest script reads it: every .mjs reads status, reach and risk
-- only. Keeping the key rather than dropping it is deliberate, because a script
-- that starts reading it later should get the product.

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
  v_slug_fallback boolean := false;
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

      insert into asset_slug (slug, asset_id, is_canonical)
      values (v_pid, v_asset, true)
      on conflict (slug) do nothing;

      if not found then
        insert into asset_slug (slug, asset_id, is_canonical)
        values (v_mkt || '-' || v_pid, v_asset, true);
        v_slug_fallback := true;
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
    v_fn, registry_delivery(surfaces, cert_d ->> 'hosting'),
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
    'slug_fallback', v_slug_fallback,
    'content_hash', v_hash, 'unchanged', (v_prev is not null and changes = 0),
    'changes', changes, 'reach', v_reach, 'risk', v_risk ->> 'risk',
    'layers_known', n_layers,
    'evidence_rejected', (select count(*) from capture_evidence
                           where capture_id = v_capture and not verified));
end $fn$;

revoke all on function ingest_capture(jsonb) from public, anon, authenticated;
grant execute on function ingest_capture(jsonb) to service_role;;

-- Called by the capture worker once it has identified, in the live DOM, which
-- image is the product logo. Idempotent per capture.
create or replace function set_capture_logo(
  p_product_id text,
  p_url text,
  p_marketplace_id text default 'microsoft'
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $fn$
declare v_capture uuid; v_link bigint; v_existing text;
begin
  select l.current_capture_id into v_capture
    from listing l
   where l.marketplace_id = p_marketplace_id and l.source_product_id = p_product_id;
  if v_capture is null then
    return jsonb_build_object('status','no_capture','product_id',p_product_id);
  end if;

  select url into v_existing from capture_link
   where capture_id = v_capture and kind = 'logo' limit 1;

  if v_existing is not null then
    if v_existing = p_url then
      return jsonb_build_object('status','unchanged','capture_id',v_capture);
    end if;
    update capture_link
       set url = p_url, archived_url = null, archived_at = null,
           content_hash = null, bytes = null, content_type = null
     where capture_id = v_capture and kind = 'logo'
     returning id into v_link;
    return jsonb_build_object('status','replaced','capture_id',v_capture,'link_id',v_link);
  end if;

  insert into capture_link (capture_id, kind, label, url, position)
  values (v_capture, 'logo', 'Product logo', p_url, 0)
  returning id into v_link;
  return jsonb_build_object('status','set','capture_id',v_capture,'link_id',v_link);
end $fn$;

revoke all on function set_capture_logo(text, text, text) from public, anon, authenticated;
grant execute on function set_capture_logo(text, text, text) to service_role;
