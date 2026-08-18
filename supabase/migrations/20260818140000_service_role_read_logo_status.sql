-- The logo archiver authenticates with the service-role key and failed on
-- every run with 42501 "permission denied for view v_logo_status".
--
-- The view granted SELECT to anon, authenticated and postgres, but never to
-- service_role -- which in fact held SELECT on nothing at all in public. The
-- other harvest passes never noticed because they write through SECURITY
-- DEFINER functions (ingest_capture, record_link_archive), which run as the
-- owner and so need no table grants. archive-logos.mjs is the only pass that
-- reads a relation directly, so it is the only one that hit the missing grant.
--
-- v_logo_status is security_invoker, so the grant on the view alone is not
-- enough: the caller's own rights are what the underlying scan is checked
-- against. The three base tables it reads are granted with it.
--
-- Scoped deliberately to what that one script reads. This is not Supabase's
-- blanket "grant all on all tables to service_role" -- writes stay behind the
-- definer functions where the evidence gate lives, and nothing here widens
-- what anon can see.

grant select on public.v_logo_status  to service_role;
grant select on public.asset          to service_role;
grant select on public.capture_extract to service_role;
grant select on public.capture_link    to service_role;
