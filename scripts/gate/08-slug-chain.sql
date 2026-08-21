-- Step 12: the three level canonical slug chain, and proof that an unguarded
-- collision no longer aborts the ingest. Issue #45.
--
-- Runs LAST, after 07-final has finished every count, facet and read assertion,
-- so the assets it adds cannot move a number an earlier check depends on. Each
-- ingest here creates its own single listing asset, so the registry stays 1:1:
-- the point is not two listings on one asset, it is two marketplaces claiming
-- the same source_product_id, which is the first thing that drives the slug
-- past level 0. Before this migration the second such claim was survivable only
-- while its marketplace prefix happened to be free; the third, whose prefix was
-- also taken, hit the unguarded fallback insert and aborted the whole capture.
set role service_role;

create temp table slugfx (label text, level int, result jsonb);

-- L0: a fresh product id on microsoft. The bare slug "dup" is free, so it is
-- claimed directly and slug_fallback reports level 0.
insert into slugfx select 'L0 microsoft/dup', 0, ingest_capture($p$
{"capture_meta":{"marketplace_id":"microsoft","source_product_id":"dup",
  "captured_at_utc":"2026-08-20T10:00:00Z","drive_file_id":"drive-slugfx-l0"},
 "ingest_source":"dual_write","raw":{"body":"slugfx l0"},
 "extract":{"name":"Slug Chain L0","publisher":"Slug Chain Co",
   "tagline":"bare product id is free","certification":"none"}}
$p$::jsonb);

-- Prereq so the L2 case below finds its marketplace prefixed slug already taken:
-- a microsoft listing whose bare product id is literally the string "drai-dup".
-- Its own bare slug is free, so it lands at level 0 and occupies "drai-dup".
insert into slugfx select 'prereq microsoft/drai-dup', 0, ingest_capture($p$
{"capture_meta":{"marketplace_id":"microsoft","source_product_id":"drai-dup",
  "captured_at_utc":"2026-08-20T10:00:01Z","drive_file_id":"drive-slugfx-prereq"},
 "ingest_source":"dual_write","raw":{"body":"slugfx prereq"},
 "extract":{"name":"Slug Chain Prereq","publisher":"Slug Chain Co",
   "tagline":"occupies the slug drai-dup","certification":"none"}}
$p$::jsonb);

-- L1: the same product id "dup" on aws. Bare "dup" is taken by the L0 asset, so
-- the chain falls to "aws-dup", which is free. slug_fallback reports level 1.
insert into slugfx select 'L1 aws/dup', 1, ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"dup",
  "captured_at_utc":"2026-08-20T10:00:02Z","drive_file_id":"drive-slugfx-l1"},
 "ingest_source":"dual_write","raw":{"body":"slugfx l1"},
 "extract":{"name":"Slug Chain L1","publisher":"Slug Chain Co",
   "tagline":"bare taken, marketplace prefix free","certification":"none"}}
$p$::jsonb);

-- L2: "dup" on drai. Bare "dup" is taken (L0) AND "drai-dup" is taken (prereq),
-- so the chain reaches the terminal identity, the asset uuid as text, and
-- slug_fallback reports level 2. Under the OLD unguarded fallback this exact
-- ingest raised unique_violation on asset_slug_pkey outside any exception block
-- and aborted the whole transaction: no asset, no listing, no capture, with an
-- error that named the primary key rather than the capture. It must now COMMIT.
insert into slugfx select 'L2 drai/dup', 2, ingest_capture($p$
{"capture_meta":{"marketplace_id":"drai","source_product_id":"dup",
  "captured_at_utc":"2026-08-20T10:00:03Z","drive_file_id":"drive-slugfx-l2"},
 "ingest_source":"dual_write","raw":{"body":"slugfx l2"},
 "extract":{"name":"Slug Chain L2","publisher":"Slug Chain Co",
   "tagline":"bare and marketplace prefix both taken","certification":"none"}}
$p$::jsonb);

reset role;

\pset format aligned
select label, result ->> 'status' as status, result ->> 'asset_id' as asset_id,
       result ->> 'slug_fallback' as slug_fallback
  from slugfx order by label;

-- The assertions, recorded into gate.result so run.sh's verdict counts them.
do $$
declare
  r0 jsonb; r1 jsonb; r2 jsonb;
  a0 uuid; a1 uuid; a2 uuid;
  lvl0 text; lvl1 text; lvl2 text;
  s0 text; s1 text; s2 text;
  st text := '12. slug chain';
  n_canon0 int; n_canon1 int; n_canon2 int;
  n_distinct int; n_list int; n_cap int;
begin
  select result into r0 from slugfx where label = 'L0 microsoft/dup';
  select result into r1 from slugfx where label = 'L1 aws/dup';
  select result into r2 from slugfx where label = 'L2 drai/dup';
  a0 := (r0 ->> 'asset_id')::uuid;
  a1 := (r1 ->> 'asset_id')::uuid;
  a2 := (r2 ->> 'asset_id')::uuid;
  lvl0 := r0 ->> 'slug_fallback';
  lvl1 := r1 ->> 'slug_fallback';
  lvl2 := r2 ->> 'slug_fallback';

  select slug into s0 from asset_slug where asset_id = a0 and is_canonical;
  select slug into s1 from asset_slug where asset_id = a1 and is_canonical;
  select slug into s2 from asset_slug where asset_id = a2 and is_canonical;

  select count(*) into n_canon0 from asset_slug where asset_id = a0 and is_canonical;
  select count(*) into n_canon1 from asset_slug where asset_id = a1 and is_canonical;
  select count(*) into n_canon2 from asset_slug where asset_id = a2 and is_canonical;

  select count(distinct v.slug) into n_distinct
    from (values (s0),(s1),(s2)) v(slug);

  select count(*) into n_list from listing where asset_id = a2;
  select count(*) into n_cap
    from capture c join listing l on l.id = c.listing_id where l.asset_id = a2;

  -- 1. slug_fallback reports the level that was used, 0 then 1 then 2.
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'service_role', 'slug_fallback level', null,
          gate.expect(lvl0 = '0' and lvl1 = '1' and lvl2 = '2', 'green'),
          format('slug_fallback: L0=%s L1=%s L2=%s, expected 0,1,2', lvl0, lvl1, lvl2));

  -- 2. every ingest committed and returned created, the L2 one included: that
  -- is the unguarded collision no longer aborting the transaction.
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'service_role', 'status', null,
          gate.expect(r0 ->> 'status' = 'created' and r1 ->> 'status' = 'created'
                      and r2 ->> 'status' = 'created', 'green'),
          format('statuses: %s / %s / %s, all expected created',
                 r0 ->> 'status', r1 ->> 'status', r2 ->> 'status'));

  -- 3. the canonical slug each asset actually got: bare, marketplace prefixed,
  -- and the asset uuid. L2 equals a2::text, which is what proves the terminal
  -- level fell all the way to the uuid rather than colliding again.
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'service_role', 'canonical slug value', null,
          gate.expect(s0 = 'dup' and s1 = 'aws-dup' and s2 = a2::text, 'green'),
          format('slugs: L0=%L L1=%L L2=%L, L2 expected the uuid %L',
                 s0, s1, s2, a2::text));

  -- 4. exactly one canonical slug per asset, none left without a URL.
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'service_role', 'one canonical slug each', null,
          gate.expect(n_canon0 = 1 and n_canon1 = 1 and n_canon2 = 1, 'green'),
          format('canonical rows: L0=%s L1=%s L2=%s, each expected 1',
                 n_canon0, n_canon1, n_canon2));

  -- 5. three distinct slugs across the three level assets.
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'service_role', 'three distinct slugs', n_distinct,
          gate.expect(n_distinct = 3, 'green'),
          format('%s distinct canonical slugs across the 3 assets, expected 3', n_distinct));

  -- 6. the L2 transaction committed WHOLE: asset, listing and capture all
  -- present. A bare "asset exists" would pass even if the fix committed the
  -- asset but lost the listing or capture, so all three are counted.
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'service_role', 'L2 whole transaction committed', n_cap,
          gate.expect(a2 is not null and n_list = 1 and n_cap >= 1, 'green'),
          format('L2 asset %s: %s listing(s), %s capture(s); unguarded collision no longer aborts',
                 a2, n_list, n_cap));

  -- 7. the negative control, so the slug assertions above are known to be ABLE
  -- to fail. The L0 slug is held to a value it does not have, expected red: a
  -- green result here would mean check 3 proves nothing. Same principle as 10i.
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'service_role', 'negative control', null,
          gate.expect(s0 = 'not-the-slug', 'red'),
          format('L0 slug %L deliberately mis-expected as %L', s0, 'not-the-slug'));

  raise notice 'SLUG CHAIN: L0=%s(%s) L1=%s(%s) L2=%s(%s), 3 distinct, L2 committed whole',
    s0, lvl0, s1, lvl1, s2, lvl2;
end $$;

\pset format aligned
select step, as_role, object, n_rows, verdict, note
  from gate.result where step like '12.%' order by seq;
