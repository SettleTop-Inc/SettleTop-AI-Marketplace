-- The two RPCs that operate the merge storage phase 1 built. Issue #63.
--
-- Phase 1 laid down asset_slug, asset_merge, asset.merged_into and
-- asset.primary_listing_id, and nothing wrote them. This migration adds the
-- functions that do: merge_assets folds one product's two marketplace listings
-- into a single asset with one listing per marketplace, and unmerge_asset takes
-- that apart again, exactly.
--
-- Red Hat AI Enterprise on Microsoft and on AWS is the standing example: two
-- listings, one real product, and after merge_assets one asset carrying both
-- listings with the AWS one absorbed and the Microsoft one surviving.
--
--
-- WHAT merge_assets DOES, IN ONE TRANSACTION (a function body is atomic, so a
-- raise anywhere below rolls the whole thing back and no partial merge lands):
--
--   1. Capture what moves BEFORE moving it: the listing ids under p_from, the
--      slugs under p_from, and which of those slugs was the canonical one. This
--      is what unmerge_asset later reads to move everything back, so it is read
--      while it is still true.
--   2. Every listing of p_from moves to p_into. Every one, no exceptions.
--   3. Every slug of p_from moves to p_into and is set is_canonical = false.
--      Clearing canonical is required, not tidiness: asset_slug_one_canonical is
--      unique (asset_id) where is_canonical, so moving a still-canonical slug
--      onto an asset that already has one raises 23505. No slug row is deleted
--      and none is chained, so a lookup stays one indexed read.
--   4. primary_listing_id is left ALONE on both assets, deliberately. The
--      survivor p_into keeps its own. The retired p_from ALSO keeps its own,
--      even though it now names a listing that belongs to the survivor, for
--      three reasons: asset_merge has no column to record it if it were nulled;
--      the asset-keyed views all join
--        join listing l on l.id = a.primary_listing_id and l.asset_id = a.id
--      so a retired asset's stale pointer cannot resurface it, because the
--      listing it points at no longer names it back and the row drops; and
--      unmerge_asset needs the pointer intact to restore the asset whole. It is
--      not nulled.
--   5. p_from is retired: merged_into is set to p_into.
--   6. One asset_merge row records the listing ids and slugs from step 1, the
--      basis, the handle, and the canonical slug from step 1 in the new
--      from_canonical_slug column.
--
-- Returns { merge_id, from_asset_id, into_asset_id, listings_moved, slugs_moved }.
--
--
-- WHAT IT REFUSES, each with a raise and never a silent no-op: p_from = p_into;
-- either id absent from asset; either already retired (merged_into set); p_from
-- owning zero listings; a blank basis or a blank handle; a handle containing an
-- @, because merged_by is publicly readable and is a handle, never an email.
--
--
-- THE REVERSIBILITY CONTRACT. merge_assets then unmerge_asset on the resulting
-- merge id restores, exactly:
--   - listing.asset_id for every moved listing,
--   - asset_slug.asset_id for every moved slug,
--   - asset_slug.is_canonical per slug (the one canonical slug goes back to
--     true, the rest stay false, which is what they were),
--   - asset.merged_into back to null on the revived asset,
--   - and therefore every v_registry_stats field back to its pre-merge value.
-- updated_at moves forward on both directions and is not part of the contract;
-- no stat reads it.
--
-- NEITHER DIRECTION TOUCHES THE CAPTURE FAMILY. Not capture, capture_extract,
-- capture_link, capture_plan, capture_permission, capture_compliance or
-- capture_evidence, in read or in write. A merge is a claim about which listings
-- are the same product; it moves listings and slugs and nothing else. Row counts
-- and content of those seven tables are identical before merge, after merge and
-- after unmerge.
--
--
-- unmerge_asset(p_merge_id). Refuses when the merge is already undone. Refuses
-- when any listing the merge moved is no longer owned by into_asset_id, because
-- a later merge moved it on and a stack of merges is undone newest first. Then
-- it moves the listings back to from_asset_id, moves the slugs back and sets
-- is_canonical = true on from_canonical_slug and that slug only, nulls
-- merged_into on the revived asset, and stamps undone_at on the log row.
--
--
-- PRIVILEGES. Both functions are security definer with a pinned search_path,
-- matching ingest_capture and 20260816171453_pin_function_search_paths.sql, and
-- both are granted to service_role only: revoked from public, anon and
-- authenticated, granted to service_role, exactly as ingest_capture is.


-- The schema gap phase 1 left, closed in the same migration --------------------
--
-- asset_merge.slugs is text[] and carries no canonical flag, so unmerge_asset
-- could not know which of the moved slugs was the retired asset's canonical one.
-- Add a nullable column recording it. Nullable is deliberate: the one synthetic
-- asset_merge row the gate harness inserts at scripts/gate/04-reads.sql does not
-- set it, and must still validate.
alter table asset_merge add column from_canonical_slug text;

comment on column asset_merge.from_canonical_slug is
  'The slug that was the retired asset''s canonical one at merge time. merge_assets clears is_canonical on every moved slug, so this is the only record of which one to restore, and unmerge_asset sets is_canonical = true on this slug alone. Nullable so the synthetic gate row still validates.';


create or replace function merge_assets(p_from uuid, p_into uuid, p_basis text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_from_retired boolean;
  v_into_retired boolean;
  v_listing_ids  uuid[];
  v_slugs        text[];
  v_from_canon   text;
  v_merge_id     bigint;
begin
  -- Validation. Every branch raises; none is a silent no-op.
  if p_from = p_into then
    raise exception 'merge_assets: p_from and p_into are the same asset (%)', p_from;
  end if;
  if p_basis is null or btrim(p_basis) = '' then
    raise exception 'merge_assets: p_basis is blank; a merge is the registry''s own claim and must record its basis';
  end if;
  if p_by is null or btrim(p_by) = '' then
    raise exception 'merge_assets: p_by is blank; a merge must record who made it';
  end if;
  if position('@' in p_by) > 0 then
    raise exception 'merge_assets: p_by (%) contains @; merged_by is a public handle, never an email', p_by;
  end if;

  select (merged_into is not null) into v_from_retired from asset where id = p_from;
  if not found then
    raise exception 'merge_assets: p_from (%) is not an asset', p_from;
  end if;
  select (merged_into is not null) into v_into_retired from asset where id = p_into;
  if not found then
    raise exception 'merge_assets: p_into (%) is not an asset', p_into;
  end if;
  if v_from_retired then
    raise exception 'merge_assets: p_from (%) is already retired (merged_into is set)', p_from;
  end if;
  if v_into_retired then
    raise exception 'merge_assets: p_into (%) is already retired (merged_into is set)', p_into;
  end if;

  -- 1. Capture what moves, before any of it moves.
  select array_agg(id order by id) into v_listing_ids
    from listing where asset_id = p_from;
  if v_listing_ids is null or cardinality(v_listing_ids) = 0 then
    raise exception 'merge_assets: p_from (%) owns no listings; there is nothing to merge', p_from;
  end if;

  select array_agg(slug order by slug) into v_slugs
    from asset_slug where asset_id = p_from;
  select slug into v_from_canon
    from asset_slug where asset_id = p_from and is_canonical;

  -- 2. Every listing moves.
  update listing
     set asset_id = p_into, updated_at = now()
   where asset_id = p_from;

  -- 3. Every slug moves and loses canonical. See the header on
  --    asset_slug_one_canonical; clearing this is required, not tidiness.
  update asset_slug
     set asset_id = p_into, is_canonical = false
   where asset_id = p_from;

  -- 4. primary_listing_id is left alone on both assets. See the header.

  -- 5. Retire the absorbed asset.
  update asset
     set merged_into = p_into, updated_at = now()
   where id = p_from;

  -- 6. Log the claim, with the canonical slug unmerge needs to restore.
  insert into asset_merge
    (from_asset_id, into_asset_id, listing_ids, slugs, basis, merged_by, from_canonical_slug)
  values
    (p_from, p_into, v_listing_ids, coalesce(v_slugs, '{}'::text[]), p_basis, p_by, v_from_canon)
  returning id into v_merge_id;

  return jsonb_build_object(
    'merge_id',       v_merge_id,
    'from_asset_id',  p_from,
    'into_asset_id',  p_into,
    'listings_moved', cardinality(v_listing_ids),
    'slugs_moved',    coalesce(cardinality(v_slugs), 0));
end
$fn$;

comment on function merge_assets(uuid, uuid, text, text) is
  'Fold p_from into p_into: move every listing and slug of p_from onto p_into, clear is_canonical on the moved slugs, retire p_from via merged_into, and log one asset_merge row with the moved ids, the basis, the handle and the pre-merge canonical slug. Refuses same id, absent id, already-retired id, zero-listing p_from, blank basis or handle, or a handle containing @. Touches no capture-family table. service_role only.';


create or replace function unmerge_asset(p_merge_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  m            asset_merge%rowtype;
  v_owned      int;
  v_n_listings int;
begin
  select * into m from asset_merge where id = p_merge_id;
  if not found then
    raise exception 'unmerge_asset: no merge with id %', p_merge_id;
  end if;
  if m.undone_at is not null then
    raise exception 'unmerge_asset: merge % is already undone (undone_at %)', p_merge_id, m.undone_at;
  end if;

  v_n_listings := cardinality(m.listing_ids);

  -- Refuse if a later merge moved any of these listings on. A stack of merges is
  -- undone newest first, so if a listing this merge moved is no longer owned by
  -- the survivor, an later merge owns it and must be undone first.
  select count(*) into v_owned
    from listing
   where id = any(m.listing_ids) and asset_id = m.into_asset_id;
  if v_owned <> v_n_listings then
    raise exception
      'unmerge_asset: merge % cannot be undone; % of % moved listings are no longer owned by the survivor %, a later merge moved them on and must be undone first',
      p_merge_id, v_n_listings - v_owned, v_n_listings, m.into_asset_id;
  end if;

  -- Move the listings back.
  update listing
     set asset_id = m.from_asset_id, updated_at = now()
   where id = any(m.listing_ids);

  -- Move the slugs back, then restore canonical on the one slug that held it,
  -- and only that one. The others were set false by the merge and stay false,
  -- which is what they were before it.
  update asset_slug
     set asset_id = m.from_asset_id
   where slug = any(m.slugs);
  if m.from_canonical_slug is not null then
    update asset_slug
       set is_canonical = true
     where slug = m.from_canonical_slug and asset_id = m.from_asset_id;
  end if;

  -- Revive the retired asset.
  update asset
     set merged_into = null, updated_at = now()
   where id = m.from_asset_id;

  -- Mark the log row undone.
  update asset_merge set undone_at = now() where id = p_merge_id;

  return jsonb_build_object(
    'merge_id',          p_merge_id,
    'from_asset_id',     m.from_asset_id,
    'into_asset_id',     m.into_asset_id,
    'listings_restored', v_n_listings,
    'slugs_restored',    coalesce(cardinality(m.slugs), 0));
end
$fn$;

comment on function unmerge_asset(bigint) is
  'Undo the merge identified by p_merge_id: move its listings and slugs back to from_asset_id, restore is_canonical on from_canonical_slug alone, null merged_into on the revived asset, and stamp undone_at. Refuses an already-undone merge, and a merge whose listings a later merge has moved on. Touches no capture-family table. service_role only.';


-- Privileges, exactly as ingest_capture has them: revoked from everyone, then
-- granted to service_role alone.
revoke all on function merge_assets(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function merge_assets(uuid, uuid, text, text) to service_role;

revoke all on function unmerge_asset(bigint) from public, anon, authenticated;
grant execute on function unmerge_asset(bigint) to service_role;
