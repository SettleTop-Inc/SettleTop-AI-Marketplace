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

  -- registry_search, after the third capture of seed-alpha and after step 5 has
  -- moved a listing between assets and put it back. Both are why these run
  -- again rather than being taken on trust from step 3: the blob is rebuilt
  -- from the current capture on every read, and 5u wrote to the column that
  -- decides which asset a listing belongs to.
  perform gate.check_search_total('7. final read, after every write');
  perform gate.check_search_term('7. final read, after every write', 'invoices', 'seed-beta');
  perform gate.check_search_term('7. final read, after every write', 'triage', 'seed-gamma');
  perform gate.check_search_escape('7. final read, after every write');
  perform gate.check_search_source('7. final read, after every write');
  perform gate.check_search_sort('7. final read, after every write');
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

-- ===========================================================================
-- 10. The delivery derivation, and the AWS branch that
--     20260820140000_registry_delivery_aws.sql added to it.
--
-- This step exists because that branch shipped with no automated coverage at
-- all. Before it, grepping scripts/gate/*.sql for "delivery" returned nothing,
-- and the 45 tests in scripts/lib/sources/aws.test.mjs prove only that the
-- ADAPTER emits delivery_ids: not one of them reaches the CASE that consumes
-- them. So the single change to the most dangerous function in the repository
-- had no proof in CI that AMAZON_MACHINE_IMAGE yields 'Virtual machine', that
-- an unmapped id yields 'Unknown', or that Microsoft and DRAI still land where
-- they landed before.
--
-- It runs LAST, after every other assertion has finished reading the registry,
-- so the listings it adds cannot move a count an earlier check depends on.
-- ===========================================================================

-- 10a. A standing copy of the PRE-MIGRATION function.
--
-- "Microsoft and DRAI are unaffected" is the constraint the whole migration was
-- written around, and until now it was only ever asserted in prose. The body
-- below is the two-argument registry_delivery exactly as
-- 20260816163106_registry_derivation.sql:71 defined it, which is what
-- production ran before the new migration; the pin migration only ever set its
-- search_path. It lives in the gate schema under a different name so it can
-- stand BESIDE the new function instead of replacing it, and 10c then compares
-- the two over the same inputs rather than trusting either.
create or replace function gate.registry_delivery_v0(p_surfaces text[], p_cert_hosting text)
returns text language sql immutable parallel safe as $v0$
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
    else 'Unknown'
  end
$v0$;

-- Assert one scalar SQL expression equals one expected value.
--
-- The call is spliced as text so a two-argument call and a three-argument call
-- can be checked through the same helper, which matters here: whether
-- registry_delivery(a, b) still resolves at all is one of the things under
-- test. An expected NULL is compared with IS NOT DISTINCT FROM, so a check
-- cannot pass by both sides being null when neither should be.
create or replace function gate.check_value(p_step text, p_object text, p_call text,
                                            p_expect_value text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare got text; ok boolean; v text; note text := '';
begin
  begin
    execute format('select (%s)::text', p_call) into got;
    ok := got is not distinct from p_expect_value;
    v := gate.expect(ok, p_expect);
    note := format('%s => %L, expected %L', p_call,
                   coalesce(got, '(null)'), coalesce(p_expect_value, '(null)'));
  exception when others then
    v := 'ERROR ' || sqlstate;
    note := sqlerrm || ' :: ' || p_call;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'postgres', p_object, null, v, note);
end $fn$;

-- The delivery a listing actually ended up with, read back out of
-- capture_extract for its CURRENT capture. This is the whole write path, not
-- the function in isolation: adapter shape, jsonb read, derivation, insert.
create or replace function gate.check_capture_delivery(p_step text, p_pid text,
                                                       p_expect_value text,
                                                       p_expect text default 'green')
returns void language plpgsql as $fn$
declare got text; n int; ok boolean; v text; note text := '';
begin
  begin
    select count(*) into n from listing where source_product_id = p_pid;
    select e.delivery into got
      from capture_extract e
      join listing l on l.current_capture_id = e.capture_id
     where l.source_product_id = p_pid;
    -- A missing listing must FAIL rather than pass on two nulls, which is the
    -- exact vacuous shape the rest of this gate exists to hunt.
    ok := n = 1 and got is not distinct from p_expect_value;
    v := gate.expect(ok, p_expect);
    note := format('%L: %s listing(s), delivery %L, expected %L', p_pid, n,
                   coalesce(got, '(null)'), coalesce(p_expect_value, '(null)'));
  exception when others then
    v := 'ERROR ' || sqlstate;
    note := sqlerrm || ' :: ' || p_pid;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'postgres', 'capture_extract.delivery', n, v, note);
end $fn$;

-- 10b. The drop actually happened, and the search_path pin came back with it.
--
-- Without the drop, `create or replace` on the three-argument signature would
-- leave the two-argument function standing beside it, Postgres would prefer the
-- exact arity match, and every existing call would keep resolving to the OLD
-- body: the migration would appear to have done nothing. No value assertion can
-- see that, because the old body answers a two-argument call correctly. Only
-- the catalog can, so the catalog is what is read.
do $$
declare n_fns int; n_args int; cfg text;
begin
  select count(*) into n_fns
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'registry_delivery';
  select p.pronargs, array_to_string(p.proconfig, ',') into n_args, cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'registry_delivery'
   limit 1;

  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('10b. registry_delivery signature', 'postgres', 'pg_proc', n_fns,
          gate.expect(n_fns = 1 and n_args = 3, 'green'),
          format('%s function(s) named registry_delivery, %s argument(s)', n_fns, n_args));

  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('10b. registry_delivery search_path pin', 'postgres', 'pg_proc.proconfig', n_fns,
          gate.expect(cfg = 'search_path=pg_catalog, public', 'green'),
          format('proconfig %L, expected %L', coalesce(cfg, '(none)'),
                 'search_path=pg_catalog, public'));
end $$;

-- 10c. THE REGRESSION PIN. The new function and the pre-migration copy agree on
-- every (surfaces, cert_hosting) pair, three ways: a two-argument call, an
-- explicit null third argument, and the '{}' the write path passes when an
-- extract carries no delivery_ids. Any disagreement is a Microsoft or DRAI
-- behaviour change and there must be none.
--
-- The surfaces list is every chip the function names, plus combinations that
-- straddle two branches so branch ORDER is pinned and not just branch presence,
-- plus the empty array and a null. The hosting list is every substring the
-- fallbacks match, in both cases, plus values that match none.
do $$
declare n_tot int; n_bad int; worst text;
begin
  with s(surfaces) as (values
    ('{"Virtual Machines"}'::text[]), ('{Containers}'::text[]),
    ('{"Azure Applications"}'::text[]), ('{Teams}'::text[]), ('{Outlook}'::text[]),
    ('{"Office app"}'::text[]), ('{"Microsoft 365 Copilot"}'::text[]),
    ('{"Dragon Copilot"}'::text[]), ('{"Power Apps"}'::text[]),
    ('{"Power Automate"}'::text[]), ('{"Power Virtual Agents"}'::text[]),
    ('{"UiPath Autopilot"}'::text[]), ('{"Dynamics 365 Sales"}'::text[]),
    ('{"Dynamics 365 Customer Service"}'::text[]),
    ('{"Dynamics 365 Field Service"}'::text[]), ('{SaaS}'::text[]),
    ('{Web}'::text[]), ('{Teams,Outlook}'::text[]),
    ('{"Virtual Machines",SaaS}'::text[]), ('{Containers,Teams}'::text[]),
    ('{SaaS,Teams}'::text[]), ('{"Azure Applications",Containers}'::text[]),
    ('{}'::text[]), (null::text[])
  ), h(hosting) as (values
    ('Microsoft Azure'), ('SaaS'), ('saas'), ('Multi-tenant SaaS'), ('PaaS'),
    ('paas'), ('IaaS'), ('iaas'), ('ISVHosted'), ('isvhosted'),
    ('ISV hosted'), ('AWS'), ('Google Cloud'), (''), (null)
  )
  select count(*),
         count(*) filter (where
              registry_delivery(s.surfaces, h.hosting)
                is distinct from gate.registry_delivery_v0(s.surfaces, h.hosting)
           or registry_delivery(s.surfaces, h.hosting, null)
                is distinct from gate.registry_delivery_v0(s.surfaces, h.hosting)
           or registry_delivery(s.surfaces, h.hosting, '{}')
                is distinct from gate.registry_delivery_v0(s.surfaces, h.hosting)),
         min(format('surfaces %L hosting %L: v0 %L new %L',
                    s.surfaces, h.hosting,
                    gate.registry_delivery_v0(s.surfaces, h.hosting),
                    registry_delivery(s.surfaces, h.hosting)))
           filter (where registry_delivery(s.surfaces, h.hosting)
                     is distinct from gate.registry_delivery_v0(s.surfaces, h.hosting))
    into n_tot, n_bad, worst
    from s cross join h;

  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('10c. new function equals pre-migration function', 'postgres',
          'registry_delivery vs gate.registry_delivery_v0', n_tot,
          gate.expect(n_tot > 0 and n_bad = 0, 'green'),
          format('%s (surfaces, hosting) pairs, each checked 3 ways, %s disagreement(s)%s',
                 n_tot, n_bad, coalesce('; first: ' || worst, '')));
end $$;

-- 10d. THE AWS MAPPING, every observed id on its own.
--
-- Written as one line per id rather than a loop over a table of (id, expected),
-- because such a table is a second copy of the mapping and would agree with a
-- wrong CASE just as happily as with a right one. Ten ids are recorded in
-- 20260820120000_add_aws_marketplace.sql; all ten are here.
do $$
declare st text := '10d. AWS fulfilment id maps to delivery';
begin
  perform gate.check_value(st, 'AMAZON_MACHINE_IMAGE',
    $q$registry_delivery('{}', null, '{AMAZON_MACHINE_IMAGE}')$q$,    'Virtual machine');
  perform gate.check_value(st, 'CONTAINER',
    $q$registry_delivery('{}', null, '{CONTAINER}')$q$,               'Container');
  perform gate.check_value(st, 'HELM',
    $q$registry_delivery('{}', null, '{HELM}')$q$,                    'Container');
  perform gate.check_value(st, 'SAAS',
    $q$registry_delivery('{}', null, '{SAAS}')$q$,                    'SaaS');
  perform gate.check_value(st, 'API',
    $q$registry_delivery('{}', null, '{API}')$q$,                     'SaaS');
  -- The five deliberately left unmapped. These are the assertions that would
  -- catch someone inventing a label later without the vocabulary decision the
  -- migration header asks the owner to take.
  perform gate.check_value(st, 'CLOUDFORMATION_TEMPLATE',
    $q$registry_delivery('{}', null, '{CLOUDFORMATION_TEMPLATE}')$q$, 'Unknown');
  perform gate.check_value(st, 'SAGEMAKER_MODEL',
    $q$registry_delivery('{}', null, '{SAGEMAKER_MODEL}')$q$,         'Unknown');
  perform gate.check_value(st, 'SAGEMAKER_ALGORITHM',
    $q$registry_delivery('{}', null, '{SAGEMAKER_ALGORITHM}')$q$,     'Unknown');
  perform gate.check_value(st, 'DATA_EXCHANGE',
    $q$registry_delivery('{}', null, '{DATA_EXCHANGE}')$q$,           'Unknown');
  perform gate.check_value(st, 'PROFESSIONAL_SERVICES',
    $q$registry_delivery('{}', null, '{PROFESSIONAL_SERVICES}')$q$,   'Unknown');
  -- An id AWS has not published yet must degrade, not guess.
  perform gate.check_value(st, 'an id nobody has seen',
    $q$registry_delivery('{}', null, '{QUANTUM_TOASTER}')$q$,         'Unknown');
end $$;

-- 10e. PRECEDENCE, both as determinism and as outcome.
--
-- Each pair is asserted in BOTH orders. Equal answers prove the result does not
-- depend on the order the adapter emitted the ids in; the answer itself is the
-- editorial call the migration header states, that the more of the stack the
-- buyer runs the higher the id ranks. Pinning the outcome is the point: a
-- reordered CASE would still be deterministic and would still be wrong.
do $$
declare st text := '10e. AWS precedence over several ids';
begin
  perform gate.check_value(st, 'AMI before CLOUDFORMATION_TEMPLATE',
    $q$registry_delivery('{}', null, '{AMAZON_MACHINE_IMAGE,CLOUDFORMATION_TEMPLATE}')$q$, 'Virtual machine');
  perform gate.check_value(st, 'and the same reversed',
    $q$registry_delivery('{}', null, '{CLOUDFORMATION_TEMPLATE,AMAZON_MACHINE_IMAGE}')$q$, 'Virtual machine');
  perform gate.check_value(st, 'AMI before SAAS',
    $q$registry_delivery('{}', null, '{AMAZON_MACHINE_IMAGE,SAAS}')$q$, 'Virtual machine');
  perform gate.check_value(st, 'AMI before SAAS reversed',
    $q$registry_delivery('{}', null, '{SAAS,AMAZON_MACHINE_IMAGE}')$q$, 'Virtual machine');
  perform gate.check_value(st, 'AMI before CONTAINER',
    $q$registry_delivery('{}', null, '{CONTAINER,AMAZON_MACHINE_IMAGE}')$q$, 'Virtual machine');
  perform gate.check_value(st, 'CONTAINER before SAAS',
    $q$registry_delivery('{}', null, '{CONTAINER,SAAS}')$q$, 'Container');
  perform gate.check_value(st, 'CONTAINER before SAAS reversed',
    $q$registry_delivery('{}', null, '{SAAS,CONTAINER}')$q$, 'Container');
  perform gate.check_value(st, 'HELM before API',
    $q$registry_delivery('{}', null, '{API,HELM}')$q$, 'Container');
  perform gate.check_value(st, 'CONTAINER and HELM agree, so order is moot',
    $q$registry_delivery('{}', null, '{CONTAINER,HELM}')$q$, 'Container');
  perform gate.check_value(st, 'an unmapped id does not mask a mapped one',
    $q$registry_delivery('{}', null, '{PROFESSIONAL_SERVICES,SAAS}')$q$, 'SaaS');
  perform gate.check_value(st, 'nor reversed',
    $q$registry_delivery('{}', null, '{SAAS,PROFESSIONAL_SERVICES}')$q$, 'SaaS');
  perform gate.check_value(st, 'all five unmapped together are still Unknown',
    $q$registry_delivery('{}', null, '{CLOUDFORMATION_TEMPLATE,SAGEMAKER_MODEL,SAGEMAKER_ALGORITHM,DATA_EXCHANGE,PROFESSIONAL_SERVICES}')$q$,
    'Unknown');
end $$;

-- 10f. The AWS branch cannot pre-empt an earlier branch.
--
-- This is the other half of "Microsoft and DRAI are unaffected", and 10c cannot
-- see it because 10c never passes a non-empty third argument. A Microsoft row
-- that somehow arrived carrying delivery_ids must still answer from surfaces,
-- because the AWS branch sits after every existing branch.
do $$
declare st text := '10f. AWS ids cannot pre-empt an earlier branch';
begin
  perform gate.check_value(st, 'surfaces beat delivery_ids',
    $q$registry_delivery('{Teams}', null, '{SAAS}')$q$, 'Microsoft 365 app');
  perform gate.check_value(st, 'surfaces beat delivery_ids, container case',
    $q$registry_delivery('{Containers}', null, '{AMAZON_MACHINE_IMAGE}')$q$, 'Container');
  perform gate.check_value(st, 'cert_hosting beats delivery_ids',
    $q$registry_delivery('{}', 'ISVHosted', '{AMAZON_MACHINE_IMAGE}')$q$, 'ISV hosted');
  perform gate.check_value(st, 'and only then does the AWS branch run',
    $q$registry_delivery('{Web}', 'Amazon Web Services', '{AMAZON_MACHINE_IMAGE}')$q$, 'Virtual machine');
  -- The three shapes a row with no AWS ids can arrive in.
  perform gate.check_value(st, 'a two-argument call still resolves',
    $q$registry_delivery('{Teams}', null)$q$, 'Microsoft 365 app');
  perform gate.check_value(st, 'an explicit null third argument',
    $q$registry_delivery('{Web}', null, null)$q$, 'Unknown');
  perform gate.check_value(st, 'the empty array the write path passes',
    $q$registry_delivery('{Web}', null, '{}')$q$, 'Unknown');
  -- 'X' = any(null) is null, not true, so a null array cannot reach the branch.
  perform gate.check_value(st, 'a null array cannot match an AWS id',
    $q$registry_delivery('{}', null, null)$q$, 'Unknown');
  -- A null ELEMENT beside a real id must not swallow the real id.
  perform gate.check_value(st, 'a null element beside a real id',
    $q$registry_delivery('{}', null, array[null,'SAAS']::text[])$q$, 'SaaS');
  perform gate.check_value(st, 'a null element on its own',
    $q$registry_delivery('{}', null, array[null]::text[])$q$, 'Unknown');
end $$;

-- 10g. THE WRITE PATH, end to end. Everything above tests the function; this
-- tests that ingest_capture reaches it with the right argument.
--
-- The last three payloads are the shapes the design brief asked about
-- explicitly, where delivery_ids is not an array at all. The six other extract
-- keys read as arrays in the same declare block would raise 22023 on these and
-- abort the whole capture; delivery_ids checks jsonb_typeof first, so it
-- degrades to Unknown instead. If that guard is ever removed these three turn
-- into ERROR 22023 rows rather than quiet wrong answers.
set role service_role;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"aws-deliv-ami",
  "captured_at_utc":"2026-08-20T09:00:00Z","drive_file_id":"drive-aws-deliv-ami"},
 "ingest_source":"dual_write","raw":{"body":"aws deliv ami"},
 "extract":{"extract_spec_version":"v3-aws","name":"Delivery Probe AMI",
   "publisher":"Delivery Probe Co","tagline":"One fulfilment option, an AMI",
   "overview_text":"Delivery Probe AMI ships as a machine image.",
   "pricing":"Contact us","acquire_using":"Amazon Machine Image",
   "certification":"none","delivery_ids":["AMAZON_MACHINE_IMAGE"]}}
$p$::jsonb) ->> 'status' as aws_deliv_ami;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"aws-deliv-multi",
  "captured_at_utc":"2026-08-20T09:01:00Z","drive_file_id":"drive-aws-deliv-multi"},
 "ingest_source":"dual_write","raw":{"body":"aws deliv multi"},
 "extract":{"extract_spec_version":"v3-aws","name":"Delivery Probe Multi",
   "publisher":"Delivery Probe Co","tagline":"Three fulfilment options at once",
   "overview_text":"Delivery Probe Multi ships three ways.",
   "pricing":"Contact us","acquire_using":"SaaS, Amazon Machine Image, CloudFormation Template",
   "certification":"none",
   "delivery_ids":["SAAS","AMAZON_MACHINE_IMAGE","CLOUDFORMATION_TEMPLATE"]}}
$p$::jsonb) ->> 'status' as aws_deliv_multi;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"aws-deliv-helm",
  "captured_at_utc":"2026-08-20T09:02:00Z","drive_file_id":"drive-aws-deliv-helm"},
 "ingest_source":"dual_write","raw":{"body":"aws deliv helm"},
 "extract":{"extract_spec_version":"v3-aws","name":"Delivery Probe Helm",
   "publisher":"Delivery Probe Co","tagline":"A container image and a Helm chart",
   "overview_text":"Delivery Probe Helm ships as a chart.",
   "pricing":"Contact us","acquire_using":"Container Image, Helm Chart",
   "certification":"none","delivery_ids":["CONTAINER","HELM"]}}
$p$::jsonb) ->> 'status' as aws_deliv_helm;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"aws-deliv-prof",
  "captured_at_utc":"2026-08-20T09:03:00Z","drive_file_id":"drive-aws-deliv-prof"},
 "ingest_source":"dual_write","raw":{"body":"aws deliv prof"},
 "extract":{"extract_spec_version":"v3-aws","name":"Delivery Probe Services",
   "publisher":"Delivery Probe Co","tagline":"A human engagement, nothing to run",
   "overview_text":"Delivery Probe Services is a consulting engagement.",
   "pricing":"Contact us","acquire_using":"Professional Services",
   "certification":"none","delivery_ids":["PROFESSIONAL_SERVICES"]}}
$p$::jsonb) ->> 'status' as aws_deliv_prof;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"aws-deliv-absent",
  "captured_at_utc":"2026-08-20T09:04:00Z","drive_file_id":"drive-aws-deliv-absent"},
 "ingest_source":"dual_write","raw":{"body":"aws deliv absent"},
 "extract":{"extract_spec_version":"v3-aws","name":"Delivery Probe Absent",
   "publisher":"Delivery Probe Co","tagline":"No delivery_ids key at all",
   "overview_text":"Delivery Probe Absent omits the key, as Microsoft and DRAI do.",
   "pricing":"Contact us","certification":"none"}}
$p$::jsonb) ->> 'status' as aws_deliv_absent;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"aws-deliv-empty",
  "captured_at_utc":"2026-08-20T09:05:00Z","drive_file_id":"drive-aws-deliv-empty"},
 "ingest_source":"dual_write","raw":{"body":"aws deliv empty"},
 "extract":{"extract_spec_version":"v3-aws","name":"Delivery Probe Empty",
   "publisher":"Delivery Probe Co","tagline":"An empty delivery_ids array",
   "overview_text":"Delivery Probe Empty states the key and nothing in it.",
   "pricing":"Contact us","certification":"none","delivery_ids":[]}}
$p$::jsonb) ->> 'status' as aws_deliv_empty;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"aws-deliv-elemnull",
  "captured_at_utc":"2026-08-20T09:06:00Z","drive_file_id":"drive-aws-deliv-elemnull"},
 "ingest_source":"dual_write","raw":{"body":"aws deliv elemnull"},
 "extract":{"extract_spec_version":"v3-aws","name":"Delivery Probe Element Null",
   "publisher":"Delivery Probe Co","tagline":"A JSON null inside the array",
   "overview_text":"Delivery Probe Element Null carries a null beside a real id.",
   "pricing":"Contact us","certification":"none","delivery_ids":[null,"SAAS"]}}
$p$::jsonb) ->> 'status' as aws_deliv_elemnull;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"aws-deliv-jsonnull",
  "captured_at_utc":"2026-08-20T09:07:00Z","drive_file_id":"drive-aws-deliv-jsonnull"},
 "ingest_source":"dual_write","raw":{"body":"aws deliv jsonnull"},
 "extract":{"extract_spec_version":"v3-aws","name":"Delivery Probe Json Null",
   "publisher":"Delivery Probe Co","tagline":"delivery_ids is JSON null",
   "overview_text":"Delivery Probe Json Null states the key as null.",
   "pricing":"Contact us","certification":"none","delivery_ids":null}}
$p$::jsonb) ->> 'status' as aws_deliv_jsonnull;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"aws-deliv-scalar",
  "captured_at_utc":"2026-08-20T09:08:00Z","drive_file_id":"drive-aws-deliv-scalar"},
 "ingest_source":"dual_write","raw":{"body":"aws deliv scalar"},
 "extract":{"extract_spec_version":"v3-aws","name":"Delivery Probe Scalar",
   "publisher":"Delivery Probe Co","tagline":"delivery_ids is a bare string",
   "overview_text":"Delivery Probe Scalar states the key as a string.",
   "pricing":"Contact us","certification":"none","delivery_ids":"SAAS"}}
$p$::jsonb) ->> 'status' as aws_deliv_scalar;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"aws-deliv-object",
  "captured_at_utc":"2026-08-20T09:09:00Z","drive_file_id":"drive-aws-deliv-object"},
 "ingest_source":"dual_write","raw":{"body":"aws deliv object"},
 "extract":{"extract_spec_version":"v3-aws","name":"Delivery Probe Object",
   "publisher":"Delivery Probe Co","tagline":"delivery_ids is an object",
   "overview_text":"Delivery Probe Object states the key as an object.",
   "pricing":"Contact us","certification":"none","delivery_ids":{"type_id":"SAAS"}}}
$p$::jsonb) ->> 'status' as aws_deliv_object;

-- Two non-AWS listings whose delivery is NOT Unknown, through the same new
-- write path. The existing seeds cannot serve here: seed-alpha exercises the
-- Microsoft 365 branch, but seed-beta and seed-gamma both land on Unknown, so
-- before these two the gate had no live row proving a cert_hosting fallback
-- fires at all.
select ingest_capture($p$
{"capture_meta":{"marketplace_id":"microsoft","source_product_id":"ms-deliv-vm",
  "captured_at_utc":"2026-08-20T09:10:00Z","drive_file_id":"drive-ms-deliv-vm"},
 "ingest_source":"dual_write","raw":{"body":"ms deliv vm"},
 "extract":{"extract_spec_version":"v3","name":"Delivery Probe Microsoft VM",
   "publisher":"Delivery Probe Co","tagline":"A Microsoft listing on the VM surface",
   "overview_text":"Delivery Probe Microsoft VM runs as a virtual machine.",
   "pricing":"Contact us","certification":"none","surfaces":["Virtual Machines"]}}
$p$::jsonb) ->> 'status' as ms_deliv_vm;

select ingest_capture($p$
{"capture_meta":{"marketplace_id":"drai","source_product_id":"drai-deliv-saas",
  "captured_at_utc":"2026-08-20T09:11:00Z","drive_file_id":"drive-drai-deliv-saas"},
 "ingest_source":"dual_write","raw":{"body":"drai deliv saas"},
 "extract":{"extract_spec_version":"v3-drai","name":"Delivery Probe DRAI SaaS",
   "publisher":"Delivery Probe Co","tagline":"A DRAI listing hosted as SaaS",
   "overview_text":"Delivery Probe DRAI SaaS is reached over the network.",
   "pricing":"Contact us","certification":"publisher_attestation",
   "cert_detail":{"hosting":"Multi-tenant SaaS","data_location":"United States"}}}
$p$::jsonb) ->> 'status' as drai_deliv_saas;

reset role;

do $$
declare st text := '10g. delivery through ingest_capture';
begin
  -- AWS, the mapped ids.
  perform gate.check_capture_delivery(st, 'aws-deliv-ami',      'Virtual machine');
  perform gate.check_capture_delivery(st, 'aws-deliv-multi',    'Virtual machine');
  perform gate.check_capture_delivery(st, 'aws-deliv-helm',     'Container');
  perform gate.check_capture_delivery(st, 'aws-deliv-elemnull', 'SaaS');
  -- AWS, the ids and shapes that must degrade rather than guess or raise.
  perform gate.check_capture_delivery(st, 'aws-deliv-prof',     'Unknown');
  perform gate.check_capture_delivery(st, 'aws-deliv-absent',   'Unknown');
  perform gate.check_capture_delivery(st, 'aws-deliv-empty',    'Unknown');
  perform gate.check_capture_delivery(st, 'aws-deliv-jsonnull', 'Unknown');
  perform gate.check_capture_delivery(st, 'aws-deliv-scalar',   'Unknown');
  perform gate.check_capture_delivery(st, 'aws-deliv-object',   'Unknown');
  -- The pre-existing branches, still firing through the new write path.
  perform gate.check_capture_delivery(st, 'ms-deliv-vm',        'Virtual machine');
  perform gate.check_capture_delivery(st, 'drai-deliv-saas',    'SaaS');
  -- And the seeds, which went in through the OLD ingest_capture in step 4 and
  -- were re-derived by the backfill, unchanged either way.
  perform gate.check_capture_delivery(st, 'seed-alpha',         'Microsoft 365 app');
  perform gate.check_capture_delivery(st, 'seed-beta',          'Unknown');
  perform gate.check_capture_delivery(st, 'seed-gamma',         'Unknown');
  perform gate.check_capture_delivery(st, 'sentinel-does-not-exist-0001', 'Microsoft 365 app');
end $$;

-- 10h. The delivery facet is OPEN, which is the fact the migration header now
-- states and an earlier draft of it got wrong. registry_search builds its
-- delivery options by grouping the matched rows, so a value the function has
-- never returned before appears in the rail the moment one listing carries it,
-- with no application change at all. 'Virtual machine' and 'Container' reach
-- the rail here only because the listings above exist; no seed produced either
-- before this step ran.
do $$
declare j jsonb; opts text[]; n int; ok boolean;
begin
  set role anon;
  j := registry_search(p_limit => 100000);
  reset role;
  select array_agg(o ->> 'value' order by o ->> 'value') into opts
    from jsonb_array_elements(j -> 'facets' -> 'delivery') o;
  n := coalesce(array_length(opts, 1), 0);
  ok := opts @> array['Virtual machine','SaaS','Container','Microsoft 365 app','Unknown'];
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('10h. delivery facet is data-driven', 'anon', 'registry_search facets.delivery',
          n, gate.expect(ok, 'green'),
          format('options offered: %s', coalesce(array_to_string(opts, ', '), '(none)')));
exception when others then
  reset role;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('10h. delivery facet is data-driven', 'anon', 'registry_search facets.delivery',
          null, 'ERROR ' || sqlstate, sqlerrm);
end $$;


-- 10i. The deliberate breakage, so every assertion above is known to be ABLE to
-- fail. Same principle as 05-negative.sql: a check that cannot go red is a
-- report, not a gate, and a value assertion that quietly compares two nulls is
-- the exact vacuous pass this suite exists to hunt. Each of these three is
-- expected 'red', so gate.expect records "PASS: red as designed" and run.sh
-- needs no new exclusion; a green result here would mean the corresponding
-- check above proves nothing.
do $$
declare st text := '10i. the checks can fail';
begin
  -- A wrong expected value must be caught.
  perform gate.check_value(st, 'AMAZON_MACHINE_IMAGE, deliberately mis-expected',
    $q$registry_delivery('{}', null, '{AMAZON_MACHINE_IMAGE}')$q$, 'SaaS', 'red');
  -- A listing that does not exist must FAIL rather than pass on two nulls,
  -- which is what the n = 1 guard inside check_capture_delivery is for.
  perform gate.check_capture_delivery(st, 'no-such-listing-at-all', null, 'red');
  -- And a real listing held to the wrong value.
  perform gate.check_capture_delivery(st, 'aws-deliv-ami', 'SaaS', 'red');
end $$;

\pset format aligned
select step, as_role, object, n_rows, verdict, note
  from gate.result where step like '10%' order by seq;
