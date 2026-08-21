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


-- Helpers for the merge_assets / unmerge_asset checks in 05-negative.sql -------
-- Added for issue #63. Defined here in the harness so they exist before both
-- 04-reads.sql and 05-negative.sql run.

-- v_registry_stats as anon, returned as jsonb so a pre-merge and a post-unmerge
-- snapshot can be captured and compared field for field. The role is switched
-- and reset exactly as gate.check_stats does, and reset even on error.
create or replace function gate.stats_json() returns jsonb
language plpgsql as $fn$
declare j jsonb;
begin
  set role anon;
  select to_jsonb(s) into j from v_registry_stats s;
  reset role;
  return j;
exception when others then
  reset role;
  raise;
end $fn$;

-- A content fingerprint of the seven capture-family tables: one md5 per table
-- over its rows serialised as text and sorted, plus each table's row count. A
-- merge and an unmerge must leave this jsonb identical, because neither reads or
-- writes any of these tables. Ordering by the row text rather than a primary key
-- keeps it correct whatever the table's key is, and the row text of a composite
-- serialises deterministically, jsonb columns included.
create or replace function gate.capture_family_fingerprint() returns jsonb
language sql stable as $fn$
  select jsonb_build_object(
    'capture',            (select md5(coalesce(string_agg(x, '|' order by x), '')) from (select t::text as x from capture t) s),
    'capture_extract',    (select md5(coalesce(string_agg(x, '|' order by x), '')) from (select t::text as x from capture_extract t) s),
    'capture_link',       (select md5(coalesce(string_agg(x, '|' order by x), '')) from (select t::text as x from capture_link t) s),
    'capture_plan',       (select md5(coalesce(string_agg(x, '|' order by x), '')) from (select t::text as x from capture_plan t) s),
    'capture_permission', (select md5(coalesce(string_agg(x, '|' order by x), '')) from (select t::text as x from capture_permission t) s),
    'capture_compliance', (select md5(coalesce(string_agg(x, '|' order by x), '')) from (select t::text as x from capture_compliance t) s),
    'capture_evidence',   (select md5(coalesce(string_agg(x, '|' order by x), '')) from (select t::text as x from capture_evidence t) s),
    'counts', jsonb_build_object(
      'capture',            (select count(*) from capture),
      'capture_extract',    (select count(*) from capture_extract),
      'capture_link',       (select count(*) from capture_link),
      'capture_plan',       (select count(*) from capture_plan),
      'capture_permission', (select count(*) from capture_permission),
      'capture_compliance', (select count(*) from capture_compliance),
      'capture_evidence',   (select count(*) from capture_evidence)))
$fn$;

-- Assert that a statement RAISES. p_sql is run; if it completes the check FAILs,
-- if it raises the check PASSes. This is the shape merge_assets' input-validation
-- gate needs: a rejection that silently no-ops is exactly the failure the
-- function exists to prevent, so "it raised" is the property under test. p_note
-- names which rule the input was built to trip; the sqlstate and message of the
-- actual raise are recorded beside it.
create or replace function gate.check_raises(p_step text, p_object text, p_sql text,
                                             p_note text default '') returns void
language plpgsql as $fn$
declare v text; note text;
begin
  begin
    execute p_sql;
    v := 'FAIL: expected an exception, none raised';
    note := p_note || ' :: completed without error';
  exception when others then
    v := 'PASS: raised as required';
    note := p_note || ' :: ' || sqlstate || ' ' || sqlerrm;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values (p_step, 'postgres', p_object, null, v, note);
end $fn$;
