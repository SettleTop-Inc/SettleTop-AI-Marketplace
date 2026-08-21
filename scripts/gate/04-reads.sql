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

-- Escape a value that is about to be spliced into a LIKE pattern as a literal.
--
-- The same three characters registry_search escapes, in the same order and for
-- the same reason: backslash first so the escapes added after it are not
-- themselves escaped. Seed data is not a text box, but a seeded name carrying a
-- percent sign would turn "does the blob contain this name" into "does the blob
-- contain anything", and the assertion would pass while proving nothing. That
-- is precisely the vacuous-pass shape the rest of this file exists to hunt.
create or replace function gate.like_literal(p text) returns text
language sql immutable as $fn$
  select replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_')
$fn$;

-- gate.like_literal() has one job and one way to get it wrong, so it is
-- asserted directly rather than trusted.
--
-- The discriminating case is a backslash immediately before a wildcard. If the
-- first replacement fails to DOUBLE the backslash, escaping a needle of
-- a-backslash-percent-z yields a-backslash-backslash-percent-z, which a LIKE
-- with ESCAPE reads as one literal backslash followed by a LIVE wildcard. The
-- assertion the escaping was added to protect then matches text that does not
-- contain the needle at all, which is the vacuous pass this file exists to
-- hunt, reintroduced by the fix for it.
--
-- That is not hypothetical. The first version of this function shipped as
-- replace(p, backslash, backslash), a no-op, and was green for four rounds
-- because no seed value contained a backslash. Both this check and seed-alpha's
-- publisher exist so it cannot go quiet again: this one proves the function,
-- the seed proves the path through search_blob and check_card_asset.
--
-- Every literal below is built from chr(92) rather than written as a backslash,
-- so the test cannot be broken by the same escaping confusion it detects, and
-- so this file stays ASCII.
create or replace function gate.check_like_literal(p_step text) returns void
language plpgsql as $fn$
declare bs text := chr(92);
        needle text; escaped text; expected text;
        ok_pct boolean; ok_und boolean; ok_bs boolean;
        ok_vacuous boolean; ok_real boolean; ok boolean; v text; note text;
begin
  needle   := 'a' || bs || '%z';
  escaped  := gate.like_literal(needle);
  expected := 'a' || bs || bs || bs || '%z';

  ok_pct := gate.like_literal('a%z') = 'a' || bs || '%z';
  ok_und := gate.like_literal('a_z') = 'a' || bs || '_z';
  ok_bs  := escaped = expected;
  -- Text that does NOT contain the needle must not match. This is the one that
  -- goes red when the backslash is not doubled.
  ok_vacuous := not (('a' || bs || 'bcz') like ('%' || escaped || '%') escape bs);
  -- And text that does contain it must still match, or the escaping is merely
  -- breaking the pattern rather than escaping it.
  ok_real := ('says a' || bs || '%z here') like ('%' || escaped || '%') escape bs;

  ok := ok_pct and ok_und and ok_bs and ok_vacuous and ok_real;
  v  := gate.expect(ok, 'green');
  note := format('percent %s, underscore %s, backslash doubled %s (escaped %s chars, expected %s), vacuous match prevented %s, real match kept %s',
                 ok_pct, ok_und, ok_bs, length(escaped), length(expected), ok_vacuous, ok_real);
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'postgres', 'gate.like_literal', null, v, note);
end $fn$;

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
    -- Escape AFTER reset role, not in the select list above. anon is never
    -- granted usage on the gate schema, deliberately, so calling
    -- gate.like_literal() while the role is still switched raises 42501 and
    -- turns the whole check into an ERROR row. Found by the gate itself.
    nm  := gate.like_literal(nm);
    pub := gate.like_literal(pub);
    mkt := gate.like_literal(mkt);
    ok := n_rows = n_assets and n_rows > 0 and hit
      and coalesce(array_length(mids, 1), 0) > 0
      and lcount >= 1
      and coalesce(blob, '') <> ''
      and blob = lower(blob)
      and blob like '%' || nm  || '%' escape '\'
      and blob like '%' || pub || '%' escape '\'
      and blob like '%' || mkt || '%' escape '\';
    v := gate.expect(ok, p_expect);
    note := format('%s card rows vs %s live assets; %s: marketplace_ids %s, listing_count %s, search_blob %s chars, name %s, publisher %s, marketplace %s, lowercase %s',
                   n_rows, n_assets, p_pid,
                   coalesce(array_length(mids, 1), 0), coalesce(lcount, 0),
                   coalesce(length(blob), 0),
                   coalesce((blob like '%' || nm  || '%' escape '\')::text, 'no row'),
                   coalesce((blob like '%' || pub || '%' escape '\')::text, 'no row'),
                   coalesce((blob like '%' || mkt || '%' escape '\')::text, 'no row'),
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
-- WHAT THIS COVERS, stated precisely, because an earlier version of this
-- comment claimed more. The group's nine columns carry two quantities that are
-- each written down more than once, and this checks that every copy of each
-- agrees:
--
--   the layer count      layers_known    cardinality(known_layers)
--                        reach           round(100.0 * that count / 12)
--                        risk_basis      '... N of M disclosable layers stated'
--
--   the certification    cert_label      registry_provenance(cert) ->> 'label'
--                        risk_basis      the sentence opens with that label
--
-- Three of the four corrections this group needed are therefore visible to it:
-- reach split from layers_known, known_layers split from risk_basis's count,
-- and cert_label split from risk_basis's label, which was round 1's defect and
-- which the first version of this check could NOT see, because it only ever
-- compared numbers.
--
-- WHAT IT DOES NOT COVER, and this is the important half. The relationship
-- between known_layers and the eleven columns it summarises is invisible here:
-- nothing in these views restates "did this listing disclose its hosting" in a
-- second place that could be compared, so a ledger reading 7 of 12 above a null
-- cert_hosting is coherent as far as this function can tell. That is the open
-- cut recorded at length in 20260820100000_asset_keyed_views.sql, and no
-- assertion in this gate detects it. Do not read a green here as covering it.
--
-- Only the NUMERATOR of risk_basis is compared. The denominator is NOT
-- layers_tracked: registry_risk() subtracts the three certification-only
-- layers for an unattested listing, so an uncertified row legitimately reads
-- "3 of 9" while layers_tracked is 12. Comparing denominators would fire on
-- correct data.
--
-- The label is compared by prefix rather than by regex, because
-- registry_risk() builds the basis as label || ' . ' || count and the separator
-- is a non-ASCII character this file would rather not carry. Comparing
-- left(risk_basis, length(cert_label) + 1) against cert_label || ' ' asserts
-- the same thing and additionally requires the separator to follow, so a label
-- that is a strict prefix of another cannot pass.
--
-- The row count is asserted non-zero as well, or an empty card would satisfy
-- "no row disagrees" and report PASS while showing nothing at all.
create or replace function gate.check_cert_group_coherent(p_step text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare n_rows bigint; n_reach bigint; n_basis bigint; n_label bigint; n_unparsed bigint;
        ok boolean; v text; note text := '';
begin
  begin
    set role anon;
    select count(*),
           count(*) filter (where reach is distinct from round(100.0 * layers_known / layers_tracked)::int),
           count(*) filter (where substring(risk_basis from '([0-9]+) of [0-9]+ disclosable layers stated')::int
                                  is distinct from layers_known),
           count(*) filter (where left(risk_basis, length(cert_label) + 1)
                                  is distinct from cert_label || ' '),
           count(*) filter (where substring(risk_basis from '([0-9]+) of [0-9]+ disclosable layers stated') is null)
      into n_rows, n_reach, n_basis, n_label, n_unparsed
      from v_registry_card;
    reset role;
    ok := n_rows > 0 and n_reach = 0 and n_basis = 0 and n_label = 0 and n_unparsed = 0;
    v := gate.expect(ok, p_expect);
    note := format('%s card rows; reach vs layers_known disagrees on %s, risk_basis count disagrees on %s, risk_basis label disagrees with cert_label on %s, risk_basis unparsable on %s',
                   n_rows, n_reach, n_basis, n_label, n_unparsed);
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_registry_card (group coherence)', n_rows, v, note);
end $fn$;

-- The same comparisons on the passport, which sources the group through its
-- own lateral and could therefore disagree with the card.
create or replace function gate.check_passport_group_coherent(p_step text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare n_rows bigint; n_reach bigint; n_basis bigint; n_label bigint;
        ok boolean; v text; note text := '';
begin
  begin
    set role anon;
    select count(*),
           count(*) filter (where reach is distinct from round(100.0 * layers_known / layers_tracked)::int),
           count(*) filter (where substring(risk_basis from '([0-9]+) of [0-9]+ disclosable layers stated')::int
                                  is distinct from layers_known),
           count(*) filter (where left(risk_basis, length(cert_label) + 1)
                                  is distinct from cert_label || ' ')
      into n_rows, n_reach, n_basis, n_label
      from v_asset_passport;
    reset role;
    ok := n_rows > 0 and n_reach = 0 and n_basis = 0 and n_label = 0;
    v := gate.expect(ok, p_expect);
    note := format('%s passport rows; reach disagrees on %s, risk_basis count disagrees on %s, risk_basis label disagrees on %s',
                   n_rows, n_reach, n_basis, n_label);
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'v_asset_passport (group coherence)', n_rows, v, note);
end $fn$;

-- registry_search over the whole asset ---------------------------------------
--
-- registry_search had no gate coverage at all before phase 2 task 3. It is the
-- only call the registry page makes, and every property it has was resting on
-- lib/registry-search.parity.test.ts, which can only run against production.
--
-- Five checks. Every one of them reads its EXPECTATION as postgres, before the
-- role is switched to anon, and compares it against what anon actually gets
-- back. That ordering is the whole design: an assertion that derived both sides
-- from the same anon read would be perfectly green against a registry that
-- returns nothing at all. 5q drops the marketplace policy to prove each of
-- these can in fact go red, rather than leaving it argued here.
--
-- Two of the four properties task 3 changed are invisible under 1:1, because
-- "the asset's marketplaces" and "the primary listing's marketplace" are the
-- same thing while every asset has one listing. 5u gives one asset two
-- listings on two marketplaces, for exactly as long as it takes to assert
-- them, and puts it back.

-- total is a count of ASSETS. registry_search reads v_registry_card, which
-- check_card_asset independently proves is one row per live asset, so this
-- compares against the card and reports the listing count beside it: the two
-- are equal under 1:1 and diverge the moment an asset has a second listing,
-- which is when this assertion starts discriminating.
create or replace function gate.check_search_total(p_step text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare n_cards bigint; n_listings bigint; j jsonb; t bigint; n_returned int;
        ok boolean; v text; note text := '';
begin
  begin
    select count(*) into n_cards    from v_registry_card;
    select count(*) into n_listings from listing;
    set role anon;
    j := registry_search(p_limit => 100000);
    reset role;
    t := (j ->> 'total')::bigint;
    n_returned := jsonb_array_length(j -> 'rows');
    ok := n_cards > 0 and t = n_cards and n_returned = n_cards;
    v := gate.expect(ok, p_expect);
    note := format('total %s, rows returned %s, card rows %s, listings %s',
                   t, n_returned, n_cards, n_listings);
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'registry_search (total)', t, v, note);
end $fn$;

-- A term that appears in exactly one listing, in a field only search_blob
-- carries, still finds the product it belongs to.
--
-- p_pid is the source_product_id of the CARD expected back, which is the
-- product's PRIMARY listing. Under 1:1 that is the listing the term came from.
-- Under 5u it is not, and that is the assertion phase 3 exists for: the term
-- lives on the secondary listing and the card that answers for it names the
-- primary one.
create or replace function gate.check_search_term(p_step text, p_term text, p_pid text,
                                                  p_expect text default 'green')
returns void language plpgsql as $fn$
declare j jsonb; t bigint; pid text; ok boolean; v text; note text := '';
begin
  begin
    set role anon;
    j := registry_search(p_q => p_term, p_limit => 100000);
    reset role;
    t   := (j ->> 'total')::bigint;
    pid := j -> 'rows' -> 0 ->> 'source_product_id';
    ok  := t = 1 and pid = p_pid;
    v := gate.expect(ok, p_expect);
    note := format('q %L: total %s, first source_product_id %L, expected %L',
                   p_term, t, coalesce(pid, '(none)'), p_pid);
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'registry_search (free text)', t, v, note);
end $fn$;

-- The needle escaping, asserted through registry_search itself rather than
-- through a copy of its logic.
--
-- gate.like_literal already proves the escaping RULE. This proves the rule is
-- still wired into the function, which is a different thing and is easy to
-- break while editing the CTE around it.
--
-- Every expected count is computed with strpos() over search_blob, read as
-- postgres. strpos has no pattern language at all, so the expectation cannot
-- be wrong in the same way the thing it is checking can. Hardcoding the
-- answers instead is not just brittle, it is the wrong kind of brittle: the
-- first version of this check asserted "the underscore matches exactly
-- seed-alpha" and went red the moment 06-sentinel.sql added a fourth listing
-- whose tagline names ingest_capture, which is a correct extra match.
--
--   ''        every card, so nothing below is being compared against an empty
--             registry.
--   'seed'    the cards whose blob really contains it, and more than none.
--             This is the positive control: it goes through the LIKE, so if
--             the predicate matched nothing at all the wildcard assertions
--             would pass for entirely the wrong reason.
--   '%'       the cards whose blob really contains a percent sign, which is
--             none of them. Unescaped this is the pattern '%%%' and matches
--             the whole registry. This is "100% managed" in one character.
--   '_'       the cards whose blob really contains an underscore. Unescaped
--             this is '%_%' and matches every non-empty blob.
--   backslash the cards whose blob really contains one, which is seed-alpha
--             alone. This is the case that goes wrong when the backslash is
--             not DOUBLED: the pattern degenerates into a wildcard followed by
--             a literal percent and matches nothing, so this one reads too FEW
--             where the other two read too many.
--
-- Each of the last three also requires its expected count to be below the card
-- count, or the comparison would be satisfied by a function that matched
-- everything. seed-alpha is additionally required to be among the rows for the
-- two adversarial needles, because its publisher was seeded with a literal
-- backslash and underscore for exactly this, and a count alone cannot tell
-- the right rows from the wrong ones.
--
-- The backslash is written as chr(92) so this file stays ASCII and so the test
-- cannot be broken by the same escaping confusion it is looking for.
create or replace function gate.check_search_escape(p_step text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare bs text := chr(92);
        n_cards bigint; n_seed bigint; n_pct bigint; n_und bigint; n_bs bigint;
        j jsonb; t_all bigint; t_seed bigint; t_pct bigint; t_und bigint; t_bs bigint;
        a_und boolean; a_bs boolean;
        ok boolean; v text; note text := '';
begin
  begin
    select count(*),
           count(*) filter (where strpos(search_blob, 'seed') > 0),
           count(*) filter (where strpos(search_blob, '%')    > 0),
           count(*) filter (where strpos(search_blob, '_')    > 0),
           count(*) filter (where strpos(search_blob, bs)     > 0)
      into n_cards, n_seed, n_pct, n_und, n_bs
      from v_registry_card;

    set role anon;
    t_all  := (registry_search(p_limit => 0) ->> 'total')::bigint;
    t_seed := (registry_search(p_q => 'seed', p_limit => 0) ->> 'total')::bigint;
    t_pct  := (registry_search(p_q => '%',    p_limit => 0) ->> 'total')::bigint;
    j := registry_search(p_q => '_', p_limit => 100000);
    t_und := (j ->> 'total')::bigint;
    select count(*) > 0 into a_und from jsonb_array_elements(j -> 'rows') e
     where e.value ->> 'source_product_id' = 'seed-alpha';
    j := registry_search(p_q => bs, p_limit => 100000);
    t_bs := (j ->> 'total')::bigint;
    select count(*) > 0 into a_bs from jsonb_array_elements(j -> 'rows') e
     where e.value ->> 'source_product_id' = 'seed-alpha';
    reset role;

    ok := n_cards > 0
      and t_all  = n_cards
      and t_seed = n_seed and n_seed > 0
      and t_pct  = n_pct  and n_pct  < n_cards
      and t_und  = n_und  and n_und  > 0 and n_und < n_cards and a_und
      and t_bs   = n_bs   and n_bs   > 0 and n_bs  < n_cards and a_bs;
    v := gate.expect(ok, p_expect);
    note := format('%s cards: empty %s; seed %s of %s; percent %s of %s; underscore %s of %s, seed-alpha among them %s; backslash %s of %s, seed-alpha among them %s',
                   n_cards, t_all, t_seed, n_seed, t_pct, n_pct,
                   t_und, n_und, coalesce(a_und::text, 'no rows'),
                   t_bs, n_bs, coalesce(a_bs::text, 'no rows'));
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'registry_search (needle escaping)', n_cards, v, note);
end $fn$;

-- The source facet: names not ids, one count per marketplace, and a filter that
-- matches ANY of the asset's marketplaces.
--
-- The expectation is built from listing and marketplace directly, never from
-- v_registry_card.marketplace_ids, so this cross-checks the array task 2 built
-- rather than agreeing with it. An asset is expected under EVERY marketplace it
-- has a listing on, which is what makes the counts sum to more than total once
-- an asset is multi-listed.
--
-- Four separate things are asserted and each has its own failure:
--
--   1. the facet's (value, count) pairs equal the expectation exactly, which
--      covers a missing value, an extra value and a wrong count in one
--      comparison;
--   2. every value is a real marketplace NAME, so an id can never leak into the
--      rail;
--   3. the counts sum to the number of (asset, marketplace) pairs;
--   4. filtering by each name returns that count, and every card it returns
--      really does have a listing on that marketplace.
--
-- And the ids-versus-names pair, restated for issue #47. p_source now accepts
-- BOTH a marketplace's id and its name and resolves each to the canonical name,
-- so filtering by the raw ID must return the SAME total as filtering by the
-- NAME, marketplace for marketplace. That is the fix asserted directly: the old
-- version of this check required the id form to return 0, which was the bug
-- written down as an expectation rather than the property. A function that
-- still compared p_source against marketplace_ids, or that resolved ids for the
-- filter but seeded the facet with the raw input, would fail here.
--
-- The bogus control stays exactly as it was. Filtering by a value that is
-- neither a known id nor a known name returns nothing AND seeds no facet value:
-- it proves an empty result is not simply what this function does with every
-- array it is handed, and that an unresolved value leaves no phantom bucket in
-- the rail. n_not_a_name above already asserts no id-spelled ghost leaks into
-- the facet for a resolved selection; this is its unknown-value twin.
create or replace function gate.check_search_source(p_step text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare
  j jsonb; t bigint; facet jsonb; expected text[]; actual text[];
  n_not_a_name int; sum_counts bigint; sum_expected bigint;
  r record; n_off int; n_filter_bad int := 0;
  t_by_id bigint; t_by_name bigint; n_id_name_mismatch int := 0; t_bogus bigint;
  ok boolean; v text; note text := '';
begin
  begin
    select array_agg(x.name || '=' || x.n order by x.name) into expected
      from (select m.name, count(distinct c.asset_id) as n
              from v_registry_card c
              join listing l     on l.asset_id = c.asset_id
              join marketplace m on m.id = l.marketplace_id
             group by m.name) x;
    select count(*) into sum_expected
      from (select distinct c.asset_id, l.marketplace_id
              from v_registry_card c
              join listing l on l.asset_id = c.asset_id) pairs;

    set role anon;
    j := registry_search(p_limit => 0);
    reset role;
    t     := (j ->> 'total')::bigint;
    facet := j -> 'facets' -> 'source';

    select array_agg((e.value ->> 'value') || '=' || (e.value ->> 'count')
                     order by e.value ->> 'value')
      into actual from jsonb_array_elements(facet) e;
    select coalesce(sum((e.value ->> 'count')::bigint), 0) into sum_counts
      from jsonb_array_elements(facet) e;
    select count(*) into n_not_a_name
      from jsonb_array_elements(facet) e
     where not exists (select 1 from marketplace m where m.name = e.value ->> 'value');

    for r in select m.name, count(distinct c.asset_id) as n
               from v_registry_card c
               join listing l     on l.asset_id = c.asset_id
               join marketplace m on m.id = l.marketplace_id
              group by m.name
    loop
      set role anon;
      j := registry_search(p_source => array[r.name], p_limit => 100000);
      reset role;
      if (j ->> 'total')::bigint is distinct from r.n then
        n_filter_bad := n_filter_bad + 1;
      end if;
      select count(*) into n_off
        from jsonb_array_elements(j -> 'rows') e
       where not exists (
               select 1 from listing l join marketplace m on m.id = l.marketplace_id
                where l.asset_id = (e.value ->> 'asset_id')::uuid and m.name = r.name);
      n_filter_bad := n_filter_bad + n_off;
    end loop;

    -- Filtering by each marketplace's raw ID must return the SAME total as
    -- filtering by its NAME. This is the issue #47 fix asserted directly: the
    -- previous version required the id form to return 0, which was the defect
    -- written as an expectation. One mismatch anywhere fails the check.
    for r in select m.id as mid, m.name as mname from marketplace m loop
      set role anon;
      t_by_id   := (registry_search(p_source => array[r.mid],   p_limit => 0) ->> 'total')::bigint;
      t_by_name := (registry_search(p_source => array[r.mname], p_limit => 0) ->> 'total')::bigint;
      reset role;
      if t_by_id is distinct from t_by_name then
        n_id_name_mismatch := n_id_name_mismatch + 1;
      end if;
    end loop;

    set role anon;
    t_bogus := (registry_search(p_source => array['definitely-not-a-marketplace'],
                                p_limit => 0) ->> 'total')::bigint;
    reset role;

    ok := t > 0
      and actual is not distinct from expected
      and n_not_a_name = 0
      and sum_counts = sum_expected
      and n_filter_bad = 0
      and n_id_name_mismatch = 0 and t_bogus = 0;
    v := gate.expect(ok, p_expect);
    note := format('total %s; facet %s vs expected %s; non-name values %s; counts sum %s vs %s asset-marketplace pairs; filter mismatches %s; id-vs-name total mismatches %s (must be 0); bogus %s (must be 0)',
                   t,
                   coalesce(array_to_string(actual, ', '), '(none)'),
                   coalesce(array_to_string(expected, ', '), '(none)'),
                   n_not_a_name, sum_counts, sum_expected, n_filter_bad,
                   n_id_name_mismatch, t_bogus);
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'registry_search (source facet)', t, v, note);
end $fn$;

-- The eight sort orders, checked as PROPERTIES rather than against a second
-- copy of the ORDER BY.
--
-- Rebuilding the expected order with the same window function would assert only
-- that two identical expressions agree. These four properties are independent
-- of how the ordering is written, and between them they pin the three things
-- the comment in registry_search says the ordering has to do:
--
--   the page is complete    every card comes back, exactly once
--   the key is monotonic    in the direction asked for, which is what catches a
--                           p_dir that stopped being read
--   nulls are last in BOTH  no row with a null key precedes a row with one, in
--     directions            desc or in asc. A missing rating is not a rating of
--                           zero. rating is null on two of the three seeds, so
--                           this is live rather than theoretical.
--   ties break by asset_id  ascending, whichever way the key sorts, without
--                           which a row can straddle a page boundary
--
-- The key expression is spliced per sort because reach and rating are numeric,
-- captured is a timestamp and name sorts under registry_name_ci; comparing them
-- all as text would silently make the numeric checks lexicographic.
create or replace function gate.check_search_sort(p_step text, p_expect text default 'green')
returns void language plpgsql as $fn$
declare
  sorts text[] := array['reach','rating','captured','name'];
  dirs  text[] := array['desc','asc'];
  s text; d text; j jsonb; n_cards bigint; keyx text; viol text; t bigint;
  n_rows int; n_distinct int; n_mono int; n_null_early int; n_tie int;
  bad text := ''; ok boolean; v text; note text := '';
begin
  begin
    select count(*) into n_cards from v_registry_card;
    foreach s in array sorts loop
      keyx := case s
                when 'reach'    then '(e.value ->> ''reach'')::numeric'
                when 'rating'   then '(e.value ->> ''rating'')::numeric'
                when 'captured' then '(e.value ->> ''last_captured_at'')::timestamptz'
                else                 '(e.value ->> ''name'') collate registry_name_ci'
              end;
      foreach d in array dirs loop
        viol := case when d = 'desc' then 'k > pk' else 'k < pk' end;
        set role anon;
        j := registry_search(p_sort => s, p_dir => d, p_limit => 100000);
        reset role;
        t := (j ->> 'total')::bigint;
        execute format($q$
          with r as (
            select (e.value ->> 'asset_id')::uuid as aid, %s as k, e.ord as ord
              from jsonb_array_elements($1 -> 'rows') with ordinality e(value, ord)
          ), w as (
            select aid, k, ord,
                   lag(k)   over (order by ord) as pk,
                   lag(aid) over (order by ord) as paid
              from r
          )
          select count(*)::int,
                 count(distinct aid)::int,
                 count(*) filter (where ord > 1 and k is not null and pk is not null and (%s))::int,
                 count(*) filter (where ord > 1 and k is not null and pk is null)::int,
                 count(*) filter (where ord > 1 and k is not distinct from pk and aid < paid)::int
            from w
        $q$, keyx, viol)
        into n_rows, n_distinct, n_mono, n_null_early, n_tie
        using j;

        if not (n_cards > 0 and t = n_cards and n_rows = n_cards
                and n_distinct = n_rows and n_mono = 0
                and n_null_early = 0 and n_tie = 0) then
          bad := bad || format('%s %s (total %s, rows %s, distinct %s, out of order %s, null before a value %s, tie not broken by asset_id %s); ',
                               s, d, t, n_rows, n_distinct, n_mono, n_null_early, n_tie);
        end if;
      end loop;
    end loop;
    ok := n_cards > 0 and bad = '';
    v := gate.expect(ok, p_expect);
    note := format('%s cards, 8 orderings: %s', n_cards,
                   coalesce(nullif(bad, ''),
                            'all complete, monotonic, nulls last both ways, ties by asset_id'));
  exception when others then
    reset role; v := 'ERROR ' || sqlstate; note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'anon', 'registry_search (sort order)', n_cards, v, note);
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
  perform gate.check_like_literal('3h. the gate escapes its own LIKE patterns');
  perform gate.check_view_options('3h. all seven views are security_invoker');
  perform gate.check_cert_group_coherent('3i. the certification group agrees with itself');
  perform gate.check_passport_group_coherent('3i. the certification group agrees with itself');

  -- registry_search. 'invoices' is in seed-beta's tagline and nowhere else in
  -- any blob field: its overview_text mentions invoices too, but overview_text
  -- is not one of the nine. 'triage' is in seed-gamma's tagline alone. Both
  -- would fail if the match had been left on the card's own columns and the
  -- tagline had stopped being part of what search reads.
  perform gate.check_search_total('3j. registry_search counts assets, not listings');
  perform gate.check_search_term('3j. a term only in a tagline finds its asset', 'invoices', 'seed-beta');
  perform gate.check_search_term('3j. a term only in a tagline finds its asset', 'triage', 'seed-gamma');
  perform gate.check_search_escape('3k. the needle is escaped, so % is not a wildcard');
  perform gate.check_search_source('3l. the source facet is names, sums, and matches any marketplace');
  perform gate.check_search_sort('3m. the eight sort orders are unchanged');
end $$;

\pset format aligned
select step, as_role, object, n_rows, verdict, note from gate.result order by seq;
