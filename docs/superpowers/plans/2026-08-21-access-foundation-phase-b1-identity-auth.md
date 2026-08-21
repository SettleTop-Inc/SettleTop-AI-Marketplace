# Access Foundation, Phase B1: Identity + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add magic-link sign-in, a `profile`/`role`/`admin_allowlist` identity model with an admin allowlist, and a minimal account-creation limiter, with **no change to what any visitor can see**. This establishes who is signed in and who is admin; the visibility gate itself is Phase B2.

**Architecture:** Auth is entirely server-side. Phase A retired the Supabase publishable key from the browser, and `@supabase/ssr`'s browser client would need that key back in the bundle. So sign-in runs through a server action (`signInWithOtp` on a server-held client); the emailed link lands on a server route that verifies a `token_hash` (the stateless flow, so the link works on any device); `proxy.ts` (Next 16) refreshes the session; server code reads it. There is no browser Supabase client. The header's signed-in state is a small `AccountControl` client island that fetches a new `/api/me` route, so `SiteHeader`'s ~10 call sites need no changes.

**Tech Stack:** Next.js 16.3.1 (App Router, `proxy.ts`), React 19, `@supabase/supabase-js` 2.112.3, `@supabase/ssr` (new), `server-only`, Supabase Auth (GoTrue, email OTP, token_hash flow) + Postgres. Node 22.6+ tests with `--conditions=react-server`; the pure-Postgres gate (`scripts/gate/run.sh`, Docker).

**Spec:** `docs/superpowers/specs/2026-08-21-access-foundation-design.md` (B1 implements section 4.4 identity/auth and the account-creation part of 4.5). Phase B2 (the DB re-gate, tiered reads, public-passport split) is a separate plan.

## Global Constraints

- **Branch and PR for everything.** Work on branch `claude/access-foundation` in the worktree `.claude/worktrees/access-foundation`. Never commit to `main`.
- **Auth is server-side only; the publishable key stays server-only.** No browser Supabase client, ever. All server modules read `SUPABASE_PUBLISHABLE_KEY` (not `NEXT_PUBLIC_`). If any step reaches for `createBrowserClient` or a `NEXT_PUBLIC_` key, it is wrong.
- **B1 makes NO visibility change.** Every read still returns full data to everyone. Do not revoke any grant, re-gate any view, or change any read path. That is Phase B2.
- **Migrations are applied by hand via the Supabase MCP, never by CI.**
- **Do not relax the evidence verification gate in `ingest_capture()`.**
- **No em dashes in anything a visitor reads.** Active voice, sentence case, interface voice.
- **`server-only` throws under `node --test`** unless `--conditions=react-server` is passed; every node-test command that imports a server-only module carries it. Keep pure helpers in dependency-free modules so their unit tests need neither the flag nor env.
- **Node 22.6+** (nvm Node 23) for `npm test` / `typecheck` / `build`.
- **Admin is allowlist-only, never self-serve.**

## Prerequisite (maintainer / ops, before the sign-in flow works end to end)

Sign-in cannot complete until Supabase Auth is configured on the project (ref `atevamimariwlpidgvog`), via the dashboard (there is no `[auth]` block in `supabase/config.toml`):

1. Enable the **Email** provider with magic link / OTP.
2. **Use the `token_hash` (stateless) flow so links open on any device.** Set the **Magic Link** email template's action URL to:
   `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email`
   (`{{ .RedirectTo }}` is the per-request `emailRedirectTo` the app sends, `${origin}/auth/confirm`.) Do NOT leave the default `{{ .ConfirmationURL }}` template: that is the PKCE code flow, which fails when the link is opened on a different device than it was requested from.
3. Add **Redirect URLs** allowlisting `${origin}/auth/confirm` for each origin: `https://settletop-ai-registry.vercel.app/auth/confirm` and `http://localhost:3000/auth/confirm`. Keep the allowlist narrow; avoid a broad `*.vercel.app` wildcard.
4. Ensure email delivery works (Supabase's built-in email is rate-limited; configure SMTP for real volume).

The DB, server, and UI work below can be built and gate-tested without this, but the end-to-end magic-link test (Task 4 Step 6), including the cross-device case, needs it live.

---

### Task 1: `@supabase/ssr` and the server-side auth client

**Files:** Modify `package.json`; Create `lib/auth.ts`, `lib/auth.test.ts`.

**Interfaces:** Produces `supabaseServer(): Promise<SupabaseClient>` (cookie-bound, server-only), `getSessionUser()`, `getSessionProfile(): Promise<{ id, email, role } | null>`.

- [ ] **Step 1: Add the dependency**

```bash
cd D:/Development/SettleTop/SettleTop-AI-Marketplace/.claude/worktrees/access-foundation
npm install @supabase/ssr
```

- [ ] **Step 2: Write the failing source-assertion test** (`lib/auth.test.ts`; reads source as a string, no import/env/flag)

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("auth module is server-only, uses createServerClient with getAll/setAll and the server-only key", () => {
  const src = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
  assert.match(src, /^import "server-only";/m);
  assert.match(src, /createServerClient/);
  assert.match(src, /getAll\(\)/);
  assert.match(src, /setAll\(/);
  assert.match(src, /process\.env\.SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(src, /createBrowserClient/, "no browser Supabase client: the key stays server-only");
});
```

- [ ] **Step 3: Run it to verify it fails** — `node --experimental-strip-types --test lib/auth.test.ts` (FAIL: no file).

- [ ] **Step 4: Write `lib/auth.ts`**

```ts
import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Per-request, cookie-bound Supabase client for auth. Server-only: the
 * publishable key never reaches the browser. In an RSC render `setAll` cannot
 * write cookies (Next forbids it), so it is wrapped in try/catch; proxy.ts is
 * what refreshes the session cookie. In a Server Action or Route Handler
 * `setAll` works and persists the session.
 */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return store.getAll();
        },
        setAll(list) {
          try {
            for (const { name, value, options } of list) store.set(name, value, options);
          } catch {
            // RSC render: proxy.ts handles the refresh instead.
          }
        },
      },
    }
  );
}

export async function getSessionUser() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** The current user's profile (id, email, role), or null if signed out. */
export async function getSessionProfile() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("profile").select("role").eq("id", user.id).maybeSingle();
  return {
    id: user.id,
    email: user.email ?? null,
    role: ((data as { role?: string } | null)?.role ?? "signed_in") as "signed_in" | "admin",
  };
}
```

- [ ] **Step 5: Run the test + typecheck** — `node --experimental-strip-types --test lib/auth.test.ts` (PASS); `npm run typecheck` (clean).

- [ ] **Step 6: Commit** — `git add package.json package-lock.json lib/auth.ts lib/auth.test.ts` then `git commit -m "feat: add @supabase/ssr and the server-side auth client"`.

---

### Task 2: `proxy.ts` session refresh

**Files:** Create `proxy.ts` (repo root). No automatable test (middleware); verified by build + the site still rendering.

- [ ] **Step 1: Write `proxy.ts`** (Next 16 renamed `middleware` to `proxy`; Node runtime)

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(list) {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    }
  );
  // Refresh the session; do not run code between createServerClient and getUser.
  await supabase.auth.getUser();
  return response;
}

// Exclude static assets, API routes (they read the session themselves), the
// auth routes, and metadata files, so the proxy's getUser round-trip runs only
// where a page render needs a fresh session cookie.
export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|auth/|favicon.ico|brand/|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|svg|ico|woff2?)$).*)",
  ],
};
```

- [ ] **Step 2: Build and confirm the site still renders** — `npm run build` (SUCCESS, `proxy.ts` compiled, no `middleware.ts`). Start the dev server and confirm home + `/registry` still render with no session cookie (getUser returns null, request passes through).

- [ ] **Step 3: Commit** — `git add proxy.ts` then `git commit -m "feat: proxy.ts session refresh (Next 16)"`.

---

### Task 3: profile, role, admin allowlist, and the new-user trigger (migration + gate)

**Files:** Create `supabase/migrations/20260821160000_identity.sql`, `scripts/gate/00-auth-stub.sql`, `scripts/gate/13-identity.sql`; Modify `scripts/gate/run.sh`.

- [ ] **Step 1: Write the migration**

```sql
-- Identity model (Access Foundation Phase B1). No visibility change: this only
-- CREATES new objects; no existing grant, view, or read path is touched. Admin
-- is allowlist-only, never self-serve.

create table if not exists admin_allowlist (email text primary key);
alter table admin_allowlist enable row level security;
-- No policy and no grant: unreadable by anon/authenticated. Only the definer
-- trigger and service_role touch it.
comment on table admin_allowlist is
  'Emails granted admin at profile creation. Seeded here; edited only by service_role. Never self-serve.';

insert into admin_allowlist (email) values ('niles@settletop.com') on conflict do nothing;

create table if not exists profile (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'signed_in' check (role in ('signed_in','admin')),
  created_at timestamptz not null default now()
);
alter table profile enable row level security;

-- Definer helper so an admin-check inside a profile policy does not recurse
-- through profile's own RLS.
create or replace function is_admin() returns boolean
language sql security definer set search_path = pg_catalog, public stable as $$
  select exists (select 1 from public.profile where id = auth.uid() and role = 'admin');
$$;
comment on function is_admin() is
  'True if the current auth.uid() has profile.role = admin. SECURITY DEFINER so it can sit inside profile RLS without recursion.';

-- SELECT only: a user reads their own row, an admin reads all. No INSERT/UPDATE
-- grant or policy to anon/authenticated, so role is not self-escalatable and
-- rows are created only by the trigger; roles change only via service_role.
create policy profile_read on profile for select to authenticated
  using (auth.uid() = id or is_admin());
grant select on profile to authenticated;

-- New auth user -> profile row, admin iff the email is allowlisted (case-insensitive).
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $fn$
begin
  insert into public.profile (id, role)
  values (
    new.id,
    case when exists (
      select 1 from public.admin_allowlist a where lower(a.email) = lower(new.email)
    ) then 'admin' else 'signed_in' end
  )
  on conflict (id) do nothing;
  return new;
end
$fn$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

revoke all on function is_admin() from public;
grant execute on function is_admin() to authenticated, service_role;
revoke all on function handle_new_user() from public;
```

- [ ] **Step 2: Add the gate auth-schema stub** (`scripts/gate/00-auth-stub.sql`) — the pure-Postgres gate has no Supabase `auth` schema.

```sql
-- Minimal Supabase auth shim for the gate: enough for the identity migration's
-- FK and trigger, and for auth.uid() to be simulated via request.jwt.claims.
create schema if not exists auth;
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid;
$$;
```

- [ ] **Step 3: Write the gate check** (`scripts/gate/13-identity.sql`). Every role-switched read captures into a variable, `reset role`, THEN inserts into `gate.result` as `postgres` (the `gate` schema is deliberately not granted to `authenticated`, so inserting while switched raises 42501 and aborts the gate). Match the `gate.result` column list of the sibling files. Reset claims to `'{}'` (a valid empty JSON), never `''`.

```sql
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
```

- [ ] **Step 4: Wire into `scripts/gate/run.sh`.** Read the file first to confirm the current numbering (Phase A left `say "15. Rate limiter..."` then `say "16. Verdict"`). Apply the stub right after `01-roles.sql` (around line 92): add `psql_file -q -1 < "$HERE/00-auth-stub.sql"`. Insert the identity step as **16** (contiguous) and renumber Verdict to **17**:

```bash
say "16. Identity: trigger + profile RLS + no self-escalation"
psql_file -q < "$HERE/13-identity.sql"

say "17. Verdict"
```

- [ ] **Step 5: Run the gate** — `bash scripts/gate/run.sh` → `GATE PASS`, with rows `16a`..`16e` all PASS.

- [ ] **Step 6: Commit** — `git add supabase/migrations/20260821160000_identity.sql scripts/gate/00-auth-stub.sql scripts/gate/13-identity.sql scripts/gate/run.sh` then `git commit -m "feat: identity model (profile, admin allowlist, trigger) + gate"`.

- [ ] **Step 7: Apply to production (manual, maintainer)** — apply `20260821160000_identity.sql` via the Supabase MCP `apply_migration` (LF bytes). The real `auth.users` / `auth.uid()` exist in prod; the stub is gate-only.

---

### Task 4: Sign-in page, server action, token_hash confirm route, and sign-out

**Files:** Create `app/signin/page.tsx`, `app/signin/actions.ts`, `app/auth/confirm/route.ts`.

- [ ] **Step 1: The sign-in + sign-out server actions** (`app/signin/actions.ts`)

```ts
"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/auth";
import { clientIp } from "@/lib/client-ip";
import { accountRequestAllowed } from "@/lib/account-limit";

/** Absolute site origin for the email link. Prefer the request Origin; fall
    back to the Host header, then a configured SITE_URL. Fail closed. */
async function siteOrigin(): Promise<string | null> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const host = h.get("host");
  if (host) return `https://${host}`;
  return process.env.SITE_URL ?? null;
}

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) redirect("/signin?error=email");

  const ip = clientIp(await headers());
  if (!(await accountRequestAllowed(ip, email))) redirect("/signin?error=limited");

  const origin = await siteOrigin();
  if (!origin) redirect("/signin?error=send");

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/confirm` },
  });
  if (error) redirect("/signin?error=send");
  redirect("/signin?sent=1");
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/");
}
```

- [ ] **Step 2: The sign-in page** (`app/signin/page.tsx`) — server component; copy has no em dashes.

```tsx
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { signIn } from "./actions";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;
  return (
    <>
      <SiteHeader />
      <main className="st-shell" style={{ padding: "4rem 0", maxWidth: 460 }}>
        <h1>Sign in</h1>
        {sent ? (
          <p>Check your email for a sign-in link.</p>
        ) : (
          <form action={signIn}>
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required autoComplete="email" />
            <button className="st-btn st-btn--primary" type="submit">Email me a sign-in link</button>
            {error === "email" && <p>Enter a valid email address.</p>}
            {error === "limited" && <p>We cannot create the account right now. Try again later.</p>}
            {error === "send" && <p>That did not send. Request a new link.</p>}
          </form>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
```

- [ ] **Step 3: The confirm route** (`app/auth/confirm/route.ts`) — the stateless token_hash flow (`verifyOtp`), so a link opened on any device works.

```ts
import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token_hash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  if (token_hash && type) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return NextResponse.redirect(new URL("/", url.origin));
  }
  return NextResponse.redirect(new URL("/signin?error=link", url.origin));
}
```

- [ ] **Step 4: Build + typecheck** — `npm run build && npm run typecheck` (SUCCESS; `/signin` and `/auth/confirm` compile). Sign-out is a server action (Next's CSRF protection applies); it is consumed by `AccountControl` in Task 6.

- [ ] **Step 5: Commit** — `git add app/signin app/auth` then `git commit -m "feat: server-side magic-link sign-in (token_hash), confirm route, sign-out action"`.

- [ ] **Step 6: Manual end-to-end verification (after the Supabase Auth prerequisite is live).** With email OTP + the token_hash template + allowlisted redirect URLs, load `/signin`, submit your email, and open the link. Test BOTH same-device and **cross-device** (request on desktop, open the link on your phone): both must land signed in. Confirm `/api/me` (Task 6) returns your email + `admin`. This step is manual; there is no automatable substitute without a live provider and a real inbox. Record the outcome.

---

### Task 5: Account-creation limiter

**Files:** Create `lib/disposable-domains.ts`, `lib/disposable-domains.test.ts`, `lib/account-limit.ts`.

- [ ] **Step 1: Failing test for the disposable-domain check** (`lib/disposable-domains.test.ts`)

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDisposableDomain } from "./disposable-domains.ts";

test("isDisposableDomain flags known throwaway domains, allows real ones", () => {
  assert.equal(isDisposableDomain("a@mailinator.com"), true);
  assert.equal(isDisposableDomain("a@guerrillamail.com"), true);
  assert.equal(isDisposableDomain("niles@settletop.com"), false);
  assert.equal(isDisposableDomain("not-an-email"), false);
});
```

- [ ] **Step 2: Run it (fails)** — `node --experimental-strip-types --test lib/disposable-domains.test.ts`.

- [ ] **Step 3: Write `lib/disposable-domains.ts`** (no imports)

```ts
const DISPOSABLE = new Set<string>([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "trashmail.com", "yopmail.com", "getnada.com", "dispostable.com",
]);

export function isDisposableDomain(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return DISPOSABLE.has(email.slice(at + 1).trim().toLowerCase());
}
```

- [ ] **Step 4: Run it (passes).**

- [ ] **Step 5: Write `lib/account-limit.ts`** (server-only). Short-circuit per-IP FIRST so an already-limited IP cannot drain the shared global budget; the global ceiling is evaluated last, only for requests that passed per-IP. No per-email-domain bucket: magic-link sign-in and sign-up are the same call, so a per-domain bucket would throttle legitimate sign-ins for shared domains (gmail, an employer) and let an attacker lock out a whole domain. Disposable domains are blocked outright. Rates are computed for the intended per-day ceilings.

```ts
import "server-only";
import { supabase } from "./supabase.ts";
import { isDisposableDomain } from "./disposable-domains.ts";

// rate is tokens/second; N/day = N/86400. Burst is the instantaneous allowance.
const PER_DAY = (n: number) => n / 86400;

async function take(bucket: string, rate: number, burst: number): Promise<boolean> {
  const { data, error } = await supabase.rpc("rate_take", { p_bucket: bucket, p_rate: rate, p_burst: burst });
  if (error) {
    console.error("account-limit", error.message);
    return true; // fail open on a limiter outage; Supabase Auth's own OTP limits are the floor
  }
  return data === true;
}

/**
 * Gate a sign-in / sign-up OTP request. Blocks disposable domains, then applies
 * a per-IP cap (short-circuited first) and a global new-account ceiling last.
 */
export async function accountRequestAllowed(ip: string, email: string): Promise<boolean> {
  if (isDisposableDomain(email)) return false;
  if (!(await take(`signup:ip:${ip}`, PER_DAY(5), 5))) return false; // ~5/day/IP, burst 5
  return take("signup:global:all", PER_DAY(500), 200); // ~500/day global ceiling, burst 200
}
```

- [ ] **Step 6: Typecheck** — `npm run typecheck` (clean). The rate-limited paths are proven by the Phase A gate on `rate_take`; the disposable-domain logic is unit-tested above.

- [ ] **Step 7: Commit** — `git add lib/disposable-domains.ts lib/disposable-domains.test.ts lib/account-limit.ts` then `git commit -m "feat: account-creation limiter (disposable denylist + per-IP and global caps)"`.

---

### Task 6: `AccountControl` header island + `/api/me`

**Files:** Create `app/api/me/route.ts`, `components/AccountControl.tsx`; Modify `components/SiteHeader.tsx`, `app/design.css`.

- [ ] **Step 1: `/api/me`** (`app/api/me/route.ts`) — per-user, so `no-store`.

```ts
import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth";

export async function GET() {
  const profile = await getSessionProfile();
  return NextResponse.json(profile ? { email: profile.email, role: profile.role } : null, {
    headers: { "Cache-Control": "no-store" },
  });
}
```

- [ ] **Step 2: `AccountControl`** (`components/AccountControl.tsx`, client island; reuse existing `st-btn` classes so it is styled without new CSS, plus one small class added in Step 4)

```tsx
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "@/app/signin/actions";

type Me = { email: string | null; role: "signed_in" | "admin" } | null;

export default function AccountControl() {
  const [me, setMe] = useState<Me>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let off = false;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !off && (setMe(d as Me), setLoaded(true)))
      .catch(() => !off && setLoaded(true));
    return () => {
      off = true;
    };
  }, []);
  if (!loaded) return null;
  if (!me) return <Link className="st-btn st-btn--secondary" href="/signin">Sign in</Link>;
  return (
    <form action={signOut} className="st-account">
      <span className="st-account__email">{me.email}</span>
      <button className="st-btn st-btn--secondary" type="submit">Sign out</button>
    </form>
  );
}
```

- [ ] **Step 3: Render it in `SiteHeader`** — add `<AccountControl />` inside the `st-header__actions` div in `components/SiteHeader.tsx` (after `ThemeToggle`). Import it at the top. `SiteHeader` stays otherwise unchanged; because `AccountControl` is a client island, no `SiteHeader` call site (the ~10 pages, `LandingApp`, `RegistryApp`) changes.

- [ ] **Step 4: Add minimal CSS** for the two new classes in `app/design.css`, near the existing `st-header__actions` block:

```css
.st-account { display: inline-flex; align-items: center; gap: 0.5rem; }
.st-account__email { font-size: 0.85rem; opacity: 0.8; max-width: 16ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 5: Build + preview** — `npm run build`, then start the dev server and confirm the header shows a styled "Sign in" when logged out and `/api/me` returns `null`. No em dashes in the control copy.

- [ ] **Step 6: Commit** — `git add app/api/me components/AccountControl.tsx components/SiteHeader.tsx app/design.css` then `git commit -m "feat: header account control + /api/me session endpoint"`.

---

## Notes for the executor

- **No visibility change in B1.** If any step would revoke a grant, change a view, or gate a read, stop, that belongs to Phase B2.
- **The magic-link end-to-end flow (Task 4 Step 6) cannot be automated** without the Supabase Auth prerequisite live and a real inbox, and it must be tested cross-device. The DB identity model (trigger + RLS + no-self-escalation + allowlist-unreadable) is fully proven by the gate; the account limiter's pure logic is unit-tested; everything else is build + typecheck + a manual preview.
- **`is_admin()` is `security definer`** specifically so the profile SELECT policy can call it without RLS recursion. Do not inline the `exists (select ... from profile ...)` into the policy.
- **Server-side auth only.** No `createBrowserClient`, no `NEXT_PUBLIC_` key path.
- **Gate numbering:** read `scripts/gate/run.sh` before editing to confirm the current highest `say` number (Phase A left Verdict = 16), and keep the inserted identity step (16) and the renumbered Verdict (17) contiguous. Role-switched gate assertions must capture into a variable and `reset role` BEFORE inserting into `gate.result` (the `authenticated` role has no privilege on the `gate` schema).
- **Account limiter fails open on a limiter outage** (deliberate; Supabase Auth's own OTP rate limits are the floor). The global bucket blocks when its budget is exhausted (a real ceiling). Watch for false positives once traffic is live and tune the rates.
