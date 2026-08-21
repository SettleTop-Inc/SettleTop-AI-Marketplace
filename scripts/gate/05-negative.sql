-- Step 5: prove the negative. A check that has never been observed failing is
-- not known to work, so this deliberately breaks anon's access, confirms every
-- assertion in step 4 goes red, restores it, and confirms they go green again.
--
-- capture_extract is the base table all five views inner-join, so breaking
-- anon's access to it should break all five.
--
-- Two different breakages are exercised, because they do not behave the same
-- way and the difference is the entire subject of this gate.

-- 5a. Remove the RLS policy. This is the silent one. RLS stays enabled, anon
--     keeps its SELECT grant, every statement succeeds, and every row-returning
--     view returns nothing. PostgREST answers 200 with [] and getLogos renders
--     initials. Nothing anywhere reports a fault.
drop policy capture_extract_public_read on public.capture_extract;

do $$
begin
  perform gate.check_rows('5a. RLS policy dropped (silent)', 'anon', 'v_registry_card', 'zero');
  perform gate.check_rows('5a. RLS policy dropped (silent)', 'anon', 'v_asset_passport', 'zero');
  perform gate.check_rows('5a. RLS policy dropped (silent)', 'anon', 'v_asset_change_feed', 'zero');
  perform gate.check_rows('5a. RLS policy dropped (silent)', 'anon', 'v_logo_status', 'zero');
  perform gate.check_rows('5a. RLS policy dropped (silent)', 'anon', 'capture_extract', 'zero');

  -- v_registry_stats aggregates, so its row count stays at 1 and only its
  -- values move. Recorded as informational here and asserted properly at 5d.
  perform gate.check_rows('5a. RLS policy dropped (silent)', 'anon', 'v_registry_stats', 'info');

  -- 5d. The stats view's values while the policy is still gone. This is the
  --     most alarming result in the gate: agents, marketplaces, captures,
  --     changes and last_captured_at are read straight off listing, capture and
  --     listing_change and stay correct, while everything sourced through
  --     v_registry_card collapses to zero or null. The banner would keep
  --     claiming agents exist while the list below it showed none.
  perform gate.check_stats('5d. stats values, RLS policy dropped');
end $$;

create policy capture_extract_public_read on public.capture_extract
  for select to anon, authenticated using (true);

do $$
begin
  perform gate.check_rows('5a. after restoring the policy', 'anon', 'v_registry_card');
  perform gate.check_rows('5a. after restoring the policy', 'anon', 'v_logo_status');
end $$;


-- 5b. Revoke the SELECT grant itself. The views are security_invoker, so anon's
--     own rights are what the underlying scan is checked against, and Postgres
--     refuses the statement outright with 42501. This one is loud at the SQL
--     and HTTP layers, though getLogos still swallows it into initials.
revoke select on public.capture_extract from anon;

do $$
begin
  perform gate.check_rows('5b. SELECT revoked (loud)', 'anon', 'v_registry_card', 'zero');
  perform gate.check_rows('5b. SELECT revoked (loud)', 'anon', 'v_asset_passport', 'zero');
  perform gate.check_rows('5b. SELECT revoked (loud)', 'anon', 'v_asset_change_feed', 'zero');
  perform gate.check_rows('5b. SELECT revoked (loud)', 'anon', 'v_registry_stats', 'zero');
  perform gate.check_rows('5b. SELECT revoked (loud)', 'anon', 'v_logo_status', 'zero');
  perform gate.check_stats('5e. stats values, SELECT revoked');
end $$;

grant select on public.capture_extract to anon;

-- 5c. Everything green again, so the restore is proved rather than assumed.
do $$
begin
  perform gate.check_rows('5c. restored', 'anon', 'v_registry_card');
  perform gate.check_rows('5c. restored', 'anon', 'v_asset_passport');
  perform gate.check_rows('5c. restored', 'anon', 'v_asset_change_feed');
  perform gate.check_rows('5c. restored', 'anon', 'v_registry_stats');
  perform gate.check_rows('5c. restored', 'anon', 'v_logo_status');
  perform gate.check_rows('5c. restored', 'service_role', 'v_logo_status');
  perform gate.check_stats('5f. stats values, restored');
  perform gate.check_logo_status('5f. logo values, restored');
  perform gate.check_passport('5f. passport values, restored', 'seed-alpha');
end $$;

-- 5g. The defect class 3d and 3e exist for, demonstrated.
--
-- This breakage is invisible to every row-count assertion in the gate. RLS is
-- removed from capture_link ONLY. Every view keeps its rows. v_logo_status
-- returns one row per listing exactly as before, and every one of them now has
-- a null logo_url and state no_logo_identified, which is every logo on the site
-- replaced by initials. Before 3d existed the gate called this PASS.
drop policy capture_link_public_read on public.capture_link;

do $$
begin
  -- The row count still passes. That is the point.
  perform gate.check_rows('5g. capture_link policy dropped: row count still passes', 'anon', 'v_logo_status');
  -- The value assertion does not.
  perform gate.check_logo_status('5g. capture_link policy dropped: values go red');
  perform gate.check_passport('5g. capture_link policy dropped: passport links go red', 'seed-alpha');
end $$;

create policy capture_link_public_read on public.capture_link
  for select to anon, authenticated using (true);

do $$
begin
  perform gate.check_logo_status('5h. capture_link policy restored');
  perform gate.check_passport('5h. capture_link policy restored', 'seed-alpha');
end $$;

-- 5i. The same class through the passport's other correlated subqueries. Every
-- passport keeps its row and loses its plans, permissions and compliance.
drop policy capture_plan_public_read       on public.capture_plan;
drop policy capture_permission_public_read on public.capture_permission;
drop policy capture_compliance_public_read on public.capture_compliance;

do $$
begin
  perform gate.check_rows('5i. plan/permission/compliance policies dropped: row count still passes', 'anon', 'v_asset_passport');
  perform gate.check_passport('5i. plan/permission/compliance policies dropped: values go red', 'seed-alpha');
end $$;

create policy capture_plan_public_read       on public.capture_plan       for select to anon, authenticated using (true);
create policy capture_permission_public_read on public.capture_permission for select to anon, authenticated using (true);
create policy capture_compliance_public_read on public.capture_compliance for select to anon, authenticated using (true);

do $$
begin
  perform gate.check_passport('5j. plan/permission/compliance policies restored', 'seed-alpha');
  perform gate.check_logo_status('5j. and the logo values, restored');
end $$;

-- 5k. The same two breakages, against the four views phase 2 added.
--
-- Unlike 5d, 5e, 5g and 5i, none of these steps is excluded from the verdict.
-- Each one states whether it expects green or red, so a breakage that fails to
-- break registers as FAIL rather than as a line the verdict skips over.
--
-- capture_extract first. v_registry_card, v_asset_passport and
-- v_listing_passport all inner-join it, so losing it empties them outright and
-- both the row count and the value assertion go red together. That is the loud
-- case and it is asserted both ways below.
--
-- v_asset_evidence is the one that must NOT move. It reads capture and listing
-- and nothing else, deliberately, because an evidence trail that disappeared
-- when an extract policy moved would be reading something it has no business
-- reading. Asserting it green here is what makes that a property rather than
-- an accident of the current definition.
drop policy capture_extract_public_read on public.capture_extract;

do $$
begin
  perform gate.check_rows('5k. capture_extract dropped: the extract-joined views empty out', 'anon', 'v_registry_card', 'zero');
  perform gate.check_rows('5k. capture_extract dropped: the extract-joined views empty out', 'anon', 'v_asset_passport', 'zero');
  perform gate.check_rows('5k. capture_extract dropped: the extract-joined views empty out', 'anon', 'v_listing_passport', 'zero');

  perform gate.check_card_asset('5k. capture_extract dropped: card values go red', 'seed-alpha', 'red');
  perform gate.check_passport_listings('5k. capture_extract dropped: passport listings go red', 'seed-alpha', 'red');
  perform gate.check_listing_passport('5k. capture_extract dropped: listing passport goes red', 'red');
  perform gate.check_listing_passport_sections('5k. capture_extract dropped: listing passport sections go red', 'seed-alpha', 'red');
  -- Coherence over zero rows is vacuously true, so these prove the non-zero
  -- guard in them is load bearing rather than decorative.
  perform gate.check_cert_group_coherent('5k. capture_extract dropped: group coherence goes red', 'red');
  perform gate.check_passport_group_coherent('5k. capture_extract dropped: group coherence goes red', 'red');

  perform gate.check_rows('5k. capture_extract dropped: v_asset_evidence never reads it', 'anon', 'v_asset_evidence');
  perform gate.check_asset_evidence('5k. capture_extract dropped: v_asset_evidence values are untouched');
end $$;

create policy capture_extract_public_read on public.capture_extract
  for select to anon, authenticated using (true);

do $$
begin
  perform gate.check_card_asset('5l. capture_extract restored', 'seed-alpha');
  perform gate.check_passport_listings('5l. capture_extract restored', 'seed-alpha');
  perform gate.check_listing_passport('5l. capture_extract restored');
  perform gate.check_listing_passport_sections('5l. capture_extract restored', 'seed-alpha');
  perform gate.check_cert_group_coherent('5l. capture_extract restored');
  perform gate.check_passport_group_coherent('5l. capture_extract restored');
  perform gate.check_asset_evidence('5l. capture_extract restored');
end $$;


-- 5m. capture_link, which is the breakage no row count can see.
--
-- Every view keeps every row. v_listing_passport's product_links, legal_links
-- and media go empty underneath it, exactly as v_asset_passport's do at 5g.
--
-- Three things must stay green through it, and each is asserted rather than
-- assumed. v_registry_card never reads capture_link. Neither does
-- v_asset_evidence. And v_asset_passport.listings reaches only listing,
-- marketplace and capture_extract, which are three of the four tables the
-- passport's own row already inner-joins, so the listings array cannot be
-- hollowed by anything that leaves the row standing. That is the property this
-- step exists to record: the one new column on the passport is not in the
-- class of columns 5g is about.
drop policy capture_link_public_read on public.capture_link;

do $$
begin
  perform gate.check_rows('5m. capture_link dropped: every row count still passes', 'anon', 'v_logo_status');
  perform gate.check_rows('5m. capture_link dropped: every row count still passes', 'anon', 'v_asset_passport');
  perform gate.check_rows('5m. capture_link dropped: every row count still passes', 'anon', 'v_listing_passport');

  perform gate.check_listing_passport_sections('5m. capture_link dropped: listing passport links go red', 'seed-alpha', 'red');

  perform gate.check_card_asset('5m. capture_link dropped: the card is untouched', 'seed-alpha');
  perform gate.check_asset_evidence('5m. capture_link dropped: v_asset_evidence is untouched');
  perform gate.check_passport_listings('5m. capture_link dropped: passport listings are untouched', 'seed-alpha');
end $$;

create policy capture_link_public_read on public.capture_link
  for select to anon, authenticated using (true);

do $$
begin
  perform gate.check_listing_passport_sections('5n. capture_link restored', 'seed-alpha');
  perform gate.check_card_asset('5n. capture_link restored', 'seed-alpha');
  perform gate.check_passport_listings('5n. capture_link restored', 'seed-alpha');
  perform gate.check_listing_passport('5n. capture_link restored');
  perform gate.check_asset_evidence('5n. capture_link restored');
  perform gate.check_logo_status('5n. capture_link restored');
  perform gate.check_passport('5n. capture_link restored', 'seed-alpha');
end $$;


-- 5o. A DISCRIMINATING negative test for the coherence check.
--
-- 5k already asserts these two red, but only by emptying the view, which
-- exercises the non-empty guard and nothing else. The comparison logic itself
-- has never been observed failing, and a comparison that has never failed is
-- not known to compare anything.
--
-- So corrupt one thing and only one thing. Every row's risk_basis keeps its
-- layer count and loses its label, which leaves reach, layers_known and the
-- numerator comparison untouched and moves the label comparison alone. If the
-- check still passes, the label clause is decoration.
--
-- This writes to capture_extract rather than dropping a policy, which is a
-- first for this file. The original values are stashed and restored below, and
-- 5p asserts the restore rather than assuming it; step 7 would fail loudly
-- afterwards if it had not worked.
--
-- The substitution keeps the separator and the count by replacing exactly the
-- label prefix: substr past length(label) is ' . N of M disclosable layers
-- stated'. The replacement text is not any of the four labels
-- registry_provenance() can return, so no row is left accidentally correct.
create temp table basis_stash as
  select capture_id, risk_basis from capture_extract;

update capture_extract e
   set risk_basis = 'Deliberately wrong label'
                    || substr(e.risk_basis,
                              length(registry_provenance(e.certification) ->> 'label') + 1);

do $$
begin
  perform gate.check_cert_group_coherent('5o. risk_basis label corrupted: the label clause goes red', 'red');
  perform gate.check_passport_group_coherent('5o. risk_basis label corrupted: the label clause goes red', 'red');
  -- And the neighbours must stay green, or the corruption was not surgical and
  -- the red above proves nothing about the label clause specifically.
  perform gate.check_card_asset('5o. risk_basis label corrupted: the card is otherwise fine', 'seed-alpha');
  perform gate.check_listing_passport('5o. risk_basis label corrupted: the listing passport is otherwise fine');
  perform gate.check_asset_evidence('5o. risk_basis label corrupted: v_asset_evidence is untouched');
end $$;

update capture_extract e
   set risk_basis = s.risk_basis
  from basis_stash s
 where s.capture_id = e.capture_id;

drop table basis_stash;

do $$
begin
  perform gate.check_cert_group_coherent('5p. risk_basis restored');
  perform gate.check_passport_group_coherent('5p. risk_basis restored');
end $$;

-- 5q. The negative control for the five registry_search checks.
--
-- They were all added at once and had all been green from the moment they were
-- written, which is the same as never having been observed to work. This drops
-- the RLS policy on marketplace, which every asset-keyed view inner-joins, so
-- anon sees an empty v_registry_card and registry_search answers every question
-- with total 0 and no facets.
--
-- Each check reads its expectation as postgres before switching role, so each
-- one must go red here. If any of them stayed green, it would be comparing anon
-- against anon and would report a working registry to a visitor seeing none.
drop policy marketplace_public_read on public.marketplace;

do $$
begin
  perform gate.check_search_total('5q. marketplace policy dropped: search goes red', 'red');
  perform gate.check_search_term('5q. marketplace policy dropped: search goes red', 'invoices', 'seed-beta', 'red');
  perform gate.check_search_escape('5q. marketplace policy dropped: search goes red', 'red');
  perform gate.check_search_source('5q. marketplace policy dropped: search goes red', 'red');
  perform gate.check_search_sort('5q. marketplace policy dropped: search goes red', 'red');
end $$;

create policy marketplace_public_read on public.marketplace
  for select to anon, authenticated using (true);

do $$
begin
  perform gate.check_search_total('5r. marketplace policy restored');
  perform gate.check_search_term('5r. marketplace policy restored', 'invoices', 'seed-beta');
  perform gate.check_search_escape('5r. marketplace policy restored');
  perform gate.check_search_source('5r. marketplace policy restored');
  perform gate.check_search_sort('5r. marketplace policy restored');
  perform gate.check_card_asset('5r. marketplace policy restored', 'seed-alpha');
end $$;


-- 5s. A DISCRIMINATING control for the free-text checks, in the style of 5o.
--
-- 5q proves they can go red, but only by emptying the registry, which exercises
-- the non-vacuity guard and nothing else. So corrupt one field and only one
-- field: every tagline goes blank, which is exactly the field 'invoices' and
-- 'triage' live in and no other field the blob carries.
--
-- The two term checks must go red. The other three must stay GREEN, or the
-- corruption was not surgical and the red above says nothing about the tagline
-- specifically. function_category is a stored column computed at ingest, not
-- recomputed from the tagline on read, so blanking the tagline does not move
-- it and the facets are genuinely untouched.
create temp table tagline_stash as select capture_id, tagline from capture_extract;

update capture_extract set tagline = '';

do $$
begin
  perform gate.check_search_term('5s. taglines blanked: the tagline terms go red', 'invoices', 'seed-beta', 'red');
  perform gate.check_search_term('5s. taglines blanked: the tagline terms go red', 'triage', 'seed-gamma', 'red');
  perform gate.check_search_total('5s. taglines blanked: everything else is untouched');
  perform gate.check_search_escape('5s. taglines blanked: everything else is untouched');
  perform gate.check_search_source('5s. taglines blanked: everything else is untouched');
  perform gate.check_search_sort('5s. taglines blanked: everything else is untouched');
end $$;

update capture_extract e set tagline = s.tagline from tagline_stash s where s.capture_id = e.capture_id;
drop table tagline_stash;

do $$
begin
  perform gate.check_search_term('5t. taglines restored', 'invoices', 'seed-beta');
  perform gate.check_search_term('5t. taglines restored', 'triage', 'seed-gamma');
end $$;


-- 5u. One asset on two marketplaces, built and taken apart through the real
-- merge_assets and unmerge_asset RPCs rather than a raw UPDATE. Issue #63.
--
-- This is where the two functions #63 adds are exercised end to end. Phase 2
-- left this step as a bare `update listing set asset_id`, which reproduced the
-- listing move but none of the rest of a merge: it did not retire the absorbed
-- asset, move its slugs, or log anything. merge_assets does all of it in one
-- transaction, and unmerge_asset restores it exactly. The search assertions the
-- old 5u carried must still pass through the RPC, and they do, because the RPC
-- produces the same listing topology and more.
--
-- The case: seed-gamma (drai) is folded into seed-alpha (microsoft), so
-- seed-alpha's asset ends up with two listings on two marketplaces and
-- seed-gamma's asset is retired. That is Red Hat AI Enterprise on Microsoft and
-- AWS reproduced deterministically, with drai standing in for AWS. What it makes
-- provable, none of which was provable under 1:1:
--
--   total counts ASSETS. It must fall to the live-asset count while listing
--   still holds every row.
--   search_blob spans listings. 'triage' is only in seed-gamma's tagline, which
--   is now the SECONDARY listing, so it is nowhere on the card's own nine fields
--   and search must still return seed-alpha for it.
--   the source facet counts once per MARKETPLACE, microsoft and drai both.
--   the survivor's passport carries two listings with exactly one primary, the
--   absorbed slug resolves to the survivor, and the retired asset is gone from
--   every asset-keyed view.
--
-- merge_assets and unmerge_asset touch no capture-family table, so the seven
-- tables' content is identical before merge, after merge and after unmerge, and
-- 5v proves the unmerge restores listing.asset_id, asset_slug.asset_id,
-- asset_slug.is_canonical per slug, asset.merged_into and every v_registry_stats
-- field to their pre-merge values.

-- 5u0. The RPCs are service_role only, exactly like ingest_capture: granted to
-- service_role, revoked from anon and authenticated.
do $$
declare ok boolean;
begin
  ok := has_function_privilege('service_role', 'merge_assets(uuid,uuid,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'unmerge_asset(bigint)', 'EXECUTE')
    and not has_function_privilege('anon',          'merge_assets(uuid,uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'merge_assets(uuid,uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('anon',          'unmerge_asset(bigint)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'unmerge_asset(bigint)', 'EXECUTE');
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('5u0. merge RPCs are service_role only', 'postgres', 'has_function_privilege', null,
          gate.expect(ok, 'green'),
          format('merge exec: service_role %s anon %s authenticated %s; unmerge exec: service_role %s anon %s authenticated %s',
            has_function_privilege('service_role','merge_assets(uuid,uuid,text,text)','EXECUTE'),
            has_function_privilege('anon','merge_assets(uuid,uuid,text,text)','EXECUTE'),
            has_function_privilege('authenticated','merge_assets(uuid,uuid,text,text)','EXECUTE'),
            has_function_privilege('service_role','unmerge_asset(bigint)','EXECUTE'),
            has_function_privilege('anon','unmerge_asset(bigint)','EXECUTE'),
            has_function_privilege('authenticated','unmerge_asset(bigint)','EXECUTE')));
end $$;

-- The two assets, and the absorbed listing, carried between statements.
create temp table mx as
  select (select l.asset_id from listing l where l.source_product_id = 'seed-gamma') as gamma_asset,
         (select l.id       from listing l where l.source_product_id = 'seed-gamma') as gamma_listing,
         (select l.asset_id from listing l where l.source_product_id = 'seed-alpha') as alpha_asset;

-- 5u1. merge_assets refuses bad input, with a raise and never a silent no-op.
-- Six of the seven rules are trippable while both assets are still live; the
-- seventh, already-retired, is asserted below once the merge has retired one.
do $$
declare g uuid; a uuid; t uuid; st text := '5u1. merge_assets rejects bad input';
begin
  select gamma_asset, alpha_asset into g, a from mx;
  -- A throwaway asset with no listings, for the zero-listing rule, deleted again
  -- immediately so it cannot disturb the 1:1 counts the later steps assert.
  insert into asset default values returning id into t;

  perform gate.check_raises(st, 'same id twice',
    format('select merge_assets(%L::uuid, %L::uuid, %L, %L)', g, g, 'basis', 'gate-harness'),
    'p_from = p_into');
  perform gate.check_raises(st, 'unknown id',
    format('select merge_assets(%L::uuid, %L::uuid, %L, %L)', gen_random_uuid(), a, 'basis', 'gate-harness'),
    'p_from absent from asset');
  perform gate.check_raises(st, 'zero-listing asset',
    format('select merge_assets(%L::uuid, %L::uuid, %L, %L)', t, a, 'basis', 'gate-harness'),
    'p_from owns no listings');
  perform gate.check_raises(st, 'blank basis',
    format('select merge_assets(%L::uuid, %L::uuid, %L, %L)', g, a, '   ', 'gate-harness'),
    'p_basis blank');
  perform gate.check_raises(st, 'blank handle',
    format('select merge_assets(%L::uuid, %L::uuid, %L, %L)', g, a, 'basis', ''),
    'p_by blank');
  perform gate.check_raises(st, 'handle contains @',
    format('select merge_assets(%L::uuid, %L::uuid, %L, %L)', g, a, 'basis', 'niles@settletop.com'),
    'p_by contains @');

  delete from asset where id = t;
end $$;

-- 5u#63. Give the from-asset a SECOND slug before the merge: its real canonical
-- slug (seed-gamma, is_canonical true) plus a manually inserted NON-canonical
-- sibling. This is the exact case the reversibility contract turns on and that a
-- one-slug fixture cannot prove: merge_assets clears is_canonical on EVERY moved
-- slug, and unmerge_asset restores it on from_canonical_slug ALONE, so on the way
-- back the canonical slug and the sibling must part ways per slug. Inserted as
-- postgres (the harness role, which has the same reach as service_role here),
-- before every snapshot below, so premerge_slug captures both rows and every
-- assertion downstream compares both. Removed again at the step 5 cleanup, so the
-- sentinel and final steps meet seed-gamma in its seeded one-slug state.
insert into asset_slug (slug, asset_id, is_canonical)
values ('seed-gamma-legacy', (select gamma_asset from mx), false);

-- Pre-merge snapshots for the exact-restoration proof and the content-hash
-- invariance. Taken now, while seed-gamma is still live and standalone (and now
-- carrying its canonical slug plus the non-canonical sibling above).
create temp table premerge_slug as
  select slug, asset_id, is_canonical from asset_slug where asset_id = (select gamma_asset from mx);

create temp table msnap (fingerprint0 jsonb, stats0 jsonb, agents0 bigint);
insert into msnap
  select gate.capture_family_fingerprint(), gate.stats_json(),
         (gate.stats_json() ->> 'agents')::bigint;

create temp table mrun (merge_id bigint);

-- The merge, as service_role, which is how production would call it. The RPC is
-- security definer, so it runs as its owner whoever calls it; calling it as
-- service_role exercises the execute grant end to end. The ids are read into
-- local variables first so no temp table is read while the role is switched.
do $$
declare g uuid; a uuid; mid bigint;
begin
  select gamma_asset, alpha_asset into g, a from mx;
  set role service_role;
  mid := (merge_assets(g, a,
            'gate 5u: seed-gamma and seed-alpha are the same product across marketplaces',
            'gate-harness') ->> 'merge_id')::bigint;
  reset role;
  insert into mrun values (mid);
end $$;

-- The search assertions the old 5u carried, unchanged, now against the merged
-- state the RPC produced. Every one must still pass.
do $$
begin
  perform gate.check_search_total('5u. one asset, two marketplaces: total counts assets not listings');
  perform gate.check_search_term('5u. a term on the SECONDARY listing still finds the product', 'triage', 'seed-alpha');
  -- And the retired card must no longer answer, or the line above could be
  -- passing on a row that never moved.
  perform gate.check_search_term('5u. and the retired card no longer answers', 'triage', 'seed-gamma', 'red');
  perform gate.check_search_source('5u. the source facet counts the asset under BOTH marketplaces');
  -- Untouched by the merge, and asserted so rather than assumed.
  perform gate.check_search_escape('5u. the needle escaping is untouched');
  perform gate.check_search_sort('5u. the sort orders are untouched');
end $$;

-- The merged-state assertions #63 asks for, on top of the search ones.
do $$
declare
  g uuid; a uuid; canon text; slug_owner uuid;
  card_gamma int; pass_gamma int; surv_listings int; surv_primary int;
  agents0 bigint; agents1 bigint; certified1 bigint; attested1 bigint;
  n_dangling int; ls jsonb; s1 jsonb; ok boolean;
  st text := '5u. merged state, via merge_assets';
begin
  select gamma_asset, alpha_asset into g, a from mx;
  select msnap.agents0 into agents0 from msnap;
  select from_canonical_slug into canon from asset_merge where id = (select merge_id from mrun);

  s1 := gate.stats_json();
  agents1    := (s1 ->> 'agents')::bigint;
  certified1 := (s1 ->> 'certified')::bigint;
  attested1  := (s1 ->> 'attested')::bigint;

  set role anon;
  select count(*) into card_gamma from v_registry_card  where asset_id = g;
  select count(*) into pass_gamma from v_asset_passport where asset_id = g;
  select p.listings into ls from v_asset_passport p where p.asset_id = a;
  reset role;

  surv_listings := coalesce(jsonb_array_length(ls), 0);
  select count(*) into surv_primary
    from jsonb_array_elements(coalesce(ls, '[]'::jsonb)) e
   where (e ->> 'is_primary') = 'true';

  -- The absorbed slug now resolves to the survivor's asset.
  select asset_id into slug_owner from asset_slug where slug = canon;

  -- No asset is left retired while a listing still points at it.
  select count(*) into n_dangling
    from asset x
   where x.merged_into is not null
     and exists (select 1 from listing l where l.asset_id = x.id);

  ok := card_gamma = 0 and pass_gamma = 0
    and surv_listings = 2 and surv_primary = 1
    and slug_owner = a
    and agents1 = agents0 - 1
    and certified1 + attested1 <= agents1
    and n_dangling = 0;

  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'anon', 'v_registry_card / v_asset_passport / v_registry_stats', null, gate.expect(ok, 'green'),
    format('retired asset card rows %s, passport rows %s; survivor listings %s (exactly one primary %s); absorbed slug %L resolves to %s (survivor %s); agents %s to %s; certified %s + attested %s <= agents %s; retired-with-listing assets %s',
      card_gamma, pass_gamma, surv_listings, surv_primary, canon, slug_owner, a,
      agents0, agents1, certified1, attested1, agents1, n_dangling));
end $$;

-- 5u#63. The per-slug distinction after the merge, on the two-slug from-asset.
-- BOTH of the from-asset's slugs are now on the survivor and BOTH are
-- non-canonical: merge_assets cleared is_canonical on the canonical one, and the
-- sibling was already false. And from_canonical_slug recorded the ORIGINAL
-- canonical slug, seed-gamma, not the sibling, which is the only thing that lets
-- unmerge later restore canonical on the right one. This is what a one-slug
-- fixture could not assert, because with one slug "the canonical one" and "the
-- only one" are the same row.
do $$
declare
  a uuid; canon text;
  canon_owner uuid; canon_flag boolean;
  sib_owner uuid;   sib_flag boolean;
  ok boolean; st text := '5u. two-slug from-asset: both slugs moved and both non-canonical';
begin
  select alpha_asset into a from mx;
  select from_canonical_slug into canon from asset_merge where id = (select merge_id from mrun);

  select asset_id, is_canonical into canon_owner, canon_flag
    from asset_slug where slug = 'seed-gamma';
  select asset_id, is_canonical into sib_owner, sib_flag
    from asset_slug where slug = 'seed-gamma-legacy';

  ok := canon = 'seed-gamma'                     -- the original canonical slug, not the sibling
    and canon_owner = a and sib_owner = a        -- both moved to the survivor
    and canon_flag = false and sib_flag = false; -- both non-canonical after the merge

  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'postgres', 'asset_slug (both slugs) / asset_merge.from_canonical_slug', null,
    gate.expect(ok, 'green'),
    format('from_canonical_slug %L (want seed-gamma); seed-gamma -> owner %s canonical %s; seed-gamma-legacy -> owner %s canonical %s; survivor %s',
      canon, canon_owner, canon_flag, sib_owner, sib_flag, a));
end $$;

-- 5u1, continued. The seventh rule, now trippable: p_from is retired.
do $$
declare g uuid; a uuid;
begin
  select gamma_asset, alpha_asset into g, a from mx;
  perform gate.check_raises('5u1. merge_assets rejects bad input', 'already-retired id',
    format('select merge_assets(%L::uuid, %L::uuid, %L, %L)', g, a, 'basis', 'gate-harness'),
    'p_from already retired');
end $$;

-- The capture family is untouched by the merge: same seven fingerprints as
-- before it ran.
do $$
declare f0 jsonb; f1 jsonb; ok boolean;
begin
  select fingerprint0 into f0 from msnap;
  f1 := gate.capture_family_fingerprint();
  ok := f1 = f0;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('5u. capture-family content-hash invariance across the merge', 'postgres',
          'capture family fingerprint (before vs after merge)', null, gate.expect(ok, 'green'),
          format('identical=%s; before=%s; after=%s', ok, f0::text, f1::text));
end $$;

-- 5v. unmerge_asset restores exactly.
do $$
declare mid bigint;
begin
  select merge_id into mid from mrun;
  set role service_role;
  perform unmerge_asset(mid);
  reset role;
end $$;

-- The search assertions confirm the restoration from the query angle, exactly as
-- the old 5v did.
do $$
begin
  perform gate.check_search_total('5v. unmerge restores: the listing is back on its own asset');
  perform gate.check_search_term('5v. unmerge restores: the listing is back on its own asset', 'triage', 'seed-gamma');
  perform gate.check_search_source('5v. unmerge restores: the listing is back on its own asset');
  perform gate.check_search_sort('5v. unmerge restores: the listing is back on its own asset');
  perform gate.check_card_asset('5v. unmerge restores: the listing is back on its own asset', 'seed-alpha');
  perform gate.check_passport_listings('5v. unmerge restores: the listing is back on its own asset', 'seed-alpha');
  perform gate.check_listing_passport('5v. unmerge restores: the listing is back on its own asset');
  perform gate.check_asset_evidence('5v. unmerge restores: the listing is back on its own asset');
end $$;

-- The exact-restoration proof #63 asks for: listing.asset_id, asset_slug.asset_id,
-- asset_slug.is_canonical per slug, asset.merged_into null, every stat field back
-- to pre-merge, and the capture family unchanged.
do $$
declare
  g uuid; gl uuid; listing_owner uuid; merged_into_val uuid;
  n_slug int; n_slug_match int; s0 jsonb; s2 jsonb; f0 jsonb; f2 jsonb;
  ok boolean; st text := '5v. unmerge_asset restores exactly';
begin
  select gamma_asset, gamma_listing into g, gl from mx;
  select stats0, fingerprint0 into s0, f0 from msnap;

  select asset_id  into listing_owner   from listing where id = gl;
  select merged_into into merged_into_val from asset where id = g;
  select count(*)  into n_slug           from premerge_slug;
  select count(*)  into n_slug_match
    from premerge_slug p join asset_slug s using (slug)
   where s.asset_id = p.asset_id and s.is_canonical = p.is_canonical;

  s2 := gate.stats_json();
  f2 := gate.capture_family_fingerprint();

  ok := listing_owner = g
    and n_slug > 0 and n_slug_match = n_slug
    and merged_into_val is null
    and s2 = s0
    and f2 = f0;

  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'anon', 'listing / asset_slug / asset / v_registry_stats / capture family', null,
          gate.expect(ok, 'green'),
    format('absorbed listing owner %s (want %s); slugs restored (asset_id and is_canonical) %s of %s; merged_into %s; every stat field equal %s; capture fingerprint equal %s',
      listing_owner, g, n_slug_match, n_slug, coalesce(merged_into_val::text, 'null'), (s2 = s0), (f2 = f0)));
end $$;

-- 5v#63. The per-slug distinction after the unmerge, the crux of the
-- reversibility contract and the case the one-slug fixture left unproven. BOTH
-- slugs are back on the from-asset; the ORIGINAL canonical slug is canonical
-- again; the sibling STAYS non-canonical; and the from-asset carries exactly one
-- canonical slug. This assertion is genuinely failable, which is the whole point:
-- if unmerge_asset restored canonical on the sibling (the wrong slug), or on
-- both, canon_flag/sib_flag/n_canon would move and it would go red. The one-slug
-- 5v could not fail this way, because restoring canonical on "the only slug" is
-- restoring it on "the canonical slug" whatever the code intended.
do $$
declare
  g uuid;
  canon_owner uuid; canon_flag boolean;
  sib_owner uuid;   sib_flag boolean;
  n_canon int; ok boolean;
  st text := '5v. two-slug from-asset: canonical restored on the right slug alone';
begin
  select gamma_asset into g from mx;

  select asset_id, is_canonical into canon_owner, canon_flag
    from asset_slug where slug = 'seed-gamma';
  select asset_id, is_canonical into sib_owner, sib_flag
    from asset_slug where slug = 'seed-gamma-legacy';
  select count(*) into n_canon from asset_slug where asset_id = g and is_canonical;

  ok := canon_owner = g and sib_owner = g   -- both slugs back on the from-asset
    and canon_flag = true                   -- the original canonical slug is canonical again
    and sib_flag = false                    -- the sibling stays non-canonical
    and n_canon = 1;                         -- exactly one canonical slug per asset

  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'postgres', 'asset_slug (both slugs), one-canonical invariant', n_canon,
    gate.expect(ok, 'green'),
    format('seed-gamma -> owner %s canonical %s; seed-gamma-legacy -> owner %s canonical %s; canonical slugs on from-asset %s (want exactly 1)',
      canon_owner, canon_flag, sib_owner, sib_flag, n_canon));
end $$;

-- unmerge_asset twice on the same merge raises on the second call.
do $$
declare mid bigint;
begin
  select merge_id into mid from mrun;
  perform gate.check_raises('5v. a second unmerge of the same merge raises',
    'unmerge_asset twice', format('select unmerge_asset(%s)', mid), 'merge already undone');
end $$;

-- 5w. Re-harvesting an absorbed listing does NOT undo the merge. A fresh merge is
-- put in place, the absorbed listing is re-ingested through the ordinary capture
-- path, and ingest_capture must take its listing-exists else branch (update
-- listing set updated_at) and never rewrite asset_id: the merge stands. This
-- runs after the exact-restoration proof above, because a re-harvest inserts a
-- capture and so would move the very capture-family fingerprint 5v pins.
create temp table mrun2 (merge_id bigint);

do $$
declare g uuid; a uuid; mid2 bigint;
begin
  select gamma_asset, alpha_asset into g, a from mx;
  set role service_role;
  mid2 := (merge_assets(g, a, 'gate 5w: re-merge to prove re-harvest does not undo it', 'gate-harness')
           ->> 'merge_id')::bigint;
  reset role;
  insert into mrun2 values (mid2);
end $$;

create temp table reharvest (result jsonb);
-- The same drai/seed-gamma listing, re-captured with its own content unchanged
-- and a fresh drive_file_id. It is an existing listing now owned by the survivor,
-- so ingest_capture must adopt that asset, not create a new one. The call is made
-- as service_role, but the temp-table insert happens after reset role, because
-- service_role holds no privilege on a postgres-owned temp table.
do $blk$
declare r jsonb;
begin
  set role service_role;
  r := ingest_capture($p$
{
  "capture_meta": {
    "marketplace_id": "drai",
    "source_product_id": "seed-gamma",
    "listing_url": "https://www.drai-commercial.com/agent/seed-gamma",
    "captured_at_utc": "2026-08-19T15:00:00Z",
    "drive_file_id": "drive-seed-gamma-reharvest-1"
  },
  "ingest_source": "dual_write",
  "raw": {"body": "seed gamma re-harvest while absorbed"},
  "extract": {
    "name": "Seed Gamma Assistant",
    "publisher": "Gamma Systems",
    "tagline": "Agentic support triage",
    "overview_text": "Seed Gamma Assistant uses Llama 3 and CrewAI.",
    "pricing": "Contact us",
    "certification": "publisher_attestation",
    "surfaces": ["Web"],
    "categories": ["Support"],
    "stated": {"models": ["Llama 3"], "frameworks": ["CrewAI"]},
    "cert_detail": {"hosting": "AWS", "data_location": "United States"}
  }
}
$p$::jsonb);
  reset role;
  insert into reharvest values (r);
end $blk$;

do $$
declare
  g uuid; a uuid; mid2 bigint; r jsonb;
  res_status text; res_asset uuid; listing_owner uuid; n_listing int; undone timestamptz;
  ok boolean; st text := '5w. re-harvesting an absorbed listing does not undo the merge';
begin
  select gamma_asset, alpha_asset into g, a from mx;
  select merge_id into mid2 from mrun2;
  select result into r from reharvest;
  res_status := r ->> 'status';
  res_asset  := (r ->> 'asset_id')::uuid;
  select asset_id into listing_owner from listing where source_product_id = 'seed-gamma';
  select count(*)  into n_listing     from listing where source_product_id = 'seed-gamma';
  select undone_at into undone        from asset_merge where id = mid2;

  ok := res_status = 'updated'   -- the listing-exists else branch, not 'created'
    and res_asset = a            -- it adopted the survivor, created no new asset
    and listing_owner = a        -- and never rewrote listing.asset_id
    and n_listing = 1            -- no second listing
    and undone is null;          -- the merge is still in force

  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'service_role', 'ingest_capture on an absorbed listing', null, gate.expect(ok, 'green'),
    format('status %L, result asset_id %s (survivor %s), listing owner %s, listings %s, merge undone_at %s',
      res_status, res_asset, a, listing_owner, n_listing, coalesce(undone::text, 'null')));
end $$;

-- Undo the re-harvest merge, so seed-gamma is live and standalone again for the
-- sentinel, final and merged-guard steps that follow.
do $$
declare mid2 bigint;
begin
  select merge_id into mid2 from mrun2;
  set role service_role;
  perform unmerge_asset(mid2);
  reset role;
end $$;

-- Remove the #63 sibling slug so seed-gamma returns to its seeded one-slug state
-- for the sentinel, final and merged-guard steps that follow. 07-final asserts an
-- asset_slug before/after count invariant across its re-ingest, so a slug added
-- here must not leak past step 5. seed-gamma itself is left exactly as seeded.
delete from asset_slug where slug = 'seed-gamma-legacy';

drop table mx;
drop table premerge_slug;
drop table msnap;
drop table mrun;
drop table mrun2;
drop table reharvest;

\pset format aligned
select step, as_role, object, n_rows, verdict, note
  from gate.result where step like '5%' order by seq;
