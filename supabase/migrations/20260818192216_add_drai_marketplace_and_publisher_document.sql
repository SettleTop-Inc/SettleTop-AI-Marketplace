-- Reconstructed from the running database on 2026-08-19. This migration was
-- applied to production but its SQL was never committed: the drai marketplace
-- row, the publisher_document table and the ingest_publisher_document
-- function all existed live with no matching file in the repo. Without this
-- file the repo cannot rebuild the schema it is actually running.
--
-- The version stamp matches the one already in supabase_migrations, so this is
-- skipped on production and applied only on a fresh or branch database.
--
-- publisher_document keeps the RLS state confirmed live on 2026-08-19: RLS is
-- enabled, there is no policy, and there is no SELECT grant to anon,
-- authenticated or service_role. That means nothing can read the table today.
-- That is a real gap, but reproducing production's behaviour is this task's
-- job, not closing it, so it is left exactly as found.
--
-- The one behaviour this file does not reproduce is the missing revoke/grant
-- on ingest_publisher_document: see the block at the end of this file.

insert into marketplace (id, name, base_url, product_url_template) values
  ('drai', 'DRAI Agentic-AI Marketplace', 'https://www.drai-commercial.com', null)
on conflict (id) do nothing;

create table publisher_document (
  id             bigserial primary key,
  marketplace_id text not null references marketplace(id),
  publisher      text not null,
  doc_type       text not null
                   check (doc_type in ('security_compliance','privacy_policy',
                     'enterprise_privacy_policy','ai_ethics','terms_of_service',
                     'dpa','sla','other')),
  title          text not null,
  url            text not null,
  effective_date date,
  version        text,
  captured_at    timestamptz not null default now(),
  content_hash   text not null,
  full_text      text not null,
  drive_file_id  text,
  created_at     timestamptz not null default now()
);

comment on table publisher_document is
  'Publisher level documents that govern every listing from that publisher: security statements, privacy policies, AI ethics policies, terms. One row per distinct text. A new row for the same doc_type means the publisher revised the document, which is the change signal.';

CREATE UNIQUE INDEX publisher_document_uniq ON public.publisher_document USING btree (marketplace_id, doc_type, content_hash);
CREATE INDEX publisher_document_latest ON public.publisher_document USING btree (marketplace_id, doc_type, captured_at DESC);

-- Confirmed live on 2026-08-19: RLS on, no policy, no grant. Nothing can read
-- this table today. Reproduced as found; see header.
alter table publisher_document enable row level security;

create or replace function ingest_publisher_document(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_mkt   text := payload ->> 'marketplace_id';
  v_pub   text := payload ->> 'publisher';
  v_type  text := payload ->> 'doc_type';
  v_text  text := payload ->> 'full_text';
  v_hash  text;
  v_id    bigint;
  v_prior int;
begin
  if v_mkt is null or v_pub is null or v_type is null or coalesce(btrim(v_text),'') = '' then
    raise exception 'ingest_publisher_document: needs marketplace_id, publisher, doc_type and non empty full_text';
  end if;

  v_hash := encode(sha256(convert_to(v_text, 'UTF8')), 'hex');

  select id into v_id from publisher_document
   where marketplace_id = v_mkt and doc_type = v_type and content_hash = v_hash;
  if found then
    return jsonb_build_object('status','unchanged','document_id',v_id,'content_hash',v_hash);
  end if;

  select count(*) into v_prior from publisher_document
   where marketplace_id = v_mkt and doc_type = v_type;

  insert into publisher_document (marketplace_id, publisher, doc_type, title, url,
                                  effective_date, version, captured_at, content_hash,
                                  full_text, drive_file_id)
  values (v_mkt, v_pub, v_type,
          coalesce(payload ->> 'title', v_type),
          coalesce(payload ->> 'url', ''),
          registry_safe_date(payload ->> 'effective_date'),
          payload ->> 'version',
          coalesce((payload ->> 'captured_at_utc')::timestamptz, now()),
          v_hash, v_text, payload ->> 'drive_file_id')
  returning id into v_id;

  return jsonb_build_object(
    'status', case when v_prior = 0 then 'created' else 'revised' end,
    'document_id', v_id, 'content_hash', v_hash, 'prior_versions', v_prior);
end $fn$;

-- Live was missing this pair, which every sibling write function
-- (ingest_capture, set_capture_logo, record_link_archive) carries: with no
-- explicit ACL, Postgres grants EXECUTE to PUBLIC, so the browser
-- publishable key could call this and insert arbitrary publisher_document
-- rows. Production is fixed separately, in
-- 20260819095000_revoke_public_execute_on_publisher_document.sql, because
-- this version stamp is already recorded there and this file is skipped.
-- This block only matters for a database built from scratch, which must
-- never be exposed even for the time between this migration and that one.
revoke all on function ingest_publisher_document(jsonb) from public, anon, authenticated;
grant execute on function ingest_publisher_document(jsonb) to service_role;
