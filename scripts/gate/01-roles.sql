-- Supabase-shaped roles, created before any migration runs.
-- Verified against production 2026-08-19: anon and authenticated are
-- NOBYPASSRLS, service_role is BYPASSRLS.
create role anon          nologin noinherit nobypassrls;
create role authenticated nologin noinherit nobypassrls;
create role service_role  nologin noinherit bypassrls;

-- No migration grants schema usage to service_role, yet production's
-- archive-logos.mjs failed with 42501 "permission denied for view", a
-- relation-level error, not "permission denied for schema public". So
-- service_role holds schema usage from Supabase's own bootstrap, not from
-- this repo. Reproduced here.
grant usage on schema public to anon, authenticated, service_role;

-- Deliberately NOT reproduced: Supabase's blanket
--   alter default privileges in schema public grant all on tables to ...
-- Migration 20260818140000 records that on production service_role "in fact
-- held SELECT on nothing at all in public", which is only true if those
-- default privileges are absent. Leaving them out makes this container a
-- lower bound on privileges: anything that passes here passes with more.
