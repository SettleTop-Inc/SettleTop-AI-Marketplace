# Access Foundation: Design Spec

**Date:** 2026-08-21
**Status:** Draft for review (revised: adversarial critique, then public-passport split)
**Sub-project:** 1 of 6 in the Accounts & Access initiative
**Depends on:** nothing (this is the foundation everything else builds on)

---

## 1. Where this sits

The Accounts & Access initiative has six layers, weighed equally up front, with
these priorities:

- **P1:** (1) accounts / identity, (2) roles + gated visibility
  (anonymous < signed-in < admin), (3) admin actions (merge in the UI first),
  (4) personalization, (5) behavioural analytics.
- **P2:** (6) monetization.

Build order: **1 -> 2 -> 3 -> (4 and 5) -> 6.** Layers 1 and 2 are merged into
this one foundation spec because you cannot gate visibility without an identity
to gate against, and you cannot retire the browser's database key without the
server read layer that the gate also needs. They are one subsystem.

**This spec covers the foundation only.** Explicitly out of scope, each its own
later spec:

- Admin operations UI (operating merges from the UI) -> sub-project 3.
- Personalization (save / track / compare-history / preferences) -> sub-project 4.
- Behavioural analytics, including sophisticated extraction / abuse detection
  -> sub-project 5.
- Monetization (tiers, paid services) -> sub-project 6.

The foundation establishes identity, the server read layer, the anon / signed-in
/ admin gate, the admin role flag, and a minimal set of rate and account-creation
limits. It does **not** build any admin screen, any personalization, any
analytics capture, or any billing.

---

## 2. The four decisions this spec implements

Settled in brainstorming, binding on the design:

1. **Gate provenance depth behind sign-in, with a useful public passport.**
   Anonymous visitors see cards, search, and a reduced public passport: the
   vendor's own published facts (identity, description, pricing and plans, which
   marketplaces it is on and the links out) plus our top-line verdict
   (provenance status, evidence tier, risk, and the ledger count). SettleTop's
   provenance analysis is the sign-in benefit: the evidence records, the
   per-layer tracing, the risk basis, cross-marketplace linkage detail, and the
   permissions and compliance breakdown. The gate is inline within the passport
   (each deep section invites sign-in), not a full-page wall, so the anon page
   stays genuinely useful and shareable. This still changes the PR #30 "nobody
   takes our word" promise: the proof depth becomes a sign-in benefit. The
   landing copy will be revised to match in a later pass; that copy change is
   noted here, not built here.
   The organizing line: the vendor's own facts are public (they are scrapable
   from the source marketplaces anyway, so gating them buys nothing); SettleTop's
   analysis is gated (it is the unique, monetizable asset worth protecting).

2. **Cards server-side too.** All reads move behind a Next.js server layer, and
   the anon Supabase key is retired from the browser. Anon still sees cards, but
   through the server, rate-limited.

   *Realistic reach of this claim, corrected after critique:* the server layer
   plus rate limits genuinely gate **passport depth** behind auth and make it
   costly to reach. They **raise the cost** of card-level bulk extraction but do
   not make it impossible: a determined botnet with a proxy pool can still
   paginate the ~5,000 public cards, because cards are the top-line tier and are
   accepted as expensively-public. We do not claim to "block" card vacuuming;
   we claim to raise its cost and to protect depth. Section 4.5 adds an
   IP-independent global anon budget as a backstop lever.

3. **Passwordless sign-in (email magic link + Google/GitHub/LinkedIn OAuth);
   admin by allowlist.** Sign-in is Supabase GoTrue: an email magic link (no
   password handling) plus social OAuth for Google, GitHub, and LinkedIn, to keep
   sign-up low-friction. All of it runs server-side, so no Supabase key returns
   to the browser. The admin role is granted only by a server-side allowlist,
   keyed on the email each method returns; there is never a self-serve path to
   admin.

4. **Open self-serve sign-up, rate-limited.** Anyone can create an account with
   a verified email and unlock passport depth. Per-account read limits, minimal
   account-creation limits, and the recorded signal for later abuse detection
   are the extraction defense; the gate alone is not, because sign-up is open.

---

## 3. Current state (grounded against the code)

Read from the main repo at HEAD `77f9170` (merge of PR #78). An independent
grounding pass confirmed every claim in this section against the code; the file
references let the implementer re-verify.

### 3.1 One Supabase client, anon key in the browser

- `lib/supabase.ts` creates a single client with `createClient` from
  `@supabase/supabase-js`, using `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, with
  `auth: { persistSession: false, autoRefreshToken: false }`. It throws at
  import time if either env var is missing (`lib/supabase.ts:11-19`).
- Because the key is `NEXT_PUBLIC_*`, Next.js inlines it into the browser
  bundle: any `"use client"` component importing `lib/supabase` carries it, and
  `LandingApp.tsx` (in the home route) is such a component. The key value itself
  is `.env.example:7`
  (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...`). To reproduce the
  inlining, run a production build and grep the emitted client chunks for the
  key; do not rely on a specific hashed chunk path.
- The key is Supabase's **new opaque publishable-key format** (`sb_publishable_`
  prefix), which can be individually issued and revoked without touching the
  GoTrue JWT signing key. That is what makes "rotate the publishable key" and
  "hold it server-only" both real operations (see 4.3).
- No `@supabase/ssr`, no `createBrowserClient` / `createServerClient`, no
  service-role usage in the app runtime. Service role appears only in
  `scripts/*.mjs` ingest tooling. Installed: `@supabase/supabase-js` 2.112.3
  (declared `^2.45.0`). `@supabase/ssr` is **not** installed.

### 3.2 Read paths

- Every registry read is a function in `lib/registry.ts`, importing the one
  `supabase` client. Documented there: "Every read the site performs. Server
  components call these directly."
- Almost all reads run **server-side in RSC page components** that pass results
  as props to client components:
  - `app/page.tsx` (home): `getFacetCounts` (rpc `registry_search` with
    `p_limit:0`), `getTopAgents` (`v_registry_card`), `getStats`
    (`v_registry_stats`), `getFeatured` (`v_asset_passport`), `getLogos`
    (`v_logo_status`).
  - `app/registry/page.tsx`: `searchRegistry` (rpc `registry_search`),
    `getStats`, `getLogos`. `RegistryApp` is a client component whose controls
    only rewrite the URL; it imports no Supabase client.
  - `app/registry/compare/page.tsx`: `getPassports` (`v_asset_passport`).
  - `app/agent/[id]/page.tsx`: `getPassportBySlug` (`asset_slug` then
    `v_asset_passport`), `getLogos`. `PassportView` is pure presentational.
- **Exactly one browser read exists:** `components/LandingApp.tsx` (`"use
  client"`) calls `supabase.from("v_asset_passport").select("*").eq("asset_id",
  modal.id).maybeSingle()` in a `useEffect` when the home Quick-look modal opens
  (`LandingApp.tsx:68-84`). This is the only read that does not cross an RSC
  boundary.
- Reader functions that exist but are not yet wired to any page:
  `getListingPassports` (`v_listing_passport`), `getAssetEvidence`
  (`v_asset_evidence`), `getMergeCandidates` (`v_merge_candidates`),
  `getRecentChanges` (`v_asset_change_feed`).
- Both server-rendered passport pages fail today by **throwing**, which routes to
  the generic error boundary: `app/agent/[id]/page.tsx:70`
  `throw new Error("registry read failed: ...")`, and
  `app/registry/compare/page.tsx:87-90` renders "The registry could not be
  loaded / This is a fault on our side" when `!result.ok`. This matters for the
  gate (4.3): an anon permission-denial must not fall through to these
  fault paths.
- There is **no** `app/api` directory, no route handlers, no `middleware.ts` /
  `proxy.ts`, no server actions. All server-layer plumbing is greenfield.

### 3.3 Database visibility (the crux)

- Eight registry views, **all `security_invoker = true`** (RLS runs as the
  caller), enforced by tripwire `DO` blocks that raise if a view's reloptions
  lack `security_invoker=true`.
- **Card and passport data are already in separate views:** `v_registry_card`
  (~36 columns, deliberately no `overview_text`) vs `v_asset_passport` (full
  passport: `overview_text`, `evidence` jsonb, `plans`, `product_links`,
  `legal_links`, `media`, `graph_permissions`, `compliance`, `listings` jsonb).
- **No tier separation today.** Every view is granted `select ... to anon,
  authenticated` identically. Every base table has RLS with a blanket
  `for select to anon, authenticated using (true)` policy, plus a blanket
  `grant select on all tables in schema public to anon, authenticated`
  (`20260816162955_registry_core.sql:214-226`).
- Consequences of the blanket grant, all confirmed against the code:
  - Anon can read full passports, `v_listing_passport`, `v_asset_evidence`, and
    `v_merge_candidates` (the cross-marketplace linkage / merge-review queue).
  - **Anon can read the raw capture bytes directly.** `capture.raw` is a jsonb
    column on the `capture` table (`registry_core.sql:52`), under the blanket
    grant + `using(true)` policy. `v_asset_evidence` deliberately exposes only
    `has_raw`, but its own comment records the live hole: "raw ... is already
    publicly readable on capture for anyone who wants it"
    (`20260820100000_asset_keyed_views.sql:586`). The same grant gives the
    identical direct access to the `authenticated` role.
- `v_logo_status` is one of the eight views: `security_invoker = true`, granted
  to anon, and it reads base tables (`listing`, `capture_extract`,
  `capture_link`) as the caller
  (`20260819100400_asset_layer_views.sql:223-252`). A note in
  `20260818140000_service_role_read_logo_status.sql:11-13` states plainly that a
  grant on this view alone is not enough because "the caller's own rights are
  what the underlying scan is checked against." **Any revoke of anon's base-table
  grant breaks anon logo reads unless `v_logo_status` is also converted.**
- Writes are the only existing privilege boundary: all `security definer` RPCs
  (`ingest_capture`, `merge_assets`, `unmerge_asset`, `set_capture_logo`,
  `record_link_archive`, `ingest_publisher_document`) are revoked from public /
  anon / authenticated and granted to `service_role` only. There is **no admin
  Postgres role**, and Supabase's JWT maps a signed-in user to the built-in
  `authenticated` role, not a per-app role.
- `registry_search` is `security invoker`, `stable`, `search_path`-pinned,
  granted `execute to anon, authenticated`
  (`20260820160000_registry_search_source_id_or_name.sql:74-91,367`). Its body
  pages with `rn <= greatest(p_offset,0) + greatest(p_limit,0)` and **caps
  nothing** (`:243-247`); only the server caller bounds `per` to <= 96
  (`lib/registry.ts:270`).
- `publisher_document` is the one table anon cannot read (RLS on, no policy, no
  grant).
- **Grants survive `create or replace` but not `drop`.** Tripwire `DO` blocks
  after each view replacement assert anon + authenticated still hold SELECT
  (`20260821120000_known_layers_primary.sql:337-347`,
  `20260820100000_asset_keyed_views.sql:632-648`,
  `20260820190000_merge_candidates.sql:215-227`). **These blocks run at their own
  position in filename order.** A later-timestamped re-gate migration runs after
  all of them, so they are not retroactively triggered and must not be edited
  (see 4.2).

### 3.4 Auth and tooling

- The app is **fully anonymous**. No GoTrue sign-in, no session, no cookies, no
  middleware, no user / profile / role table. The `authenticated` role in RLS
  policies is the built-in Supabase role; nothing in the codebase produces a JWT
  today.
- The env contract already separates a browser anon key from a server-only
  `SUPABASE_SERVICE_ROLE_KEY` ("Server only. Never prefix with NEXT_PUBLIC_"),
  used only by ingest scripts.
- Next.js 16.3.1, App Router only, React 19.
- Test tooling (`package.json`): `test` (`node --experimental-strip-types --test
  lib/*.test.ts scripts/**/*.test.mjs`), `test:parity`
  (`lib/registry-search.parity.test.ts`), `typecheck` (`tsc --noEmit`), `gate`
  (`bash scripts/gate/run.sh`). `--experimental-strip-types` needs Node 22.6+
  (use a Node 23 toolchain). `playwright` is a devDependency, so e2e is possible.
- The gate (`scripts/gate/run.sh`) is a pure-Postgres harness: a throwaway
  `postgres:17-alpine` container, no network, no Supabase credential. It stubs
  the `anon` / `authenticated` / `service_role` roles (not native to bare
  Postgres), applies every migration in filename order (split at the rename
  threshold `20260819100000`), seeds through the old write path, then runs
  numbered check files (`01-roles.sql` ... `11-known-layers.sql`) that assert
  reads as `anon` / `service_role`, with deliberate-breakage negative tests
  proving the assertions can fail. Its verdict counts non-PASS rows in
  `gate.result` excluding designed-failure steps. It is the right harness for the
  new tier grants, **with the auth-schema additions noted in 4.2**, because
  `auth.users` and `auth.uid()` are Supabase-provided and are not in bare
  Postgres either.

---

## 4. Target architecture

```
Browser (no Supabase credential)
   |
   |  fetch / RSC render
   v
Next.js server layer  ── session (magic-link cookie, @supabase/ssr)
   |                          |
   |  picks credential by session:
   |    logged-out -> server-held anon key (anon role)
   |    signed-in  -> user JWT           (authenticated role)
   |    writes/ops -> service_role       (later specs)
   |
   |  + rate limiter (IP for anon, user id for signed-in, admin exempt)
   |  + account-creation limiter
   v
Supabase Postgres
   All anon + authenticated reads go through SECURITY DEFINER surfaces.
   Direct base-table SELECT is revoked from anon AND authenticated.
   anon role          -> card-tier definer surfaces only
   authenticated      -> card-tier + passport-tier definer surfaces
   admin (app-level)  -> + ops surfaces, enforced in the definer body via
                          profile.role AND re-checked in the server layer
   capture.raw        -> readable by service_role only, no read surface exposes it
```

Two enforcement layers, defense in depth:

1. **Database.** Direct base-table SELECT is revoked from anon and authenticated.
   Each tier reads only through definer surfaces that project that tier's
   columns. The anon key can reach only card data; a signed-in JWT can reach
   passport depth but never `capture.raw` and never the admin ops surface; only
   `service_role` touches base tables directly.
2. **Server layer.** Chooses the credential by session, shapes responses,
   serves the public projection and the inline depth gate for anon passport
   requests, re-checks `profile.role` before exposing any admin surface, and
   enforces rate and account-creation limits.

### 4.1 What each tier sees

The organizing line: **the vendor's own published facts plus our top-line
verdict are public; SettleTop's provenance analysis is gated behind sign-in.**

| Surface (read function) | Anon | Signed-in | Admin |
|---|---|---|---|
| Registry grid, search, facets (`registry_search`) | yes | yes | yes |
| Top-line stats (`v_registry_stats`) | yes | yes | yes |
| Registry cards (`v_registry_card` / `getTopAgents`) | yes | yes | yes |
| Logo status (`v_logo_status` / `getLogos`) | yes | yes | yes |
| Public passport (`v_asset_passport_public`, new): identity, description (`overview_text`), pricing and plans, where-to-get-it (marketplaces + links), plus the top-line verdict (status, tier, risk, ledger count) | yes | yes | yes |
| Provenance depth (full `v_asset_passport`): evidence records, per-layer tracing (`known_layers` detail), risk basis, permissions and compliance detail | no (inline gate) | yes | yes |
| Per-listing passport (`v_listing_passport`) | no | yes | yes |
| Raw-evidence metadata (`v_asset_evidence`: content_hash, method, has_raw) | no | yes | yes |
| Recent changes (`v_asset_change_feed` / `getRecentChanges`) | no | yes | yes |
| Cross-marketplace linkage detail on a merged passport | no | yes | yes |
| Merge-candidate queue (`v_merge_candidates` / `getMergeCandidates`) | no | no | yes |
| Raw capture bytes (`capture.raw`) | no | no | no (service_role only) |
| Operations (merge / unmerge) | no | no | later spec |

Notes. The anon *public passport* renders as a real page (good for sharing and
SEO); the deep sections show an inline sign-in prompt, not a full-page wall.
`capture.raw` is unreadable by every browser tier including admin: the admin
merge UI (sub-project 3) acts through `service_role` RPCs, not by reading raw
bytes. Linkage distinction: the *detail* that two listings are the same product,
shown on a merged passport, is signed-in depth; the *merge-candidate queue* of
unconfirmed suspects is admin-only. Borderline fields (detailed permissions and
compliance) are classified as gated depth, because they are part of the
provenance detail the passport exists to surface; the vendor's headline
certification stays visible through the public evidence tier. The plan finalizes
the field-by-field projection.

### 4.2 Database re-gate (the core change)

**Problem.** Today anon *and* authenticated read everything, because of the
blanket base-table grant plus `using(true)` policies, and because the read
surfaces are `security_invoker` (they read base tables as the caller). Revoking
anon alone is insufficient on two counts: anon could still reach base columns
through any invoker view, and `authenticated` would keep the identical direct
path to `capture.raw` and every passport base column, which, with open sign-up,
is one free account away from world-readable.

**Approach: make every anon/authenticated read a `security definer` surface, and
revoke direct base-table SELECT from both roles.**

- Convert the read surfaces to `security definer`, owned by a role that holds
  base access, each projecting only its tier's columns:
  - **Public tier** (granted `anon, authenticated`): `registry_search`,
    `v_registry_card`, `v_registry_stats`, `v_logo_status`, and a new
    `v_asset_passport_public` projecting the public passport fields (identity,
    `overview_text`, pricing and plans, the listings' marketplace names and
    source URLs, and the top-line verdict). It carries none of the evidence
    jsonb, per-layer detail, risk basis, permissions, or compliance detail, so
    depth cannot leak through the public surface. `registry_search` also gains an
    internal `p_limit` cap (below).
  - **Passport-depth tier** (granted `authenticated` only): `v_asset_passport`
    (full), `v_listing_passport`, `v_asset_evidence` (projects `has_raw`, never
    `raw`), `v_asset_change_feed`.
  - **Admin tier** (granted `authenticated`, admin-checked in the body):
    `v_merge_candidates` gets a trailing `where exists (select 1 from profile
    where profile.id = auth.uid() and role = 'admin')`, so a signed-in non-admin
    receives zero rows. This is **not** an RLS policy on the view (Postgres RLS
    attaches to tables, not views); the predicate lives in the definer view
    body. The server layer re-checks `profile.role` before exposing it.
- **Revoke the blanket base-table SELECT from anon and authenticated**, and the
  passport-view grants from anon. After this, neither role can select base
  columns directly; `capture.raw` is reachable only by `service_role`. Add a
  narrow, explicit revoke of SELECT on `capture` from anon and authenticated so
  the raw column is provably out of reach even if a future object re-exposes the
  table.
- **Cap `registry_search`.** Before or as part of the definer conversion, bound
  the page inside the function: `least(greatest(p_limit,0), 100)` (or the chosen
  cap). As a definer function it must not be turnable into a whole-corpus dump by
  a large `p_limit`; the server caller's 96-cap is not sufficient because the
  function is granted directly.

**Alternative considered and rejected: per-column grants to keep
`security_invoker`.** Rejected because `capture.raw` and the passport columns
sit on the same base tables as card columns, the passport assembly (merge,
evidence, listings jsonb) already lives in the views, and per-column grants
across ~15 tables plus jsonb assembly are fragile and scattered. Definer
surfaces put the projection boundary in one auditable place per tier.

**Tripwires: do not touch the historical ones.** The existing
`security_invoker`-and-grants tripwires run at their own position in filename
order, before any later re-gate migration, so they pass unchanged and must not
be edited (editing applied history also violates the immutable-migration norm).
Put the new-contract assertions in **new** `DO` blocks inside the re-gate
migration and in new gate check files (6). New assertions: anon denied on
passport views, base tables, and `capture.raw`; authenticated denied on
`capture.raw` and base tables; anon allowed on the card surface; authenticated
allowed on the passport surface; `v_merge_candidates` returns rows only for an
admin `auth.uid()`.

**Gate needs an `auth` shim.** The pure-Postgres container has no Supabase `auth`
schema, but the `profile` table references `auth.users(id)` and the admin
predicate calls `auth.uid()`. The gate must provide a minimal stub: an `auth`
schema with a minimal `auth.users` table and an `auth.uid()` that reads
`current_setting('request.jwt.claims', true)`, plus a `profile` seed, so the
numbered checks can `set local request.jwt.claims` to simulate admin vs
non-admin callers. Specify this shim alongside the new check files.

**Verify live state before writing the migration.** Prod grants and policies
have drifted from the migration history before (for example `v_logo_status` was
`security definer` on prod; `publisher_document` grants were applied by hand).
The implementer must first run a read-only catalog check against the live
database (`pg_policies`, `information_schema.role_table_grants`,
`pg_class.reloptions`) using the Supabase MCP tools, reconcile the actual current
grants with the migration history, and write the re-gate migration against
reality. Do not assume the migrations describe the deployed state.

**Do not relax the evidence verification gate in `ingest_capture()`.** This spec
touches read privileges only. The write path and its evidence gate are untouched.

### 4.3 Server read layer, key retirement, and the gated pages

- Add `@supabase/ssr` and the `server-only` package.
- `lib/supabase.ts` becomes **server-only** with `import "server-only"` at the
  top (requires the `server-only` package) so it can never be bundled into
  browser code. It no longer reads a `NEXT_PUBLIC_*` key. It exposes:
  - a server anon client from a server-only anon key, for logged-out card reads;
  - a per-request client bound to the user's cookie session (`createServerClient`
    from `@supabase/ssr`), for signed-in reads. The cookie adapter **must** use
    the `getAll` / `setAll` methods (never the deprecated `get` / `set` /
    `remove`), and `cookies()` must be awaited (Next 16 async Request APIs).
  - `service_role` is used only for writes / admin operations in later specs,
    never for reads.
- **`lib/registry.ts` reads become session-aware.** Each read function resolves
  the request session and uses the anon client or the session client. For a
  passport, an anon session reads `v_asset_passport_public` (the public
  projection) and a signed-in session reads `v_asset_passport` (full). A
  full-depth read is never attempted for anon, and **no privileged credential is
  ever used to satisfy an anon read**. A genuine failure still returns the
  existing `{ ok: false, error }` shape and must never surface the raw PostgREST
  message.
- **Rotate the publishable key.** The current key is in git history and shipped
  bundles, so relocating it is not enough: rotate it in Supabase so the old key
  stops authorizing PostgREST. The new anon key is server-only (no
  `NEXT_PUBLIC_` prefix). Coordinate the rotation with the deploy so no shipped
  window has a live client pointed at a dead key.
- **Relocate the one browser read.** Replace the client
  `supabase.from("v_asset_passport")` in `LandingApp.tsx` with a `fetch` to a
  route handler, `app/api/passport/[assetId]/route.ts`, that returns the
  tier-appropriate projection: the public passport for anon, the full passport
  for signed-in, both `200`. The modal renders the public fields and shows the
  inline depth gate when the response is the public shape.
- **Render the public passport on the two server-rendered pages, depth gated
  inline** (they are the primary passport surfaces and cannot be left out):
  - `app/agent/[id]/page.tsx`: for anon, read `v_asset_passport_public` and
    render `PassportView` in gated mode (public fields shown, depth sections
    replaced by an inline sign-in prompt). Signed-in reads the full passport and
    renders normally. Never throw a 500 on the anon path and never surface the
    raw permission-denied message.
  - `app/registry/compare/page.tsx`: for anon, compare the public fields with the
    depth rows gated inline. Signed-in compares the full passports.
- **`PassportView` gains a `gated` mode.** It renders the public fields from
  whichever projection it is handed and, in gated mode, replaces each depth
  section (evidence, per-layer tracing, risk basis, permissions, compliance,
  cross-marketplace linkage) with the inline sign-in affordance (4.6). This is
  the one real UI change; the component stays presentational.
- **Home "featured passport".** `getFeatured` currently reads `v_asset_passport`
  for everyone. For anon it reads `v_asset_passport_public` and the modal shows
  the public fields with the depth gated; signed-in keeps the full featured
  passport.

### 4.4 Authentication and identity

- Enable email OTP (magic link) and the Google, GitHub, and LinkedIn OAuth
  providers in Supabase Auth config (each social provider needs an OAuth app
  registered in its own console with the client id/secret pasted into Supabase).
- **`proxy.ts`** (Next 16's renamed middleware; the exported function is `proxy`,
  the runtime is Node.js and cannot be configured to edge) refreshes the session
  on each request per the `@supabase/ssr` pattern, using the same `getAll` /
  `setAll` cookie adapter, so server components and route handlers observe a
  valid session. Do not scaffold a `middleware.ts` / `middleware` export; that
  convention is deprecated in Next 16.
- **Sign-in UI:** social buttons (Google, GitHub, LinkedIn) plus an email input.
  Email uses the stateless `token_hash` flow (a server action calls
  `signInWithOtp`; the emailed link hits `app/auth/confirm/route.ts`, which calls
  `verifyOtp`), so a link opened on a different device works. Social uses a
  server action calling `signInWithOAuth` (which redirects the browser to the
  provider) and returns to `app/auth/callback/route.ts`, which calls
  `exchangeCodeForSession` (same browser, so the PKCE verifier is present). All
  server-side via `@supabase/ssr`; sign-out is a server action that clears the
  session.
- **`profile` table:**
  - `id uuid primary key references auth.users(id) on delete cascade`
  - `role text not null default 'signed_in' check (role in ('signed_in','admin'))`
  - `created_at timestamptz not null default now()`
  - RLS: a user may select and update their own row (`auth.uid() = id`); admins
    may select all. `role` must not be self-escalatable to `admin`: make `role`
    writable only by `service_role` / a definer function, so a user's own
    `update` cannot set it.
  - A trigger on `auth.users` insert creates the profile row with
    `role = 'signed_in'`, promoted to `admin` only if the new email is in an
    `admin_allowlist` table (seeded with `niles@settletop.com`). Admin is never
    self-serve.

### 4.5 Rate limiting and account-creation limiting

- **Read limiter** in the server layer, wrapping the read functions and route
  handlers. Keyed by IP for anon, by user id for signed-in, admin exempt. On
  exceed, return `429` with a plain message (4.6).
- **Global anon backstop.** Because the anon IP-keyed limit is defeatable by a
  proxy pool, add an IP-independent global anon read budget (a coarse
  rows/requests ceiling per window across all anon traffic) as a backstop. An
  optional proof-of-work / Turnstile challenge on the anon read route is a lever
  to enable if anomalous anon volume is observed; it is not on by default,
  because easy public browsing is the point of the card tier.
- **Account-creation limiter** (minimal, new to this spec, flagged for the
  reviewer): per-IP and per-email-domain new-account caps per day, a
  disposable / catch-all domain denylist, and a global new-account budget per
  window with alerting. This exists because open sign-up otherwise lets a
  scripted magic-link farm mint unlimited verified accounts, each with its own
  read budget, to pull passport depth in parallel. It is deliberately minimal;
  sophisticated farm detection is sub-project 5. **Residual risk:** a determined
  adversary using many IPs and many real inboxes can still create accounts and
  extract passport depth slowly; that residual is accepted here and closed by
  sub-project 5. If the reviewer prefers, drop the account-creation limiter from
  this spec and accept the full residual until sub-project 5.
- **Storage:** Vercel KV if the project has it (check `vercel.json` and the
  Vercel project), else a Postgres token-bucket table with a `security definer`
  check-and-increment function granted to `service_role` only. The Postgres
  option has write amplification, acceptable at current scale; revisit if traffic
  grows. Implementation choice for the plan.
- The limiter records enough signal (keys, counts, timestamps) to seed later
  abuse detection (sub-project 5); detection logic itself is out of scope here.

### 4.6 Error handling and visitor-facing copy

Active voice, sentence case, interface voice, **no em dashes** (house rule for
anything a visitor reads):

- Rate limit (`429`): "You are moving quickly. Sign in for higher limits, or slow
  down and try again in a moment."
- Inline depth gate (shown in place of each gated passport section, on the
  modal, the agent page, and compare): "Sign in to see the provenance. The
  evidence, the layer-by-layer tracing, the risk basis, and the
  cross-marketplace links are open to signed-in accounts."
- Magic-link sent: "Check your email for a sign-in link."
- Auth callback failure: "That sign-in link did not work. Request a new one."
- Account-creation limited: "We cannot create the account right now. Try again
  later."
- A genuine server failure (not a gate refusal) returns "Something went wrong
  loading this passport. Try again." The raw PostgREST permission-denied message
  must never reach the client; a gated depth section renders the inline sign-in
  prompt, not an error.

---

## 5. Build sequence

The subsystem is interdependent but has one clean internal seam. The plan may
split this into two plans along it; each phase produces working, testable
software with no visibility regression.

**Phase A: server read layer + key retirement (no visible gate yet).**
Add `@supabase/ssr` and `server-only`; make `lib/supabase.ts` server-only; move
the one client read to a route handler; route all reads through the server anon
client; rotate the key; add the read rate limiter and the global anon backstop.
After Phase A, visibility is unchanged (no auth exists yet, so the server serves
the same data to everyone), the browser holds no credential, reads are
server-side and rate-limited. Shippable, no regression.

**Phase B: auth + the tier gate.**
Add magic-link auth (`proxy.ts`, callback route, sign-in UI), `profile` + role +
`admin_allowlist` + trigger, the account-creation limiter, the DB re-gate
(definer surfaces including the new `v_asset_passport_public`, base-table SELECT
revoked from both roles, `registry_search` cap, `v_merge_candidates` admin check,
new-contract DO-blocks), the gate `auth` shim and new check files, `PassportView`
gated mode with the inline depth gate on the modal / agent page / compare page,
and the public featured passport for anon. After Phase B, the gate is real.

---

## 6. Testing strategy

- **Gate (pure-Postgres container), with the `auth` shim from 4.2.** New numbered
  check files assert:
  - anon: SELECT on the public definer surfaces (`v_registry_card`,
    `v_registry_stats`, `v_logo_status`, `v_asset_passport_public`) returns rows;
    EXECUTE `registry_search` returns rows; a large `p_limit` returns at most the
    cap.
  - anon: SELECT on `v_asset_passport` (full) / `v_listing_passport` /
    `v_asset_evidence` / `v_asset_change_feed` / `v_merge_candidates` raises
    `42501`; SELECT on base tables raises `42501`; `select raw from capture`
    raises `42501`.
  - `v_asset_passport_public` carries no evidence, per-layer, risk-basis,
    permissions, or compliance columns: assert the projection so depth cannot
    leak through the public surface.
  - authenticated: SELECT on the passport surfaces returns rows;
    `select raw from capture` raises `42501`; SELECT on base tables raises
    `42501`.
  - admin gate: with `request.jwt.claims` set to an admin `auth.uid()`,
    `v_merge_candidates` returns rows; with a non-admin `auth.uid()`, zero rows.
  - Negative tests in the gate's existing style, proving each new assertion can
    fail.
  - New assertions live in new DO-blocks / check files; the historical tripwires
    are untouched.
- **Parity.** Keep `test:parity` green: `registry_search` card results unchanged
  by the definer conversion and the cap (within the existing <= 96 page size).
- **App / integration (Playwright + `node --test`).** The passport route returns
  the public projection for anon (`200`, no depth fields) and the full passport
  for signed-in (`200`). Anon `GET /agent/<slug>` and
  `GET /registry/compare?ids=...` render the public passport with the depth
  sections gated inline, never the full depth and never a 500; signed-in renders
  full depth. The read limiter returns `429` past the budget. The
  account-creation limiter blocks past its budget. The auth callback sets a
  session; sign-out clears it.

---

## 7. Security and anti-extraction summary

- The bundled publishable key is rotated, so the old key dies.
- The browser holds no Supabase credential; all reads go through the server.
- Direct base-table SELECT is revoked from anon and authenticated; every read is
  a tier-scoped definer surface. `capture.raw` is reachable only by
  `service_role`, so no browser tier, including admin, can read raw evidence.
- `registry_search` is capped so one definer call cannot dump the corpus.
- The public passport (vendor facts + top-line verdict) is intentionally open and
  was scrapable from the source marketplaces anyway. SettleTop's provenance
  analysis (evidence, per-layer tracing, risk basis, linkage, permissions and
  compliance detail) is genuinely gated behind auth; reaching it requires an
  account.
- Read limits: anon by IP plus a global anon backstop; signed-in by account;
  admin exempt. Account creation is limited per IP / domain with a global budget.
- **Honest residuals** (closed by sub-project 5, not this spec): a determined
  adversary can still slowly (a) paginate the ~5,000 public cards through the
  anon route with rotating IPs, since cards are the top-line tier, and (b) create
  accounts across many IPs and real inboxes to extract passport depth. The
  foundation raises the cost and records the signal; full abuse detection is the
  next layer.

---

## 8. Risks and open items

- **Live prod drift.** The re-gate migration must be written against a verified
  live catalog check, not the migration history. Highest-risk step: a wrong
  assumption about current grants could leave a hole or break reads.
- **Definer conversion changes semantics.** Flipping the read surfaces from
  `security_invoker` to `security definer` reverses a deliberate architecture
  choice. The tier projection and the admin predicate must live in each surface's
  body, and each definer surface must be owned by a role with exactly the base
  access it needs and no more.
- **Rate-limit and account-limit storage** (KV vs Postgres) pends an infra check.
- **Magic-link deliverability.** Supabase Auth email / SMTP configuration is an
  ops setup item; without it, sign-in does not work end to end.
- **Key rotation timing.** Rotation and the server-only-client deploy must be
  coordinated so no deployed window ships a client with a dead key.
- **The public passport treatment** (the anon passport rendering the public
  fields with the depth sections gated inline, on the modal, agent page, and
  compare) is a visible change to existing surfaces; confirm the treatment during
  review.
- **The public/depth field split** in `v_asset_passport_public` is load-bearing:
  any field wrongly placed on the public side leaks analysis, any field wrongly
  gated makes the anon page thin. The plan must produce the exact column list and
  the gate must assert the public projection excludes every depth column.
- **The account-creation limiter is a scope addition** (section 4.5). Keep it or
  defer it; if deferred, the passport-farm residual is accepted until
  sub-project 5.

---

## 9. Definition of done

- The browser bundle contains no Supabase key (verified by building and grepping
  the emitted client chunks).
- The old publishable key is rotated and no longer authorizes PostgREST.
- Anon can browse cards, search, stats, logos, and the public passport through
  the server layer only. The Quick-look modal, `/agent/<slug>`, and
  `/registry/compare` render the public passport with the provenance depth gated
  inline, never a 500 and never a raw DB error.
- A visitor can sign in by magic link; a signed-in account sees full passport
  depth.
- The admin allowlist promotes the seeded account to admin; no self-serve path to
  admin exists; the merge-candidate queue returns rows only to an admin.
- The gate proves the tier contract: anon allowed the public surfaces (including
  `v_asset_passport_public`) and denied the full passport, base tables, and
  `capture.raw`; authenticated denied `capture.raw` and base tables, allowed the
  full passport surface; `registry_search` capped; admin-only rows on
  `v_merge_candidates`. The parity test is green.
- Read limits return `429` past the budget for anon (by IP, with the global
  backstop) and signed-in (by account); admin is exempt. Account creation is
  limited per IP / domain with a global budget.
