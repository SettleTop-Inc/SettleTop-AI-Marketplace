-- Seed slugs are only safe because source_product_id happens to be unique
-- across marketplaces today: 6,876 listings, 6,876 distinct values. The unique
-- index is on the pair, not on source_product_id alone, so that is luck rather
-- than a constraint. Assert it here so a collision is a clear message and not a
-- primary-key violation halfway through the migration.
--
-- This guard runs first, before the column is even added, on purpose. It only
-- reads listing.source_product_id, which needs nothing from this file to
-- exist first. If a migration runner ever applies this file statement by
-- statement instead of as one transaction, a guard that ran after the column
-- add would leave that add committed on failure: a nullable, all-null
-- asset_id with no assets, no slugs, and a retry that fails immediately
-- because the column already exists, needing a manual drop before anyone can
-- try again. Running the guard first means a failure here leaves nothing
-- behind to clean up. Do not move this back below the column add.
do $$
declare n int;
begin
  select count(*) into n
    from (select source_product_id from listing group by 1 having count(*) > 1) d;
  if n > 0 then
    raise exception
      'cannot seed slugs: % source_product_id values are shared by more than one listing', n;
  end if;
end $$;

alter table listing add column asset_id uuid references asset(id);

with made as (
  insert into asset (primary_listing_id)
  select l.id from listing l
  returning id as asset_id, primary_listing_id
)
update listing l
   set asset_id = made.asset_id
  from made
 where made.primary_listing_id = l.id;

alter table listing alter column asset_id set not null;
create index listing_asset_idx on listing (asset_id);

comment on column listing.asset_id is
  'Every listing belongs to exactly one asset, always. A newly harvested listing that matches nothing gets a fresh asset of its own, so the default state of a scraped listing is that it is its own product.';

-- source_product_id is the seed slug because that is what /agent/[id] already
-- carries, so every existing URL keeps resolving with no redirect.
insert into asset_slug (slug, asset_id, is_canonical)
select l.source_product_id, l.asset_id, true from listing l;

do $$
declare n_listing int; n_asset int; n_slug int;
begin
  select count(*) into n_listing from listing;
  select count(*) into n_asset   from asset;
  select count(*) into n_slug    from asset_slug where is_canonical;
  if not (n_listing = n_asset and n_asset = n_slug) then
    raise exception 'backfill left them unequal: % listings, % assets, % canonical slugs',
      n_listing, n_asset, n_slug;
  end if;
end $$;
