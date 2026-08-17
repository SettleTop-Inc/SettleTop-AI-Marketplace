create extension if not exists pgcrypto;

create type certification_status as enum (
  'microsoft_365_certified', 'publisher_attestation', 'none', 'not_eligible'
);
create type evidence_kind as enum (
  'model', 'framework', 'tool_mcp', 'data_source', 'integration',
  'deployment', 'language'
);
create type evidence_source as enum ('listing', 'certification');
create type link_kind as enum ('product', 'legal', 'media');
create type risk_band as enum ('Low', 'Medium', 'High');
create type provenance_status as enum ('Verified', 'Disclosed', 'Unknown');
create type ingest_source as enum ('dual_write', 'backfill', 'reconcile');

create table marketplace (
  id                   text primary key,
  name                 text not null,
  base_url             text,
  product_url_template text,
  created_at           timestamptz not null default now()
);
comment on table marketplace is
  'A source of listings. Microsoft Marketplace is the first; the schema does not assume it is the only one.';

create table asset (
  id                uuid primary key default gen_random_uuid(),
  marketplace_id    text not null references marketplace(id) on delete restrict,
  source_product_id text not null,
  listing_url       text not null,
  first_seen_at     timestamptz not null default now(),
  last_captured_at  timestamptz,
  current_capture_id uuid,
  capture_count     integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (marketplace_id, source_product_id)
);
comment on column asset.source_product_id is
  'The marketplace''s own product id, e.g. anthropic.anthropic-claude-opus-4-8-offer or WA200004554. Never a slug we invented.';

create table capture (
  id               uuid primary key default gen_random_uuid(),
  asset_id         uuid not null references asset(id) on delete cascade,
  captured_at      timestamptz not null,
  template_version text not null,
  capture_complete boolean not null default true,
  missing          text[] not null default '{}',
  source_view_url  text,
  drive_file_id    text,
  drive_file_name  text,
  raw              jsonb,
  content_hash     text not null,
  ingest_source    ingest_source not null,
  created_at       timestamptz not null default now()
);
comment on table capture is
  'One immutable observation of one listing. Never updated, never deleted. raw holds the capture file verbatim so extraction can be improved and re-run without re-scraping; it is null only for rows backfilled from a pre-Supabase index, which is recorded honestly in ingest_source.';
comment on column capture.content_hash is
  'sha256 over the normalised extract. Equal hashes mean the listing did not change between observations.';

create unique index capture_drive_file_uniq
  on capture (drive_file_id) where drive_file_id is not null;
create index capture_asset_time_idx on capture (asset_id, captured_at desc);

alter table asset
  add constraint asset_current_capture_fk
  foreign key (current_capture_id) references capture(id) on delete set null;

create or replace function public.immutable_array_text(arr text[])
returns text language sql immutable parallel safe as
$$ select coalesce(array_to_string(arr, ' '), '') $$;

create table capture_extract (
  capture_id                uuid primary key references capture(id) on delete cascade,
  extract_spec_version      text not null,
  name                      text not null,
  publisher                 text,
  tagline                   text,
  surfaces                  text[] not null default '{}',
  categories                text[] not null default '{}',
  industries                text[] not null default '{}',
  works_with                text[] not null default '{}',
  pricing                   text,
  acquire_using             text,
  listing_version           text,
  listing_updated           date,
  overview_text             text,
  support                   text,
  rating                    numeric(3,2),
  rating_count              integer not null default 0,
  native_rating             numeric(3,2),
  native_count              integer,
  external_source           text,
  external_rating           numeric(3,2),
  external_count            integer,
  certification             certification_status not null default 'none',
  cert_url                  text,
  cert_hosting              text,
  cert_data_location        text,
  cert_data_handling        text,
  cert_developer_updated    date,
  cert_page_updated         date,
  function_category         text,
  delivery                  text,
  price_band                text,
  price_note                text,
  known_layers              text[] not null default '{}',
  reach                     integer not null default 0,
  provenance                provenance_status not null default 'Unknown',
  evidence_tier             text,
  risk                      risk_band not null default 'High',
  risk_basis                text,
  search tsvector generated always as (
    to_tsvector('english'::regconfig,
      coalesce(name, '') || ' ' ||
      coalesce(publisher, '') || ' ' ||
      coalesce(tagline, '') || ' ' ||
      coalesce(overview_text, '') || ' ' ||
      public.immutable_array_text(categories) || ' ' ||
      public.immutable_array_text(industries) || ' ' ||
      public.immutable_array_text(surfaces)   || ' ' ||
      public.immutable_array_text(works_with)
    )
  ) stored
);
create index capture_extract_search_idx on capture_extract using gin (search);
create index capture_extract_function_idx on capture_extract (function_category);
create index capture_extract_cert_idx on capture_extract (certification);

create table capture_evidence (
  id         bigserial primary key,
  capture_id uuid not null references capture(id) on delete cascade,
  kind       evidence_kind not null,
  value      text not null,
  source     evidence_source not null,
  verified   boolean not null default false,
  unique (capture_id, kind, value)
);
comment on table capture_evidence is
  'Named build facts: models, frameworks, tool layers, data sources, integrations, deployment targets. verified means the string was confirmed to appear character for character in this capture''s own text. Public views expose verified rows only.';
create index capture_evidence_lookup_idx on capture_evidence (kind, value) where verified;
create index capture_evidence_capture_idx on capture_evidence (capture_id);

create table capture_plan (
  id         bigserial primary key,
  capture_id uuid not null references capture(id) on delete cascade,
  position   integer not null,
  name       text,
  price      text,
  unit       text,
  billing    text,
  unique (capture_id, position)
);
comment on column capture_plan.price is
  'Copied as displayed, e.g. "$0.00/month". Never normalised to a number.';

create table capture_link (
  id         bigserial primary key,
  capture_id uuid not null references capture(id) on delete cascade,
  kind       link_kind not null,
  label      text,
  url        text not null,
  position   integer not null default 0
);
create index capture_link_capture_idx on capture_link (capture_id, kind);

create table capture_permission (
  id         bigserial primary key,
  capture_id uuid not null references capture(id) on delete cascade,
  permission text not null,
  unique (capture_id, permission)
);
comment on table capture_permission is
  'Microsoft Graph permission names named on the app certification page. An empty set on a certified app means none were requested, which is different from unknown.';

create table capture_compliance (
  id            bigserial primary key,
  capture_id    uuid not null references capture(id) on delete cascade,
  certification text not null,
  unique (capture_id, certification)
);

create table asset_change (
  id              bigserial primary key,
  asset_id        uuid not null references asset(id) on delete cascade,
  from_capture_id uuid references capture(id) on delete cascade,
  to_capture_id   uuid not null references capture(id) on delete cascade,
  observed_at     timestamptz not null,
  field           text not null,
  old_value       jsonb,
  new_value       jsonb,
  created_at      timestamptz not null default now()
);
comment on table asset_change is
  'What moved between two consecutive captures of the same asset: pricing changes, permission scope growth, an attestation appearing or lapsing, a residency claim quietly dropped.';
create index asset_change_asset_idx on asset_change (asset_id, observed_at desc);
create index asset_change_field_idx on asset_change (field, observed_at desc);

alter table marketplace        enable row level security;
alter table asset              enable row level security;
alter table capture            enable row level security;
alter table capture_extract    enable row level security;
alter table capture_evidence   enable row level security;
alter table capture_plan       enable row level security;
alter table capture_link       enable row level security;
alter table capture_permission enable row level security;
alter table capture_compliance enable row level security;
alter table asset_change       enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'marketplace','asset','capture','capture_extract','capture_evidence',
    'capture_plan','capture_link','capture_permission','capture_compliance',
    'asset_change'
  ] loop
    execute format(
      'create policy %I on public.%I for select to anon, authenticated using (true)',
      t || '_public_read', t);
  end loop;
end $$;

grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;

insert into marketplace (id, name, base_url, product_url_template) values
  ('microsoft', 'Microsoft Marketplace', 'https://marketplace.microsoft.com',
   'https://marketplace.microsoft.com/en-us/product/{id}')
on conflict (id) do nothing;;