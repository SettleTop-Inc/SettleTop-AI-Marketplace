-- Gate harness. Lives in its own schema so nothing it creates is visible to
-- the checks themselves. anon is never granted usage on it.
create schema if not exists gate;

create table if not exists gate.result (
  seq      bigserial primary key,
  step     text,
  as_role  text,
  object   text,
  n_rows   bigint,
  verdict  text,
  note     text
);

-- Runs count(*) over one object with current_user actually switched to p_role,
-- so RLS is evaluated against that role rather than against the owner.
--
-- A zero-row result is recorded as a FAIL, not a pass. That is the whole point:
-- PostgREST answers an empty view with HTTP 200 and [], and getLogos in
-- lib/registry.ts turns that into initials, so success and silent emptiness are
-- indistinguishable unless the count is asserted.
create or replace function gate.check_rows(p_step text, p_role text, p_obj text,
                                           p_expect text default 'nonzero')
returns void language plpgsql as $fn$
declare n bigint; v text; note text := '';
begin
  begin
    execute format('set role %I', p_role);
    execute format('select count(*) from %s', p_obj) into n;
    reset role;
    if p_expect = 'nonzero' then
      v := case when n > 0 then 'PASS' else 'FAIL: zero rows, silently' end;
    elsif p_expect = 'zero' then
      v := case when n = 0 then 'PASS: zero rows, no error' else 'FAIL: still returned rows' end;
    else
      v := 'PASS: informational';
    end if;
  exception when others then
    reset role;
    n := null;
    v := 'ERROR ' || sqlstate;
    note := sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, p_role, p_obj, n, v, note);
end $fn$;
