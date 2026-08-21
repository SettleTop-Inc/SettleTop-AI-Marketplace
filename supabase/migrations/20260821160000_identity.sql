-- Identity model (Access Foundation Phase B1). No visibility change: this only
-- CREATES new objects; no existing grant, view, or read path is touched. Admin
-- is allowlist-only, never self-serve.

create table if not exists admin_allowlist (email text primary key);
alter table admin_allowlist enable row level security;
-- No policy and no grant: unreadable by anon/authenticated. Only the definer
-- trigger and service_role touch it.
comment on table admin_allowlist is
  'Emails granted admin at profile creation. Seeded here; edited only by service_role. Never self-serve.';

insert into admin_allowlist (email) values ('niles@settletop.com') on conflict do nothing;

create table if not exists profile (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'signed_in' check (role in ('signed_in','admin')),
  created_at timestamptz not null default now()
);
alter table profile enable row level security;

-- Definer helper so an admin-check inside a profile policy does not recurse
-- through profile's own RLS.
create or replace function is_admin() returns boolean
language sql security definer set search_path = pg_catalog, public stable as $$
  select exists (select 1 from public.profile where id = auth.uid() and role = 'admin');
$$;
comment on function is_admin() is
  'True if the current auth.uid() has profile.role = admin. SECURITY DEFINER so it can sit inside profile RLS without recursion.';

-- SELECT only: a user reads their own row, an admin reads all. No INSERT/UPDATE
-- grant or policy to anon/authenticated, so role is not self-escalatable and
-- rows are created only by the trigger; roles change only via service_role.
create policy profile_read on profile for select to authenticated
  using (auth.uid() = id or is_admin());
grant select on profile to authenticated;

-- New auth user -> profile row, admin iff the email is allowlisted (case-insensitive).
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $fn$
begin
  insert into public.profile (id, role)
  values (
    new.id,
    case when exists (
      select 1 from public.admin_allowlist a where lower(a.email) = lower(new.email)
    ) then 'admin' else 'signed_in' end
  )
  on conflict (id) do nothing;
  return new;
end
$fn$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

revoke all on function is_admin() from public;
grant execute on function is_admin() to authenticated, service_role;
revoke all on function handle_new_user() from public;
