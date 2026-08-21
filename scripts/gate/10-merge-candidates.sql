-- Step 12: cross-marketplace duplicate DETECTION, v_merge_candidates. Issue #64.
--
-- Runs after 08-slug-chain, so every count the earlier steps asserted is already
-- taken and the assets seeded here cannot move one. It proves four things about
-- the proposal view, each with its own seed so the assertion is about a row this
-- step put there rather than about whatever production happened to contain:
--
--   1. the view is cross-marketplace ONLY: every row it returns, over the whole
--      seeded database, has two DIFFERENT marketplace_ids. Never a same-market
--      pair, for any product.
--   2. a same-marketplace name+publisher collision, the n8n family's shape, does
--      NOT appear. Two Microsoft listings of one product by one publisher are two
--      listings the registry does not merge here, and the marketplace-differs
--      rule excludes them by construction.
--   3. one product on TWO marketplaces with a matching publisher DOES appear, as
--      a 'high' candidate, carrying the evidence that earned the tier.
--   4. the canonical false positive, one name on two marketplaces by DIFFERENT
--      publishers with no shared link, appears as 'low'. A shared name is not a
--      shared product.
--
-- Plus a red-as-designed negative control, so the tier assertions are known to be
-- able to fail, in the same spirit as 04-reads' 'red' expectations and 08's
-- check 7.

set role service_role;

create temp table mergefx (label text, result jsonb);

-- 1 + 4: one product on two marketplaces by the same publisher (the HIGH case),
-- and a different product whose name collides across two marketplaces but whose
-- publishers differ (the LOW case). Distinct, unmistakable names so nothing
-- already seeded shares them.
insert into mergefx select 'high microsoft', ingest_capture($p$
{"capture_meta":{"marketplace_id":"microsoft","source_product_id":"mergefx-high-ms",
  "captured_at_utc":"2026-08-20T12:00:00Z","drive_file_id":"drive-mergefx-high-ms"},
 "ingest_source":"dual_write","raw":{"body":"mergefx high ms"},
 "extract":{"name":"Mergefx Crossmarket Product","publisher":"Mergefx Vendor, Inc.",
   "tagline":"same product, marketplace one","certification":"none"}}
$p$::jsonb);

insert into mergefx select 'high aws', ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"mergefx-high-aws",
  "captured_at_utc":"2026-08-20T12:00:01Z","drive_file_id":"drive-mergefx-high-aws"},
 "ingest_source":"dual_write","raw":{"body":"mergefx high aws"},
 "extract":{"name":"Mergefx Crossmarket Product","publisher":"Mergefx Vendor",
   "tagline":"same product, marketplace two","certification":"none"}}
$p$::jsonb);

-- The LOW pair: identical normalised name, DIFFERENT publishers, no shared link.
-- This is Agentforce/Agent Force reproduced deterministically.
insert into mergefx select 'low microsoft', ingest_capture($p$
{"capture_meta":{"marketplace_id":"microsoft","source_product_id":"mergefx-low-ms",
  "captured_at_utc":"2026-08-20T12:00:02Z","drive_file_id":"drive-mergefx-low-ms"},
 "ingest_source":"dual_write","raw":{"body":"mergefx low ms"},
 "extract":{"name":"Mergefx Nameonly Product","publisher":"Alpha Nameonly Systems",
   "tagline":"same name, unrelated vendor one","certification":"none"}}
$p$::jsonb);

insert into mergefx select 'low aws', ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"mergefx-low-aws",
  "captured_at_utc":"2026-08-20T12:00:03Z","drive_file_id":"drive-mergefx-low-aws"},
 "ingest_source":"dual_write","raw":{"body":"mergefx low aws"},
 "extract":{"name":"Mergefx Nameonly Product","publisher":"Beta Unrelated Holdings",
   "tagline":"same name, unrelated vendor two","certification":"none"}}
$p$::jsonb);

-- 2: the same-marketplace collision. Two Microsoft listings, one product name,
-- one publisher, two different source_product_ids, so two assets. Same name AND
-- same publisher, which would be the strongest possible pair were it not for the
-- one thing that disqualifies it: both are on microsoft.
insert into mergefx select 'same one', ingest_capture($p$
{"capture_meta":{"marketplace_id":"microsoft","source_product_id":"mergefx-same-1",
  "captured_at_utc":"2026-08-20T12:00:04Z","drive_file_id":"drive-mergefx-same-1"},
 "ingest_source":"dual_write","raw":{"body":"mergefx same 1"},
 "extract":{"name":"Mergefx Samemarket Product","publisher":"Mergefx Samemarket Vendor",
   "tagline":"intra-marketplace collision one","certification":"none"}}
$p$::jsonb);

insert into mergefx select 'same two', ingest_capture($p$
{"capture_meta":{"marketplace_id":"microsoft","source_product_id":"mergefx-same-2",
  "captured_at_utc":"2026-08-20T12:00:05Z","drive_file_id":"drive-mergefx-same-2"},
 "ingest_source":"dual_write","raw":{"body":"mergefx same 2"},
 "extract":{"name":"Mergefx Samemarket Product","publisher":"Mergefx Samemarket Vendor",
   "tagline":"intra-marketplace collision two","certification":"none"}}
$p$::jsonb);

reset role;

\pset format aligned
select label, result ->> 'status' as status, result ->> 'asset_id' as asset_id
  from mergefx order by label;

do $$
declare
  a_high_ms uuid; a_high_aws uuid;
  a_low_ms  uuid; a_low_aws  uuid;
  a_same1   uuid; a_same2    uuid;
  st text := '13. merge candidates';
  n_same_mkt bigint; n_anon bigint;
  hi record; lo record;
  n_hi int; n_lo int; n_same_present int;
begin
  select (result ->> 'asset_id')::uuid into a_high_ms  from mergefx where label = 'high microsoft';
  select (result ->> 'asset_id')::uuid into a_high_aws from mergefx where label = 'high aws';
  select (result ->> 'asset_id')::uuid into a_low_ms   from mergefx where label = 'low microsoft';
  select (result ->> 'asset_id')::uuid into a_low_aws  from mergefx where label = 'low aws';
  select (result ->> 'asset_id')::uuid into a_same1    from mergefx where label = 'same one';
  select (result ->> 'asset_id')::uuid into a_same2    from mergefx where label = 'same two';

  -- 1. cross-marketplace only, over the WHOLE view. Not one row, seeded or not,
  -- may have equal marketplace_ids. This is the scope invariant the issue is
  -- built on, so it is checked globally rather than on the seed alone.
  select count(*) into n_same_mkt
    from v_merge_candidates where marketplace_id_a = marketplace_id_b;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'postgres', 'v_merge_candidates same-marketplace rows', n_same_mkt,
          gate.expect(n_same_mkt = 0, 'green'),
          format('%s rows with equal marketplace_ids, expected 0', n_same_mkt));

  -- 2. the same-marketplace collision does NOT appear. Count any row that pairs
  -- the two same-market assets, in either order.
  select count(*) into n_same_present
    from v_merge_candidates
   where (asset_id_a = a_same1 and asset_id_b = a_same2)
      or (asset_id_a = a_same2 and asset_id_b = a_same1)
      or asset_id_a in (a_same1, a_same2)
      or asset_id_b in (a_same1, a_same2);
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'postgres', 'n8n-like same-market collision absent', n_same_present,
          gate.expect(n_same_present = 0, 'green'),
          format('%s candidate rows touch the two same-marketplace assets, expected 0', n_same_present));

  -- 3. the cross-marketplace matching-publisher product DOES appear, as 'high',
  -- with the evidence that earned the tier: name match and publisher exact
  -- (Mergefx Vendor, Inc. and Mergefx Vendor both normalise to mergefxvendorinc
  -- / mergefxvendor, one a prefix of the other -> publisher prefix; the trailing
  -- ", Inc." is exactly the real-world difference the prefix signal exists for).
  select count(*) into n_hi
    from v_merge_candidates
   where (asset_id_a = a_high_ms  and asset_id_b = a_high_aws)
      or (asset_id_a = a_high_aws and asset_id_b = a_high_ms);
  select * into hi
    from v_merge_candidates
   where (asset_id_a = a_high_ms  and asset_id_b = a_high_aws)
      or (asset_id_a = a_high_aws and asset_id_b = a_high_ms);
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'postgres', 'cross-marketplace high candidate present', n_hi,
          gate.expect(n_hi = 1
                      and hi.confidence = 'high'
                      and hi.signal_name_match
                      and (hi.signal_publisher_exact or hi.signal_publisher_prefix)
                      and hi.marketplace_id_a <> hi.marketplace_id_b
                      and hi.norm_name = 'mergefxcrossmarketproduct', 'green'),
          format('%s row(s); confidence %s, name_match %s, pub_exact %s, pub_prefix %s, link %s, norm_name %L, mkts %s/%s',
                 n_hi, hi.confidence, hi.signal_name_match, hi.signal_publisher_exact,
                 hi.signal_publisher_prefix, hi.signal_link_host_shared, hi.norm_name,
                 hi.marketplace_id_a, hi.marketplace_id_b));

  -- 4. the name-only different-publisher pair appears, as 'low'. No corroborating
  -- signal: not publisher exact, not publisher prefix, no shared link.
  select count(*) into n_lo
    from v_merge_candidates
   where (asset_id_a = a_low_ms  and asset_id_b = a_low_aws)
      or (asset_id_a = a_low_aws and asset_id_b = a_low_ms);
  select * into lo
    from v_merge_candidates
   where (asset_id_a = a_low_ms  and asset_id_b = a_low_aws)
      or (asset_id_a = a_low_aws and asset_id_b = a_low_ms);
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'postgres', 'name-only pair present and low', n_lo,
          gate.expect(n_lo = 1
                      and lo.confidence = 'low'
                      and lo.signal_name_match
                      and not lo.signal_publisher_exact
                      and not lo.signal_publisher_prefix
                      and not lo.signal_link_host_shared, 'green'),
          format('%s row(s); confidence %s, name_match %s, pub_exact %s, pub_prefix %s, link %s',
                 n_lo, lo.confidence, lo.signal_name_match, lo.signal_publisher_exact,
                 lo.signal_publisher_prefix, lo.signal_link_host_shared));

  -- anon can read the view: the grant and security_invoker path exercised, not
  -- just asserted in the migration. Non-zero because this step seeded rows.
  begin
    set role anon;
    select count(*) into n_anon from v_merge_candidates;
    reset role;
  exception when others then
    reset role; n_anon := -1;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'anon', 'v_merge_candidates readable by anon', n_anon,
          gate.expect(n_anon > 0, 'green'),
          format('anon read %s candidate rows, expected > 0', n_anon));

  -- 5. negative control, red as designed: the high pair held to 'low'. A green
  -- here would mean check 3's confidence assertion proves nothing.
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (st, 'postgres', 'negative control', null,
          gate.expect(hi.confidence = 'low', 'red'),
          format('cross-marketplace pair confidence %L deliberately mis-expected as low', hi.confidence));

  raise notice 'MERGE CANDIDATES: same-mkt=%s, n8n-like present=%s, high=%s(%s), low=%s(%s), anon read=%s',
    n_same_mkt, n_same_present, n_hi, hi.confidence, n_lo, lo.confidence, n_anon;
end $$;

\pset format aligned
select step, as_role, object, n_rows, verdict, note
  from gate.result where step like '13.%' order by seq;
