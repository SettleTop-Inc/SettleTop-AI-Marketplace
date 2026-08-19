-- The registry's unit becomes the product, so the table that holds one
-- marketplace's page for something is called what it is: a listing.
--
-- Views follow a rename automatically, because they record dependencies by
-- object identity. plpgsql function bodies are stored as text and do not, so
-- ingest_capture and set_capture_logo are broken from this statement until
-- 20260819100300 recreates them. Both are in the same push, so the window does
-- not exist outside the migration run.
--
-- Naming convention for every statement below: once a table has been renamed
-- earlier in this file, every later statement that touches it (column,
-- policy, trigger, index or constraint) refers to it by its NEW name. asset
-- and asset_change are renamed first, so nothing after that point ever names
-- them again.

alter table asset rename to listing;
alter table capture rename column asset_id to listing_id;
alter table asset_change rename to listing_change;
alter table listing_change rename column asset_id to listing_id;

-- Constraints, indexes, policies and triggers survive a rename but keep their
-- old names. A policy called asset_public_read on a table called listing
-- misleads the next reader.
alter policy asset_public_read        on public.listing        rename to listing_public_read;
alter policy asset_change_public_read on public.listing_change rename to listing_change_public_read;
alter trigger asset_change_suppress_cross_method on public.listing_change
  rename to listing_change_suppress_cross_method;
alter index capture_asset_time_idx  rename to capture_listing_time_idx;
alter index asset_change_asset_idx  rename to listing_change_listing_idx;
alter index asset_change_field_idx  rename to listing_change_field_idx;

-- Eight constraints named for asset, sitting on tables now called listing and
-- listing_change. Renaming a primary key or unique constraint renames its
-- backing index with it. Nothing in the repo references a constraint by name.
alter table listing rename constraint asset_pkey to listing_pkey;
alter table listing rename constraint asset_marketplace_id_fkey to listing_marketplace_id_fkey;
alter table listing rename constraint asset_marketplace_id_source_product_id_key to listing_marketplace_id_source_product_id_key;
alter table listing rename constraint asset_current_capture_fk to listing_current_capture_fk;
alter table listing_change rename constraint asset_change_pkey to listing_change_pkey;
alter table listing_change rename constraint asset_change_asset_id_fkey to listing_change_listing_id_fkey;
alter table listing_change rename constraint asset_change_from_capture_id_fkey to listing_change_from_capture_id_fkey;
alter table listing_change rename constraint asset_change_to_capture_id_fkey to listing_change_to_capture_id_fkey;

comment on table listing is
  'One marketplace''s page for something. A listing is evidence about an asset, not the asset itself.';
comment on table listing_change is
  'What moved between two consecutive captures of the same listing: pricing changes, permission scope growth, an attestation appearing or lapsing, a residency claim quietly dropped.';

-- The comment on capture was not accurate. Of 30,900 captures, 187 have a null
-- raw: 140 backfill, and 47 dual_write on template_version 2.0, captured in a
-- two-hour window on 2026-08-17 during the manual capture era. No listing's
-- current capture is among them, so every listing's newest observation is fully
-- backed by its source material.
comment on table capture is
  'One immutable observation of one listing. Never updated, never deleted. raw holds the capture file verbatim so extraction can be improved and re-run without re-scraping. raw is null for 187 superseded rows: 140 backfilled from a pre-Supabase index, and 47 from the template 2.0 manual capture era. No listing''s current capture has a null raw.';
