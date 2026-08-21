# Access Foundation, Phase A: Server Layer + Key Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the Supabase publishable *key* from the browser and route the one remaining browser read through a server route handler, add a Postgres-backed read rate limiter (per-IP on the passport route, plus a global anon backstop on the card/search path), and rotate the key, with no change to what any visitor can see.

**Architecture:** The app already does almost all reads server-side in RSC page components; only the home Quick-look modal reads Supabase from the browser. Phase A makes `lib/supabase.ts` a server-only module holding a server-only publishable key, moves that one browser read to `app/api/passport/[assetId]/route.ts`, and adds a token-bucket rate limiter (`rate_take` SECURITY DEFINER function + `rate_bucket` table) applied to the passport route (per IP) and to `searchRegistry` (a global anon budget over the card/search surface). No auth, no visibility gate, no view changes: those are Phase B.

**Tech Stack:** Next.js 16.3.1 (App Router), React 19, `@supabase/supabase-js` 2.112.3, `server-only`, Supabase Postgres/PostgREST, `node --conditions=react-server --experimental-strip-types --test` (Node 22.6+), the pure-Postgres gate (`scripts/gate/run.sh`, Docker).

**Spec:** `docs/superpowers/specs/2026-08-21-access-foundation-design.md` (Phase A is section 5 "Phase A" plus the parts of 4.3 and 4.5 it names). Phase B (auth, the DB re-gate, the public-passport split, account-creation limiting) is a separate plan written after Phase A lands and the live-catalog check runs.

## Global Constraints

- **Branch and PR for everything.** Work on branch `claude/access-foundation` in the worktree `D:/Development/SettleTop/SettleTop-AI-Marketplace/.claude/worktrees/access-foundation`. Never commit to `main`.
- **Migrations are applied by hand, never by CI.** A merged PR ships app code via Vercel but never runs a migration. Applying the Phase A migration to production is a manual step via the Supabase MCP (Task 3), coordinated separately.
- **`server-only` throws under `node --test`.** The `server-only` package resolves to a throwing `index.js` unless the `react-server` export condition is set, which the Next bundler sets but plain Node does not. Therefore **every `node --test` command in this plan, and the `test` and `test:parity` npm scripts, must pass `--conditions=react-server`** so `server-only` resolves to its no-op. Keep pure, dependency-free helpers (like `clientIp`) in their own module so their unit tests need neither the flag nor env.
- **Do not relax the evidence verification gate in `ingest_capture()`.** Phase A touches read paths and one new limiter table only. The capture/write path and its evidence gate are untouched.
- **No em dashes in anything a visitor reads.** Applies to every user-facing string (error copy, 429 body).
- **User-facing copy is active voice, sentence case, interface voice, no apology.**
- **Node 22.6+ for `npm test` / `npm run typecheck`.** Use a Node 23 toolchain (nvm).
- **End state: the browser bundle holds no Supabase key.** Verified by build + grep (Task 6).
- **The gate must stay green.** `bash scripts/gate/run.sh` (Docker required) after any migration change.

## Deployment sequencing (read before merging Phase A)

`lib/supabase.ts` throws at import if its env vars are missing, and every RSC read imports it, so a deploy with the code but not the env would 500 the whole site. Sequence, as a hard order:

1. In the Vercel project (all environments), **add `SUPABASE_PUBLISHABLE_KEY`** set to the current publishable key value. Keep `NEXT_PUBLIC_SUPABASE_URL` as is. Do this **before** merging the Phase A PR.
2. Merge and deploy the Phase A code (it reads `SUPABASE_PUBLISHABLE_KEY`). Confirm the site reads.
3. Apply the rate-limit migration (Task 3) to production via the Supabase MCP.
4. Rotate the key (Task 7 runbook): issue a new publishable key, update `SUPABASE_PUBLISHABLE_KEY` in Vercel, redeploy, confirm, then revoke the old key. Only now remove the old `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from Vercel.

---

### Task 1: Server-only Supabase module, key-only env rename, and test wiring

Make `lib/supabase.ts` server-only reading a server-only *key*, keeping the non-secret URL as `NEXT_PUBLIC_SUPABASE_URL` (the ingest scripts also read it). Wire the node test runner to tolerate `server-only`, and update the parity test's credential guard so it keeps running (not silently skipping) after the rename.

**Files:**
- Modify: `lib/supabase.ts`
- Modify: `.env.example`
- Modify: `package.json` (add `server-only`; add `--conditions=react-server` to `test` and `test:parity`)
- Modify: `lib/registry-search.parity.test.ts` (credential guard, lines 30-33)
- Test: `lib/supabase.test.ts` (create)

**Interfaces:**
- Produces: `export const supabase` (unchanged name, now server-only, built from `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`). `lib/registry.ts` keeps importing `{ supabase }` unchanged.

- [ ] **Step 1: Add `server-only` and wire the test conditions**

```bash
cd D:/Development/SettleTop/SettleTop-AI-Marketplace/.claude/worktrees/access-foundation
npm install server-only
```

Then in `package.json`, add `--conditions=react-server` to both node test scripts:

```json
"test": "node --conditions=react-server --experimental-strip-types --test lib/*.test.ts scripts/**/*.test.mjs",
"test:parity": "node --conditions=react-server --experimental-strip-types --env-file-if-exists=.env.local --test lib/registry-search.parity.test.ts",
```

- [ ] **Step 2: Write the failing source-assertion test**

Create `lib/supabase.test.ts`. It reads the source as a string (no import), so it needs no env and no react-server condition.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("supabase module is server-only and the key is not NEXT_PUBLIC_", () => {
  const src = readFileSync(new URL("./supabase.ts", import.meta.url), "utf8");
  assert.match(src, /^import "server-only";/m, "must import server-only as the guard");
  assert.match(src, /process\.env\.SUPABASE_PUBLISHABLE_KEY/, "reads the server-only key");
  assert.doesNotMatch(src, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/, "the key must no longer be NEXT_PUBLIC_");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --experimental-strip-types --test lib/supabase.test.ts`
Expected: FAIL (source still uses `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, no `server-only` import).

- [ ] **Step 4: Rewrite `lib/supabase.ts` as server-only**

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Read-only client for the public registry, server-only.
 *
 * The publishable key is held on the server, never shipped to the browser:
 * `import "server-only"` makes a client-component import a build error. The URL
 * is not a secret and stays NEXT_PUBLIC_ (the ingest scripts read it too); it is
 * not inlined into any client bundle because no client module imports this file.
 * The database has public SELECT policies and no write policies, so this key is
 * structurally incapable of changing the record. Every write is service_role.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY. " +
      "Copy .env.example to .env.local, or set them in the Vercel project. " +
      "SUPABASE_PUBLISHABLE_KEY is server-only: never prefix it with NEXT_PUBLIC_."
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
```

- [ ] **Step 5: Update `.env.example`**

Keep the URL line as `NEXT_PUBLIC_SUPABASE_URL=...`. Change the key line from `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...` to:

```
# Server-only. Never prefix with NEXT_PUBLIC_: the browser holds no Supabase key.
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Update your local `.env.local` the same way (rename only the key). Leave `SUPABASE_SERVICE_ROLE_KEY` untouched. The ingest scripts (`scripts/ingest.mjs`, `scripts/archive-logos.mjs`, `scripts/verify-asset-layer.mjs`, `scripts/lib/marketplace.mjs`) read `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` and are unaffected by the key rename.

- [ ] **Step 6: Update the parity test credential guard**

In `lib/registry-search.parity.test.ts`, change the guard at lines 30-33 to read the renamed key (keep the URL name):

```ts
const haveDb = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_PUBLISHABLE_KEY
);
```

- [ ] **Step 7: Run the source test, the full suite, and parity to verify green**

```bash
node --experimental-strip-types --test lib/supabase.test.ts
npm test
npm run test:parity
```

Expected: `lib/supabase.test.ts` PASS; `npm test` PASS with no file crashing on `server-only` (the `--conditions=react-server` flag makes it resolve to a no-op); `test:parity` **runs** (prints the parity test as passing, not "skipped") because `.env.local` now carries `SUPABASE_PUBLISHABLE_KEY`. If `npm test` reports a `server-only` throw, the `--conditions=react-server` flag is missing from the script.

- [ ] **Step 8: Commit**

```bash
git add lib/supabase.ts lib/supabase.test.ts .env.example package.json package-lock.json lib/registry-search.parity.test.ts
git commit -m "feat: make lib/supabase.ts server-only with a server-only key"
```

---

### Task 2: Passport route handler, and move the one browser read off the client

Add a single-asset passport reader and an API route that serves it, then change the home Quick-look modal to fetch that route instead of calling Supabase from the browser. After this task the client no longer imports `lib/supabase`, so the `server-only` guard from Task 1 holds and the build passes.

**Files:**
- Modify: `lib/registry.ts` (add `getPassportByAssetId`)
- Create: `app/api/passport/[assetId]/route.ts`
- Modify: `components/LandingApp.tsx` (replace the direct Supabase read with a fetch)
- Test: `lib/registry.passport-route.test.ts` (create)

**Interfaces:**
- Consumes: `supabase` (Task 1), `ReadResult<T>` and `AssetPassport` (`lib/registry.ts:176`, `lib/types.ts`).
- Produces: `export async function getPassportByAssetId(assetId: string): Promise<ReadResult<AssetPassport | null>>`; route `GET /api/passport/[assetId]` returning the passport JSON (200) or `{ error }` (400/404/500). Rate limiting is added in Task 4.

- [ ] **Step 1: Write the failing test for `getPassportByAssetId`**

Create `lib/registry.passport-route.test.ts`. It imports `registry.ts` (which imports the server-only `supabase`), so it needs `--conditions=react-server` and env; it lazy-imports and skips without credentials, matching the parity test.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

const hasEnv = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_PUBLISHABLE_KEY;

test("getPassportByAssetId returns a ReadResult, null for an unknown id", { skip: hasEnv ? false : "no Supabase credentials" }, async () => {
  const { getPassportByAssetId } = await import("./registry.ts");
  const r = await getPassportByAssetId("00000000-0000-0000-0000-000000000000");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --conditions=react-server --experimental-strip-types --env-file-if-exists=.env.local --test lib/registry.passport-route.test.ts`
Expected: FAIL with "getPassportByAssetId is not a function" (with `.env.local` present so it runs rather than skips).

- [ ] **Step 3: Add `getPassportByAssetId` to `lib/registry.ts`**

Insert after `getPassports` (after `lib/registry.ts:348`):

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

Run: `node --conditions=react-server --experimental-strip-types --env-file-if-exists=.env.local --test lib/registry.passport-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the route handler**

Create `app/api/passport/[assetId]/route.ts` (rate limiting added in Task 4):

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
Expected: SUCCESS. If it fails with a `server-only` error, a Client Component still imports `lib/supabase` (directly or transitively); find it (`grep -rn "@/lib/supabase" components app`) and repoint it. The only expected importers now are `lib/registry.ts` (server) and the route handler (server).

- [ ] **Step 8: Verify the modal in the browser preview**

Start the dev server and open the preview (do not use Playwright; there is no e2e harness in this repo, and adding one is out of scope for Phase A). Open the home page, click the first "Quick look" button, and confirm the modal loads a passport. Confirm in the network panel that the request goes to `/api/passport/<uuid>` and returns 200. This is a manual verification step, recorded in the task report.

- [ ] **Step 9: Commit**

```bash
git add lib/registry.ts app/api/passport/[assetId]/route.ts components/LandingApp.tsx lib/registry.passport-route.test.ts
git commit -m "feat: serve the Quick-look passport from a route handler, off the browser"
```

---

### Task 3: Rate-limit storage (migration) and gate coverage

Add the token-bucket table and the `rate_take` function that the limiter (Task 4, Task 5) calls. This is a migration, proven in the pure-Postgres gate, not applied by CI.

**Files:**
- Create: `supabase/migrations/20260821140000_rate_limit.sql`
- Create: `scripts/gate/12-rate-limit.sql`
- Modify: `scripts/gate/run.sh` (add the step, renumber Verdict)

**Interfaces:**
- Produces: `rate_take(p_bucket text, p_rate double precision, p_burst double precision) returns boolean`, granted execute to `anon, authenticated, service_role`; table `rate_bucket`. Returns true when a token was taken (allowed), false when the bucket is empty (limited).

- [ ] **Step 1: Write the migration**

```sql
-- Token-bucket rate limiting for the server read layer (Access Foundation,
-- Phase A). One row per bucket key (e.g. 'passport:1.2.3.4', 'global:reads:all').
-- rate_take refills by elapsed time and takes one token, returning whether the
-- caller is allowed. SECURITY DEFINER so the table needs no public policy;
-- granted to anon so the server-only anon client can call it. The anon key is
-- server-only now, so this is not a public surface.

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

First read `scripts/gate/04-reads.sql` and `scripts/gate/11-known-layers.sql` to confirm the exact `gate.result` column list and the `step`-label style. The column list is `(step, as_role, object, n_rows, verdict, note)`. Use step label `15a.` (the new say step is 15, see Step 3).

```sql
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
```

- [ ] **Step 3: Add the step to `scripts/gate/run.sh` and renumber Verdict**

The current last steps are `say "14. Known layers..."` (`scripts/gate/run.sh:165`) and `say "15. Verdict"` (`scripts/gate/run.sh:168`). Insert the new step as 15 and renumber Verdict to 16:

```bash
say "15. Rate limiter: a bucket allows its burst then denies"
psql_file -q < "$HERE/12-rate-limit.sql"

say "16. Verdict"
```

(Change the existing `say "15. Verdict"` line to `say "16. Verdict"`.) The verdict function keys on the `verdict` column, not the say label, so numbering is cosmetic; keep it monotonic.

- [ ] **Step 4: Run the gate**

Run: `bash scripts/gate/run.sh`
Expected: `GATE PASS: no unexpected failures`. If Docker is not running, start it first.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260821140000_rate_limit.sql scripts/gate/12-rate-limit.sql scripts/gate/run.sh
git commit -m "feat: token-bucket rate_take function and gate coverage"
```

- [ ] **Step 6: Apply the migration to production (manual, maintainer)**

Not applied by CI. Apply `20260821140000_rate_limit.sql` to the live database via the Supabase MCP `apply_migration`, using the exact LF bytes as committed. Confirm `rate_take` exists and is granted to `anon` via a catalog check. Until this is done, the limiter fails open (Task 4) and no 429 is produced: that is expected and safe (no regression), but the 429 behavior in the spec's Definition of Done is only met once this migration is live.

---

### Task 4: Client-IP helper, rate-limit helper, and the passport route limiter

Add a dependency-free `clientIp` (its own module, so its unit test needs neither `server-only` nor env), the `rateLimit` helper that calls `rate_take`, and apply a per-IP limit on the passport route. Fail-open: a limiter outage must never take the site down.

**Files:**
- Create: `lib/client-ip.ts`
- Create: `lib/rate-limit.ts`
- Modify: `app/api/passport/[assetId]/route.ts`
- Test: `lib/client-ip.test.ts` (create)

**Interfaces:**
- Consumes: `supabase` (Task 1), `rate_take` (Task 3).
- Produces: `export function clientIp(h: Headers): string` (in `lib/client-ip.ts`); `export async function rateLimit(bucketPrefix: string, rate: number, burst: number, keyOverride?: string): Promise<boolean>` and `export async function globalReadTake(): Promise<boolean>` (in `lib/rate-limit.ts`; true = allowed).

- [ ] **Step 1: Write the failing test for `clientIp`**

Create `lib/client-ip.test.ts`. `lib/client-ip.ts` imports nothing, so this needs no flag and no env.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "./client-ip.ts";

test("clientIp takes the first x-forwarded-for hop, falls back to a constant", () => {
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
  assert.equal(clientIp(new Headers({ "x-real-ip": "5.6.7.8" })), "5.6.7.8");
  assert.equal(clientIp(new Headers()), "unknown");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test lib/client-ip.test.ts`
Expected: FAIL ("Cannot find module ./client-ip.ts").

- [ ] **Step 3: Write `lib/client-ip.ts`**

```ts
/** First x-forwarded-for hop is the client on Vercel; fall back to x-real-ip. */
export function clientIp(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return h.get("x-real-ip")?.trim() || "unknown";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test lib/client-ip.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `lib/rate-limit.ts`**

```ts
import "server-only";
import { supabase } from "./supabase.ts";
import { clientIp } from "./client-ip.ts";

/**
 * Take one token from `${bucketPrefix}:${key}` (key defaults to the client IP).
 * Returns true when allowed. Fail-open: if the limiter RPC errors (for example
 * before the migration is applied), allow, so a limiter outage degrades to no
 * limiting rather than a down site.
 */
export async function rateLimit(
  bucketPrefix: string,
  rate: number,
  burst: number,
  keyOverride?: string
): Promise<boolean> {
  let key = keyOverride;
  if (key === undefined) {
    const { headers } = await import("next/headers");
    key = clientIp(await headers());
  }
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

/**
 * A single global budget over all anon dynamic reads (the card/search surface
 * and the passport route). IP-independent, so it backstops a proxy pool that
 * rotates IPs to defeat the per-IP limit. Coarse by design. Fixed key, so it
 * never reads request headers.
 */
export async function globalReadTake(): Promise<boolean> {
  return rateLimit("global:reads", 40, 400, "all");
}
```

- [ ] **Step 6: Apply the limiter in the route handler**

Edit `app/api/passport/[assetId]/route.ts` to check the global backstop and a per-IP bucket before reading. Per IP: refill 0.5 tokens/sec (about 30/minute), burst 30. Tunable.

```ts
import { NextResponse } from "next/server";
import { getPassportByAssetId } from "@/lib/registry";
import { rateLimit, globalReadTake } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  if (!UUID.test(assetId)) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const okGlobal = await globalReadTake();
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

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (The automated proof that the limiter denies past the burst is the gate check on `rate_take` from Task 3. The live 429 on the route is verified after the migration is applied, see Task 3 Step 6 and the notes below.)

- [ ] **Step 8: Commit**

```bash
git add lib/client-ip.ts lib/client-ip.test.ts lib/rate-limit.ts app/api/passport/[assetId]/route.ts
git commit -m "feat: rate-limit the passport route by IP with a global anon backstop"
```

---

### Task 5: Global anon backstop on the card/search surface

`searchRegistry` (the `/registry` grid, search, and facets) is the real card bulk-extraction path, and it is dynamic per URL so it is not saved by ISR. Wire the global budget into it, and render a slow-down notice on `/registry` when the budget is spent. This delivers the spec's "global anon backstop across all anon traffic" on the surface that matters.

**Files:**
- Modify: `lib/registry.ts` (`ReadResult` false variant gains `rateLimited?`; `searchRegistry` checks `globalReadTake`)
- Modify: `app/registry/page.tsx` (render the notice on `rateLimited`)

**Interfaces:**
- Consumes: `globalReadTake` (Task 4).
- Produces: `ReadResult<T> = { ok: true; data: T } | { ok: false; error: string; rateLimited?: boolean }`.

- [ ] **Step 1: Extend `ReadResult` and gate `searchRegistry`**

In `lib/registry.ts`, change the `ReadResult` definition (`lib/registry.ts:176`) to add the optional flag:

```ts
export type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; rateLimited?: boolean };
```

Then, at the very top of `searchRegistry` (before it reads `c.perPage`), add the backstop. Import `globalReadTake` at the top of the file (`import { globalReadTake } from "./rate-limit.ts";`).

```ts
export async function searchRegistry(c: Criteria): Promise<ReadResult<RegistryPage>> {
  if (!(await globalReadTake())) {
    return {
      ok: false,
      rateLimited: true,
      error: "You are moving quickly. Sign in for higher limits, or slow down and try again in a moment.",
    };
  }
  // ... existing body unchanged ...
```

Note: `globalReadTake` uses a fixed key and never reads request headers, so `searchRegistry` stays callable from the parity test (plain node, no request context). Before the migration is applied, `rate_take` errors and `globalReadTake` fails open (returns true), so `searchRegistry` behaves exactly as today.

- [ ] **Step 2: Render the notice on `/registry`**

In `app/registry/page.tsx`, after `const [result, stats] = await Promise.all([...])` (line 55-58) and before the `logos` read, add:

```tsx
if (!result.ok && result.rateLimited) {
  return (
    <main className="container" style={{ padding: "4rem 0" }}>
      <h1>Slow down for a moment</h1>
      <p>
        The registry is handling a lot of requests right now. Sign in for higher
        limits, or try again in a moment.
      </p>
    </main>
  );
}
```

(Match the page's existing container/class conventions; the copy carries no em dash.)

- [ ] **Step 3: Typecheck and confirm no parity regression**

```bash
npm run typecheck
npm run test:parity
```

Expected: typecheck PASS; parity **runs and passes** (fail-open means `searchRegistry` is unaffected pre-migration; post-migration the global burst of 400 is far above the parity test's call count).

- [ ] **Step 4: Manual preview check of the notice (optional, recorded)**

To see the notice render, temporarily change `globalReadTake` to `rateLimit("global:reads", 0, 1, "all")` (burst 1, no refill), load `/registry` twice, confirm the second load shows the slow-down notice, then revert the change. Only meaningful once the migration is applied to the DB the dev server uses. Do not commit the temporary change.

- [ ] **Step 5: Commit**

```bash
git add lib/registry.ts app/registry/page.tsx
git commit -m "feat: global anon read budget on the card/search surface"
```

---

### Task 6: Prove the browser bundle holds no Supabase key

A build-and-grep check that fails if the publishable key is inlined into any client chunk. This is the anti-extraction acceptance test for Phase A.

**Files:**
- Create: `scripts/check-no-key-in-bundle.mjs`
- Modify: `package.json` (add a `check:bundle` script)

**Interfaces:**
- Produces: `npm run check:bundle`, exit non-zero if the key appears in `.next/static`.

- [ ] **Step 1: Write the checker**

Grep for the key only. The URL stays `NEXT_PUBLIC_SUPABASE_URL` intentionally and is not inlined into client chunks (no client module imports it), so it is not a needle.

```js
// Fails if the Supabase publishable key is inlined into any client chunk.
// Run after `next build`. The key is server-only now (Access Foundation
// Phase A); if it appears in .next/static, a client component is importing it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const NEEDLES = ["sb_publishable_"];
if (KEY) NEEDLES.push(KEY);
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
console.log("OK: no Supabase publishable key in .next/static client chunks.");
```

- [ ] **Step 2: Add the script to `package.json`**

Add to `scripts`: `"check:bundle": "node scripts/check-no-key-in-bundle.mjs"`.

- [ ] **Step 3: Build and run the checker to verify it passes**

```bash
npm run build && node --env-file-if-exists=.env.local scripts/check-no-key-in-bundle.mjs
```

Expected: `OK: no Supabase publishable key in .next/static client chunks.`

- [ ] **Step 4: Prove the check can fail (sanity)**

Temporarily add `import { supabase } from "@/lib/supabase";` and a trivial use to a client component, `npm run build`, run the checker, confirm it reports a LEAK and exits non-zero, then revert and rebuild clean. Do not commit the temporary edit.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-no-key-in-bundle.mjs package.json
git commit -m "feat: fail the build check if a Supabase key leaks into a client bundle"
```

---

### Task 7: Key rotation runbook (manual, at deploy)

Rotate the publishable key so the old one, already in git history and shipped bundles, stops working. This is a production ops step done by the maintainer, sequenced after the code that reads the server-only key is deployed (see "Deployment sequencing" at the top).

**Files:**
- Create: `docs/runbooks/rotate-publishable-key.md`

- [ ] **Step 1: Write the runbook**

Document the order (mirroring the Deployment sequencing section):

1. Set `SUPABASE_PUBLISHABLE_KEY` (current key value) in the Vercel project, all environments, before merging Phase A. Keep `NEXT_PUBLIC_SUPABASE_URL`.
2. Merge and deploy Phase A. Confirm the site reads and `npm run check:bundle` passed at build.
3. Apply the rate-limit migration (Task 3 Step 6).
4. Issue a new publishable key in the Supabase dashboard; set it as `SUPABASE_PUBLISHABLE_KEY` in Vercel; redeploy; confirm the site still reads.
5. Revoke the old publishable key in Supabase. Verify a direct PostgREST call with the old key returns 401.
6. Remove the now-unused `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from the Vercel project.

Include the rule: never re-add the key with a `NEXT_PUBLIC_` prefix.

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/rotate-publishable-key.md
git commit -m "docs: publishable key rotation runbook"
```

- [ ] **Step 3: Execute the rotation** (maintainer, at deploy; not part of automated execution). Leave unchecked until performed in production.

---

## Notes for the executor

- Phase A does **not** gate visibility: every read still returns full data to everyone, by design. Do not add auth, do not change any view, do not revoke any grant here. That is Phase B.
- **`server-only` + node tests:** every `node --test` command that transitively imports `lib/supabase.ts` or `lib/rate-limit.ts` must pass `--conditions=react-server`, and the `test` / `test:parity` scripts carry it. Tests that import only dependency-free modules (`lib/client-ip.ts`, the `lib/supabase.ts` source-string test) do not need it. `next build` and `tsc --noEmit` handle `server-only` natively and need no flag.
- **The 429 Definition of Done requires the migration live.** The limiter fails open until `rate_take` exists in the DB the server talks to. The gate (Task 3) proves the mechanism denies past the burst; the live 429 on the route and the `/registry` notice are verified after Task 3 Step 6 applies the migration. Do not claim the live 429 works before then.
- **No Playwright.** This repo has the `playwright` driver as a devDependency but no `@playwright/test` runner, no config, and no e2e suite. Phase A verifies the modal and the notice via the dev-server preview (manual, recorded), not via a new e2e harness. Adding one is out of scope.
- **Deliberate deviation from the spec's Phase A list:** `@supabase/ssr` is *not* added in Phase A. It exists to build the per-request cookie-session client, which only appears in Phase B (there is no session in Phase A). Adding it now would be an unused dependency. Phase A adds only `server-only`.
- Keep `test:parity` green **and running** (not skipped): Task 1 updates its credential guard to the renamed key so it keeps exercising the live DB.
