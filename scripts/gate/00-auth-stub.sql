-- Minimal Supabase auth shim for the gate: enough for the identity migration's
-- FK and trigger, and for auth.uid() to be simulated via request.jwt.claims.
create schema if not exists auth;
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid;
$$;
