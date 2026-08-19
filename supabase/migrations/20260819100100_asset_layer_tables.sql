-- The registry's unit. One row per real product; a listing is one marketplace's
-- page about it.

create table asset (
  id                 uuid primary key default gen_random_uuid(),
  primary_listing_id uuid,                       -- FK added below, after listing exists
  merged_into        uuid references asset(id),  -- non-null means retired
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table asset is
  'One real product. Listings are evidence about it. An asset with merged_into set has been merged away and is retained only so the merge log stays valid; every count of assets must exclude it.';
comment on column asset.primary_listing_id is
  'Which listing supplies the headline fields. Stored rather than derived: a rule like "most captures" would silently change a product''s headline whenever data moved.';

-- asset.primary_listing_id and listing.asset_id reference each other. The same
-- shape already exists between asset.current_capture_id and capture, and is
-- solved the same way: add the constraint once both tables exist.
alter table asset
  add constraint asset_primary_listing_fk
  foreign key (primary_listing_id) references listing(id) on delete set null;

create index asset_merged_into_idx on asset (merged_into) where merged_into is not null;

-- Slugs are their own table so an asset can answer to several, which is what
-- keeps a merged-away product's URL resolving. Uniqueness is enforced here
-- because the existing index is on (marketplace_id, source_product_id), never
-- on source_product_id alone.
create table asset_slug (
  slug         text primary key,
  asset_id     uuid not null references asset(id) on delete cascade,
  is_canonical boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index asset_slug_one_canonical on asset_slug (asset_id) where is_canonical;
create index asset_slug_asset_idx on asset_slug (asset_id);

comment on table asset_slug is
  'Every URL an asset answers to. The canonical one is what the site links; the rest are earlier identities kept alive so no link ever breaks.';

-- The claim that two listings are the same product is ours. No marketplace
-- makes it, so it carries provenance like everything else here.
create table asset_merge (
  id             bigserial primary key,
  from_asset_id  uuid not null references asset(id),
  into_asset_id  uuid not null references asset(id),
  listing_ids    uuid[] not null,
  slugs          text[] not null,
  basis          text not null,
  merged_by      text not null,
  merged_at      timestamptz not null default now(),
  undone_at      timestamptz
);
create index asset_merge_into_idx on asset_merge (into_asset_id, merged_at desc);

comment on column asset_merge.merged_by is
  'A handle, never an email. This table is publicly readable.';
comment on column asset_merge.listing_ids is
  'Exactly what moved, so unmerge_asset can move it back. Captures and extracts are never touched by either direction.';

-- RLS is on for every table in this schema and the existing policies were
-- created by a loop over a hardcoded array, so a new table inherits nothing.
-- A table with RLS on and no policy is invisible to anon.
alter table asset       enable row level security;
alter table asset_slug  enable row level security;
alter table asset_merge enable row level security;

create policy asset_public_read       on public.asset       for select to anon, authenticated using (true);
create policy asset_slug_public_read  on public.asset_slug  for select to anon, authenticated using (true);
create policy asset_merge_public_read on public.asset_merge for select to anon, authenticated using (true);

grant select on public.asset, public.asset_slug, public.asset_merge
  to anon, authenticated, service_role;
