-- Token-bucket rate limiting for the server read layer (Access Foundation,
-- Phase A). One row per bucket key (e.g. 'passport:1.2.3.4', 'global:reads:all').
-- rate_take refills by elapsed time and takes one token, returning whether the
-- caller is allowed. SECURITY DEFINER so the table needs no public policy;
-- granted to anon so the server-only anon client can call it. The anon key is
-- server-only now, so this is not a public surface.

create table if not exists rate_bucket (
  bucket     text primary key,
  tokens     double precision not null,
  updated_at timestamptz not null default now()
);
alter table rate_bucket enable row level security;
-- No policy: only the definer function reaches this table.

create or replace function rate_take(
  p_bucket text, p_rate double precision, p_burst double precision
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_now    timestamptz := clock_timestamp();
  v_tokens double precision;
  v_last   timestamptz;
begin
  insert into rate_bucket (bucket, tokens, updated_at)
    values (p_bucket, p_burst, v_now)
    on conflict (bucket) do nothing;

  select tokens, updated_at into v_tokens, v_last
    from rate_bucket where bucket = p_bucket for update;

  v_tokens := least(p_burst, v_tokens + extract(epoch from (v_now - v_last)) * p_rate);

  if v_tokens < 1 then
    update rate_bucket set tokens = v_tokens, updated_at = v_now where bucket = p_bucket;
    return false;
  end if;

  update rate_bucket set tokens = v_tokens - 1, updated_at = v_now where bucket = p_bucket;
  return true;
end
$fn$;

comment on function rate_take(text, double precision, double precision) is
  'Token-bucket take: refill p_bucket by elapsed time at p_rate tokens/sec up to p_burst, take one token, return whether allowed. SECURITY DEFINER; the server-only anon client calls it.';

revoke all on function rate_take(text, double precision, double precision) from public;
grant execute on function rate_take(text, double precision, double precision) to anon, authenticated, service_role;
