-- registry_delivery() gains an AWS branch, and ingest_capture() feeds it.
--
-- This discharges the follow-up recorded at the end of
-- 20260820120000_add_aws_marketplace.sql. Every AWS listing derived delivery
-- 'Unknown' because the function reads extract.surfaces first and falls back to
-- cert_detail.hosting, and AWS listings have neither: there is no data node
-- behind the rendered "Supported services" row, and AWS publishes no
-- certification questionnaire. Both are permanent on the evidence available,
-- so the fix is not to fill those two fields but to read the third thing AWS
-- does state.
--
-- WHAT AWS STATES is a fulfilment option type, at
-- fulfillmentOptions[].fulfillmentOptionType. The adapter now copies the
-- DISTINCT type ids into a new source-neutral extract key, delivery_ids, and
-- this function switches on them.
--
-- THE IDS, NEVER THE DISPLAY NAMES. AWS publishes both:
-- fulfillmentOptionTypeId "AMAZON_MACHINE_IMAGE" beside
-- fulfillmentOptionTypeName "Amazon Machine Image". The id is the stable
-- machine value; the name is a label AWS renders and is free to reword, and it
-- is already localised in the page's UI translation table. A CASE written
-- against the names would go silently to 'Unknown' the day AWS retitled
-- "Container Image", and nothing would fail: the column would simply stop being
-- filled. The names are not discarded, they are what a reader sees, joined into
-- extract.acquire_using exactly as before this migration. delivery_ids is what
-- the derivation switches on; acquire_using is what the passport prints.
--
-- THE MAPPING, and it is OURS, not AWS's. delivery has always been the
-- registry's own classification, and the values must stay inside the set this
-- function already returns, which is the set the facet rail offers.
--
--   AMAZON_MACHINE_IMAGE     -> 'Virtual machine'  an AMI boots as an EC2
--                               instance, the same thing Microsoft's 'Virtual
--                               Machines' surface chip already maps to
--   CONTAINER                -> 'Container'
--   HELM                     -> 'Container'        a Helm chart is a Kubernetes
--                               package of container images, and what the buyer
--                               runs is containers
--   SAAS                     -> 'SaaS'
--   API                      -> 'SaaS'             an API-based product is
--                               reached over the network on infrastructure the
--                               seller runs, which is what 'SaaS' means here.
--                               It collapses two ids AWS keeps apart, in the
--                               same way the Microsoft branch above collapses
--                               twelve surface chips into 'Microsoft 365 app'.
--                               Nothing is lost to a reader: acquire_using
--                               still says "API-Based Agents & Tools" in AWS's
--                               own words.
--
-- FIVE IDS ARE DELIBERATELY LEFT UNMAPPED and fall through to 'Unknown',
-- because this function has no honest label for them and inventing one would be
-- worse than saying nothing:
--
--   CLOUDFORMATION_TEMPLATE  a template deployed into the buyer's own AWS
--                            account. Its structural counterpart in the set is
--                            'Azure application', and naming Azure on an AWS
--                            listing would be a false statement about which
--                            cloud the thing runs on.
--   SAGEMAKER_MODEL          deployed to a SageMaker endpoint. Container
--                            packaging is an implementation detail the listing
--                            does not state, so 'Container' would be our
--                            inference presented as AWS's.
--   SAGEMAKER_ALGORITHM      the same.
--   DATA_EXCHANGE            a data product. Not a software delivery method at
--                            all, and no value in the set describes it.
--   PROFESSIONAL_SERVICES    a human engagement. Nothing is delivered to run.
--
-- 'Unknown' for these is a true statement about what this function can say, and
-- extract.acquire_using still carries AWS's own words for every one of them.
-- Widening the value set to cover them cleanly is a separate change, because
-- the set is currently Microsoft-shaped and adding to it touches the facet rail
-- and every card.
--
-- PRECEDENCE. A listing can carry several fulfilment options, so delivery_ids
-- can hold more than one id. The branches below are tried in a fixed literal
-- order and the first match wins, which is how the Microsoft branches above
-- already work. That makes the result independent of the order the adapter
-- emitted the ids in, so it is deterministic even though delivery_ids is
-- AWS-ordered, and it stays deterministic if AWS reorders fulfillmentOptions.
--
-- ORDERING IS WHAT KEEPS MICROSOFT AND DRAI UNCHANGED. The AWS branch is added
-- AFTER every existing branch and BEFORE the final else, so any row that
-- matched an earlier branch still matches that same branch first. The new
-- parameter has a default of null, so the existing two-argument call sites keep
-- resolving, and 'X' = any(null) is null rather than true, so a row with no
-- delivery_ids cannot reach the new branch at all.
--
-- MICROSOFT'S EMPTY DELIVERY IS A DIFFERENT PROBLEM AND THIS DOES NOT FIX IT.
-- Most Microsoft listings still derive 'Unknown', for two causes that are
-- untouched here and are not about this function:
--   1. scripts/lib/sources/microsoft.mjs reads the products field, which is a
--      bitmask object rather than an array, so surfaces arrives empty.
--   2. cert_hosting is null because the certification pass has not been run
--      over the catalogue.
-- Neither is addressed by this migration. A later reader finding Microsoft
-- still mostly 'Unknown' after this landed is looking at those two, not at a
-- regression here.
--
-- WHY THE DROP, and it is not optional. `create or replace` matches on the
-- argument types, so creating registry_delivery(text[], text, text[]) leaves
-- the two-argument function standing beside it rather than replacing it.
-- Postgres prefers an exact arity match, so every existing two-argument call
-- would keep resolving to the OLD body and this migration would appear to have
-- done nothing. The two-argument function is dropped first, and afterwards a
-- two-argument call resolves to the new function through the default. Nothing
-- depends on it: pg_proc shows one caller, ingest_capture, whose plpgsql body
-- is stored as text and carries no dependency, and no view or generated column
-- references it.

drop function if exists public.registry_delivery(text[], text);

create or replace function registry_delivery(
  p_surfaces text[], p_cert_hosting text, p_delivery_ids text[] default null
) returns text language sql immutable parallel safe as $$
  select case
    when 'Virtual Machines'    = any(p_surfaces) then 'Virtual machine'
    when 'Containers'          = any(p_surfaces) then 'Container'
    when 'Azure Applications'  = any(p_surfaces) then 'Azure application'
    when p_surfaces && array['Teams','Outlook','Office app','Microsoft 365 Copilot',
                             'Dragon Copilot','Power Apps','Power Automate',
                             'Power Virtual Agents','UiPath Autopilot',
                             'Dynamics 365 Sales','Dynamics 365 Customer Service',
                             'Dynamics 365 Field Service']
      then 'Microsoft 365 app'
    when 'SaaS' = any(p_surfaces) then 'SaaS'
    when lower(coalesce(p_cert_hosting,'')) like '%saas%' then 'SaaS'
    when lower(coalesce(p_cert_hosting,'')) like '%paas%' then 'Vendor cloud (PaaS)'
    when lower(coalesce(p_cert_hosting,'')) like '%iaas%' then 'Vendor cloud (IaaS)'
    when lower(coalesce(p_cert_hosting,'')) like '%isvhosted%' then 'ISV hosted'
    -- AWS fulfilment option type ids. See the header for the mapping, for the
    -- five ids left out of it, and for why this reads ids and not names.
    when 'AMAZON_MACHINE_IMAGE' = any(p_delivery_ids) then 'Virtual machine'
    when p_delivery_ids && array['CONTAINER','HELM'] then 'Container'
    when p_delivery_ids && array['SAAS','API'] then 'SaaS'
    else 'Unknown'
  end
$$;

-- The drop took the pin from 20260816171453_pin_function_search_paths.sql with
-- it. Reapplied here against the new signature, identical setting.
alter function public.registry_delivery(text[], text, text[])
  set search_path = pg_catalog, public;

-- ingest_capture() is recreated for one reason: to pass delivery_ids through.
-- The body below is COPIED from 20260819100300_asset_layer_write_path.sql, not
-- retyped, and exactly one line differs from it, the registry_delivery call in
-- the capture_extract insert. The evidence verification gate, the two haystacks
-- through the Microsoft Graph rule, is byte for byte what that file holds.
-- The region runs from the line beginning hay_listing := concat_ws( down to
-- the end if; that closes the Microsoft Graph rule, both lines included, and
-- over it sha256 reads the same in both files:
--
--   da56d8f9c1f4763269cf9b441cba049a59b8131463163bf456e24b45e5a41852  as
--   the bytes sit on disk, CRLF included
--   2fe4306cffb3ca6be2fb1d323f898e0eaefd8c1c9d78edd2a1c2d51a9cbeddc7  with
--   line endings normalised to LF, which is what git stores
--
-- The new argument is read with the same shape the declare block already uses
-- for surfaces, categories and industries, so an extract with no delivery_ids
-- key yields '{}' rather than raising. It is inline rather than a new declared
-- variable so that the diff against the previous definition is one line and can
-- be checked at a glance.

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
    v_fn, registry_delivery(surfaces, cert_d ->> 'hosting', coalesce(array(select jsonb_array_elements_text(ex -> 'delivery_ids')), '{}')),
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
