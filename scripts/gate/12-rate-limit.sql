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
