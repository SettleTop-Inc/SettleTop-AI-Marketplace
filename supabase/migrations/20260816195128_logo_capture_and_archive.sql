-- Logos.
--
-- The original capture template had one flat media_image_urls bucket, so a
-- product logo and a screenshot were indistinguishable, and nothing ever
-- fetched the bytes. A URL on someone else's CDN is a pointer, not a capture:
-- it rots, it can be swapped, and it cannot be hashed. This makes the logo a
-- first-class link kind and gives every link somewhere to record that we hold
-- an actual archived copy.

alter table capture_link
  add column if not exists archived_url  text,
  add column if not exists archived_at   timestamptz,
  add column if not exists content_hash  text,
  add column if not exists bytes         integer,
  add column if not exists content_type  text;

comment on column capture_link.archived_url is
  'Where our own copy lives. Null means we hold only the publisher''s URL and the image is not actually captured.';
comment on column capture_link.content_hash is
  'sha256 of the archived bytes. Lets a later re-fetch prove the publisher swapped the image.';

create index if not exists capture_link_logo_idx
  on capture_link (capture_id) where kind = 'logo';
create index if not exists capture_link_unarchived_idx
  on capture_link (kind) where archived_url is null;

-- Called by the capture worker once it has identified, in the live DOM, which
-- image is the product logo. Idempotent per capture.
create or replace function set_capture_logo(
  p_product_id text,
  p_url text,
  p_marketplace_id text default 'microsoft'
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $fn$
declare v_capture uuid; v_link bigint; v_existing text;
begin
  select a.current_capture_id into v_capture
    from asset a
   where a.marketplace_id = p_marketplace_id and a.source_product_id = p_product_id;
  if v_capture is null then
    return jsonb_build_object('status','no_capture','product_id',p_product_id);
  end if;

  select url into v_existing from capture_link
   where capture_id = v_capture and kind = 'logo' limit 1;

  if v_existing is not null then
    if v_existing = p_url then
      return jsonb_build_object('status','unchanged','capture_id',v_capture);
    end if;
    update capture_link
       set url = p_url, archived_url = null, archived_at = null,
           content_hash = null, bytes = null, content_type = null
     where capture_id = v_capture and kind = 'logo'
     returning id into v_link;
    return jsonb_build_object('status','replaced','capture_id',v_capture,'link_id',v_link);
  end if;

  insert into capture_link (capture_id, kind, label, url, position)
  values (v_capture, 'logo', 'Product logo', p_url, 0)
  returning id into v_link;
  return jsonb_build_object('status','set','capture_id',v_capture,'link_id',v_link);
end $fn$;

revoke all on function set_capture_logo(text, text, text) from public, anon, authenticated;
grant execute on function set_capture_logo(text, text, text) to service_role;

-- Called by the archiver once the bytes are actually stored.
create or replace function record_link_archive(
  p_link_id bigint, p_archived_url text, p_content_hash text,
  p_bytes integer, p_content_type text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $fn$
begin
  update capture_link
     set archived_url = p_archived_url, archived_at = now(),
         content_hash = p_content_hash, bytes = p_bytes, content_type = p_content_type
   where id = p_link_id;
  if not found then
    return jsonb_build_object('status','no_such_link','link_id',p_link_id);
  end if;
  return jsonb_build_object('status','archived','link_id',p_link_id);
end $fn$;

revoke all on function record_link_archive(bigint, text, text, integer, text) from public, anon, authenticated;
grant execute on function record_link_archive(bigint, text, text, integer, text) to service_role;

-- What still needs work, so the gap is queryable rather than invisible.
create or replace view v_logo_status
with (security_invoker = true) as
select a.source_product_id, x.name, x.publisher,
       l.id                                   as link_id,
       l.url                                  as logo_url,
       l.archived_url,
       l.content_hash,
       case when l.id is null            then 'no_logo_identified'
            when l.archived_url is null  then 'url_only_not_archived'
            else 'archived' end               as state
  from asset a
  join capture_extract x on x.capture_id = a.current_capture_id
  left join capture_link l
         on l.capture_id = a.current_capture_id and l.kind = 'logo';

comment on view v_logo_status is
  'Every asset and whether its logo is unidentified, referenced only, or actually held. url_only_not_archived is not done.';

grant select on v_logo_status to anon, authenticated;;