# Access Foundation, Phase A: Server Layer + Key Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the Supabase publishable key from the browser and route the one remaining browser read through a server route handler, add a Postgres-backed read rate limiter, and rotate the key, with no change to what any visitor can see.

**Architecture:** The app already does almost all reads server-side in RSC page components; only the home Quick-look modal reads Supabase from the browser. Phase A makes `lib/supabase.ts` a server-only module holding a server-only publishable key, moves that one browser read to `app/api/passport/[assetId]/route.ts`, and adds a token-bucket rate limiter (`rate_take` SECURITY DEFINER function + `rate_bucket` table) applied to the new route and a global anon backstop. No auth, no visibility gate, no view changes: those are Phase B.

**Tech Stack:** Next.js 16.3.1 (App Router), React 19, `@supabase/supabase-js` 2.112.3, Supabase Postgres/PostgREST, `node --test --experimental-strip-types` (Node 22.6+), Playwright, the pure-Postgres gate (`scripts/gate/run.sh`, Docker).

**Spec:** `docs/superpowers/specs/2026-08-21-access-foundation-design.md` (Phase A is section 5 "Phase A" plus the parts of 4.3 and 4.5 it names). Phase B (auth, the DB re-gate, the public-passport split, account-creation limiting) is a separate plan written after Phase A lands and the live-catalog check runs.

## Global Constraints

- **Branch and PR for everything.** Work on branch `claude/access-foundation` in the worktree `D:/Development/SettleTop/SettleTop-AI-Marketplace/.claude/worktrees/access-foundation`. Never commit to `main`.
- **Migrations are applied by hand, never by CI.** A merged PR ships app code via Vercel but never runs a migration. Applying the Phase A migration to production is a manual step (Task 3, and via the Supabase MCP), coordinated separately.
- **Do not relax the evidence verification gate in `ingest_capture()`.** Phase A touches read paths and one new limiter table only. The capture/write path and its evidence gate are untouched.
- **No em dashes in anything a visitor reads.** Restructure with colons, commas, or two sentences. Applies to every user-facing string (error copy, 429 body).
- **User-facing copy is active voice, sentence case, interface voice, no apology.**
- **Node 22.6+ for `npm test` / `npm run typecheck`.** The worktree default Node is too old for `--experimental-strip-types`; use a Node 23 toolchain (nvm).
- **End state: the browser bundle holds no Supabase credential.** Verified by build + grep (Task 5).
- **The gate must stay green.** `bash scripts/gate/run.sh` (Docker required) after any migration change.

---

### Task 1: Server-only Supabase module and env migration

Make `lib/supabase.ts` a server-only module reading a server-only key, so the publishable key can never be inlined into a client bundle. This task alone would break the build if a client component still imported the module; Task 2 removes that importer, so land Task 1 and Task 2 together conceptually but commit Task 1 first (the build is exercised at the end of Task 2).

**Files:**
- Modify: `lib/supabase.ts`
- Modify: `.env.example`
- Modify: `package.json` (add `server-only` dependency)
- Test: `lib/supabase.test.ts` (create)

**Interfaces:**
- Produces: `export const supabase` (unchanged name, now a server-only client built from `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`). `lib/registry.ts` keeps importing `{ supabase }` unchanged.

- [ ] **Step 1: Add the `server-only` dependency**

```bash
cd D:/Development/SettleTop/SettleTop-AI-Marketplace/.claude/worktrees/access-foundation
npm install server-only
```

Expected: `package.json` dependencies gains `"server-only"`. This package throws at build time if a Client Component imports a module that imports it, which is the guard we want.

- [ ] **Step 2: Write the failing test for the env-var names**

Create `lib/supabase.test.ts`. The module throws at import when its env vars are missing; the test asserts it now names the server-only vars (no `NEXT_PUBLIC_`), by reading the source.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("supabase module is server-only and uses non-public env vars", () => {
  const src = readFileSync(new URL("./supabase.ts", import.meta.url), "utf8");
  assert.match(src, /^import "server-only";/m, "must import server-only as the guard");
  assert.match(src, /process\.env\.SUPABASE_URL/, "reads SUPABASE_URL (server-only)");
  assert.match(src, /process\.env\.SUPABASE_PUBLISHABLE_KEY/, "reads SUPABASE_PUBLISHABLE_KEY (server-only)");
  assert.doesNotMatch(src, /NEXT_PUBLIC_SUPABASE/, "no NEXT_PUBLIC_ Supabase var may remain");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --experimental-strip-types --test lib/supabase.test.ts`
Expected: FAIL (source still uses `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, no `server-only` import).

- [ ] **Step 4: Rewrite `lib/supabase.ts` as server-only**

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Read-only client for the public registry, server-only.
 *
 * The publishable key is held on the server, never shipped to the browser:
 * `import "server-only"` makes a client-component import a build error. The
 * database has public SELECT policies and no write policies, so this key is
 * structurally incapable of changing the record. ingest_capture() and every
 * other write is granted to service_role only.
 */
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY. " +
      "Copy .env.example to .env.local, or set them in the Vercel project. " +
      "These are server-only now: do not prefix them with NEXT_PUBLIC_."
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
```

- [ ] **Step 5: Update `.env.example`**

Rename the two client vars to server-only names. Change the lines that read

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

to

```
# Server-only. Never prefix with NEXT_PUBLIC_: the browser holds no Supabase key.
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Leave `SUPABASE_SERVICE_ROLE_KEY` as it is. Update your local `.env.local` the same way so `npm run dev` and `test:parity` keep working.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --experimental-strip-types --test lib/supabase.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/supabase.ts lib/supabase.test.ts .env.example package.json package-lock.json
git commit -m "feat: make lib/supabase.ts server-only with a server-only key"
```

---

### Task 2: Passport route handler, and move the one browser read off the client

Add a single-asset passport reader and an API route that serves it, then change the home Quick-look modal to fetch that route instead of calling Supabase from the browser. After this task the client no longer imports `lib/supabase`, so the `server-only` guard from Task 1 holds and the build passes.

**Files:**
- Modify: `lib/registry.ts` (add `getPassportByAssetId`)
- Create: `app/api/passport/[assetId]/route.ts`
- Modify: `components/LandingApp.tsx` (replace the direct Supabase read with a fetch)
- Test: `lib/registry.passport-route.test.ts` (create), and a Playwright check

**Interfaces:**
- Consumes: `supabase` (Task 1), `ReadResult<T>` and `AssetPassport` (existing, `lib/registry.ts:176`, `lib/types.ts`).
- Produces: `export async function getPassportByAssetId(assetId: string): Promise<ReadResult<AssetPassport | null>>`; route `GET /api/passport/[assetId]` returning the passport JSON (200), `{ error }` with 400/404/500. Rate limiting is added in Task 4; this task wires the reader and the route without it.

- [ ] **Step 1: Write the failing test for `getPassportByAssetId`**

Create `lib/registry.passport-route.test.ts`. Assert the reader exists with the right shape by exercising it against the live DB, guarded by env like the parity test (`lib/registry-search.parity.test.ts` imports lazily because `lib/supabase.ts` throws without env).

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

const hasEnv = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_PUBLISHABLE_KEY;

test("getPassportByAssetId returns a ReadResult, null for an unknown id", { skip: !hasEnv }, async () => {
  const { getPassportByAssetId } = await import("./registry.ts");
  const r = await getPassportByAssetId("00000000-0000-0000-0000-000000000000");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --env-file-if-exists=.env.local --test lib/registry.passport-route.test.ts`
Expected: FAIL with "getPassportByAssetId is not a function" (or the test skips if env is absent; set `.env.local` so it runs).

- [ ] **Step 3: Add `getPassportByAssetId` to `lib/registry.ts`**

Insert after `getPassports` (around `lib/registry.ts:348`). It reads one passport by asset_id and keeps "could not read" distinct from "no such record", matching `getPassportBySlug`.

```ts
/**
 * One passport by asset_id, for the Quick-look modal's route handler. Keeps a
 * failed read (ok:false) distinct from a missing row (ok:true, data:null), so
 * the modal never renders "not found" during an outage.
 */
export async function getPassportByAssetId(
  assetId: string
): Promise<ReadResult<AssetPassport | null>> {
  const { data, error } = await supabase
    .from("v_asset_passport")
    .select("*")
    .eq("asset_id", assetId)
    .maybeSingle();
  if (error) {
    console.error("getPassportByAssetId", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, data: (data as AssetPassport) ?? null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --env-file-if-exists=.env.local --test lib/registry.passport-route.test.ts`
Expected: PASS (with env set).

- [ ] **Step 5: Create the route handler**

Create `app/api/passport/[assetId]/route.ts`. Validate the id as a uuid (the modal passes `asset_id`), and return the passport. Rate limiting is added in Task 4.

```ts
import { NextResponse } from "next/server";
import { getPassportByAssetId } from "@/lib/registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  if (!UUID.test(assetId)) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const r = await getPassportByAssetId(assetId);
  if (!r.ok) {
    return NextResponse.json(
      { error: "Something went wrong loading this passport. Try again." },
      { status: 500 }
    );
  }
  if (!r.data) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(r.data);
}
```

- [ ] **Step 6: Move the Quick-look modal off Supabase**

In `components/LandingApp.tsx`, remove line 6 `import { supabase } from "@/lib/supabase";` (nothing else in the file uses `supabase`). `AssetPassport` is already imported from `@/lib/types` (line 17), so no type-import change is needed. Replace the modal `useEffect` at lines 61-88 (it currently calls `supabase.from("v_asset_passport")...`) with this exact version, which preserves the `modal` / `passport` / `loadingPassport` state and the `!modal` reset:

```tsx
useEffect(() => {
  if (!modal) {
    setPassport(null);
    return;
  }
  let cancelled = false;
  setLoadingPassport(true);
  fetch(`/api/passport/${encodeURIComponent(modal.id)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (cancelled) return;
      setPassport((data as AssetPassport) ?? null);
      setLoadingPassport(false);
    })
    .catch(() => {
      if (cancelled) return;
      setPassport(null);
      setLoadingPassport(false);
    });
  return () => {
    cancelled = true;
  };
}, [modal]);
```

- [ ] **Step 7: Verify the build passes with no client Supabase import**

Run: `npm run build`
Expected: SUCCESS. If it fails with a `server-only` error, a Client Component still imports `lib/supabase` (directly or transitively); find it (`grep -rn "@/lib/supabase" components app`) and repoint it. The only expected importer now is `lib/registry.ts` (server) and the route handler (server).

- [ ] **Step 8: Playwright check the modal still loads a passport**

Add a Playwright test `tests/e2e/quick-look.spec.ts` that opens the home page, clicks the first "Quick look" button, and asserts the modal shows passport content fetched from `/api/passport/...` (assert a network response to `**/api/passport/**` returns 200). Run it against `npm run dev`.

```ts
import { test, expect } from "@playwright/test";

test("quick look loads a passport via the API route", async ({ page }) => {
  await page.goto("http://localhost:3000/");
  const resp = page.waitForResponse((r) => r.url().includes("/api/passport/") && r.status() === 200);
  await page.getByRole("button", { name: "Quick look" }).first().click();
  await resp;
});
```

- [ ] **Step 9: Commit**

```bash
git add lib/registry.ts app/api/passport/[assetId]/route.ts components/LandingApp.tsx lib/registry.passport-route.test.ts tests/e2e/quick-look.spec.ts
git commit -m "feat: serve the Quick-look passport from a route handler, off the browser"
```

---

### Task 3: Rate-limit storage (migration) and gate coverage

Add the token-bucket table and the `rate_take` function that the limiter (Task 4) calls. This is a migration, so it is proven in the pure-Postgres gate, not applied by CI.

**Files:**
- Create: `supabase/migrations/20260821140000_rate_limit.sql`
- Create: `scripts/gate/12-rate-limit.sql`
- Modify: `scripts/gate/run.sh` (add the step)

**Interfaces:**
- Produces: `rate_take(p_bucket text, p_rate double precision, p_burst double precision) returns boolean`, granted execute to `anon, authenticated, service_role`; table `rate_bucket`. Returns true when a token was taken (allowed), false when the bucket is empty (limited).

- [ ] **Step 1: Write the migration**

```sql
-- Token-bucket rate limiting for the server read layer (Access Foundation,
-- Phase A). One row per bucket key (e.g. 'passport:1.2.3.4'). rate_take refills
-- by elapsed time and takes one token, returning whether the caller is allowed.
-- SECURITY DEFINER so the table needs no public policy; granted to anon so the
-- server-only anon client can call it. The anon key is server-only now, so this
-- is not a public surface.

create table if not exists rate_bucket (
  bucket     text primary key,
  tokens     double precision not null,
  updated_at timestamptz not null default now()
);
alter table rate_bucket enable row level security;
-- No policy: only the definer function reaches this table.

create or replace function rate_take(
  p_bucket text, p_rate double precision, p_burst double precision
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_now    timestamptz := clock_timestamp();
  v_tokens double precision;
  v_last   timestamptz;
begin
  insert into rate_bucket (bucket, tokens, updated_at)
    values (p_bucket, p_burst, v_now)
    on conflict (bucket) do nothing;

  select tokens, updated_at into v_tokens, v_last
    from rate_bucket where bucket = p_bucket for update;

  v_tokens := least(p_burst, v_tokens + extract(epoch from (v_now - v_last)) * p_rate);

  if v_tokens < 1 then
    update rate_bucket set tokens = v_tokens, updated_at = v_now where bucket = p_bucket;
    return false;
  end if;

  update rate_bucket set tokens = v_tokens - 1, updated_at = v_now where bucket = p_bucket;
  return true;
end
$fn$;

comment on function rate_take(text, double precision, double precision) is
  'Token-bucket take: refill p_bucket by elapsed time at p_rate tokens/sec up to p_burst, take one token, return whether allowed. SECURITY DEFINER; the server-only anon client calls it.';

revoke all on function rate_take(text, double precision, double precision) from public;
grant execute on function rate_take(text, double precision, double precision) to anon, authenticated, service_role;
```

- [ ] **Step 2: Write the gate check `scripts/gate/12-rate-limit.sql`**

Records results into `gate.result` the way the other check files do (match their `insert into gate.result(...)` shape by reading `scripts/gate/04-reads.sql` first). Assert: a fresh bucket allows exactly `burst` takes then denies; with a tiny burst it denies immediately after exhaustion.

```sql
-- Rate limiter: a bucket of burst 3 allows 3 takes then denies the 4th.
-- rate 0 so no refill happens within the test.
do $$
declare
  v1 boolean; v2 boolean; v3 boolean; v4 boolean;
begin
  v1 := rate_take('gate:test', 0, 3);
  v2 := rate_take('gate:test', 0, 3);
  v3 := rate_take('gate:test', 0, 3);
  v4 := rate_take('gate:test', 0, 3);
  insert into gate.result(step, as_role, object, n_rows, verdict, note)
  values ('16a. rate_take allows burst then denies', 'postgres', 'rate_take', null,
    case when v1 and v2 and v3 and not v4 then 'PASS' else 'FAIL' end,
    format('takes: %s %s %s %s', v1, v2, v3, v4));
end $$;
```

(Confirm the exact `gate.result` column list and the `step` numbering convention against `scripts/gate/11-known-layers.sql` before writing; the harness numbers steps and the verdict function reads `gate.result`.)

- [ ] **Step 3: Add the step to `scripts/gate/run.sh`**

After the "Known layers" step (`scripts/gate/run.sh:165-166`), before "Verdict", add:

```bash
say "16. Rate limiter: a bucket allows its burst then denies"
psql_file -q < "$HERE/12-rate-limit.sql"
```

- [ ] **Step 4: Run the gate**

Run: `bash scripts/gate/run.sh`
Expected: `GATE PASS: no unexpected failures`. If Docker is not running, start it first.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260821140000_rate_limit.sql scripts/gate/12-rate-limit.sql scripts/gate/run.sh
git commit -m "feat: token-bucket rate_take function and gate coverage"
```

- [ ] **Step 6: Apply the migration to production (manual)**

Migrations are not applied by CI. Apply `20260821140000_rate_limit.sql` to the live database via the Supabase MCP `apply_migration`, using the exact LF bytes as committed. Confirm `rate_take` exists and is granted to `anon` with `list_migrations` / a catalog check. Record that it was applied.

---

### Task 4: Rate-limit helper, applied to the passport route and a global anon backstop

Add the TypeScript helper that calls `rate_take` with the caller's IP, and apply it in the route handler with a global backstop bucket. Fail-open: a limiter outage must never take the site down.

**Files:**
- Create: `lib/rate-limit.ts`
- Modify: `app/api/passport/[assetId]/route.ts`
- Test: `lib/rate-limit.test.ts` (create), and extend the Playwright route test

**Interfaces:**
- Consumes: `supabase` (Task 1), `rate_take` (Task 3).
- Produces: `export async function rateLimit(bucketPrefix: string, rate: number, burst: number, keyOverride?: string): Promise<boolean>` (true = allowed). `export function clientIp(h: Headers): string`.

- [ ] **Step 1: Write the failing test for `clientIp`**

`clientIp` is the pure, testable core (IP extraction from headers). The `rateLimit` DB path is covered by the gate (Task 3) and Playwright (Step 6).

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "./rate-limit.ts";

test("clientIp takes the first x-forwarded-for hop, falls back to a constant", () => {
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
  assert.equal(clientIp(new Headers({ "x-real-ip": "5.6.7.8" })), "5.6.7.8");
  assert.equal(clientIp(new Headers()), "unknown");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test lib/rate-limit.test.ts`
Expected: FAIL ("Cannot find module ./rate-limit.ts").

- [ ] **Step 3: Write `lib/rate-limit.ts`**

```ts
import "server-only";
import { supabase } from "./supabase.ts";

/** First x-forwarded-for hop is the client on Vercel; fall back to x-real-ip. */
export function clientIp(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return h.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Take one token from `${bucketPrefix}:${key}` (key defaults to the client IP).
 * Returns true when allowed. Fail-open: if the limiter RPC errors, allow, so a
 * limiter outage degrades to no limiting rather than a down site.
 */
export async function rateLimit(
  bucketPrefix: string,
  rate: number,
  burst: number,
  keyOverride?: string
): Promise<boolean> {
  const { headers } = await import("next/headers");
  const key = keyOverride ?? clientIp(await headers());
  const { data, error } = await supabase.rpc("rate_take", {
    p_bucket: `${bucketPrefix}:${key}`,
    p_rate: rate,
    p_burst: burst,
  });
  if (error) {
    console.error("rateLimit", error.message);
    return true;
  }
  return data === true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test lib/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply the limiter in the route handler**

Edit `app/api/passport/[assetId]/route.ts` to check a global anon backstop and a per-IP bucket before reading. Numbers: per IP, refill 0.5 tokens/sec (about 30 requests/minute) with burst 30; global, refill 50/sec with burst 200. Tune later.

```ts
import { NextResponse } from "next/server";
import { getPassportByAssetId } from "@/lib/registry";
import { rateLimit } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  if (!UUID.test(assetId)) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const okGlobal = await rateLimit("passport:global", 50, 200, "global");
  const okIp = await rateLimit("passport", 0.5, 30);
  if (!okGlobal || !okIp) {
    return NextResponse.json(
      { error: "You are moving quickly. Sign in for higher limits, or slow down and try again in a moment." },
      { status: 429 }
    );
  }
  const r = await getPassportByAssetId(assetId);
  if (!r.ok) {
    return NextResponse.json(
      { error: "Something went wrong loading this passport. Try again." },
      { status: 500 }
    );
  }
  if (!r.data) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(r.data);
}
```

- [ ] **Step 6: Playwright check that the route returns 429 past the burst**

Extend `tests/e2e/quick-look.spec.ts` (or add `tests/e2e/rate-limit.spec.ts`): request `/api/passport/<a-known-uuid>` more than the per-IP burst in a tight loop and assert at least one `429` with the exact copy. Use a valid asset_id read from the page or a known one from the DB. Run against `npm run dev`.

```ts
import { test, expect } from "@playwright/test";

test("passport route rate-limits past the burst", async ({ request }) => {
  const id = "00000000-0000-0000-0000-000000000000"; // any valid-format uuid; 404s still consume a token
  let saw429 = false;
  for (let i = 0; i < 40; i++) {
    const r = await request.get(`http://localhost:3000/api/passport/${id}`);
    if (r.status() === 429) { saw429 = true; break; }
  }
  expect(saw429).toBe(true);
});
```

Note: the limiter runs before the 404 check, so a non-existent id still exercises it.

- [ ] **Step 7: Commit**

```bash
git add lib/rate-limit.ts lib/rate-limit.test.ts app/api/passport/[assetId]/route.ts tests/e2e/rate-limit.spec.ts
git commit -m "feat: rate-limit the passport route by IP with a global anon backstop"
```

---

### Task 5: Prove the browser bundle holds no Supabase key

A build-and-grep check that fails if the publishable key or a Supabase URL is inlined into any client chunk. This is the anti-extraction acceptance test for Phase A.

**Files:**
- Create: `scripts/check-no-key-in-bundle.mjs`
- Modify: `package.json` (add a `check:bundle` script)

**Interfaces:**
- Produces: `npm run check:bundle`, exit non-zero if a key/URL string appears in `.next/static`.

- [ ] **Step 1: Write the checker**

```js
// Fails if the Supabase publishable key or URL is inlined into any client
// chunk. Run after `next build`. The key is server-only now (Access
// Foundation Phase A); if it appears in .next/static, a client component is
// importing it and the retirement regressed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
if (!KEY) {
  console.error("Set SUPABASE_PUBLISHABLE_KEY (or source .env.local) before running.");
  process.exit(2);
}
const NEEDLES = [KEY, "sb_publishable_", ".supabase.co"];
const ROOT = ".next/static";

function* files(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.js$/.test(p)) yield p;
  }
}

let hits = 0;
for (const f of files(ROOT)) {
  const src = readFileSync(f, "utf8");
  for (const n of NEEDLES) {
    if (src.includes(n)) {
      console.error(`LEAK: "${n}" found in ${f}`);
      hits++;
    }
  }
}
if (hits) {
  console.error(`\nFAIL: ${hits} client-bundle leak(s). A client component is importing lib/supabase.`);
  process.exit(1);
}
console.log("OK: no Supabase key or URL in .next/static client chunks.");
```

- [ ] **Step 2: Add the script to `package.json`**

Add to `scripts`: `"check:bundle": "node scripts/check-no-key-in-bundle.mjs"`.

- [ ] **Step 3: Build and run the checker to verify it passes**

```bash
npm run build && node --env-file-if-exists=.env.local scripts/check-no-key-in-bundle.mjs
```

Expected: `OK: no Supabase key or URL in .next/static client chunks.` If it fails, a client component still imports `lib/supabase`; fix it (Task 2, Step 7) and rebuild.

- [ ] **Step 4: Prove the check can fail (sanity)**

Temporarily add `import { supabase } from "@/lib/supabase";` and a trivial use to a client component, `npm run build`, run the checker, confirm it reports a LEAK and exits non-zero, then revert the temporary edit and rebuild clean. Do not commit the temporary edit.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-no-key-in-bundle.mjs package.json
git commit -m "feat: fail the build check if a Supabase key leaks into a client bundle"
```

---

### Task 6: Key rotation runbook (manual, at deploy)

Rotate the publishable key so the old one, already in git history and shipped bundles, stops working. This is a production ops step done by the maintainer at deploy time, not by a subagent, and it must be sequenced after the code that reads the server-only key is deployed.

**Files:**
- Create: `docs/runbooks/rotate-publishable-key.md`

- [ ] **Step 1: Write the runbook**

Document the exact order so no window ships a client pointed at a dead key:

1. Merge and deploy Phase A (server-only client, route handler, limiter) with the **current** key still valid, set as the server-only `SUPABASE_PUBLISHABLE_KEY` in Vercel (and remove the old `NEXT_PUBLIC_SUPABASE_*` vars from the Vercel project).
2. Confirm the deployed site reads correctly with the server-only key and `npm run check:bundle` passed in CI/build.
3. In the Supabase dashboard, issue a new publishable key and set it as `SUPABASE_PUBLISHABLE_KEY` in Vercel; redeploy.
4. Confirm the site still reads. Then revoke the old publishable key in Supabase.
5. Verify the old key is dead: a direct PostgREST call with the old key returns 401.

Include the note that the URL and keys must never be re-added with a `NEXT_PUBLIC_` prefix.

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/rotate-publishable-key.md
git commit -m "docs: publishable key rotation runbook"
```

- [ ] **Step 3: Execute the rotation** (maintainer, at deploy; not part of automated execution). Leave this step unchecked until the rotation is actually performed in production.

---

## Notes for the executor

- Phase A does **not** gate visibility: every read still returns full data to everyone, by design. Do not add auth, do not change any view, do not revoke any grant here. That is Phase B.
- The only client-boundary change is the Quick-look modal (Task 2). If the build's `server-only` guard trips elsewhere, a client component is importing `lib/supabase` transitively; repoint it, do not weaken the guard.
- Rate-limit numbers in Task 4 are starting values; they are tunable and not load-bearing for correctness.
- Keep `test:parity` green throughout: it reads the live DB via the same client and must be unaffected by Phase A.
- **Deliberate deviation from the spec's Phase A list:** `@supabase/ssr` is *not* added in Phase A. It exists to build the per-request cookie-session client, which only appears in Phase B (there is no session in Phase A). Adding it now would be an unused dependency. Phase A adds only `server-only`. This is a YAGNI call, not an omission.
