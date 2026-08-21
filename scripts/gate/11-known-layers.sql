-- Step 14: known_layers, layers_known and reach come from the PRIMARY listing.
-- Issue #43, resolved as option (b) and implemented in
-- 20260821120000_known_layers_primary.sql.
--
-- This is the assertion the issue said the gate could NOT previously make. Under
-- 1:1 the qualifying listing IS the primary listing, so no seed could tell the
-- two rules apart and every check was vacuous. This step builds a synthetic
-- TWO-listing asset in which the qualifying listing and the primary listing are
-- deliberately DIFFERENT, and different in their layer count, so "the ledger reads
-- the primary" and "the ledger reads the qualifying" give different answers and
-- the gate can finally choose between them.
--
-- THE SHAPE.
--   * A PRIMARY listing on microsoft, UNCERTIFIED but richly disclosed: publisher,
--     hosting, data residency, works_with, graph permissions, pricing, access
--     model and support. Eight of the twelve tracked layers, reach 67. It states
--     no certification, so it does not claim the permission-scope layer.
--   * A SECONDARY listing on aws, microsoft_365_CERTIFIED but sparse: publisher
--     only. Two layers (vendor identity, and permission scope which the
--     certification itself grants), reach 17. No hosting, no data residency, no
--     pricing, no access model, no support.
--   * The two listings are merged under one asset the way merge_assets does it:
--     the secondary listing is relocated onto the primary's asset and the old
--     asset retired. The primary listing stays primary.
--
-- Now the qualifying listing (best certification tier) is the sparse aws one,
-- while the primary listing is the rich microsoft one. certification and
-- risk_basis resolve to the aws listing; known_layers, layers_known, reach and
-- every disclosure fact resolve to the microsoft one. Before option (b) the layer
-- COUNT came from the aws listing (2) while the disclosure facts came from the
-- microsoft one (rich): a ledger reading "2 of 12" above a full hosting and
-- pricing block. After option (b) both read the primary listing and agree.
--
-- Includes a red-as-designed control: the claim "layers_known equals the
-- QUALIFYING listing's count" is expected red, so a green there would mean the
-- count still comes from the qualifying listing and the primary-sourcing
-- assertions prove nothing. In the same spirit as 04-reads' 'red' expectations,
-- 08's check 7 and 10's negative control.
--
-- Runs LAST, after every earlier step has finished its counts, so the assets it
-- seeds and merges cannot move a number an earlier assertion depends on.

set role service_role;

create temp table klfx (label text, result jsonb);

-- The rich, UNCERTIFIED primary listing on microsoft.
insert into klfx select 'primary', ingest_capture($p$
{"capture_meta":{"marketplace_id":"microsoft","source_product_id":"kl-primary",
  "captured_at_utc":"2026-08-20T13:00:00Z","drive_file_id":"drive-kl-primary"},
 "ingest_source":"dual_write","raw":{"body":"kl primary"},
 "extract":{"name":"KnownLayers Primary Listing","publisher":"KnownLayers Vendor",
   "tagline":"rich uncertified primary",
   "overview_text":"KnownLayers Primary Listing is richly disclosed.",
   "pricing":"From 20 dollars per user per month","acquire_using":"Subscription",
   "support":"https://support.example/kl","works_with":["SharePoint","Teams"],
   "certification":"none",
   "cert_detail":{"hosting":"Microsoft Azure","data_location":"European Union",
     "graph_permissions":["Mail.Read","User.Read"]}}}
$p$::jsonb);

-- The sparse, CERTIFIED secondary listing on aws.
insert into klfx select 'secondary', ingest_capture($p$
{"capture_meta":{"marketplace_id":"aws","source_product_id":"kl-secondary",
  "captured_at_utc":"2026-08-20T13:00:01Z","drive_file_id":"drive-kl-secondary"},
 "ingest_source":"dual_write","raw":{"body":"kl secondary"},
 "extract":{"name":"KnownLayers Secondary Listing","publisher":"KnownLayers Vendor",
   "tagline":"sparse certified secondary","certification":"microsoft_365_certified"}}
$p$::jsonb);

-- Back to the superuser the harness already is for the raw table updates below:
-- service_role holds execute on ingest_capture but no direct DML on listing or
-- asset, exactly as on production. The merge is done by hand, the way
-- 09-merged-guard's partial merge is.
reset role;

-- Merge the secondary onto the primary's asset, the way a real merge relocates a
-- listing, and retire the now-empty secondary asset. The primary listing keeps
-- being primary, so the asset ends up with two listings whose qualifying listing
-- (the certified aws one) is NOT its primary listing (the rich microsoft one).
-- This is a superuser update, exactly as 09-merged-guard's partial merge is; the
-- difference is that here the listing IS relocated, so this is a full merge and
-- the retired asset drops from the views by the primary-listing join alone.
do $$
declare a_primary uuid; a_secondary uuid; l_secondary uuid;
begin
  select (result ->> 'asset_id')::uuid into a_primary   from klfx where label = 'primary';
  select (result ->> 'asset_id')::uuid into a_secondary from klfx where label = 'secondary';
  select id into l_secondary from listing where source_product_id = 'kl-secondary';

  update listing set asset_id = a_primary where id = l_secondary;
  update asset   set merged_into = a_primary, primary_listing_id = null
   where id = a_secondary;
end $$;

\pset format aligned
select label, result ->> 'status' as status, result ->> 'asset_id' as asset_id,
       result ->> 'layers_known' as layers_known, result ->> 'reach' as reach
  from klfx order by label;

do $$
declare
  a_primary uuid;
  l_primary uuid; l_secondary uuid;
  st text := '14. known_layers from primary';
  -- Stored truth, read straight from each listing's own extract as superuser.
  p_layers int; p_reach int; p_hosting text; p_residency text;
  p_acquire text; p_support text; p_cert text;
  q_layers int; q_reach int; q_hosting text; q_cert text; q_risk_basis text;
  -- What the two views actually return, read as anon.
  c_layers int; c_reach int; c_cert text; c_risk_basis text; c_mkt text;
  ps_layers int; ps_reach int; ps_hosting text; ps_residency text;
  ps_acquire text; ps_support text; ps_cert text; ps_risk_basis text;
  ps_listing_count int;
  ok_primary_ledger boolean; ok_divergence boolean; ok_disclosure_same boolean;
  ok_qualifying boolean; ok_two_listings boolean; err text := '';
begin
  select (result ->> 'asset_id')::uuid into a_primary from klfx where label = 'primary';
  select id into l_primary   from listing where source_product_id = 'kl-primary';
  select id into l_secondary from listing where source_product_id = 'kl-secondary';

  -- Stored per-listing truth. The primary (rich microsoft) listing:
  select cardinality(x.known_layers), x.reach, x.cert_hosting, x.cert_data_location,
         x.acquire_using, x.support, x.certification::text
    into p_layers, p_reach, p_hosting, p_residency, p_acquire, p_support, p_cert
    from listing l join capture_extract x on x.capture_id = l.current_capture_id
   where l.id = l_primary;
  -- The secondary (sparse certified aws) listing:
  select cardinality(x.known_layers), x.reach, x.cert_hosting, x.certification::text, x.risk_basis
    into q_layers, q_reach, q_hosting, q_cert, q_risk_basis
    from listing l join capture_extract x on x.capture_id = l.current_capture_id
   where l.id = l_secondary;

  -- What anon sees through the two views, which is what the site renders.
  begin
    set role anon;
    select c.layers_known, c.reach, c.certification::text, c.risk_basis, c.marketplace_id
      into c_layers, c_reach, c_cert, c_risk_basis, c_mkt
      from v_registry_card c where c.asset_id = a_primary;
    select p.layers_known, p.reach, p.cert_hosting, p.cert_data_location,
           p.acquire_using, p.support, p.certification::text, p.risk_basis,
           jsonb_array_length(p.listings)
      into ps_layers, ps_reach, ps_hosting, ps_residency, ps_acquire, ps_support,
           ps_cert, ps_risk_basis, ps_listing_count
      from v_asset_passport p where p.asset_id = a_primary;
    reset role;
  exception when others then
    reset role; err := sqlerrm;
  end;

  -- 1. The ledger (layers_known, reach, known_layers) comes from the PRIMARY
  -- listing, in BOTH views. This is the core of option (b).
  ok_primary_ledger :=
        c_layers  = p_layers and c_reach  = p_reach
    and ps_layers = p_layers and ps_reach = p_reach;

  -- 2. The divergence is real, so the assertion above is not vacuous: the primary
  -- and qualifying listings genuinely disagree about the count and the reach.
  ok_divergence := p_layers <> q_layers and p_reach <> q_reach;

  -- 3. The disclosure facts come from the SAME primary listing the ledger does,
  -- so the count and the facts it summarises agree. The secondary (qualifying)
  -- listing states no hosting, so hosting appearing here proves it came from the
  -- primary and not the qualifying listing.
  ok_disclosure_same :=
        ps_hosting   = p_hosting   and p_hosting   is not null and q_hosting is null
    and ps_residency = p_residency and p_residency is not null
    and ps_acquire   = p_acquire   and p_acquire   is not null
    and ps_support   = p_support   and p_support   is not null;

  -- 4. certification and risk_basis come from the QUALIFYING listing (the sparse
  -- certified aws one), unchanged by option (b). The primary listing is
  -- uncertified, so the certified value appearing here proves it came from the
  -- qualifying listing. The primary listing supplies the card's marketplace_id.
  ok_qualifying :=
        c_cert  = q_cert  and c_cert  = 'microsoft_365_certified' and p_cert = 'none'
    and ps_cert = q_cert
    and c_risk_basis  = q_risk_basis
    and ps_risk_basis = q_risk_basis
    and c_mkt = 'microsoft';

  -- 5. The passport really carries two listings, which is the condition
  -- PassportView uses to attribute risk_basis to its qualifying marketplace.
  ok_two_listings := ps_listing_count = 2;

  insert into gate.result(step, as_role, object, n_rows, verdict, note) values
    (st, 'anon', 'ledger (layers_known, reach) from PRIMARY listing', null,
     gate.expect(ok_primary_ledger and err = '', 'green'),
     format('card layers_known=%s reach=%s, passport layers_known=%s reach=%s; primary stored=%s/%s%s',
            c_layers, c_reach, ps_layers, ps_reach, p_layers, p_reach,
            case when err = '' then '' else ' ERR: ' || err end)),

    (st, 'postgres', 'primary and qualifying listings genuinely diverge', null,
     gate.expect(ok_divergence, 'green'),
     format('primary layers=%s reach=%s vs qualifying layers=%s reach=%s',
            p_layers, p_reach, q_layers, q_reach)),

    (st, 'anon', 'disclosure facts from the SAME primary listing as the ledger', null,
     gate.expect(ok_disclosure_same, 'green'),
     format('passport hosting=%L residency=%L acquire=%L support=%L; qualifying hosting=%L',
            ps_hosting, ps_residency, ps_acquire, ps_support, q_hosting)),

    (st, 'anon', 'certification and risk_basis from the QUALIFYING listing', null,
     gate.expect(ok_qualifying, 'green'),
     format('card cert=%L risk_basis=%L mkt=%L; passport cert=%L; primary cert=%L; qualifying cert=%L',
            c_cert, c_risk_basis, c_mkt, ps_cert, p_cert, q_cert)),

    (st, 'anon', 'passport carries both listings', ps_listing_count,
     gate.expect(ok_two_listings, 'green'),
     format('passport listings length=%s, expected 2', ps_listing_count)),

    -- Red as designed: the count does NOT equal the qualifying listing's count.
    -- Under the pre-option-(b) views it would have, so a green here would mean the
    -- fix never took and checks 1 and 3 are meaningless.
    (st, 'anon', 'layers_known does NOT come from the qualifying listing (red as designed)', null,
     gate.expect(c_layers = q_layers, 'red'),
     format('card layers_known=%s, qualifying count=%s: equal would mean the count still tracks the qualifying listing',
            c_layers, q_layers));

  raise notice 'KNOWN LAYERS: primary=%L/% reach %, qualifying=%L/% reach %, card layers_known=% reach=%, cert=%, listings=%',
    p_cert, p_layers, p_reach, q_cert, q_layers, q_reach, c_layers, c_reach, c_cert, ps_listing_count;
end $$;

\pset format aligned
select step, as_role, object, n_rows, verdict, note
  from gate.result where step like '14.%' order by seq;
