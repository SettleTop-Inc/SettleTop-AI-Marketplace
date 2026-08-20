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

\pset format aligned
select step, as_role, object, n_rows, verdict, note from gate.result order by seq;
