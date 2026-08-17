-- A certification page that names Microsoft Graph permission scopes IS
-- first-party evidence that the app uses Microsoft Graph. ingest_capture()
-- asserted that, but with ON CONFLICT DO NOTHING — so when the capture agent
-- had already listed "Microsoft Graph" and it failed the verbatim check
-- against stored text, the unverified row won and the assertion was silently
-- dropped. 26 attested apps showed Tools / MCP as Unknown while holding a
-- named Graph scope.
--
-- Making this a trigger rather than patching the function body puts the
-- invariant on the table: however permissions arrive, the evidence follows.

create or replace function registry_graph_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
begin
  insert into capture_evidence (capture_id, kind, value, source, verified)
  values (new.capture_id, 'tool_mcp'::evidence_kind, 'Microsoft Graph',
          'certification'::evidence_source, true)
  on conflict (capture_id, kind, value)
    do update set verified = true, source = 'certification'::evidence_source;
  return new;
end $fn$;

comment on function registry_graph_evidence is
  'Upholds: a capture holding Microsoft Graph permission names always carries verified Microsoft Graph tool evidence. Upgrades an existing unverified row rather than deferring to it.';

drop trigger if exists capture_permission_graph_evidence on capture_permission;
create trigger capture_permission_graph_evidence
after insert on capture_permission
for each row execute function registry_graph_evidence();

-- repair the rows already stored
insert into capture_evidence (capture_id, kind, value, source, verified)
select distinct p.capture_id, 'tool_mcp'::evidence_kind, 'Microsoft Graph',
       'certification'::evidence_source, true
  from capture_permission p
on conflict (capture_id, kind, value)
  do update set verified = true, source = 'certification'::evidence_source;
