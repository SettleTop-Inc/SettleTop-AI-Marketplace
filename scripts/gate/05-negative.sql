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

\pset format aligned
select step, as_role, object, n_rows, verdict, note
  from gate.result where step like '5%' order by seq;
