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
end $$;

\pset format aligned
select step, as_role, object, n_rows, verdict, note
  from gate.result where step like '5%' order by seq;
