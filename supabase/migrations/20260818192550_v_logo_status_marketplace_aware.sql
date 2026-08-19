-- Reconstructed from the running database on 2026-08-19. This migration was
-- applied to production but its SQL was never committed, so the repo could not
-- rebuild the live schema: the repo's v_logo_status lacked marketplace_id and
-- listing_url, and a rebuild would have broken archive-logos.mjs and every logo
-- on the site.
--
-- The version stamp matches the one already in supabase_migrations, so this is
-- skipped on production and applied only on a fresh or branch database.
--
-- This is a drop and create, not create or replace. CREATE OR REPLACE VIEW
-- requires the existing columns to keep their name, type and position, and
-- allows only new columns appended at the end. The committed original in
-- 20260816195128_logo_capture_and_archive.sql starts with source_product_id;
-- this version puts marketplace_id first and inserts listing_url in the
-- middle, so replaying it as create or replace fails against a database that
-- already ran that earlier migration:
--
--   ERROR:  cannot change name of view column "source_product_id" to
--   "marketplace_id"
--
-- Changing a view's column shape forces Postgres to drop and recreate it
-- under the hood, and it is that drop that takes the grants with it, not
-- create or replace as such: a column-compatible create or replace preserves
-- grants. 20260818210000_v_logo_status_grants.sql traces the outage this
-- caused; its description of the mechanism is corrected here. The practice
-- that migration establishes, keeping the grant next to the view, is still
-- right, so it is repeated below.
--
-- No cascade on the drop. Nothing else in this schema depends on
-- v_logo_status; if that ever changes, the drop should fail loudly rather
-- than silently taking a dependent object with it.
--
-- One deliberate difference from what production currently holds: this
-- restores `with (security_invoker = true)`. The applied version dropped it,
-- so the live view runs as its creator and bypasses row level security,
-- which Supabase's linter flags at ERROR level. Every other view in this
-- schema is security_invoker. Restoring it changes no behaviour: the three
-- tables this view reads all carry `for select to anon using (true)`
-- policies, and archive-logos.mjs reads it with the service role key.
-- Production itself stays on the definer-style view until Task 7 of this
-- plan recreates every view with security_invoker = true; this file cannot
-- reach production because its version is already recorded there.

drop view if exists v_logo_status;

create view v_logo_status
with (security_invoker = true) as
 SELECT a.marketplace_id,
    a.source_product_id,
    a.listing_url,
    x.name,
    x.publisher,
    l.id AS link_id,
    l.url AS logo_url,
    l.archived_url,
    l.content_hash,
        CASE
            WHEN l.id IS NULL THEN 'no_logo_identified'::text
            WHEN l.archived_url IS NULL THEN 'url_only_not_archived'::text
            ELSE 'archived'::text
        END AS state
   FROM asset a
     JOIN capture_extract x ON x.capture_id = a.current_capture_id
     LEFT JOIN capture_link l ON l.capture_id = a.current_capture_id AND l.kind = 'logo'::link_kind;

-- Dropping and recreating the view drops every grant. Keep these here, next
-- to the view.
grant select on public.v_logo_status to anon, authenticated, service_role;
