-- Rate limiter: a bucket of burst 3 with rate 0 (no refill) allows 3 takes
-- then denies the 4th.
do $$
declare
  v1 boolean; v2 boolean; v3 boolean; v4 boolean;
begin
  v1 := rate_take('gate:test', 0, 3);
  v2 := rate_take('gate:test', 0, 3);
  v3 := rate_take('gate:test', 0, 3);
  v4 := rate_take('gate:test', 0, 3);
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('15a. rate_take allows burst then denies', 'postgres', 'rate_take', null,
    case when v1 and v2 and v3 and not v4 then 'PASS' else 'FAIL' end,
    format('takes: %s %s %s %s', v1, v2, v3, v4));
end $$;

-- anon must specifically hold EXECUTE on rate_take (the server calls it with the
-- anon-role key). Run as anon and record whether the call is permitted.
do $$
declare ok boolean := true;
begin
  begin
    set local role anon;
    perform rate_take('gate:anon', 0, 2);
    reset role;
  exception when insufficient_privilege then
    reset role; ok := false;
  end;
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('15b. anon can execute rate_take', 'anon', 'rate_take', null,
    case when ok then 'PASS' else 'FAIL' end, format('anon execute ok: %s', ok));
end $$;
