-- Step 3 and step 4 of the gate: read every surface the site touches, as the
-- role that actually touches it, and assert a NON-ZERO row count.
--
-- Statement success is not the assertion. PostgREST answers an empty view with
-- HTTP 200 and [], and getLogos in lib/registry.ts turns any failure into
-- initials, so a view returning nothing is indistinguishable from a view
-- working unless the count is checked. That is the failure that took all 6,820
-- logos off the live site.

-- asset_merge is legitimately empty after the backfill, and will be empty on
-- production at phase 1 too. An empty table cannot demonstrate that anon can
-- read it, so one synthetic row is inserted purely so the anon read has
-- something to return. merged_into is deliberately left alone, so no view's
-- counts change and the retired-asset exclusion is not disturbed.
insert into asset_merge (from_asset_id, into_asset_id, listing_ids, slugs, basis, merged_by)
select f.id, t.id, array[]::uuid[], array[]::text[],
       'synthetic row, gate harness only', 'gate-harness'
  from (select id from asset order by created_at limit 1) f
 cross join (select id from asset order by created_at desc limit 1) t;

-- Step 3c needs a different assertion from the other four views.
--
-- v_registry_stats is nine independent scalar subqueries, so it returns exactly
-- one row whatever happens underneath, and Postgres does not evaluate a scalar
-- subquery that count(*) never reads. A row-count assertion on it is vacuous:
-- it returns 1 even when anon holds no SELECT on capture_extract at all, which
-- step 5 demonstrates. The values are what has to be asserted.
create or replace function gate.check_stats(p_step text) returns void
language plpgsql as $fn$
declare j jsonb; v text; note text := '';
begin
  begin
    set role anon;
    select to_jsonb(s) into j from v_registry_stats s;
    reset role;
    if (j ->> 'agents')::bigint > 0
       and (j ->> 'marketplaces')::bigint > 0
       and (j ->> 'captures')::bigint > 0
       and (j ->> 'changes')::bigint > 0
       and (j ->> 'publishers')::bigint > 0
       and (j ->> 'certified')::bigint > 0
       and (j ->> 'attested')::bigint > 0
       and j ->> 'mean_reach' is not null
       and j ->> 'last_captured_at' is not null
    then v := 'PASS'; else v := 'FAIL: a stat is zero or null'; end if;
    note := j::text;
  exception when others then
    reset role;
    v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_registry_stats (values)', null, v, note);
end $fn$;


-- Steps 3d and 3e: the same defect class as 3c, in two more views.
--
-- 3c found that count(*) on v_registry_stats proves nothing, because Postgres
-- never evaluates a scalar subquery no output column reads. The same shape
-- applies wherever a view reaches a table through a LEFT JOIN or a correlated
-- subquery rather than an inner join, because losing that table empties a
-- COLUMN while leaving the ROW COUNT untouched.
--
-- Two views qualify and both are asserted below:
--
--   v_logo_status  LEFT JOINs capture_link. Drop capture_link's RLS policy and
--                  the view still returns one row per listing, every one of
--                  them with a null logo_url and state no_logo_identified.
--                  Every logo on the site is gone and the row count says PASS.
--
--   v_asset_passport reaches capture_plan, capture_link, capture_permission,
--                  capture_compliance and capture_evidence through correlated
--                  subqueries. Drop any of those policies and every passport
--                  keeps its row and loses that section entirely.
--
-- v_registry_card and v_asset_change_feed do NOT qualify: they reach listing,
-- marketplace, capture and capture_extract through inner joins only, so losing
-- any of them empties the view and the row count is a sound assertion there.

create or replace function gate.check_logo_status(p_step text) returns void
language plpgsql as $fn$
declare n_total int; n_url int; n_arch int; n_urlonly int; n_lying int; n_hollow int;
        v text; note text := '';
begin
  begin
    set role anon;
    select count(*),
           count(*) filter (where logo_url is not null),
           count(*) filter (where state = 'archived'),
           count(*) filter (where state = 'url_only_not_archived'),
           count(*) filter (where logo_url is not null and state = 'no_logo_identified'),
           count(*) filter (where state = 'archived' and archived_url is null)
      into n_total, n_url, n_arch, n_urlonly, n_lying, n_hollow
      from v_logo_status;
    reset role;
    if n_total > 0 and n_url > 0 and n_arch > 0 and n_urlonly > 0
       and n_lying = 0 and n_hollow = 0
    then v := 'PASS';
    else v := 'FAIL: logo columns are hollow';
    end if;
    note := format('rows %s, with logo_url %s, archived %s, url_only %s, contradictory %s, archived-without-url %s',
                   n_total, n_url, n_arch, n_urlonly, n_lying, n_hollow);
  exception when others then
    reset role;
    v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_logo_status (values)', null, v, note);
end $fn$;

create or replace function gate.check_passport(p_step text, p_pid text) returns void
language plpgsql as $fn$
declare r record; v text; note text := '';
begin
  begin
    set role anon;
    select jsonb_array_length(p.plans)                as plans,
           jsonb_array_length(p.product_links)        as product_links,
           jsonb_array_length(p.legal_links)          as legal_links,
           jsonb_array_length(p.media)                as media,
           coalesce(array_length(p.graph_permissions, 1), 0) as perms,
           coalesce(array_length(p.compliance, 1), 0) as compliance,
           (select count(*) from jsonb_object_keys(p.evidence)) as evidence_kinds
      into r
      from v_asset_passport p
     where p.source_product_id = p_pid;
    reset role;
    if r is null then
      v := 'FAIL: no passport row at all';
    elsif r.plans > 0 and r.product_links > 0 and r.legal_links > 0 and r.media > 0
          and r.perms > 0 and r.compliance > 0 and r.evidence_kinds > 0
    then v := 'PASS';
    else v := 'FAIL: a passport section is empty';
    end if;
    note := format('%s: plans %s, product_links %s, legal_links %s, media %s, graph_permissions %s, compliance %s, evidence kinds %s',
                   p_pid, r.plans, r.product_links, r.legal_links, r.media,
                   r.perms, r.compliance, r.evidence_kinds);
  exception when others then
    reset role;
    v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_asset_passport (values)', null, v, note);
end $fn$;
do $$
begin
  -- Step 3: the five views the site reads, as anon.
  perform gate.check_rows('3. anon reads the views', 'anon', 'v_registry_card');
  perform gate.check_rows('3. anon reads the views', 'anon', 'v_asset_passport');
  perform gate.check_rows('3. anon reads the views', 'anon', 'v_asset_change_feed');
  perform gate.check_rows('3. anon reads the views', 'anon', 'v_registry_stats');
  perform gate.check_rows('3. anon reads the views', 'anon', 'v_logo_status');

  -- Step 3, continued: the three new tables, as anon.
  perform gate.check_rows('3. anon reads the new tables', 'anon', 'asset');
  perform gate.check_rows('3. anon reads the new tables', 'anon', 'asset_slug');
  perform gate.check_rows('3. anon reads the new tables', 'anon', 'asset_merge');

  -- Not asked for by the spec, but the views inner-join these and a policy or
  -- grant lost during the rename would land here first.
  perform gate.check_rows('3b. anon reads the renamed base tables', 'anon', 'listing');
  perform gate.check_rows('3b. anon reads the renamed base tables', 'anon', 'listing_change');
  perform gate.check_rows('3b. anon reads the renamed base tables', 'anon', 'capture_extract');
  perform gate.check_rows('3b. anon reads the renamed base tables', 'anon', 'capture_link');

  perform gate.check_stats('3c. anon reads v_registry_stats values');
  perform gate.check_logo_status('3d. anon reads v_logo_status values');
  perform gate.check_passport('3e. anon reads v_asset_passport values', 'seed-alpha');

  -- Step 4: v_logo_status as service_role. The views migration flips this view
  -- from SECURITY DEFINER to security_invoker, so from here on service_role has
  -- to satisfy grants on listing, capture_extract and capture_link directly
  -- rather than inheriting the view owner's rights. archive-logos.mjs is the
  -- only pass that reads a relation rather than calling a definer function, so
  -- it is the only one a missing grant reaches.
  perform gate.check_rows('4. service_role reads v_logo_status', 'service_role', 'v_logo_status');
  perform gate.check_rows('4. and the three tables it now reads as invoker', 'service_role', 'listing');
  perform gate.check_rows('4. and the three tables it now reads as invoker', 'service_role', 'capture_extract');
  perform gate.check_rows('4. and the three tables it now reads as invoker', 'service_role', 'capture_link');

  -- Informational: the other four views are granted to anon and authenticated
  -- only, never to service_role, in this repo as on production. An error here
  -- is the designed grant surface, not a regression.
  perform gate.check_rows('4b. informational: service_role on the other views', 'service_role', 'v_registry_card', 'info');
  perform gate.check_rows('4b. informational: service_role on the other views', 'service_role', 'v_asset_passport', 'info');
  perform gate.check_rows('4b. informational: service_role on the other views', 'service_role', 'v_asset_change_feed', 'info');
  perform gate.check_rows('4b. informational: service_role on the other views', 'service_role', 'v_registry_stats', 'info');
end $$;


-- Phase 2: the asset-keyed read surface --------------------------------------
--
-- Every assertion below is on a value, never on a bare row count. Three of the
-- four views reach at least one source by something other than an inner join:
-- v_registry_card builds marketplace_ids, listing_count and search_blob in a
-- lateral over every listing, and both passports reach plans, links, media,
-- permissions, compliance and evidence through correlated subqueries. Only
-- v_asset_evidence is inner joins the whole way down, which makes its count
-- sound; it is asserted on values anyway, because a count that is sound today
-- stops being sound the moment somebody adds an outer join to the view.
--
-- Each check takes p_expect. 'green' means the assertion must hold, 'red' means
-- it must NOT, which is what step 5's deliberate breakages are for. Phase 1
-- kept its breakages out of the verdict by naming them in run.sh's EXCLUDED
-- list. Stating the expectation instead is stricter: a breakage that fails to
-- break is then a FAIL rather than a line nobody reads, and run.sh does not
-- have to learn a new step name every time a check is added.

create or replace function gate.expect(p_ok boolean, p_expect text) returns text
language sql immutable as $fn$
  select case when p_expect = 'red'
    then case when p_ok then 'FAIL: breakage did not go red' else 'PASS: red as designed' end
    else case when p_ok then 'PASS' else 'FAIL: value assertion' end
  end
$fn$;

-- v_registry_card is one row per live asset, and search_blob really carries the
-- product's own words. The lowercase assertion is not decoration: the client
-- lowercases the needle before matching, so a blob that kept its capitals would
-- match nothing while looking perfectly healthy.
create or replace function gate.check_card_asset(p_step text, p_pid text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare n_rows bigint; n_assets bigint; hit boolean;
        mids text[]; lcount int; blob text; nm text; pub text; mkt text;
        ok boolean; v text; note text := '';
begin
  begin
    select count(*) into n_assets from asset where merged_into is null;
    set role anon;
    select count(*) into n_rows from v_registry_card;
    select c.marketplace_ids, c.listing_count, c.search_blob,
           lower(c.name), lower(c.publisher), lower(c.marketplace_name)
      into mids, lcount, blob, nm, pub, mkt
      from v_registry_card c where c.source_product_id = p_pid;
    hit := found;
    reset role;
    ok := n_rows = n_assets and n_rows > 0 and hit
      and coalesce(array_length(mids, 1), 0) > 0
      and lcount >= 1
      and coalesce(blob, '') <> ''
      and blob = lower(blob)
      and blob like '%' || nm  || '%'
      and blob like '%' || pub || '%'
      and blob like '%' || mkt || '%';
    v := gate.expect(ok, p_expect);
    note := format('%s card rows vs %s live assets; %s: marketplace_ids %s, listing_count %s, search_blob %s chars, name %s, publisher %s, marketplace %s, lowercase %s',
                   n_rows, n_assets, p_pid,
                   coalesce(array_length(mids, 1), 0), coalesce(lcount, 0),
                   coalesce(length(blob), 0),
                   coalesce((blob like '%' || nm  || '%')::text, 'no row'),
                   coalesce((blob like '%' || pub || '%')::text, 'no row'),
                   coalesce((blob like '%' || mkt || '%')::text, 'no row'),
                   coalesce((blob = lower(blob))::text, 'no row'));
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_registry_card (values)', n_rows, v, note);
end $fn$;

-- v_asset_passport is one row per live asset and its listings array is not
-- empty. Under 1:1 that array has exactly one element and it is the primary,
-- which is what is asserted; the day a merge gives an asset two, the first
-- element is still the primary because the aggregate orders on it.
create or replace function gate.check_passport_listings(p_step text, p_pid text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare n_rows bigint; n_assets bigint; hit boolean; ls jsonb; head jsonb;
        ok boolean; v text; note text := '';
begin
  begin
    select count(*) into n_assets from asset where merged_into is null;
    set role anon;
    select count(*) into n_rows from v_asset_passport;
    select p.listings into ls from v_asset_passport p where p.source_product_id = p_pid;
    hit := found;
    reset role;
    head := ls -> 0;
    ok := n_rows = n_assets and n_rows > 0 and hit
      and jsonb_typeof(ls) = 'array'
      and jsonb_array_length(ls) > 0
      and (head ->> 'is_primary') = 'true'
      and nullif(head ->> 'marketplace_id', '') is not null;
    v := gate.expect(ok, p_expect);
    note := format('%s passport rows vs %s live assets; %s: listings %s, first is_primary %s, first marketplace_id %s',
                   n_rows, n_assets, p_pid,
                   case when jsonb_typeof(ls) = 'array'
                        then jsonb_array_length(ls)::text
                        else coalesce(jsonb_typeof(ls), 'absent') end,
                   coalesce(head ->> 'is_primary', '-'),
                   coalesce(head ->> 'marketplace_id', '-'));
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_asset_passport.listings', n_rows, v, note);
end $fn$;

-- v_listing_passport keeps the grain the asset passport gave up: one row per
-- listing, with asset_id pointing back at the product.
create or replace function gate.check_listing_passport(p_step text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare n_rows bigint; n_listings bigint; n_null_asset bigint; n_null_pid bigint;
        ok boolean; v text; note text := '';
begin
  begin
    select count(*) into n_listings from listing;
    set role anon;
    select count(*),
           count(*) filter (where asset_id is null),
           count(*) filter (where source_product_id is null)
      into n_rows, n_null_asset, n_null_pid
      from v_listing_passport;
    reset role;
    ok := n_rows = n_listings and n_rows > 0 and n_null_asset = 0 and n_null_pid = 0;
    v := gate.expect(ok, p_expect);
    note := format('%s rows vs %s listings, %s null asset_id, %s null source_product_id',
                   n_rows, n_listings, n_null_asset, n_null_pid);
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_listing_passport (values)', n_rows, v, note);
end $fn$;

-- The same six correlated subqueries the asset passport carries, in the
-- listing-grained view. check_passport asserts these on v_asset_passport; this
-- is its twin, and it exists because a policy failure hollows both and the row
-- count sees neither.
create or replace function gate.check_listing_passport_sections(p_step text, p_pid text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare r record; hit boolean; ok boolean; v text; note text := '';
begin
  begin
    set role anon;
    select jsonb_array_length(p.plans)                    as plans,
           jsonb_array_length(p.product_links)            as product_links,
           jsonb_array_length(p.legal_links)              as legal_links,
           jsonb_array_length(p.media)                    as media,
           coalesce(array_length(p.graph_permissions, 1), 0) as perms,
           coalesce(array_length(p.compliance, 1), 0)     as compliance,
           (select count(*) from jsonb_object_keys(p.evidence)) as evidence_kinds
      into r
      from v_listing_passport p
     where p.source_product_id = p_pid;
    hit := found;
    reset role;
    ok := hit and r.plans > 0 and r.product_links > 0 and r.legal_links > 0
      and r.media > 0 and r.perms > 0 and r.compliance > 0 and r.evidence_kinds > 0;
    v := gate.expect(ok, p_expect);
    note := format('%s: plans %s, product_links %s, legal_links %s, media %s, graph_permissions %s, compliance %s, evidence kinds %s',
                   p_pid, r.plans, r.product_links, r.legal_links, r.media,
                   r.perms, r.compliance, r.evidence_kinds);
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_listing_passport (sections)', null, v, note);
end $fn$;

-- v_asset_evidence is one row per capture, keyed by asset. content_hash is the
-- whole point of the view: it is what says two observations were the same
-- observation, so a null one is an evidence row that proves nothing. has_raw
-- is asserted non-zero because a view that reported "no source material held"
-- for every capture would look identical to a working one otherwise.
create or replace function gate.check_asset_evidence(p_step text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare n_rows bigint; n_captures bigint; n_null_hash bigint; n_null_asset bigint; n_raw bigint;
        ok boolean; v text; note text := '';
begin
  begin
    select count(*) into n_captures from capture;
    set role anon;
    select count(*),
           count(*) filter (where content_hash is null),
           count(*) filter (where asset_id is null),
           count(*) filter (where has_raw)
      into n_rows, n_null_hash, n_null_asset, n_raw
      from v_asset_evidence;
    reset role;
    ok := n_rows = n_captures and n_rows > 0
      and n_null_hash = 0 and n_null_asset = 0 and n_raw > 0;
    v := gate.expect(ok, p_expect);
    note := format('%s rows vs %s captures, %s null content_hash, %s null asset_id, %s with raw',
                   n_rows, n_captures, n_null_hash, n_null_asset, n_raw);
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_asset_evidence (values)', n_rows, v, note);
end $fn$;

-- All seven views exist and every one of them is security_invoker. Without it
-- a view runs as its owner, which here means RLS is evaluated against postgres
-- rather than against the visitor, and every policy in this database stops
-- being load bearing. v_logo_status sat in exactly that state on production
-- until phase 1 closed it.
create or replace function gate.check_view_options(p_step text) returns void
language plpgsql as $fn$
declare n_views int; bad text; ok boolean; v text; note text := '';
  seven text[] := array['v_registry_card','v_asset_passport','v_listing_passport',
                        'v_asset_evidence','v_asset_change_feed','v_registry_stats','v_logo_status'];
begin
  select count(*) into n_views
    from pg_class c join pg_namespace nsp on nsp.oid = c.relnamespace
   where nsp.nspname = 'public' and c.relkind = 'v' and c.relname = any(seven);
  select string_agg(c.relname || ' -> ' || coalesce(array_to_string(c.reloptions, ','), '(none)'), ', ')
    into bad
    from pg_class c join pg_namespace nsp on nsp.oid = c.relnamespace
   where nsp.nspname = 'public' and c.relkind = 'v' and c.relname = any(seven)
     and not coalesce(c.reloptions, '{}') @> array['security_invoker=true'];
  ok := n_views = 7 and bad is null;
  v := gate.expect(ok, 'green');
  note := format('%s of 7 views present; not security_invoker: %s', n_views, coalesce(bad, 'none'));
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'postgres', 'pg_class.reloptions', n_views, v, note);
end $fn$;

-- The certification group, checked for internal agreement rather than for
-- membership.
--
-- This is the instrument that would have caught all three of the corrections
-- the group needed, without anyone reasoning about derivations. known_layers,
-- layers_known, reach and the count embedded in risk_basis are one quantity in
-- four presentations:
--
--   layers_known           cardinality(known_layers)
--   reach                  round(100.0 * cardinality(known_layers) / 12)
--   risk_basis             '... N of M disclosable layers stated', N = the same
--
-- If any of the four is ever sourced from a different listing than the others,
-- these rows disagree and this check goes red. It does not know which columns
-- are in the group and does not need to.
--
-- Only the numerator of risk_basis is compared. The denominator is NOT
-- layers_tracked: registry_risk() subtracts the three certification-only
-- layers for an unattested listing, so an uncertified row legitimately reads
-- "3 of 9" while layers_tracked is 12.
--
-- The row count is asserted non-zero as well, or an empty card would satisfy
-- "no row disagrees" and report PASS while showing nothing at all.
create or replace function gate.check_cert_group_coherent(p_step text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare n_rows bigint; n_reach bigint; n_basis bigint; n_unparsed bigint;
        ok boolean; v text; note text := '';
begin
  begin
    set role anon;
    select count(*),
           count(*) filter (where reach is distinct from round(100.0 * layers_known / layers_tracked)::int),
           count(*) filter (where substring(risk_basis from '([0-9]+) of [0-9]+ disclosable layers stated')::int
                                  is distinct from layers_known),
           count(*) filter (where substring(risk_basis from '([0-9]+) of [0-9]+ disclosable layers stated') is null)
      into n_rows, n_reach, n_basis, n_unparsed
      from v_registry_card;
    reset role;
    ok := n_rows > 0 and n_reach = 0 and n_basis = 0 and n_unparsed = 0;
    v := gate.expect(ok, p_expect);
    note := format('%s card rows; reach disagrees with layers_known on %s, risk_basis layer count disagrees on %s, risk_basis unparsable on %s',
                   n_rows, n_reach, n_basis, n_unparsed);
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_registry_card (group coherence)', n_rows, v, note);
end $fn$;

-- The same four, on the passport, which sources them through its own lateral.
create or replace function gate.check_passport_group_coherent(p_step text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare n_rows bigint; n_reach bigint; n_basis bigint;
        ok boolean; v text; note text := '';
begin
  begin
    set role anon;
    select count(*),
           count(*) filter (where reach is distinct from round(100.0 * layers_known / layers_tracked)::int),
           count(*) filter (where substring(risk_basis from '([0-9]+) of [0-9]+ disclosable layers stated')::int
                                  is distinct from layers_known)
      into n_rows, n_reach, n_basis
      from v_asset_passport;
    reset role;
    ok := n_rows > 0 and n_reach = 0 and n_basis = 0;
    v := gate.expect(ok, p_expect);
    note := format('%s passport rows; reach disagrees on %s, risk_basis layer count disagrees on %s',
                   n_rows, n_reach, n_basis);
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_asset_passport (group coherence)', n_rows, v, note);
end $fn$;

do $$
begin
  perform gate.check_rows('3f. anon reads the phase 2 views', 'anon', 'v_registry_card');
  perform gate.check_rows('3f. anon reads the phase 2 views', 'anon', 'v_asset_passport');
  perform gate.check_rows('3f. anon reads the phase 2 views', 'anon', 'v_listing_passport');
  perform gate.check_rows('3f. anon reads the phase 2 views', 'anon', 'v_asset_evidence');

  perform gate.check_card_asset('3g. v_registry_card is asset-keyed and its blob is real', 'seed-alpha');
  perform gate.check_passport_listings('3g. v_asset_passport is asset-keyed and carries listings', 'seed-alpha');
  perform gate.check_listing_passport('3g. v_listing_passport is listing-keyed');
  perform gate.check_listing_passport_sections('3g. v_listing_passport carries its sections', 'seed-alpha');
  perform gate.check_asset_evidence('3g. v_asset_evidence is capture-keyed');
  perform gate.check_view_options('3h. all seven views are security_invoker');
  perform gate.check_cert_group_coherent('3i. the certification group agrees with itself');
  perform gate.check_passport_group_coherent('3i. the certification group agrees with itself');
end $$;

\pset format aligned
select step, as_role, object, n_rows, verdict, note from gate.result order by seq;
