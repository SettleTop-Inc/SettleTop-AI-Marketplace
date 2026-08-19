-- Reconstructed from the running database on 2026-08-19. This migration was
-- applied to production but its SQL was never committed, so the repo could not
-- rebuild the live schema: the repo's v_logo_status lacked marketplace_id and
-- listing_url, and a rebuild would have broken archive-logos.mjs and every logo
-- on the site.
--
-- The version stamp matches the one already in supabase_migrations, so this is
-- skipped on production and applied only on a fresh or branch database.
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

create or replace view v_logo_status
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

-- create or replace view drops every grant. Keep these here, next to the view.
grant select on public.v_logo_status to anon, authenticated, service_role;
