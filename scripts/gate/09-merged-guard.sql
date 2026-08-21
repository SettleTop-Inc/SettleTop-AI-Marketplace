-- Step 11: the merged-into guard on v_registry_stats' card_lite CTE. Issue #44.
--
-- v_registry_stats has nine scalars. `agents` counts the asset table directly
-- with `where merged_into is null`, so it excludes a retired asset. Four others,
-- `certified`, `attested`, `mean_reach` and `publishers`, are derived from the
-- card_lite CTE. Before 20260820180000 card_lite did not filter merged_into, so
-- those four could count an asset that `agents` did not. This step retires one
-- asset the way a PARTIAL merge does, out of band and WITHOUT relocating its
-- listings, and proves that under the guard `agents` and the four card-derived
-- numbers exclude it together, so `certified + attested <= agents` still holds.
--
-- It runs LAST, after 07-final has finished every count, facet and read
-- assertion, so the one asset it retires and then restores cannot move a number
-- an earlier check depends on. The retirement is undone at the end, leaving the
-- registry as the steps before this one saw it.
--
-- This is the GUARD route from #44: the view refuses to count a retired asset no
-- matter how it was retired. The CONSTRAINT route, making merge_assets relocate
-- the listings so a partial merge cannot exist, is #63's job and is not tested
-- here.


-- The nine stats as anon, the way the front page reads them. Returned as jsonb
-- so a before and an after snapshot can each be captured and compared. The role
-- is switched exactly as gate.check_stats does, and reset even on error.
create or replace function gate.stats_as_anon() returns jsonb
language plpgsql as $fn$
declare j jsonb;
begin
  set role anon;
  select to_jsonb(s) into j from v_registry_stats s;
  reset role;
  return j;
exception when others then
  reset role;
  raise;
end $fn$;

-- A standing recomputation of card_lite from the base tables, the way 10a keeps
-- a standing copy of the pre-migration registry_delivery. p_guard = true applies
-- the merged_into filter the migration added, so it matches the live view;
-- p_guard = false is the pre-migration card_lite, and the two diverge the moment
-- a retired asset still owns its primary listing. The cert lateral is
-- v_registry_stats' own, byte for byte, so the four scalars are computed the
-- same way the view computes them and only the guard differs. has_asset reports
-- whether one specific asset survives into card_lite, which is the crisp form of
-- "do the four card-derived numbers count it": all four read this one CTE.
create or replace function gate.card_lite_probe(p_asset uuid, p_guard boolean)
returns table(certified bigint, attested bigint, mean_reach numeric,
              publishers bigint, has_asset boolean)
language sql stable as $fn$
  with card_lite as (
    select
      a.id            as asset_id,
      x.publisher,
      cert.certification,
      cert.reach
    from asset a
    join listing l         on l.id = a.primary_listing_id and l.asset_id = a.id
    join capture_extract x on x.capture_id = l.current_capture_id
    cross join lateral (
      select x2.certification, x2.provenance, x2.evidence_tier, x2.risk,
             x2.risk_basis, x2.known_layers, x2.reach
        from listing l2
        left join capture_extract x2 on x2.capture_id = l2.current_capture_id
       where l2.asset_id = a.id
       order by case x2.certification
                  when 'microsoft_365_certified'::certification_status then 0
                  when 'publisher_attestation'::certification_status   then 1
                  when 'none'::certification_status                    then 2
                  when 'not_eligible'::certification_status            then 3
                  else                                                      4
                end,
                (l2.id = a.primary_listing_id) desc,
                l2.id
       limit 1
    ) cert
    where (not p_guard) or a.merged_into is null
  )
  select
    count(distinct asset_id) filter (where certification = 'microsoft_365_certified'),
    count(distinct asset_id) filter (where certification = 'publisher_attestation'),
    round(avg(reach)),
    count(distinct publisher) filter (where publisher is not null
                                        and btrim(publisher) <> ''
                                        and publisher <> 'Unknown'),
    coalesce(bool_or(asset_id = p_asset), false)
  from card_lite
$fn$;


-- The victim and the merge target, plus the baseline snapshot, carried between
-- statements the way 07-final carries before_after.
create temp table mg (x_asset uuid, y_asset uuid, base jsonb);

-- 11a. Baseline and precondition. seed-gamma is publisher_attestation, so
-- v_registry_stats counts it in attested, and its publisher and reach feed
-- publishers and mean_reach. Confirm it is live and present in card_lite before
-- retiring it, or the exclusion asserted below could be vacuous.
do $$
declare x uuid; y uuid; base_j jsonb; g record; live boolean; ok boolean;
begin
  select asset_id into x from listing where source_product_id = 'seed-gamma';
  select asset_id into y from listing where source_product_id = 'seed-alpha';
  base_j := gate.stats_as_anon();
  select * into g from gate.card_lite_probe(x, true);
  live := exists (select 1 from asset where id = x and merged_into is null);
  insert into mg values (x, y, base_j);

  ok := x is not null and y is not null and x is distinct from y and live and g.has_asset;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('11a. seed-gamma is live and counted in attested', 'anon',
          'v_registry_stats + card_lite', null, gate.expect(ok, 'green'),
          format('x=%s y=%s live=%s in_card_lite=%s; baseline agents=%s certified=%s attested=%s publishers=%s mean_reach=%s',
                 x, y, live, g.has_asset,
                 base_j->>'agents', base_j->>'certified', base_j->>'attested',
                 base_j->>'publishers', base_j->>'mean_reach'));
end $$;

-- The partial merge. A raw update, run as the superuser the harness already is
-- (no set role, exactly as 05-negative's raw updates run), so it does NOT go
-- through merge_assets and the listings are NOT relocated: seed-gamma keeps its
-- listing and its primary_listing_id still names it back. That is the partial
-- merge #44 is about, and the case the primary-listing join alone cannot catch.
update asset set merged_into = (select y_asset from mg)
 where id = (select x_asset from mg);

-- 11b. The whole claim: after the partial merge, agents and the four
-- card-derived numbers all exclude the retired asset, they move together, and
-- the invariant holds. Read the view as anon again, recompute card_lite both
-- ways from the base tables, and compare.
do $$
declare
  x uuid; base_j jsonb; after_j jsonb; g record; u record;
  a0 bigint; c0 bigint; t0 bigint; p0 bigint; r0 numeric;
  a1 bigint; c1 bigint; t1 bigint; p1 bigint; r1 numeric;
  ok boolean;
begin
  select x_asset, mg.base into x, base_j from mg;
  after_j := gate.stats_as_anon();
  select * into g from gate.card_lite_probe(x, true);   -- guarded, matches the view
  select * into u from gate.card_lite_probe(x, false);  -- pre-migration card_lite

  a0 := (base_j ->>'agents')::bigint;  c0 := (base_j ->>'certified')::bigint;
  t0 := (base_j ->>'attested')::bigint; p0 := (base_j ->>'publishers')::bigint;
  r0 := (base_j ->>'mean_reach')::numeric;
  a1 := (after_j->>'agents')::bigint;  c1 := (after_j->>'certified')::bigint;
  t1 := (after_j->>'attested')::bigint; p1 := (after_j->>'publishers')::bigint;
  r1 := (after_j->>'mean_reach')::numeric;

  ok :=
       -- agents dropped the retired asset ...
       a1 = a0 - 1
       -- ... and so did attested, the card-derived number that counted it ...
   and t1 = t0 - 1
       -- ... while certified, which never counted it, did not move.
   and c1 = c0
       -- The structural invariant the guard exists to keep.
   and c1 + t1 <= a1
       -- The view's four card-derived scalars equal the guarded card_lite, so
       -- all four reflect the exclusion, not just the two that changed value.
   and c1 = g.certified and t1 = g.attested and p1 = g.publishers
   and r1 is not distinct from g.mean_reach
       -- The retired asset is GONE from the guarded card_lite that feeds them.
   and g.has_asset = false
       -- The pre-migration card_lite still carries it, which is the entire
       -- difference the guard makes: without it the four numbers keep counting
       -- an asset agents has dropped. attested and publishers each move by
       -- exactly this one asset.
   and u.has_asset = true
   and u.attested = t0 and u.attested = g.attested + 1
   and u.publishers = p0 and u.publishers = g.publishers + 1;

  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('11b. a partial merge excludes the asset from agents and the card scalars together',
          'anon', 'v_registry_stats (merged guard)', null, gate.expect(ok, 'green'),
          format('agents %s->%s, certified %s->%s, attested %s->%s, publishers %s->%s, mean_reach %s->%s; guarded has_asset=%s unguarded has_asset=%s; unguarded attested=%s publishers=%s; certified+attested=%s <= agents=%s',
                 a0,a1, c0,c1, t0,t1, p0,p1, r0,r1,
                 g.has_asset, u.has_asset, u.attested, u.publishers, c1+t1, a1));
end $$;

-- 11c. The negative control, in the style of 10i and 05-negative: prove the
-- exclusion 11b asserts can go red. Point the same claim at the PRE-MIGRATION
-- card_lite, which does not filter merged_into: the retired asset is still
-- present, so "the asset is excluded" is FALSE there and, expected red, is
-- recorded as red-as-designed. A green here would mean the guard made no
-- difference and 11b's green proved nothing. run.sh needs no new exclusion:
-- gate.expect records a red-as-designed as "PASS: red as designed".
do $$
declare x uuid; u record; ok boolean;
begin
  select x_asset into x from mg;
  select * into u from gate.card_lite_probe(x, false);
  ok := u.has_asset = false;  -- false: the unguarded CTE still carries the asset
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('11c. without the guard the retired asset is NOT excluded (red as designed)',
          'postgres', 'gate.card_lite_probe(guard=false)', null,
          gate.expect(ok, 'red'),
          format('unguarded card_lite has_asset=%s: the guard is the only thing that drops it', u.has_asset));
end $$;

-- Undo the partial merge, so the container is left as the earlier steps saw it.
update asset set merged_into = null where id = (select x_asset from mg);

-- 11d. Restored: agents and the four card-derived numbers are back at baseline
-- and the asset is present in card_lite again, proving the retirement, not some
-- other drift, is what moved them.
do $$
declare x uuid; base_j jsonb; now_j jsonb; g record; ok boolean;
begin
  select x_asset, mg.base into x, base_j from mg;
  now_j := gate.stats_as_anon();
  select * into g from gate.card_lite_probe(x, true);
  ok := (now_j->>'agents')::bigint     = (base_j->>'agents')::bigint
    and (now_j->>'certified')::bigint  = (base_j->>'certified')::bigint
    and (now_j->>'attested')::bigint   = (base_j->>'attested')::bigint
    and (now_j->>'publishers')::bigint = (base_j->>'publishers')::bigint
    and (now_j->>'mean_reach')::numeric is not distinct from (base_j->>'mean_reach')::numeric
    and g.has_asset = true;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('11d. the retired asset restored', 'anon', 'v_registry_stats (merged guard)',
          null, gate.expect(ok, 'green'),
          format('agents=%s certified=%s attested=%s publishers=%s mean_reach=%s in_card_lite=%s',
                 now_j->>'agents', now_j->>'certified', now_j->>'attested',
                 now_j->>'publishers', now_j->>'mean_reach', g.has_asset));
end $$;

drop table mg;

\pset format aligned
select step, as_role, object, n_rows, verdict, note
  from gate.result where step like '11%' order by seq;
