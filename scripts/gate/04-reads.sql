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

\pset format aligned
select step, as_role, object, n_rows, verdict, note from gate.result order by seq;
