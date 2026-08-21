-- Identity: trigger sets admin iff allowlisted; profile RLS is self-or-admin;
-- role is not self-escalatable; admin_allowlist is unreadable by a signed-in user.
do $$
declare
  v_admin uuid; v_user uuid;
  v_admin_role text; v_user_role text;
  v_n_user int; v_n_admin int;
  v_escalation_blocked boolean := true;
  v_allowlist_blocked  boolean := true;
begin
  insert into auth.users (email) values ('niles@settletop.com') returning id into v_admin;
  insert into auth.users (email) values ('someone@example.com') returning id into v_user;
  select role into v_admin_role from public.profile where id = v_admin;
  select role into v_user_role  from public.profile where id = v_user;

  -- As the non-admin user: reads only own row; cannot escalate; cannot read allowlist.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user::text)::text, true);
  set local role authenticated;
  select count(*) into v_n_user from public.profile;
  begin
    update public.profile set role = 'admin' where id = v_user;
    v_escalation_blocked := false; -- reaching here means it was allowed (bad)
  exception when insufficient_privilege then
    v_escalation_blocked := true;
  end;
  begin
    perform 1 from public.admin_allowlist limit 1;
    v_allowlist_blocked := false;
  exception when insufficient_privilege then
    v_allowlist_blocked := true;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  -- As the admin: reads all rows.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin::text)::text, true);
  set local role authenticated;
  select count(*) into v_n_admin from public.profile;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  insert into gate.result(step, as_role, object, n_rows, verdict, note) values
   ('16a. trigger admin iff allowlisted', 'postgres', 'profile', null,
     case when v_admin_role='admin' and v_user_role='signed_in' then 'PASS' else 'FAIL' end,
     format('admin=%s user=%s', v_admin_role, v_user_role)),
   ('16b. non-admin reads only own profile', 'authenticated', 'profile', v_n_user,
     case when v_n_user=1 then 'PASS' else 'FAIL' end, 'rls self-only'),
   ('16c. admin reads all profiles', 'authenticated', 'profile', v_n_admin,
     case when v_n_admin=2 then 'PASS' else 'FAIL' end, 'rls admin-all'),
   ('16d. role is not self-escalatable', 'authenticated', 'profile', null,
     case when v_escalation_blocked then 'PASS' else 'FAIL' end, 'update role denied'),
   ('16e. admin_allowlist unreadable by a signed-in user', 'authenticated', 'admin_allowlist', null,
     case when v_allowlist_blocked then 'PASS' else 'FAIL' end, 'select denied');
end $$;
