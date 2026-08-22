-- Step 16c: the visibility-gate contract (Access Foundation Phase B2, Task 2).
--
-- Runs AFTER the re-gate migration (20260821180000_visibility_gate.sql) has
-- been applied by run.sh's step 16b, against the same seeded database every
-- earlier check already read. It proves the four-tier read contract the
-- migration's structural self-assertions cannot: those check catalog shape
-- (grants, security_invoker, columns); this checks BEHAVIOR, by actually
-- reading and writing as each role.
--
-- Pattern copied from 13-identity.sql: set_config('request.jwt.claims', ...,
-- true) + set local role authenticated (or anon, which needs no claim) to
-- simulate a browser role, capture results into plpgsql variables, then
-- reset role before touching gate.* or inserting into gate.result. anon and
-- authenticated hold no USAGE on the gate schema, so calling a gate helper
-- while the role is still switched turns the whole check into an ERROR row
-- rather than an assertion; 04-reads.sql's check_card_asset comment explains
-- the same trap. Every per-statement denial check below therefore accumulates
-- into a plpgsql array while switched, and is only written to gate.result
-- after `reset role`.
--
-- Every assertion in this file is expected to PASS; there is no designed
-- failure here for run.sh's EXCLUDED list to carry.

-- 17a. Anon reads the public surface: the four views the gate keeps open, the
-- search function, and slug resolution. -----------------------------------
do $$
declare
  v_seed_asset_id uuid;
  v_resolved      uuid;
  n_card int; n_stats int; n_logo int; n_pub int;
  j jsonb; n_search_rows int;
begin
  select asset_id into v_seed_asset_id from listing where source_product_id = 'seed-alpha';

  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  select count(*) into n_card  from v_registry_card;
  select count(*) into n_stats from v_registry_stats;
  select count(*) into n_logo  from v_logo_status;
  select count(*) into n_pub   from v_asset_passport_public;
  j := registry_search(p_limit => 5);
  n_search_rows := jsonb_array_length(j -> 'rows');
  v_resolved := resolve_asset_slug('seed-alpha');
  reset role;

  insert into gate.result(step, as_role, object, n_rows, verdict, note) values
   ('17a. anon reads the public surface', 'anon', 'v_registry_card', n_card,
     case when n_card > 0 then 'PASS' else 'FAIL: zero rows' end, format('%s rows', n_card)),
   ('17a. anon reads the public surface', 'anon', 'v_registry_stats', n_stats,
     case when n_stats > 0 then 'PASS' else 'FAIL: zero rows' end, format('%s rows', n_stats)),
   ('17a. anon reads the public surface', 'anon', 'v_logo_status', n_logo,
     case when n_logo > 0 then 'PASS' else 'FAIL: zero rows' end, format('%s rows', n_logo)),
   ('17a. anon reads the public surface', 'anon', 'v_asset_passport_public', n_pub,
     case when n_pub > 0 then 'PASS' else 'FAIL: zero rows' end, format('%s rows', n_pub)),
   ('17a. anon reads the public surface', 'anon', 'registry_search(p_limit=>5) rows', n_search_rows,
     case when n_search_rows > 0 then 'PASS' else 'FAIL: zero rows' end, format('%s rows', n_search_rows)),
   ('17a. anon reads the public surface', 'anon', 'resolve_asset_slug(seed-alpha)', null,
     case when v_resolved = v_seed_asset_id then 'PASS' else 'FAIL: mismatch' end,
     format('resolved %s, expected %s', v_resolved, v_seed_asset_id));
end $$;

-- 17b. Anon cap: the page is bounded at 100 rows; the cap bounds the page,
-- not the count, so total still equals the live v_registry_card count. -----
do $$
declare
  j jsonb; n_rows int; n_total int; n_card_pg int;
begin
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  j := registry_search(p_limit => 100000);
  reset role;

  n_rows    := jsonb_array_length(j -> 'rows');
  n_total   := (j ->> 'total')::int;
  select count(*) into n_card_pg from v_registry_card;

  insert into gate.result(step, as_role, object, n_rows, verdict, note) values
   ('17b. anon cap bounds the page not the count', 'anon', 'registry_search(p_limit=>100000) rows', n_rows,
     case when n_rows <= 100 then 'PASS' else 'FAIL: page exceeds the 100-row cap' end,
     format('%s rows returned, cap is 100', n_rows)),
   ('17b. anon cap bounds the page not the count', 'postgres', 'registry_search total vs v_registry_card', n_total,
     case when n_total = n_card_pg then 'PASS' else 'FAIL: total drifted from the live count' end,
     format('total %s, v_registry_card count %s', n_total, n_card_pg));
end $$;

-- 17c. Anon denied on depth, base tables, and capture.raw. Each statement
-- runs under its own begin/exception so one denial does not short-circuit
-- the rest; the exception must be specifically insufficient_privilege
-- (SQLSTATE 42501), not any error. ------------------------------------------
do $$
declare
  deny_labels text[] := array[
    'v_asset_passport','v_listing_passport','v_asset_evidence','v_asset_change_feed',
    'v_merge_candidates','asset','listing','capture','marketplace','capture.raw'
  ];
  deny_stmts text[] := array[
    'select 1 from v_asset_passport limit 1',
    'select 1 from v_listing_passport limit 1',
    'select 1 from v_asset_evidence limit 1',
    'select 1 from v_asset_change_feed limit 1',
    'select 1 from v_merge_candidates limit 1',
    'select 1 from asset limit 1',
    'select 1 from listing limit 1',
    'select 1 from capture limit 1',
    'select 1 from marketplace limit 1',
    'select raw from capture limit 1'
  ];
  deny_ok    boolean[] := array_fill(false, array[10]);
  deny_note  text[]    := array_fill(''::text, array[10]);
  i int;
begin
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  for i in 1 .. array_length(deny_stmts, 1) loop
    begin
      execute deny_stmts[i];
      deny_ok[i]   := false;
      deny_note[i] := 'statement succeeded, expected 42501';
    exception when insufficient_privilege then
      deny_ok[i]   := true;
      deny_note[i] := 'raised ' || sqlstate || ' as required';
    when others then
      deny_ok[i]   := false;
      deny_note[i] := 'wrong error ' || sqlstate || ' ' || sqlerrm;
    end;
  end loop;
  reset role;

  for i in 1 .. array_length(deny_stmts, 1) loop
    insert into gate.result(step, as_role, object, n_rows, verdict, note)
    values ('17c. anon denied on depth, base tables, and capture.raw', 'anon', deny_labels[i], null,
            case when deny_ok[i] then 'PASS' else 'FAIL: ' || deny_note[i] end, deny_note[i]);
  end loop;
end $$;

-- 17d. Authenticated non-admin: reads passport depth, sees zero merge
-- candidates, and is still denied base tables and capture.raw. -------------
do $$
declare
  v_user uuid;
  n_passport int; n_listing_passport int; n_evidence int; n_changefeed int; n_merge int;
  deny_labels text[] := array['capture.raw', 'asset'];
  deny_stmts  text[] := array['select raw from capture limit 1', 'select 1 from asset limit 1'];
  deny_ok     boolean[] := array_fill(false, array[2]);
  deny_note   text[]    := array_fill(''::text, array[2]);
  i int;
begin
  insert into auth.users (email) values ('visgate-nonadmin@example.com') returning id into v_user;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user::text)::text, true);
  set local role authenticated;

  select count(*) into n_passport         from v_asset_passport;
  select count(*) into n_listing_passport from v_listing_passport;
  select count(*) into n_evidence         from v_asset_evidence;
  select count(*) into n_changefeed       from v_asset_change_feed;
  select count(*) into n_merge            from v_merge_candidates;

  for i in 1 .. array_length(deny_stmts, 1) loop
    begin
      execute deny_stmts[i];
      deny_ok[i]   := false;
      deny_note[i] := 'statement succeeded, expected 42501';
    exception when insufficient_privilege then
      deny_ok[i]   := true;
      deny_note[i] := 'raised ' || sqlstate || ' as required';
    when others then
      deny_ok[i]   := false;
      deny_note[i] := 'wrong error ' || sqlstate || ' ' || sqlerrm;
    end;
  end loop;

  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  insert into gate.result(step, as_role, object, n_rows, verdict, note) values
   ('17d. authenticated non-admin reads depth, not candidates', 'authenticated', 'v_asset_passport', n_passport,
     case when n_passport > 0 then 'PASS' else 'FAIL: zero rows' end, format('%s rows', n_passport)),
   ('17d. authenticated non-admin reads depth, not candidates', 'authenticated', 'v_listing_passport', n_listing_passport,
     case when n_listing_passport > 0 then 'PASS' else 'FAIL: zero rows' end, format('%s rows', n_listing_passport)),
   ('17d. authenticated non-admin reads depth, not candidates', 'authenticated', 'v_asset_evidence', n_evidence,
     case when n_evidence > 0 then 'PASS' else 'FAIL: zero rows' end, format('%s rows', n_evidence)),
   ('17d. authenticated non-admin reads depth, not candidates', 'authenticated', 'v_asset_change_feed', n_changefeed,
     case when n_changefeed > 0 then 'PASS' else 'FAIL: zero rows' end, format('%s rows', n_changefeed)),
   ('17d. authenticated non-admin reads depth, not candidates', 'authenticated', 'v_merge_candidates', n_merge,
     case when n_merge = 0 then 'PASS' else 'FAIL: non-admin saw candidate rows' end,
     format('%s rows, expected 0', n_merge));

  for i in 1 .. array_length(deny_stmts, 1) loop
    insert into gate.result(step, as_role, object, n_rows, verdict, note)
    values ('17d. authenticated non-admin still denied base + raw', 'authenticated', deny_labels[i], null,
            case when deny_ok[i] then 'PASS' else 'FAIL: ' || deny_note[i] end, deny_note[i]);
  end loop;
end $$;

-- 17e. Seed a fresh cross-marketplace candidate pair (same technique as
-- 10-merge-candidates.sql: two listings, two marketplaces, matching
-- normalized name), then confirm an allowlisted admin sees it. The pair is
-- left in place afterward, same as 10-merge-candidates.sql's own seed. ------
set role service_role;

create temp table visgatefx (label text, result jsonb);

insert into visgatefx select 'visgate microsoft', ingest_capture($p$
{"capture_meta":{"marketplace_id":"microsoft","source_product_id":"visgate-cross-ms",
  "captured_at_utc":"2026-08-21T18:00:00Z","drive_file_id":"drive-visgate-cross-ms"},
 "ingest_source":"dual_write","raw":{"body":"visgate cross ms"},
 "extract":{"name":"Visgate Crossmarket Product","publisher":"Visgate Vendor",
   "tagline":"visibility gate admin-candidate seed, marketplace one","certification":"none"}}
$p$::jsonb);

insert into visgatefx select 'visgate aws', ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"visgate-cross-aws",
  "captured_at_utc":"2026-08-21T18:00:01Z","drive_file_id":"drive-visgate-cross-aws"},
 "ingest_source":"dual_write","raw":{"body":"visgate cross aws"},
 "extract":{"name":"Visgate Crossmarket Product","publisher":"Visgate Vendor",
   "tagline":"visibility gate admin-candidate seed, marketplace two","certification":"none"}}
$p$::jsonb);

reset role;

do $$
declare
  v_admin uuid;
  a_ms uuid; a_aws uuid;
  n_pair_postgres int;
  n_c_postgres int; n_c_admin int;
begin
  select (result ->> 'asset_id')::uuid into a_ms  from visgatefx where label = 'visgate microsoft';
  select (result ->> 'asset_id')::uuid into a_aws from visgatefx where label = 'visgate aws';

  insert into auth.users (email) values ('niles@settletop.com') returning id into v_admin;

  -- C, computed as postgres: the predicate depends only on auth.uid(), which
  -- reads request.jwt.claims regardless of current_user, so setting the
  -- admin's claim while still running as postgres satisfies the predicate the
  -- same way an admin's own session would, without reproducing the view body.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin::text)::text, true);
  select count(*) into n_c_postgres from v_merge_candidates;
  select count(*) into n_pair_postgres from v_merge_candidates
   where (asset_id_a = a_ms and asset_id_b = a_aws) or (asset_id_a = a_aws and asset_id_b = a_ms);

  -- The same admin, now actually switched to authenticated, must see the
  -- same C.
  set local role authenticated;
  select count(*) into n_c_admin from v_merge_candidates;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  insert into gate.result(step, as_role, object, n_rows, verdict, note) values
   ('17e. authenticated admin sees the seeded cross-marketplace pair', 'postgres',
     'v_merge_candidates (visgate pair, admin jwt)', n_pair_postgres,
     case when n_pair_postgres = 1 then 'PASS' else 'FAIL: seeded pair not present' end,
     format('%s row(s) for the seeded pair, expected 1', n_pair_postgres)),
   ('17e. authenticated admin sees the seeded cross-marketplace pair', 'authenticated',
     'v_merge_candidates (C, admin)', n_c_admin,
     case when n_c_admin > 0 and n_c_admin = n_c_postgres then 'PASS'
          else 'FAIL: admin count does not match C' end,
     format('admin saw %s rows, C (postgres, admin jwt) = %s', n_c_admin, n_c_postgres));
end $$;

-- 17f. The public projection is depth-free: none of the gated columns exist
-- on v_asset_passport_public. Catalog-only, no role switch needed. ---------
do $$
declare
  cols text[] := array['evidence', 'known_layers', 'risk_basis', 'graph_permissions', 'compliance'];
  c text;
  present boolean;
begin
  foreach c in array cols loop
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'v_asset_passport_public' and column_name = c
    ) into present;
    insert into gate.result(step, as_role, object, n_rows, verdict, note)
    values ('17f. public projection carries none of the gated columns', 'postgres',
            'v_asset_passport_public.' || c, null,
            case when present then 'FAIL: column present' else 'PASS' end,
            case when present then 'column exists, expected absent' else 'column absent, as required' end);
  end loop;
end $$;

\pset format aligned
select step, as_role, object, n_rows, verdict, note
  from gate.result where step like '17%' order by seq;
