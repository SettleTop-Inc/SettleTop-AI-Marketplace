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


-- 5u. One asset on two marketplaces, which is the only way to test any of this.
--
-- Under 1:1 "the asset's marketplaces" and "the primary listing's marketplace"
-- are the same set, and "counts assets" and "counts listings" are the same
-- number, so three of the four properties phase 2 task 3 changed cannot be
-- distinguished from the behaviour they replaced. Every check above is green
-- against the old function too. That is not a reason to skip the checks; it is
-- a reason not to mistake them for evidence.
--
-- So build the phase 3 case here and take it apart again. seed-gamma's listing
-- is moved onto seed-alpha's asset, which leaves:
--
--   three listings and two assets that have a primary listing, because
--   seed-gamma's own asset now points at a listing that names somebody else
--   back and drops out of every asset-keyed view exactly as a retired asset
--   does;
--
--   one asset on two marketplaces, microsoft through its primary listing and
--   drai through the one just moved.
--
-- What that makes provable, none of which was provable a moment ago:
--
--   total counts ASSETS. It must read 2 while listing still holds 3.
--
--   search_blob spans listings. 'triage' appears only in seed-gamma's tagline
--   and seed-gamma is now the SECONDARY listing, so the nine fields on the card
--   itself no longer contain it anywhere. The old function returned nothing for
--   this; the new one must return seed-alpha. This is the vLLM case from the
--   task, with drai standing in for AWS.
--
--   the source facet counts once per MARKETPLACE. Microsoft must read 2 and
--   drai 1, summing to 3 against a total of 2. A facet that grouped the array
--   as a single value would give one bucket holding both names and a count of
--   1, and the match would still be right, which is what makes this the easy
--   half of the change to leave undone.
--
--   the source filter matches ANY of an asset's marketplaces. Filtering by drai
--   must return the asset whose primary listing is on microsoft.
--
-- listing.asset_id is a plain column with no trigger on it, and asset_slug,
-- capture and capture_extract are all keyed by something this does not touch,
-- so the move is a single UPDATE and the restore below is its exact inverse.
-- 5v asserts the restore rather than assuming it.
create temp table search_merge_stash as
  select (select l.id       from listing l where l.source_product_id = 'seed-gamma') as gamma_listing,
         (select l.asset_id from listing l where l.source_product_id = 'seed-gamma') as gamma_asset,
         (select l.asset_id from listing l where l.source_product_id = 'seed-alpha') as alpha_asset;

update listing
   set asset_id = (select alpha_asset from search_merge_stash)
 where id       = (select gamma_listing from search_merge_stash);

do $$
begin
  perform gate.check_search_total('5u. one asset, two marketplaces: total counts assets not listings');
  perform gate.check_search_term('5u. a term on the SECONDARY listing still finds the product', 'triage', 'seed-alpha');
  -- And it must no longer answer with the card it used to, or the line above
  -- could be passing on a row that never moved.
  perform gate.check_search_term('5u. and the retired card no longer answers', 'triage', 'seed-gamma', 'red');
  perform gate.check_search_source('5u. the source facet counts the asset under BOTH marketplaces');
  -- Untouched by the grain change, and asserted so rather than assumed.
  perform gate.check_search_escape('5u. the needle escaping is untouched');
  perform gate.check_search_sort('5u. the sort orders are untouched');
end $$;

update listing
   set asset_id = (select gamma_asset from search_merge_stash)
 where id       = (select gamma_listing from search_merge_stash);

drop table search_merge_stash;

do $$
begin
  perform gate.check_search_total('5v. the listing is back on its own asset');
  perform gate.check_search_term('5v. the listing is back on its own asset', 'triage', 'seed-gamma');
  perform gate.check_search_source('5v. the listing is back on its own asset');
  perform gate.check_search_sort('5v. the listing is back on its own asset');
  perform gate.check_card_asset('5v. the listing is back on its own asset', 'seed-alpha');
  perform gate.check_passport_listings('5v. the listing is back on its own asset', 'seed-alpha');
  perform gate.check_listing_passport('5v. the listing is back on its own asset');
  perform gate.check_asset_evidence('5v. the listing is back on its own asset');
end $$;

\pset format aligned
select step, as_role, object, n_rows, verdict, note
  from gate.result where step like '5%' order by seq;
