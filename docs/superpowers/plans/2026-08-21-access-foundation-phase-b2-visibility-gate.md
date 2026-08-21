# Access Foundation — Phase B2 (the visibility gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make anonymous visitors see a reduced *public passport* (the vendor's own facts plus our top-line verdict) while SettleTop's provenance analysis is unlocked only by signing in, enforced in the database and re-shaped in the server read layer and passport UI.

**Architecture:** The database re-gate is the core: every anon/authenticated read becomes a `security definer` surface owned by `postgres` (which has `rolbypassrls`), and direct base-table `SELECT` is revoked from both browser roles, so depth cannot leak through any invoker view or the raw `capture` bytes. A new `v_asset_passport_public` is a *projecting definer view over* `v_asset_passport` (no assembly duplication). The Next server read layer becomes session-aware: a signed-in request reads the full view through the user's cookie-bound (authenticated) client; a signed-out request reads the public view through the anon client. `PassportView` and `CompareTable` gain a `gated` mode that renders the public fields and replaces each depth section with an inline sign-in prompt.

**Tech Stack:** Supabase Postgres (roles/grants/RLS, `security definer` views + functions), Next.js 16 App Router (server components, route handlers, `@supabase/ssr` session client), TypeScript, the pure-Postgres Docker gate (`scripts/gate/run.sh`).

**Spec:** `docs/superpowers/specs/2026-08-21-access-foundation-design.md` (sections 4.1, 4.2, 4.3, 4.6, 5 "Phase B", 6). This plan implements the B2 slice: the DB re-gate + session-aware reads + public projection + gated UI. Identity/auth (proxy, profile, admin_allowlist, sign-in) already shipped in B1; Phase A (server read layer, key retirement, rate limiting) already shipped.

## Global Constraints

- **No visibility regression across the merge window.** Merging deploys code via Vercel; the migration is applied **manually afterward** (this repo's standing rule: database deploys are manual). The new code MUST tolerate the pre-migration DB (where `v_asset_passport_public` does not yet exist) by falling back to the full view **only** on Postgres `42P01` (undefined_table). Before the migration is applied, anon sees full data exactly as today (no regression); after it is applied, the gate is live. The old (currently deployed) code must never meet the new DB, so the migration is applied only after the new deploy is confirmed healthy.
- **No privileged credential ever satisfies an anon read.** The anon path uses the anon (publishable-key) role only. A signed-in read uses the user's cookie-bound session client (authenticated role). `service_role` is never used for a browser read.
- **Never surface a raw PostgREST message to the client.** A genuine failure returns the existing `{ ok: false, error }` shape and the visitor-facing copy from spec 4.6; a permission-denied on a depth surface renders the inline sign-in gate, not an error.
- **Do not relax the evidence verification gate in `ingest_capture()`.** This phase touches READ privileges only. The write path is untouched.
- **Do not edit applied migrations or the historical gate assertion files** (`04-reads.sql` … `13-identity.sql`). The re-gate is a NEW migration; the new contract is asserted in a NEW gate file. `run.sh` (the harness runner, not an assertion) IS edited, to hold the re-gate migration back so the historical anon-read tripwires run against the pre-re-gate state, exactly as the spec assumes ("tripwires run at their own position in filename order, before any later re-gate migration").
- **No em dashes in anything a visitor reads** (house rule). Restructure with colons, commas, or two sentences.
- **Maintainer/ops steps are NOT performed by subagents:** applying the migration to prod, and any dashboard action. Implementers do code + the local Docker gate; the live end-to-end verification is surfaced to the user.
- **Migration files are pure LF, applied via the Supabase MCP by the maintainer.** New migration timestamp `20260821180000` sorts after identity `20260821160000`.
- Node: use `nvm use 23` for `npm test` / `npm run typecheck` / `npm run build` (the worktree default v20.9.0 is too old). Node-test commands that touch `server-only` modules need `--conditions=react-server` (already wired into the `test` scripts).

---

## Live catalog ground truth (verified against prod `atevamimariwlpidgvog`, 2026-08-21)

The implementer of Task 1 MUST re-run the read-only catalog check (below) and write the migration against what it returns, not against this snapshot. The snapshot is the design basis:

- **No `capture` schema exists.** All capture tables (`capture`, `capture_compliance`, `capture_evidence`, `capture_extract`, `capture_link`, `capture_permission`, `capture_plan`) are in `public`. "capture.raw" means the `raw` column on `public.capture`.
- All read views are `security_invoker=true`, owned by `postgres`, EXCEPT `v_publisher_document_current` (already definer/private; leave it alone). `v_asset_passport_public` does not exist yet.
- Base-table `SELECT` is granted to **both** `anon` and `authenticated` on: `asset`, `asset_merge`, `asset_slug`, `capture`, `capture_compliance`, `capture_evidence`, `capture_extract`, `capture_link`, `capture_permission`, `capture_plan`, `function_override`, `listing`, `listing_change`, `marketplace`. These are the tables to revoke.
- Already correctly locked (do NOT touch): `profile` (authenticated keeps SELECT via B1's `profile_read`; anon has none), `admin_allowlist` (no SELECT either role), `publisher_document` (no SELECT either role), `rate_bucket` (no SELECT either role), `v_publisher_document_current` (no SELECT either role).
- All read views granted SELECT to both roles today: `v_registry_card`, `v_registry_stats`, `v_logo_status`, `v_asset_passport`, `v_listing_passport`, `v_asset_evidence`, `v_asset_change_feed`, `v_merge_candidates`.
- `registry_search(...)` is `security invoker` (`prosecdef=false`), `STABLE`, `search_path=public,pg_temp`, granted `anon,authenticated`; it reads `v_registry_card` and the base `marketplace` table; the page window is bounded by `greatest(p_limit, 0)` in its `page` CTE.
- No `public` base table has `FORCE ROW LEVEL SECURITY`. `postgres` has `rolbypassrls=true` and `service_role` has `rolbypassrls=true`. So a `postgres`-owned definer view reads all base rows regardless of the base tables' `using(true)` RLS, and the anon/authenticated revokes fully close direct base access.
- The gate harness `run.sh` applies ALL migrations first (step 3 pre-rename, step 5 rename-onward), then runs ALL check files (steps 6–16). Therefore the re-gate migration MUST be held back behind a new threshold so `04-reads.sql`…`13-identity.sql` run against the pre-re-gate DB. The auth shim `scripts/gate/00-auth-stub.sql` already provides `auth.users` and `auth.uid()` reading `request.jwt.claims->>'sub'`. `13-identity.sql` demonstrates the role-simulation pattern (`set_config('request.jwt.claims', …, true)` + `set local role authenticated`, capture-then-`reset role`) that Task 2's new check reuses.

Read-only catalog check (Supabase MCP `execute_sql`, no writes) the Task 1 implementer runs first:

```sql
-- 1. view security mode + owner
select c.relname, c.reloptions, pg_get_userbyid(c.relowner) owner
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='v' order by c.relname;
-- 2. grants to anon/authenticated
select table_name, grantee, string_agg(privilege_type,',' order by privilege_type) p
from information_schema.role_table_grants
where grantee in ('anon','authenticated') and table_schema='public'
group by table_name, grantee order by table_name, grantee;
-- 3. FORCE RLS (expect empty) and role bypass
select relname from pg_class where relforcerowsecurity and relkind='r';
select rolname, rolbypassrls from pg_roles where rolname in ('postgres','anon','authenticated','service_role');
-- 4. authoritative bodies to modify (copy verbatim, then apply the edits this plan specifies)
select pg_get_functiondef((select oid from pg_proc where proname='registry_search' and pronamespace='public'::regnamespace));
select pg_get_viewdef('public.v_merge_candidates'::regclass, true);
select column_name from information_schema.columns
where table_schema='public' and table_name='v_asset_passport' order by ordinal_position;
```

---

## File Structure

- **Create** `supabase/migrations/20260821180000_visibility_gate.sql` — the re-gate: `v_asset_passport_public` (projecting definer view), `resolve_asset_slug()` definer resolver, `registry_search` → definer + cap, `v_merge_candidates` → definer + admin predicate, flip the seven read views to definer, grant/revoke, and structural self-assertions. (Task 1)
- **Create** `scripts/gate/14-visibility-gate.sql` — role-simulated assertions of the new contract. **Modify** `scripts/gate/run.sh` — hold the re-gate migration behind a threshold, then apply it and run check 14. (Task 2)
- **Modify** `lib/types.ts` — add `PublicPassport` (the public projection shape) and the tiered result type. (Task 3)
- **Modify** `lib/registry.ts` — session-aware passport reads (`getPassportByAssetId`, `getPassportBySlug`, `getFeatured`, `getPassports`), the `resolveAssetSlug` rpc, the `42P01` fallback, and keep the public-tier reads (`getLogos`/`getStats`/`getTopAgents`/`searchRegistry`/`getFacetCounts`) on the anon client. (Task 3)
- **Create** `lib/registry.gate.test.ts` — unit tests for tier selection + the public projection allowlist + the 42P01 fallback. (Task 3)
- **Modify** `components/PassportView.tsx` — `gated` mode; **Create** `components/DepthGate.tsx` — the inline sign-in affordance; **Modify** `app/design.css` — gate classes. (Task 4)
- **Modify** `components/registry/CompareTable.tsx` — `gated` mode (depth rows replaced by the gate). (Task 5)
- **Modify** `app/agent/[id]/page.tsx`, `app/registry/compare/page.tsx`, `app/page.tsx` — read tier-aware and pass `gated`. (Task 6)
- **Modify** `app/api/passport/[assetId]/route.ts`, `components/LandingApp.tsx` — the route returns the tiered shape; the modal renders `gated`; the featured passport is tier-aware. (Task 7)

Task order: **1 → 2 → 3 → 4 → 5 → 6 → 7.** Task 2 needs Task 1's migration file. Tasks 4–7 consume Task 3's read-layer + type interface. Tasks 1/3 are independent and could run in either order, but 1-before-3 keeps the column contract authoritative.

---

### Task 1: The re-gate migration

**Files:**
- Create: `supabase/migrations/20260821180000_visibility_gate.sql`

**Interfaces:**
- Produces (consumed by Task 3): view `public.v_asset_passport_public` (columns below), function `public.resolve_asset_slug(p_slug text) returns uuid`.
- Produces (consumed by Task 2): the migration file the gate applies post-threshold; the new-contract behavior the check asserts.

**The public projection — the exact column allowlist for `v_asset_passport_public`.** These are the ONLY columns; the boundary is the projection. Included (vendor facts + top-line verdict + where-to-get-it):

```
asset_id, source_product_id, listing_url, marketplace_id, marketplace_name,
name, publisher, tagline, overview_text,
surfaces, categories, industries, works_with,
pricing, acquire_using, support,
listing_version, listing_updated,
rating, rating_count, native_rating, native_count,
external_source, external_rating, external_count,
certification, cert_label, cert_url,
function_category, delivery, price_band, price_note,
reach, provenance, evidence_tier, risk,
plans, product_links, legal_links, media,
listing_id, last_captured_at, capture_count
```

Deliberately EXCLUDED (SettleTop's analysis = gated depth): `evidence`, `known_layers`, `layers_known`, `layers_tracked`, `risk_basis`, `graph_permissions`, `compliance`, `cert_hosting`, `cert_data_location`, `cert_data_handling`, `cert_developer_updated`, `cert_page_updated`, `listings` (cross-marketplace linkage), and the capture internals `first_seen_at`, `capture_id`, `captured_at`, `capture_complete`, `missing`, `ingest_source`. The five the gate asserts absent are `evidence`, `known_layers`, `risk_basis`, `graph_permissions`, `compliance`.

- [ ] **Step 1: Run the read-only catalog check** (the four queries above) via the Supabase MCP against prod. Confirm the ground-truth snapshot still holds; note any drift (e.g., an unexpected extra grant) and gate against reality. Do NOT write anything to prod.

- [ ] **Step 2: Write the migration header and the public view.** Pure LF. Header comment states: read-privilege change only, additive-then-revoke, backward-compatible until applied.

```sql
-- Visibility gate (Access Foundation Phase B2). READ privileges only; the write
-- path and ingest_capture()'s evidence gate are untouched. Every anon/authenticated
-- read becomes a security-definer surface owned by postgres (rolbypassrls), and
-- direct base-table SELECT is revoked from both browser roles, so provenance depth
-- and capture.raw cannot leak through any invoker view. Anon reads the reduced
-- public passport; a signed-in JWT reads the full passport; only service_role
-- touches base tables directly.

-- Public passport: a PROJECTING definer view over v_asset_passport. It carries the
-- vendor's own facts plus the top-line verdict, and NONE of the evidence, per-layer
-- tracing, risk basis, permissions, compliance detail, or cross-marketplace linkage.
create or replace view public.v_asset_passport_public as
select
  asset_id, source_product_id, listing_url, marketplace_id, marketplace_name,
  name, publisher, tagline, overview_text,
  surfaces, categories, industries, works_with,
  pricing, acquire_using, support,
  listing_version, listing_updated,
  rating, rating_count, native_rating, native_count,
  external_source, external_rating, external_count,
  certification, cert_label, cert_url,
  function_category, delivery, price_band, price_note,
  reach, provenance, evidence_tier, risk,
  plans, product_links, legal_links, media,
  listing_id, last_captured_at, capture_count
from public.v_asset_passport;
alter view public.v_asset_passport_public set (security_invoker = false);
```

- [ ] **Step 3: Add the slug resolver** (so slug→asset_id keeps working after `asset_slug` SELECT is revoked; preserves historical slugs):

```sql
create or replace function public.resolve_asset_slug(p_slug text) returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select asset_id from public.asset_slug where slug = p_slug;
$$;
comment on function public.resolve_asset_slug(text) is
  'Slug to asset_id, security definer so browser roles need no asset_slug grant. Routing only, no provenance.';
revoke all on function public.resolve_asset_slug(text) from public;
grant execute on function public.resolve_asset_slug(text) to anon, authenticated;
```

- [ ] **Step 4: Convert `registry_search` to definer + cap.** Take the EXACT current body from Step 1's `pg_get_functiondef` output. Apply exactly two edits, nothing else:
  1. Add `SECURITY DEFINER` to the function attributes (it is currently absent; keep `STABLE` and the `SET search_path`).
  2. In the `page` CTE, change the upper bound from `greatest(p_limit, 0)` to `least(greatest(p_limit, 0), 100)`. The `page` CTE reads:
     `where rn > greatest(p_offset, 0) and rn <= greatest(p_offset, 0) + greatest(p_limit, 0)` — only the second `greatest(p_limit, 0)` becomes `least(greatest(p_limit, 0), 100)`.
  Emit the whole function as `create or replace function public.registry_search(...) ... security definer ... as $function$ ... $function$;`. Do not alter any other line, comment, or CTE. (The grant to anon/authenticated already exists and is preserved by `create or replace`.)

- [ ] **Step 5: Convert `v_merge_candidates` to definer + admin predicate.** Take the EXACT current view body from Step 1's `pg_get_viewdef`. Emit `create or replace view public.v_merge_candidates as <exact body>` with a single appended predicate on the final outer select (the one ending `... from pair`):
  `where exists (select 1 from public.profile where profile.id = auth.uid() and role = 'admin')`.
  Then `alter view public.v_merge_candidates set (security_invoker = false);`. A signed-in non-admin gets zero rows; anon is additionally denied by the grant revoke in Step 7. (Fallback if the body reproduction is judged too risky in review: instead revoke `v_merge_candidates` SELECT from BOTH anon and authenticated and skip the predicate — this still satisfies "no browser tier reads merge candidates"; note the choice in the ledger. The predicate is preferred because the spec's gate test asserts admin-only rows.)

- [ ] **Step 6: Flip the seven read views to definer.** No body change:

```sql
alter view public.v_registry_card     set (security_invoker = false);
alter view public.v_registry_stats     set (security_invoker = false);
alter view public.v_logo_status        set (security_invoker = false);
alter view public.v_asset_passport     set (security_invoker = false);
alter view public.v_listing_passport   set (security_invoker = false);
alter view public.v_asset_evidence     set (security_invoker = false);
alter view public.v_asset_change_feed  set (security_invoker = false);
```

- [ ] **Step 7: Grants and revokes.** Public tier to both roles; depth tier to authenticated only; base tables and `capture` revoked from both; the explicit `capture` revoke per spec:

```sql
-- Public tier (anon + authenticated). registry_search + the three card/stats/logo
-- views are already granted to both; the new public passport view is added here.
grant select on public.v_asset_passport_public to anon, authenticated;

-- Passport-depth tier: authenticated only. Revoke anon from every depth view.
revoke select on public.v_asset_passport    from anon;
revoke select on public.v_listing_passport  from anon;
revoke select on public.v_asset_evidence    from anon;
revoke select on public.v_asset_change_feed from anon;
-- (authenticated keeps SELECT on these four; it already has it.)

-- Admin tier: anon revoked; authenticated keeps the grant, gated to zero rows by
-- the Step 5 predicate.
revoke select on public.v_merge_candidates from anon;

-- Base-table SELECT revoked from BOTH browser roles. capture.raw becomes reachable
-- only by service_role.
revoke select on public.asset, public.asset_merge, public.asset_slug,
  public.capture, public.capture_compliance, public.capture_evidence,
  public.capture_extract, public.capture_link, public.capture_permission,
  public.capture_plan, public.function_override, public.listing,
  public.listing_change, public.marketplace
  from anon, authenticated;
-- Explicit, so the raw column is provably out of reach even if a future object
-- re-exposes the table.
revoke select on public.capture from anon, authenticated;
```

- [ ] **Step 8: Structural self-assertions** (a trailing `DO $$ ... $$;` block). Catalog-only, environment-agnostic, safe on prod; the migration refuses to apply if it did not achieve the contract. Assert: `registry_search` has `prosecdef = true`; the seven views + `v_asset_passport_public` + `v_merge_candidates` are NOT `security_invoker=true`; `anon` holds no SELECT on `v_asset_passport`, `v_listing_passport`, `v_asset_evidence`, `v_asset_change_feed`, `v_merge_candidates`, or any of the fourteen base tables, or `capture`; `authenticated` holds no SELECT on the base tables or `capture`; `v_asset_passport_public` has none of the columns `evidence`, `known_layers`, `risk_basis`, `graph_permissions`, `compliance`. Each failed assertion `raise exception`.

- [ ] **Step 9: Verify LF + apply nothing.** Confirm the file is pure LF (`file` / no CRLF). Do NOT apply to prod (maintainer step). Confirm it parses by relying on Task 2's gate run.

- [ ] **Step 10: Commit.**

```bash
git add supabase/migrations/20260821180000_visibility_gate.sql
git commit -m "feat(db): visibility gate — definer read surfaces, base SELECT revoked, public passport"
```

---

### Task 2: Gate the new contract (harness threshold + check 14)

**Files:**
- Modify: `scripts/gate/run.sh`
- Create: `scripts/gate/14-visibility-gate.sql`
- Read for reference (do not edit): `scripts/gate/13-identity.sql`, `scripts/gate/00-auth-stub.sql`, `scripts/gate/10-merge-candidates.sql`.

**Interfaces:**
- Consumes: the migration from Task 1; the auth shim (`auth.users`, `auth.uid()`) already present.

- [ ] **Step 1: Hold the re-gate migration back in `run.sh`.** Add a second threshold constant `REGATE=20260821180000` near the top. Change step 5's loop so it applies migrations `>= 20260819100000` AND `< REGATE` (add `[[ "$b" < "$REGATE" ]] || continue` alongside the existing `[[ "$b" < "20260819100000" ]] && continue`). The historical checks then run against the pre-re-gate DB and pass unchanged. After the existing step 16 (identity) and before the verdict, add:

```bash
say "16b. Apply the visibility-gate migration(s), in filename order"
for f in "$MIGRATIONS"/*.sql; do
  b=$(basename "$f")
  [[ "$b" < "$REGATE" ]] && continue
  printf '%-50s ' "$b"
  if ! psql_file -q -1 < "$f" >/dev/null; then
    echo "FAILED"; echo "Re-gate migration $b did not apply. The gate stops here." >&2; exit 1
  fi
  echo OK
done

say "16c. Visibility gate: tiered read surfaces, base + capture.raw denied, admin-only candidates"
psql_file -q < "$HERE/14-visibility-gate.sql"
```

  Renumber the "17. Verdict" say-line to "17." unchanged. Confirm the verdict function still reads `gate.result` (it does) and that the `EXCLUDED` list needs no new entries (check 14 has no designed-failure steps; every assertion must PASS).

- [ ] **Step 2: Write `14-visibility-gate.sql`.** Follow `13-identity.sql`'s pattern (capture-into-variables under a switched role, then `reset role`; never call `gate.*` helpers while a role is switched — `anon`/`authenticated` lack USAGE on the `gate` schema; escape/insert only after `reset role`). Insert one `gate.result` row per assertion with `verdict` `'PASS'` or `'FAIL: …'`. Assert:
  - **Anon allowed on the public surface:** as `anon`, `select count(*)` on `v_registry_card`, `v_registry_stats`, `v_logo_status`, `v_asset_passport_public` each `> 0`; `registry_search(p_limit => 5)` returns rows; `resolve_asset_slug` returns the seeded asset's id.
  - **Anon cap:** `jsonb_array_length(registry_search(p_limit => 100000) -> 'rows') <= 100`. (The seed is tiny, so also assert the total is unchanged, i.e. the cap bounds the page, not the count: `(registry_search(p_limit => 100000) ->> 'total')::int = (select count(*) from v_registry_card)` read as postgres.)
  - **Anon denied on depth + base + raw:** as `anon`, each of `select 1 from v_asset_passport`, `v_listing_passport`, `v_asset_evidence`, `v_asset_change_feed`, `v_merge_candidates`, and from base tables `asset`, `listing`, `capture`, `marketplace`, and `select raw from capture`, raises `insufficient_privilege` (SQLSTATE 42501). Use a per-statement `begin … exception when insufficient_privilege then …` and assert the exception fired.
  - **Authenticated non-admin:** with `request.jwt.claims` set to a seeded non-admin user's sub and `set local role authenticated`: `v_asset_passport`, `v_listing_passport`, `v_asset_evidence`, `v_asset_change_feed` each return `> 0` rows; `v_merge_candidates` returns exactly `0` rows; `select raw from capture` and `select 1 from asset` still raise `42501`.
  - **Authenticated admin sees candidates:** seed a cross-marketplace candidate pair (reuse the technique in `10-merge-candidates.sql`: two listings, two marketplaces, matching normalized name) so the view computes `C > 0` as postgres; with an allowlisted admin user's sub + `authenticated`, `v_merge_candidates` returns `C` rows (`> 0`). Tidy up the synthetic pair afterward if `10`'s pattern requires it.
  - **Projection is depth-free:** `v_asset_passport_public` has none of the columns `evidence`, `known_layers`, `risk_basis`, `graph_permissions`, `compliance` (query `information_schema.columns`).
  - End with `\pset format aligned` + `select step, as_role, object, n_rows, verdict, note from gate.result order by seq;` (matching the other check files) — but note `gate.result` accumulates across files, so scope your final display or rely on the run.sh verdict, consistent with how `13-identity.sql` ends.

- [ ] **Step 3: Run the gate.** `bash scripts/gate/run.sh`. Expected: `GATE PASS`. The historical checks (04–13) still PASS (they ran pre-re-gate); step 16c's assertions all PASS. If Docker is unavailable, STOP and surface — do not skip.

- [ ] **Step 4: Commit.**

```bash
git add scripts/gate/run.sh scripts/gate/14-visibility-gate.sql
git commit -m "test(gate): assert the visibility-gate contract; hold re-gate behind a threshold"
```

---

### Task 3: Session-aware read layer + public projection type

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/registry.ts`
- Create: `lib/registry.gate.test.ts`
- Consumes: `supabaseServer` / `getSessionUser` from `lib/auth.ts` (B1); the anon `supabase` client from `lib/supabase.ts`; `v_asset_passport_public` + `resolve_asset_slug` from Task 1.

**Interfaces (Produces, consumed by Tasks 4–7):**

```ts
// lib/types.ts
/** The reduced public passport: vendor facts + top-line verdict, no analysis.
 *  Mirrors v_asset_passport_public — the depth fields are absent by construction. */
export type PublicPassport = Pick<AssetPassport,
  | "asset_id" | "source_product_id" | "listing_url" | "marketplace_id" | "marketplace_name"
  | "name" | "publisher" | "tagline" | "overview_text"
  | "surfaces" | "categories" | "industries" | "works_with"
  | "pricing" | "acquire_using" | "support"
  | "listing_version" | "listing_updated"
  | "rating" | "rating_count" | "native_rating" | "native_count"
  | "external_source" | "external_rating" | "external_count"
  | "certification" | "cert_label" | "cert_url"
  | "function_category" | "delivery" | "price_band" | "price_note"
  | "reach" | "provenance" | "evidence_tier" | "risk"
  | "plans" | "product_links" | "legal_links" | "media"
  | "listing_id" | "last_captured_at" | "capture_count"> & { logo?: string | null };

/** A passport read at the tier the session earns. `gated` drives PassportView. */
export type TieredPassport =
  | { gated: false; passport: AssetPassport }
  | { gated: true; passport: PublicPassport };
```

`getPassportByAssetId`, `getPassportBySlug`, `getFeatured` return `ReadResult<TieredPassport | null>` (null = missing row). `getPassports(assetIds)` returns `ReadResult<{ gated: boolean; passports: AssetPassport[] | PublicPassport[] }>` (one tier for the whole compare set, decided once by the session).

**The public column allowlist, as a runtime constant** (used to build the `.select(...)` and unit-tested against the type): `PUBLIC_PASSPORT_COLUMNS` = the 43 names listed in Task 1 Step 2. Keep the anon read's `.select()` to this list so a future view widening cannot leak depth through the anon path.

- [ ] **Step 1: Write the failing tests** in `lib/registry.gate.test.ts` (node:test, `--conditions=react-server` already in the `test` script). Cover, with the Supabase client mocked so no network is needed:
  - `PUBLIC_PASSPORT_COLUMNS` contains none of `evidence`, `known_layers`, `risk_basis`, `graph_permissions`, `compliance`, `listings`, `cert_hosting`, `cert_data_location`, `cert_data_handling` (the depth allowlist guard).
  - A signed-in session (`getSessionUser` mocked non-null) makes the passport read hit `v_asset_passport` and return `{ gated: false }`.
  - A signed-out session hits `v_asset_passport_public` with `.select(PUBLIC_PASSPORT_COLUMNS.join(","))` and returns `{ gated: true }`.
  - The anon path, when the underlying read returns a `42P01` (undefined_table) error, falls back to `v_asset_passport` and returns `{ gated: true }` still (public projection preserved by selecting only the allowlist), so the pre-migration window does not 500.
  - A non-`42P01` error returns `{ ok: false }` and never the raw message.

- [ ] **Step 2: Run the tests, verify they fail.** `nvm use 23 && npm test` → the new file RED.

- [ ] **Step 3: Implement.** Add the types + `PUBLIC_PASSPORT_COLUMNS`. Add an internal helper:

```ts
// Resolves the session ONCE, then reads the tier it earns. The anon client is the
// publishable-key (anon-role) client; the session client is authenticated when a
// cookie session exists. Never a privileged credential for an anon read.
async function readPassport(
  by: { assetId: string } | { slug: string }
): Promise<ReadResult<TieredPassport | null>> {
  const user = await getSessionUser();               // null when signed out
  const assetId = "assetId" in by
    ? by.assetId
    : await resolveAssetSlug(by.slug);               // rpc, both tiers
  if (assetId === undefined) return { ok: true, data: null };      // slug not found
  if (assetId === null) return { ok: false, error: "resolve failed" };
  if (user) {
    const { data, error } = await supabaseServer_then_from_v_asset_passport(assetId);
    if (error) { console.error(...); return { ok: false, error: error.message }; }
    return { ok: true, data: data ? { gated: false, passport: data } : null };
  }
  // Signed out: public projection via the anon client, with the pre-migration fallback.
  const pub = await anonSelect("v_asset_passport_public", PUBLIC_PASSPORT_COLUMNS, assetId);
  if (pub.error && pub.error.code === "42P01") {
    const fb = await anonSelect("v_asset_passport", PUBLIC_PASSPORT_COLUMNS, assetId); // pre-migration
    if (fb.error) return { ok: false, error: fb.error.message };
    return { ok: true, data: fb.data ? { gated: true, passport: fb.data as PublicPassport } : null };
  }
  if (pub.error) return { ok: false, error: pub.error.message };
  return { ok: true, data: pub.data ? { gated: true, passport: pub.data as PublicPassport } : null };
}
```

  (The named helpers above are illustrative; implement with the real `@supabase/ssr` calls: `supabaseServer()` for the signed-in read, the module `supabase` client for the anon read. `resolveAssetSlug` calls `supabase.rpc("resolve_asset_slug", { p_slug })` and returns the uuid, `undefined` for a not-found slug, `null` on error.) Rewrite `getPassportByAssetId` and `getPassportBySlug` to delegate to `readPassport`. Rewrite `getFeatured`: pick the featured asset id from `v_registry_card` (public, both tiers) ordered by reach/rating_count, then `readPassport({ assetId })`, returning `ReadResult<TieredPassport | null>`. Rewrite `getPassports` (compare): resolve the session once; signed-in reads `v_asset_passport` for the ids and returns `{ gated:false, passports }`; signed-out reads `v_asset_passport_public` (allowlist) with the same 42P01 fallback and returns `{ gated:true, passports }`.
  - Keep `getListingPassports`, `getAssetEvidence`, `getRecentChanges`, `getMergeCandidates` reading their depth views through the **session** client (`supabaseServer()`), and document that they are only called on signed-in code paths (a signed-out caller would get a permission error, surfaced as `{ ok:false }`, never a leak).
  - Leave `getLogos`, `getStats`, `getTopAgents`, `searchRegistry`, `getFacetCounts`, `getCards`/`fetchAllCards` on the anon `supabase` client unchanged (public tier).

- [ ] **Step 4: Run tests + typecheck.** `nvm use 23 && npm test && npm run typecheck` → all green. The existing `lib/registry.passport-route.test.ts` and `registry-search.parity.test.ts` must still pass; adjust only their call sites if the return shape changed (they may need to read `.data.passport`).

- [ ] **Step 5: Commit.**

```bash
git add lib/types.ts lib/registry.ts lib/registry.gate.test.ts
git commit -m "feat: session-aware passport reads + public projection (tiered visibility)"
```

---

### Task 4: `PassportView` gated mode + inline depth gate

**Files:**
- Modify: `components/PassportView.tsx`
- Create: `components/DepthGate.tsx`
- Modify: `app/design.css`
- Consumes: `PublicPassport` / `AssetPassport` from Task 3.

**What is public vs gated in the render.** PUBLIC (always shown): the identity band (name, publisher, function_category, surfaces, cert_label), the top fields (User rating, Runs on, Provenance + reach), the risk BAND (not `risk_basis`), "What the publisher says" (overview_text/tagline), Plans and pricing, the Sources section (listing_url, cert_url, product_links, legal_links), and the Access section (pricing/delivery/open listing). GATED (replaced by `<DepthGate />` for anon): the layer ledger detail, `risk_basis` note, the entire "Agent build and provenance" record (models, framework, tools, data, integrations, hosting, residency, Graph permissions, compliance, deployment), the `cert_data_handling` callout, and the per-listing "Listed on" panels (cross-marketplace linkage).

- [ ] **Step 1: Create `components/DepthGate.tsx`** (server component, presentational, no client JS): renders the spec 4.6 copy and a link to `/signin`. Exact copy, no em dashes:

```tsx
import Link from "next/link";
export default function DepthGate() {
  return (
    <div className="st-depth-gate">
      <p className="st-depth-gate__lead">Sign in to see the provenance.</p>
      <p className="st-depth-gate__body">
        The evidence, the layer-by-layer tracing, the risk basis, and the
        cross-marketplace links are open to signed-in accounts.
      </p>
      <Link className="st-btn st-btn--primary" href="/signin">Sign in</Link>
    </div>
  );
}
```

- [ ] **Step 2: Add a `gated` prop to `PassportView`.** Signature becomes `{ a: AssetPassport | PublicPassport; back?: {...}; gated?: boolean }`. When `gated` is true the component reads ONLY public fields (the `PublicPassport` shape), and renders `<DepthGate />` once in place of each gated section named above. Guard every depth field access behind `!gated` (or narrow the type), so a `PublicPassport` (which lacks `evidence`, `known_layers`, `risk_basis`, `graph_permissions`, `compliance`, `cert_*` detail, `listings`) is never dereferenced for a missing key. Keep the non-gated (signed-in) render byte-for-byte as today.

- [ ] **Step 3: Add gate styles to `app/design.css`** (`.st-depth-gate`, `__lead`, `__body`) consistent with existing `st-*` tokens; a quiet inset panel, not a full-page wall.

- [ ] **Step 4: Typecheck + build.** `nvm use 23 && npm run typecheck && npm run build`. Verify no `PublicPassport`-missing-key access compiles through (the type must make a gated dereference of a depth field an error).

- [ ] **Step 5: Commit.**

```bash
git add components/PassportView.tsx components/DepthGate.tsx app/design.css
git commit -m "feat(ui): PassportView gated mode + inline depth sign-in gate"
```

---

### Task 5: `CompareTable` gated mode

**Files:**
- Modify: `components/registry/CompareTable.tsx`
- Consumes: `PublicPassport` / `AssetPassport` (Task 3), `DepthGate` (Task 4).

- [ ] **Step 1: Read `components/registry/CompareTable.tsx`** and identify which comparison rows are depth (anything sourced from `evidence`, `known_layers`, `risk_basis`, `graph_permissions`, `compliance`, `cert_*` detail, or `listings`) versus public (identity, provenance status, risk band, evidence tier, rating, pricing, delivery, marketplace, links).

- [ ] **Step 2: Add a `gated` prop.** `{ agents: AssetPassport[] | PublicPassport[]; gated?: boolean }`. In gated mode, render the public rows for each agent and replace the depth rows with a single gated affordance (a row spanning the table that renders `<DepthGate />` or the same copy inline), so an anon compare shows the public facts side by side with one sign-in prompt for the analysis. Guard every depth-field access behind `!gated`.

- [ ] **Step 3: Typecheck + build.** `nvm use 23 && npm run typecheck && npm run build`.

- [ ] **Step 4: Commit.**

```bash
git add components/registry/CompareTable.tsx
git commit -m "feat(ui): CompareTable gated mode for anonymous comparisons"
```

---

### Task 6: Wire the server-rendered passport surfaces

**Files:**
- Modify: `app/agent/[id]/page.tsx`, `app/registry/compare/page.tsx`, `app/page.tsx`
- Consumes: the Task 3 read layer, `PassportView`/`CompareTable` gated mode.

- [ ] **Step 1: `app/agent/[id]/page.tsx`.** `getPassportBySlug` now returns `ReadResult<TieredPassport | null>`. Keep the failed-read-throws / missing-row-`notFound()` logic. Merge `getLogos` into the passport (works for both tiers; `PublicPassport` carries `source_product_id`). Pass `<PassportView a={passport} back={back} gated={result.data.gated} />`. `generateMetadata` uses whichever tier it gets (title/tagline are public). No 500 on the anon path; no raw permission message.

- [ ] **Step 2: `app/registry/compare/page.tsx`.** `getPassports` now returns `{ gated, passports }`. Keep the uuid-validation and missing-id logic (operate on `passports`). Render `<CompareTable agents={result.data.passports} gated={result.data.gated} />`.

- [ ] **Step 3: `app/page.tsx`.** `getFeatured` now returns `ReadResult<TieredPassport | null>`. Pass the featured passport AND its `gated` flag into `LandingApp` (prop added in Task 7). Handle null/failed featured exactly as today (the home page already tolerates a null featured).

- [ ] **Step 4: Typecheck + build; smoke via the preview.** `nvm use 23 && npm run typecheck && npm run build`. Then, signed-out, load `/agent/<a real slug>` and `/registry/compare?ids=<two real uuids>` in the preview and confirm: public fields render, the depth sections show the sign-in gate, no console error, no raw PostgREST text. (Reads still return full data until the migration is applied, so pre-migration the gate mode is exercised by the `gated` flag from the type path, not yet by DB denial. That is expected; Task 2's gate proves the DB denial.)

- [ ] **Step 5: Commit.**

```bash
git add app/agent/[id]/page.tsx app/registry/compare/page.tsx app/page.tsx
git commit -m "feat: render the public passport (depth gated) on agent, compare, and home"
```

---

### Task 7: Wire the client modal path

**Files:**
- Modify: `app/api/passport/[assetId]/route.ts`, `components/LandingApp.tsx`
- Consumes: Task 3 read layer, `PassportView` gated mode.

- [ ] **Step 1: Route handler.** `getPassportByAssetId` now returns `ReadResult<TieredPassport | null>`. Keep the uuid guard, the rate limits, the 429/500/404 copy. On success return the tiered shape as JSON: `{ gated, passport }` (200 for both tiers). Never leak the raw error.

- [ ] **Step 2: `LandingApp.tsx`.** The modal `fetch('/api/passport/{id}')` now yields `{ gated, passport }`; store both and render `<PassportView a={passport} gated={gated} />`. The `featured` prop becomes `{ passport, gated } | null` (from Task 6 Step 3); render the featured card / workbench with `gated` too. Keep the loading and "could not be loaded" states.

- [ ] **Step 3: Typecheck + build + preview smoke.** `nvm use 23 && npm run typecheck && npm run build`. In the preview, signed-out, open a Quick-look modal from the landing page and confirm the public passport renders with the depth gate; check the network response is `{ gated: true, passport: {...public...} }` and 200.

- [ ] **Step 4: Commit.**

```bash
git add app/api/passport/[assetId]/route.ts components/LandingApp.tsx
git commit -m "feat: Quick-look modal + featured passport render the gated public tier"
```

---

## Maintainer steps (surfaced at finish; NOT performed by subagents)

1. Merge the PR (Vercel deploys the tier-aware, pre-migration-tolerant code). Confirm the site is healthy: signed-out pages still render (full data, via the fallback, no regression), signed-in pages render.
2. Apply `supabase/migrations/20260821180000_visibility_gate.sql` to prod via the Supabase MCP (pure LF). Its structural self-assertions will refuse the apply if the grant/definer/projection contract is not met.
3. Verify the gate is live: signed-out, `/agent/<slug>` shows the public passport with the depth sign-in gate and the network read carries no evidence/permissions/compliance; signed-in (magic link) shows the full passport. Optionally spot-check with the Supabase MCP that `anon` gets `42501` on `v_asset_passport` and `select raw from capture`.
4. (Carried over, still pending, independent of B2) rotate the publishable key per `docs/runbooks/rotate-publishable-key.md`.

## Self-review checklist (run before execution)

- Spec 4.1 tier table: every "no (inline gate)" / "no" row is enforced by a revoke or the projection; every "yes" by a grant. ✓ (public passport, depth views, merge candidates, capture.raw).
- Spec 4.2: definer conversion + base revoke + `registry_search` cap + `v_merge_candidates` admin predicate + capture revoke + the auth shim + new DO-block assertions + new gate file. ✓
- Spec 4.3: session-aware reads, public projection, no privileged anon read, no raw message, the two server pages + the modal + featured. ✓ (key rotation is a maintainer step, tracked.)
- Spec 4.6 copy used verbatim, no em dashes. ✓
- Type consistency: `PublicPassport`, `TieredPassport`, `PUBLIC_PASSPORT_COLUMNS` used identically in Tasks 3–7. ✓
- No placeholder: the two giant bodies (`registry_search`, `v_merge_candidates`) are sourced from the live catalog with an exact, named edit rather than hand-transcribed. ✓
