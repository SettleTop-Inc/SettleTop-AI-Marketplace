# Registry Asset Layer, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `asset` to `listing`, introduce an `asset` table above it, and give every existing listing its own asset and slug, with the deployed site behaving identically throughout.

**Architecture:** Five ordered migrations applied in one push: rename, new tables, backfill, write path, views. Assets and listings stay 1:1, so nothing a visitor sees changes. A verification harness written before the migrations proves the invariants, and is the gate on the branch database before production.

**Tech Stack:** Postgres 17 on Supabase, migrations under `supabase/migrations`, applied by the GitHub to Supabase integration on push to `main`. Node 23 scripts, plain `fetch` against PostgREST. Next 16 app, `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-19-registry-asset-layer-design.md`

## Scope

This plan implements **phase 1 only**. Phases 2 and 3 get their own plans, written after phase 1's verification passes on production, because phase 2's read surface depends on how the rename actually lands.

## Global Constraints

Copied from the spec. Every task's requirements include these.

- **The evidence gate in `ingest_capture` is not to be relaxed for any reason.** The block from `hay_listing :=` through the end of the `kindmap` loop must be byte-identical before and after. Its current md5 is `d9156fc8d49d2bcd6aafb1e0c4b7edc6` over the whole function body, verified to match the repo file exactly.
- **Every `create or replace view` carries its `grant` immediately after it, in the same migration.** A column-compatible replacement does preserve grants; what loses them is a `drop view`, and changing a view's column names or order forces one. That is what took all 6,820 logos off the live site once, silently, because `getLogos` returns `{}` on error. The grant goes next to the view regardless, and Task 7's assertion is what proves the outcome.
- **A view's existing columns keep their names, types and order. New ones are appended.** `create or replace view` refuses anything else, with `cannot change name of view column`. Changing what an existing column is sourced from is fine.
- **Every new table gets an explicit RLS policy and grant.** Policies were created by a loop over a hardcoded array in `registry_core.sql`, so a new table inherits nothing, and a table with RLS on and no policy is invisible to `anon`.
- **Views follow a table rename automatically; plpgsql function bodies do not.** `ingest_capture` and `set_capture_logo` break only when next called, so they must be *executed* during verification, not inspected.
- **`NOT NULL` cannot be deferred.** Postgres accepts `DEFERRABLE` only on `UNIQUE`, `PRIMARY KEY`, `EXCLUDE` and `REFERENCES`. The asset must exist before the listing that points at it.
- **Phase 1 is verified in full on a Supabase branch database before it reaches production.** A failed branch is discarded, not rolled back.
- **No em dashes in any prose a person reads**, including doc updates. Use colons, commas, or two sentences.
- Assets and listings are 1:1 for the whole of phase 1. `v_registry_stats` must return identical values before and after.

---

## Pre-existing condition this plan must fix first

The repo and the database have diverged. Verified on 2026-08-19 against project `atevamimariwlpidgvog`:

**In the database, not in the repo:**

| version | name |
|---|---|
| `20260818134538` | `registry_search` |
| `20260818192216` | `add_drai_marketplace_and_publisher_document` |
| `20260818192550` | `v_logo_status_marketplace_aware` |

**In the repo, not recorded in the database:** `20260818210000_v_logo_status_grants.sql`. Its effect *is* present (`anon`, `authenticated` and `service_role` all hold SELECT on `v_logo_status`), so it was applied by hand.

**The branch status is `MIGRATIONS_FAILED`.**

The consequence that matters: `v_logo_status` live has columns `marketplace_id, source_product_id, listing_url, name, publisher, link_id, logo_url, archived_url, content_hash, state`, while the repo's only definition of it (in `20260816195128`) lacks `marketplace_id` and `listing_url`. **A rebuild from the repo produces a different schema from the one running.** Recreating views from repo definitions during this work would silently revert `v_logo_status` and break `archive-logos.mjs` along with every logo on the site, which is the exact outage this project has already had once.

So Task 1 reconciles before anything else moves.

---

### Task 1: Reconcile the repo with the database

**Files:**
- Create: `supabase/migrations/20260818134538_registry_search.sql`
- Create: `supabase/migrations/20260818192216_add_drai_marketplace_and_publisher_document.sql`
- Create: `supabase/migrations/20260818192550_v_logo_status_marketplace_aware.sql`
- Create: `docs/schema-divergence-2026-08-19.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a repo that can rebuild the live schema. Every later task's view and function edits start from these files rather than from the older definitions.

The three files carry the timestamps the database already records, so they are skipped on production and applied on a fresh or branch database. This is the mechanism `docs/runbooks.md` already documents: "Existing migration files carry the timestamps already recorded in `supabase_migrations.schema_migrations`, so they are skipped rather than re-run."

- [ ] **Step 1: Dump the live definitions**

Use the Supabase MCP `execute_sql` against project `atevamimariwlpidgvog`:

```sql
select pg_get_viewdef('public.v_logo_status'::regclass, true) as v_logo_status;
```

```sql
select pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('registry_search','ingest_publisher_document')
 order by p.proname;
```

```sql
select id, name, base_url, product_url_template from marketplace order by id;
```

```sql
select table_name, string_agg(column_name, ', ' order by ordinal_position) as cols
  from information_schema.columns
 where table_schema='public'
   and table_name in ('publisher_document','v_logo_status')
 group by table_name;
```

- [ ] **Step 2: Confirm the divergence is exactly what this plan claims**

Compare each dumped definition against the repo. Expected: `v_logo_status` differs by two columns, `registry_search` and `ingest_publisher_document` have no repo file at all, and `marketplace` holds a `drai` row that no repo migration inserts.

If anything else differs, stop and report it. This step exists to catch a divergence larger than the one measured on 2026-08-19.

- [ ] **Step 3: Write the three reconciliation migrations**

Each file contains the live definition verbatim, plus its grants, plus a header comment saying it was reconstructed from the running database on 2026-08-19 and why. For example, `20260818192550_v_logo_status_marketplace_aware.sql`:

```sql
-- Reconstructed from the running database on 2026-08-19. This migration was
-- applied to production but its SQL was never committed, so the repo could not
-- rebuild the live schema: the repo's v_logo_status lacked marketplace_id and
-- listing_url, and a rebuild would have broken archive-logos.mjs and every logo
-- on the site.
--
-- The version stamp matches the one already in supabase_migrations, so this is
-- skipped on production and applied only on a fresh or branch database.

create or replace view v_logo_status
with (security_invoker = true) as
<the dumped definition>;

-- create or replace view drops every grant. Keep these here, next to the view.
grant select on public.v_logo_status to anon, authenticated, service_role;
```

- [ ] **Step 4: Verify the reconciliation is a no-op on production**

```sql
select version, name from supabase_migrations.schema_migrations
 where version in ('20260818134538','20260818192216','20260818192550');
```

Expected: three rows. Because the versions are already recorded, the integration skips these files. If any version is absent, the file would execute; confirm it is idempotent before proceeding.

- [ ] **Step 5: Record the divergence and how it happened**

Write `docs/schema-divergence-2026-08-19.md`: what was found, which objects differed, that the branch was in `MIGRATIONS_FAILED`, and the rule the runbook already states. Add a line to `docs/runbooks.md` under "Schema change" pointing at it.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations docs
git commit -m "fix: commit three migrations that were applied but never checked in"
```

- [ ] **Step 7: Establish why the pipeline reports MIGRATIONS_FAILED**

Check the Supabase branch status and the integration's last run. Report the cause. Do not begin Task 2 until either the cause is understood or the user has been told what it is and has said to continue. A migration pipeline in a failed state is not a foundation for a five-migration change.

---

### Task 2: Verification harness

**Files:**
- Create: `scripts/verify-asset-layer.mjs`
- Modify: `package.json` (add two scripts)
- Create: `data/asset-layer-baseline.json` (written by the harness, git-ignored)

**Interfaces:**
- Consumes: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`, each overridable by the environment so the harness can be pointed at a branch database.
- Produces: `npm run verify:baseline` and `npm run verify:asset-layer`. Every later task ends by running the latter.

The harness is written first and fails first. That is the point: it encodes the spec's phase 1 verification list before anything exists to satisfy it.

**Two design decisions, both deliberate:**

Grants are verified by **actually reading as `anon` over PostgREST**, not by inspecting `information_schema`. A catalog row saying the grant exists is not the thing that broke last time; a failed read that returned `{}` is. So the check is an HTTP request with the publishable key that must return 200.

Functions are verified by **calling them in a way that cannot write**. `ingest_capture('{}'::jsonb)` must fail with the function's own validation message, and `set_capture_logo` on a nonexistent product must return `no_capture`. Both prove the body executes and resolves its tables. A function still naming `asset` after the rename fails only when called, and these are the calls.

- [ ] **Step 1: Write the harness**

```js
#!/usr/bin/env node
/**
 * Phase 1 verification for the registry asset layer.
 *
 *   node scripts/verify-asset-layer.mjs --baseline   # before the migrations
 *   node scripts/verify-asset-layer.mjs              # after
 *
 * Point it at a branch database by exporting NEXT_PUBLIC_SUPABASE_URL and the
 * two keys before running. The branch has to pass this in full before
 * production sees the migrations.
 *
 * Grants are checked by reading as anon over PostgREST rather than by reading
 * information_schema. The outage this guards against was a read that returned
 * {} to the site, not a missing catalog row, so the check is the read itself.
 *
 * Every paged read orders by a unique key. PostgREST caps a response at 1000
 * rows and pages without a total order overlap; both have silently truncated
 * this project's reads before.
 */
import fs from "node:fs";

const BASELINE = "data/asset-layer-baseline.json";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const head = (key) => ({ apikey: key, Authorization: `Bearer ${key}` });

async function count(path) {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    headers: { ...head(ANON), Prefer: "count=exact", Range: "0-0" },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return Number(r.headers.get("content-range").split("/")[1]);
}

async function rpc(key, fn, body) {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...head(key), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

/** anon must be able to SELECT from every public read surface. */
const READ_SURFACES = [
  "v_registry_card", "v_asset_passport", "v_asset_change_feed",
  "v_registry_stats", "v_logo_status",
];
const NEW_TABLES = ["asset", "asset_slug", "asset_merge"];

async function snapshot() {
  const r = await fetch(`${URL_BASE}/rest/v1/v_registry_stats?select=*`, { headers: head(ANON) });
  const stats = (await r.json())[0];
  return { stats, listings: await count("v_registry_card?select=asset_id") };
}

const baselineMode = process.argv.includes("--baseline");

if (baselineMode) {
  const snap = await snapshot();
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(snap, null, 2));
  console.log(`baseline written to ${BASELINE}`);
  console.log(JSON.stringify(snap, null, 2));
  process.exit(0);
}

console.log("Phase 1 verification\n");

// 1. anon can read every public surface, including the new tables.
for (const v of [...READ_SURFACES, ...NEW_TABLES]) {
  const r = await fetch(`${URL_BASE}/rest/v1/${v}?select=*&limit=1`, { headers: head(ANON) });
  record(`anon can select from ${v}`, r.ok, r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}`);
}

// 2. Counts and the 1:1 invariant.
const listings = await count("v_registry_card?select=asset_id");
const assets = await count("asset?select=id");
const slugs = await count("asset_slug?select=slug");
const canonical = await count("asset_slug?select=slug&is_canonical=is.true");
const retired = await count("asset?select=id&merged_into=not.is.null");

const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : null;
record("baseline exists", Boolean(base), base ? "" : `run --baseline first`);
if (base) {
  record("listing count unchanged", listings === base.listings, `${listings} vs ${base.listings}`);
}
record("one asset per listing", assets === listings, `${assets} assets, ${listings} listings`);
record("one canonical slug per asset", canonical === assets, `${canonical} canonical, ${assets} assets`);
record("no slug is orphaned", slugs >= assets, `${slugs} slugs`);
record("nothing retired yet in phase 1", retired === 0, `${retired} retired`);

// 3. v_registry_stats is identical, field by field.
if (base) {
  const now = (await snapshot()).stats;
  for (const k of Object.keys(base.stats)) {
    record(`v_registry_stats.${k} unchanged`, String(now[k]) === String(base.stats[k]),
      `${now[k]} vs ${base.stats[k]}`);
  }
}

// 4. v_asset_change_feed exposes both ids.
{
  const r = await fetch(`${URL_BASE}/rest/v1/v_asset_change_feed?select=listing_id,asset_id&limit=1`,
    { headers: head(ANON) });
  record("v_asset_change_feed exposes listing_id and asset_id", r.ok,
    r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}`);
}

// 5. The write path still executes. A function that still names `asset` after
//    the rename fails here and nowhere else. Neither call writes anything.
if (!SERVICE) {
  record("write path exercised", false, "SKIPPED: SUPABASE_SERVICE_ROLE_KEY not set. This is a FAIL, not a skip.");
} else {
  const a = await rpc(SERVICE, "ingest_capture", { payload: {} });
  record("ingest_capture reaches its own validation",
    a.text.includes("capture_meta.source_product_id"),
    a.text.slice(0, 110));

  const b = await rpc(SERVICE, "set_capture_logo",
    { p_product_id: "__verify_no_such_product__", p_url: "https://example.invalid/x.png", p_marketplace_id: "microsoft" });
  record("set_capture_logo executes and reports no_capture",
    b.text.includes("no_capture"), b.text.slice(0, 110));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 2: Add the npm scripts**

In `package.json`, after `"harvest:microsoft"`:

```json
"verify:baseline": "node scripts/verify-asset-layer.mjs --baseline",
"verify:asset-layer": "node scripts/verify-asset-layer.mjs"
```

- [ ] **Step 3: Add the baseline file to .gitignore**

Append `data/asset-layer-baseline.json` to `.gitignore`. It is a machine-local snapshot, not a shared artifact.

- [ ] **Step 4: Capture the baseline against production**

Run: `npm run verify:baseline`

Expected: writes `data/asset-layer-baseline.json` with `listings` around 6876 and the nine `v_registry_stats` fields. Record the exact numbers in the commit message, because they are the "before" the whole phase is measured against.

- [ ] **Step 5: Run the harness and watch it fail**

Run: `npm run verify:asset-layer`

Expected: FAIL. Specifically `anon can select from asset`, `asset_slug` and `asset_merge` fail with 404, and `one asset per listing` fails because `asset` does not exist. The write-path checks should PASS already, which confirms the two calls are sound before the rename can break them.

If `ingest_capture reaches its own validation` fails now, stop: the harness is wrong, not the schema.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-asset-layer.mjs package.json .gitignore
git commit -m "test: phase 1 verification harness for the asset layer"
```

---

### Task 3: Rename `asset` to `listing`

**Files:**
- Create: `supabase/migrations/20260819100000_listing_rename.sql`

**Interfaces:**
- Consumes: the reconciled repo from Task 1.
- Produces: tables `listing` and `listing_change`, and `capture.listing_id`. Every later task refers to these names. `asset` no longer exists until Task 4 creates the new one.

- [ ] **Step 1: Write the migration**

```sql
-- The registry's unit becomes the product, so the table that holds one
-- marketplace's page for something is called what it is: a listing.
--
-- Views follow a rename automatically, because they record dependencies by
-- object identity. plpgsql function bodies are stored as text and do not, so
-- ingest_capture and set_capture_logo are broken from this statement until
-- 20260819100300 recreates them. Both are in the same push, so the window does
-- not exist outside the migration run.

alter table asset rename to listing;
alter table capture rename column asset_id to listing_id;
alter table asset_change rename to listing_change;
alter table listing_change rename column asset_id to listing_id;

-- Constraints, indexes, policies and triggers survive a rename but keep their
-- old names. A policy called asset_public_read on a table called listing
-- misleads the next reader.
alter policy asset_public_read        on public.listing        rename to listing_public_read;
alter policy asset_change_public_read on public.listing_change rename to listing_change_public_read;
alter trigger asset_change_suppress_cross_method on public.listing_change
  rename to listing_change_suppress_cross_method;
alter index capture_asset_time_idx  rename to capture_listing_time_idx;
alter index asset_change_asset_idx  rename to listing_change_listing_idx;
alter index asset_change_field_idx  rename to listing_change_field_idx;

comment on table listing is
  'One marketplace''s page for something. A listing is evidence about an asset, not the asset itself.';
comment on table listing_change is
  'What moved between two consecutive captures of the same listing: pricing changes, permission scope growth, an attestation appearing or lapsing, a residency claim quietly dropped.';

-- The comment on capture was not accurate. Of 30,900 captures, 187 have a null
-- raw: 140 backfill, and 47 dual_write on template_version 2.0, captured in a
-- two-hour window on 2026-08-17 during the manual capture era. No listing's
-- current capture is among them, so every listing's newest observation is fully
-- backed by its source material.
comment on table capture is
  'One immutable observation of one listing. Never updated, never deleted. raw holds the capture file verbatim so extraction can be improved and re-run without re-scraping. raw is null for 187 superseded rows: 140 backfilled from a pre-Supabase index, and 47 from the template 2.0 manual capture era. No listing''s current capture has a null raw.';
```

- [ ] **Step 2: Verify the index and policy names before writing them**

The names above were read from `registry_core.sql` and `capture_method_and_baseline.sql`. Confirm against the live database, because a wrong name fails the whole migration:

```sql
select indexname from pg_indexes where tablename in ('capture','asset_change');
select polname, polrelid::regclass from pg_policy where polrelid::regclass::text in ('asset','asset_change');
select tgname from pg_trigger where tgrelid = 'asset_change'::regclass and not tgisinternal;
```

Correct the migration to match what is actually there.

- [ ] **Step 3: Do not push yet**

This migration alone leaves `ingest_capture` and `set_capture_logo` broken. Tasks 4 through 7 land in the same push. Commit, do not deploy.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260819100000_listing_rename.sql
git commit -m "feat: rename asset to listing, and correct the capture comment"
```

---

### Task 4: The asset, asset_slug and asset_merge tables

**Files:**
- Create: `supabase/migrations/20260819100100_asset_layer_tables.sql`

**Interfaces:**
- Consumes: `listing` from Task 3.
- Produces: `asset(id, primary_listing_id, merged_into, created_at, updated_at)`, `asset_slug(slug, asset_id, is_canonical, created_at)`, `asset_merge(...)`. Task 5 backfills them, Task 6 writes to them, Task 7 reads them.

- [ ] **Step 1: Write the migration**

```sql
-- The registry's unit. One row per real product; a listing is one marketplace's
-- page about it.

create table asset (
  id                 uuid primary key default gen_random_uuid(),
  primary_listing_id uuid,                       -- FK added below, after listing exists
  merged_into        uuid references asset(id),  -- non-null means retired
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table asset is
  'One real product. Listings are evidence about it. An asset with merged_into set has been merged away and is retained only so the merge log stays valid; every count of assets must exclude it.';
comment on column asset.primary_listing_id is
  'Which listing supplies the headline fields. Stored rather than derived: a rule like "most captures" would silently change a product''s headline whenever data moved.';

-- asset.primary_listing_id and listing.asset_id reference each other. The same
-- shape already exists between asset.current_capture_id and capture, and is
-- solved the same way: add the constraint once both tables exist.
alter table asset
  add constraint asset_primary_listing_fk
  foreign key (primary_listing_id) references listing(id) on delete set null;

create index asset_merged_into_idx on asset (merged_into) where merged_into is not null;

-- Slugs are their own table so an asset can answer to several, which is what
-- keeps a merged-away product's URL resolving. Uniqueness is enforced here
-- because the existing index is on (marketplace_id, source_product_id), never
-- on source_product_id alone.
create table asset_slug (
  slug         text primary key,
  asset_id     uuid not null references asset(id) on delete cascade,
  is_canonical boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index asset_slug_one_canonical on asset_slug (asset_id) where is_canonical;
create index asset_slug_asset_idx on asset_slug (asset_id);

comment on table asset_slug is
  'Every URL an asset answers to. The canonical one is what the site links; the rest are earlier identities kept alive so no link ever breaks.';

-- The claim that two listings are the same product is ours. No marketplace
-- makes it, so it carries provenance like everything else here.
create table asset_merge (
  id             bigserial primary key,
  from_asset_id  uuid not null references asset(id),
  into_asset_id  uuid not null references asset(id),
  listing_ids    uuid[] not null,
  slugs          text[] not null,
  basis          text not null,
  merged_by      text not null,
  merged_at      timestamptz not null default now(),
  undone_at      timestamptz
);
create index asset_merge_into_idx on asset_merge (into_asset_id, merged_at desc);

comment on column asset_merge.merged_by is
  'A handle, never an email. This table is publicly readable.';
comment on column asset_merge.listing_ids is
  'Exactly what moved, so unmerge_asset can move it back. Captures and extracts are never touched by either direction.';

-- RLS is on for every table in this schema and the existing policies were
-- created by a loop over a hardcoded array, so a new table inherits nothing.
-- A table with RLS on and no policy is invisible to anon.
alter table asset       enable row level security;
alter table asset_slug  enable row level security;
alter table asset_merge enable row level security;

create policy asset_public_read       on public.asset       for select to anon, authenticated using (true);
create policy asset_slug_public_read  on public.asset_slug  for select to anon, authenticated using (true);
create policy asset_merge_public_read on public.asset_merge for select to anon, authenticated using (true);

grant select on public.asset, public.asset_slug, public.asset_merge
  to anon, authenticated, service_role;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260819100100_asset_layer_tables.sql
git commit -m "feat: add the asset, asset_slug and asset_merge tables"
```

---

### Task 5: Backfill one asset and one slug per listing

**Files:**
- Create: `supabase/migrations/20260819100200_asset_layer_backfill.sql`

**Interfaces:**
- Consumes: `listing` and the three tables from Task 4.
- Produces: `listing.asset_id`, `not null`, populated for every row; one canonical `asset_slug` per asset whose slug is the listing's `source_product_id`. Task 6 relies on `asset_id` never being null for a pre-existing listing.

- [ ] **Step 1: Write the migration**

```sql
alter table listing add column asset_id uuid references asset(id);

-- Seed slugs are only safe because source_product_id happens to be unique
-- across marketplaces today: 6,876 listings, 6,876 distinct values. The unique
-- index is on the pair, not on source_product_id alone, so that is luck rather
-- than a constraint. Assert it here so a collision is a clear message and not a
-- primary-key violation halfway through the migration.
do $$
declare n int;
begin
  select count(*) into n
    from (select source_product_id from listing group by 1 having count(*) > 1) d;
  if n > 0 then
    raise exception
      'cannot seed slugs: % source_product_id values are shared by more than one listing', n;
  end if;
end $$;

with made as (
  insert into asset (primary_listing_id)
  select l.id from listing l
  returning id as asset_id, primary_listing_id
)
update listing l
   set asset_id = made.asset_id
  from made
 where made.primary_listing_id = l.id;

alter table listing alter column asset_id set not null;
create index listing_asset_idx on listing (asset_id);

comment on column listing.asset_id is
  'Every listing belongs to exactly one asset, always. A newly harvested listing that matches nothing gets a fresh asset of its own, so the default state of a scraped listing is that it is its own product.';

-- source_product_id is the seed slug because that is what /agent/[id] already
-- carries, so every existing URL keeps resolving with no redirect.
insert into asset_slug (slug, asset_id, is_canonical)
select l.source_product_id, l.asset_id, true from listing l;

do $$
declare n_listing int; n_asset int; n_slug int;
begin
  select count(*) into n_listing from listing;
  select count(*) into n_asset   from asset;
  select count(*) into n_slug    from asset_slug where is_canonical;
  if not (n_listing = n_asset and n_asset = n_slug) then
    raise exception 'backfill left them unequal: % listings, % assets, % canonical slugs',
      n_listing, n_asset, n_slug;
  end if;
end $$;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260819100200_asset_layer_backfill.sql
git commit -m "feat: give every listing its own asset and canonical slug"
```

---

### Task 6: The write path

**Files:**
- Create: `supabase/migrations/20260819100300_asset_layer_write_path.sql`

**Interfaces:**
- Consumes: `listing`, `asset`, `asset_slug`.
- Produces: `ingest_capture(payload jsonb)` returning `{status, listing_id, asset_id, capture_id, content_hash, unchanged, changes, reach, risk, layers_known, evidence_rejected, slug_fallback}`, and `set_capture_logo(p_product_id, p_url, p_marketplace_id)` unchanged in signature and return shape.

**This is the task that touches the evidence gate.** The gate must come through byte-identical.

- [ ] **Step 1: Extract the current function body as the starting point**

```bash
git show HEAD~3:supabase/migrations/20260816163520_ingest_capture_rpc_v2.sql > /tmp/ingest_current.sql
```

Its body md5 is `d9156fc8d49d2bcd6aafb1e0c4b7edc6` and matches the live function exactly, verified 2026-08-19. Copy it whole, then change only what the next steps name.

- [ ] **Step 2: Replace the asset resolution block**

Replace this, near the top of the function:

```sql
  insert into asset (marketplace_id, source_product_id, listing_url)
  values (v_mkt, v_pid,
          coalesce(meta ->> 'listing_url',
                   'https://marketplace.microsoft.com/en-us/product/' || v_pid))
  on conflict (marketplace_id, source_product_id) do update set updated_at = now()
  returning id into v_asset;

  select id into v_prev from capture where asset_id = v_asset order by captured_at desc limit 1;
```

with this. The asset has to exist first, because `listing.asset_id` is `not null` and `NOT NULL` cannot be deferred:

```sql
  select id, asset_id into v_listing, v_asset
    from listing
   where marketplace_id = v_mkt and source_product_id = v_pid;

  if v_listing is null then
    insert into asset default values returning id into v_asset;

    begin
      insert into listing (marketplace_id, source_product_id, listing_url, asset_id)
      values (v_mkt, v_pid,
              coalesce(meta ->> 'listing_url',
                       'https://marketplace.microsoft.com/en-us/product/' || v_pid),
              v_asset)
      returning id into v_listing;
      v_new_listing := true;
    exception when unique_violation then
      -- Another transaction created this listing between the select and the
      -- insert. Its asset wins; ours is discarded unused.
      delete from asset where id = v_asset;
      select id, asset_id into v_listing, v_asset
        from listing
       where marketplace_id = v_mkt and source_product_id = v_pid;
      v_new_listing := false;
    end;

    if v_new_listing then
      update asset set primary_listing_id = v_listing where id = v_asset;

      insert into asset_slug (slug, asset_id, is_canonical)
      values (v_pid, v_asset, true)
      on conflict (slug) do nothing;

      if not found then
        insert into asset_slug (slug, asset_id, is_canonical)
        values (v_mkt || '-' || v_pid, v_asset, true);
        v_slug_fallback := true;
      end if;
    end if;
  else
    update listing set updated_at = now() where id = v_listing;
  end if;

  select id into v_prev from capture where listing_id = v_listing order by captured_at desc limit 1;
```

Add to the `declare` block:

```sql
  v_listing       uuid;
  v_new_listing   boolean := false;
  v_slug_fallback boolean := false;
```

- [ ] **Step 3: Repoint the remaining references from asset to listing**

Four more places in the same function:

- `insert into capture (asset_id, ...)` becomes `insert into capture (listing_id, ...)`, and its `values (v_asset, ...)` becomes `values (v_listing, ...)`.
- `insert into asset_change (asset_id, ...)` becomes `insert into listing_change (listing_id, ...)`, and `values (v_asset, v_prev, ...)` becomes `values (v_listing, v_prev, ...)`.
- `update asset set current_capture_id = ... where id = v_asset` becomes `update listing set ... where id = v_listing`.
- The return object gains `listing_id` and keeps `asset_id`, now meaning the product:

```sql
  return jsonb_build_object(
    'status', case when v_prev is null then 'created' else 'updated' end,
    'listing_id', v_listing, 'asset_id', v_asset, 'capture_id', v_capture,
    'slug_fallback', v_slug_fallback,
    'content_hash', v_hash, 'unchanged', (v_prev is not null and changes = 0),
    'changes', changes, 'reach', v_reach, 'risk', v_risk ->> 'risk',
    'layers_known', n_layers,
    'evidence_rejected', (select count(*) from capture_evidence
                           where capture_id = v_capture and not verified));
```

No harvest script reads `asset_id` from this result. Verified across every `.mjs`: they read only `status`, `reach` and `risk`. The key is kept and given its new meaning rather than removed, because silently repurposing it would be the trap; a script that starts reading it later gets the product.

- [ ] **Step 4: Leave the gate alone**

Do not touch anything between `hay_listing := concat_ws(...)` and the end of the `for k in select jsonb_object_keys(...)` loop, nor the `Microsoft Graph` permission block that follows it. Not the whitespace, not a comment.

- [ ] **Step 5: Repoint set_capture_logo**

In the same migration, recreate `set_capture_logo` with its body unchanged except:

```sql
  select a.current_capture_id into v_capture
    from asset a
   where a.marketplace_id = p_marketplace_id and a.source_product_id = p_product_id;
```

becomes

```sql
  select l.current_capture_id into v_capture
    from listing l
   where l.marketplace_id = p_marketplace_id and l.source_product_id = p_product_id;
```

Keep the signature, the return shapes, and the grants:

```sql
revoke all on function set_capture_logo(text, text, text) from public, anon, authenticated;
grant execute on function set_capture_logo(text, text, text) to service_role;
```

Same for `ingest_capture`:

```sql
revoke all on function ingest_capture(jsonb) from public, anon, authenticated;
grant execute on function ingest_capture(jsonb) to service_role;
```

- [ ] **Step 6: Prove the gate is byte-identical**

```bash
node -e "const fs=require('fs');const g=s=>{const a=s.indexOf('hay_listing :=');const b=s.indexOf('insert into capture_plan');return s.slice(a,b)};const before=g(fs.readFileSync('supabase/migrations/20260816163520_ingest_capture_rpc_v2.sql','utf8'));const after=g(fs.readFileSync('supabase/migrations/20260819100300_asset_layer_write_path.sql','utf8'));console.log(before===after?'GATE IDENTICAL':'GATE CHANGED');process.exit(before===after?0:1)"
```

Expected: `GATE IDENTICAL`. If it prints `GATE CHANGED`, revert the gate region and try again. This check is not optional and its result goes in the commit message.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260819100300_asset_layer_write_path.sql
git commit -m "feat: ingest_capture creates a listing and its asset, gate untouched"
```

---

### Task 7: Recreate the views

**Files:**
- Create: `supabase/migrations/20260819100400_asset_layer_views.sql`

**Interfaces:**
- Consumes: everything above.
- Produces: `v_registry_card`, `v_asset_passport`, `v_asset_change_feed`, `v_registry_stats` and `v_logo_status`, each keeping its current grain, each exposing `listing_id` and a real `asset_id` where it exposed `asset_id` before, and each re-granted.

**Start from the live definitions dumped in Task 1, not from the repo's older ones.** `v_logo_status` in particular differs: live carries `marketplace_id` and `listing_url` that the repo's original never had.

- [ ] **Step 1: Dump the current definitions**

```sql
select c.relname, pg_get_viewdef(c.oid, true) as def
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'v'
   and c.relname in ('v_registry_card','v_asset_passport','v_asset_change_feed',
                     'v_registry_stats','v_logo_status')
 order by c.relname;
```

- [ ] **Step 2: Apply exactly these changes to each**

For every view: the `from asset a` clause becomes `from listing l`, with the alias updated throughout, and `join capture c on c.id = a.current_capture_id` becomes `l.current_capture_id`.

**Append new columns; never reorder or rename an existing one.** `create or replace view` requires the replacement to produce the existing columns with the same names, types and order, and permits new ones only at the end. Changing what an existing column is *sourced from* is fine. Getting this wrong is not a style question: Task 1 hit exactly this and Postgres refused the migration outright with `cannot change name of view column`.

So for `v_registry_card` and `v_asset_passport`: leave `asset_id` exactly where it sits in the column list and change only its source.

```sql
  l.asset_id     as asset_id,      -- in its existing position, now the real product
  ...
  l.id           as listing_id,    -- appended at the very end
```

`asset_id` is the real product from this migration onward, rather than a listing id wearing the wrong name for a phase. Assets and listings are 1:1 in phase 1, so `getPassports(assetIds)` in `lib/registry.ts` keeps working either way.

For `v_asset_change_feed`: same rule. `asset_id` stays second, where `lib/types.ts` `ChangeRow` expects it, now sourced as `l.asset_id`; `listing_id` is appended last.

```sql
from listing_change ch
join listing l         on l.id = ch.listing_id
join capture_extract x on x.capture_id = l.current_capture_id
```

Keep `id`, `source_product_id`, `name`, `publisher`, `field`, `old_value`, `new_value`, `observed_at` in their existing order: `ChangeRow` names them.

Appending rather than reordering also avoids a drop-ordering problem. `v_registry_stats` selects from `v_registry_card`, so dropping the card would require dropping the stats view first or cascading through it. (`registry_search` also reads `v_registry_card`, but it is a text-bodied SQL function, which Postgres does not dependency-track.) If any view here ever genuinely needs its columns reordered, it must be a `drop view` and `create view` pair in dependency order, with every grant reissued.

For `v_registry_stats`: two counts change and the rest stay.

```sql
  (select count(*) from asset where merged_into is null)   as agents,
  (select count(distinct marketplace_id) from listing)     as marketplaces,
```

A retired asset is kept so the merge log stays valid, so counting `asset` without that filter would leave the headline frozen no matter how many merges landed. Marketplace membership is a property of listings and always was. Every other field keeps its current expression, with `asset` renamed to `listing` where it appears.

For `v_logo_status`: only the table name and alias change. Its ten columns stay exactly as they are, `marketplace_id` and `listing_url` included, because `archive-logos.mjs` builds its storage keys from them.

- [ ] **Step 3: Put the grants immediately after each view**

Not in a block at the bottom, and next to every view whether or not this particular change strictly needs it.

The mechanism is worth stating correctly, because the repo currently records it wrongly. A **column-compatible** `create or replace view` preserves grants. What loses them is a `drop view`, and changing a view's column names or order forces exactly that. That is what happened during the logo outage: the replacement changed `v_logo_status`'s column shape, so it could only have been a drop and recreate, `anon` lost SELECT, and every logo on the site fell back to initials while the registry still held all 6,820 images. `getLogos` returns `{}` on error, so nothing surfaced.

Step 2 keeps every view in this task column-compatible, so grants should survive. The grant statements go in anyway: they cost nothing, they are required the moment anyone does need a drop, and the assertion in Step 4 is what actually proves the outcome rather than the reasoning.

```sql
create or replace view v_logo_status with (security_invoker = true) as
  ...;
grant select on public.v_logo_status to anon, authenticated, service_role;
```

`v_logo_status` is the only one that needs `service_role`; the other four take `anon, authenticated`.

- [ ] **Step 4: End the migration with a grant assertion**

```sql
do $$
declare missing text;
begin
  select string_agg(format('%s -> %s', v, r), ', ') into missing
    from (values
      ('v_registry_card'),('v_asset_passport'),('v_asset_change_feed'),
      ('v_registry_stats'),('v_logo_status')) as views(v)
    cross join (values ('anon'),('authenticated')) as roles(r)
   where not has_table_privilege(r, 'public.' || v, 'SELECT');
  if missing is not null then
    raise exception 'grants missing after view replacement: %', missing;
  end if;
  if not has_table_privilege('service_role', 'public.v_logo_status', 'SELECT') then
    raise exception 'service_role lost SELECT on v_logo_status; archive-logos.mjs will fail with 42501';
  end if;
end $$;
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260819100400_asset_layer_views.sql
git commit -m "feat: views read through listing and expose the real asset_id"
```

---

### Task 8: Verify on a branch database

**Files:** none changed. This task is the gate.

**Interfaces:**
- Consumes: every migration from Tasks 3 to 7, and the harness from Task 2.
- Produces: a pass or a discarded branch.

The rename has no down-migration worth trusting. Verification happens where failure costs nothing.

- [ ] **Step 1: Open the pull request**

Push the branch and open the PR. Supabase branching is enabled on this project, so the integration creates a preview database for the PR and applies every migration to it.

- [ ] **Step 2: Confirm the branch applied the migrations**

Use the Supabase MCP `list_branches` for project `atevamimariwlpidgvog`. Wait for the PR's branch to reach a non-pending status.

Expected: `MIGRATIONS_PASSED`. If it reports `MIGRATIONS_FAILED`, read the error, fix the migration, push again. Nothing touches production while this loops.

- [ ] **Step 3: Point the harness at the branch**

Get the branch's URL and keys from the Supabase dashboard, then:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<branch-ref>.supabase.co \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<branch publishable key> \
SUPABASE_SERVICE_ROLE_KEY=<branch service role key> \
npm run verify:asset-layer
```

Do not run `npm run verify:baseline` against the branch. On a data-less branch the baseline validation refuses to write an incomplete snapshot, so the run just fails; on a data-carrying branch it would silently overwrite `data/asset-layer-baseline.json`, the production baseline, which is the one artifact that cannot be regenerated after this merges.

The branch is seeded from production's schema without data by default, so thirteen checks fail by design and are expected to: `every listing maps to a distinct asset` (its `rows.length > 0` guard deliberately requires a non-empty result to pass), `listing count unchanged`, `v_logo_status row count unchanged`, `v_asset_passport row count unchanged`, and all nine `v_registry_stats.*` comparisons. Three more checks pass on a data-less branch, but only vacuously, at `0 == 0`, and prove nothing there: `one asset per listing`, `one canonical slug per asset`, `slug count is at least the asset count`.

A branch pass means every check other than those thirteen passed. That is the gate, not a literal "every check passes."

- [ ] **Step 4: Exercise the write path against the branch**

This is the check that inspection cannot substitute for, but the two calls in the harness do not prove the same thing, and neither writes.

`set_capture_logo executes and reports no_capture` is genuinely exercised against `listing`: its probe runs `select l.current_capture_id from listing l ...` before returning `no_capture`, so a version still naming `asset` fails right here with `relation "asset" does not exist`.

`ingest_capture reaches its own validation` is not exercised against any table. Called with an empty payload, it raises at its first guard, `if v_pid is null or ex is null`, and the declare block above that guard touches no relation, so execution never reaches the `listing` select. A version of `ingest_capture` still saying `from asset` would pass this check and this check would say nothing about it: Postgres only syntax-checks a plpgsql body, it does not resolve object names until a statement actually runs. This check proves only that `ingest_capture` exists, is callable by `service_role`, and reaches its own validation.

If `set_capture_logo executes and reports no_capture` fails with a message mentioning `relation "asset" does not exist`, Task 6 missed a reference in that function. Find it, fix it, push, and repeat from Step 2.

- [ ] **Step 5: Prove `ingest_capture` resolves the renamed tables**

This is the only place `ingest_capture` is proved to resolve the renamed tables, and it is why the branch database exists: writing here is free and harmless.

Call `ingest_capture` with a complete sentinel payload for a `source_product_id` that does not exist, then call it again with the same id and one changed field. Confirm the first returns `status: created` and the second `status: updated`, that exactly one listing, one asset and one canonical slug exist for it afterwards, and that the returned `asset_id` is unchanged between the two calls.

If either call fails with a message mentioning `relation "asset" does not exist`, Task 6 missed a reference. Find it, fix it, push, and repeat from Step 2.

- [ ] **Step 6: Run the app**

```bash
npm run typecheck
npm run test
```

There are no rows and no product id on a data-less branch, so `/registry` and `/agent/<source_product_id>` cannot be exercised against it as written. Run that render check against production instead, immediately after deploy: point `.env.local` at production, run `npm run dev`, open `/registry` and one `/agent/<source_product_id>` page, and confirm both render exactly as they did before the merge. This catches anything the harness does not: a view column the app reads that quietly changed name.

- [ ] **Step 7: Report before merging**

Post the harness output on the PR. A branch pass means every check other than the thirteen listed in Step 3 passed, and that the three vacuous ones there proved nothing. Merging is the user's call, not the implementer's.

---

### Task 9: Update the docs that describe the old shape

**Files:**
- Modify: `docs/runbooks.md:83`, `:89`, `:93`, `:104-105`
- Modify: `docs/capture-integration.md:113`
- Modify: `docs/marketplace-harvest.md:234`, `:244`

**Interfaces:**
- Consumes: the finished schema.
- Produces: documentation that describes what exists.

The specs under `docs/superpowers/specs/` are historical records of decisions and are left alone.

- [ ] **Step 1: Fix the runbook's health-check SQL**

`docs/runbooks.md` line 83 joins `asset a on a.id = c.asset_id`, which becomes `listing l on l.id = c.listing_id`. Line 93 selects `from asset where capture_count > 1`, which becomes `from listing`. Line 89 reads `v_asset_change_feed`, which still exists and still works.

- [ ] **Step 2: Correct the runbook's claim about backfilled rows**

Lines 104 to 105 say `capture.raw` is NULL for "the 140 backfilled rows". It is null for 187: 140 backfill and 47 from the template 2.0 manual capture era. Say that, and add that no listing's current capture is among them.

- [ ] **Step 3: Update the two harvest docs**

`docs/capture-integration.md` line 113 documents the ingest result's `changes` field as "rows written to asset_change"; that table is now `listing_change`. Document the new `listing_id` and `slug_fallback` keys in the same block, and note that `asset_id` now means the product.

`docs/marketplace-harvest.md` lines 234 and 244 refer to `asset_change` rows; rename to `listing_change`.

- [ ] **Step 4: Check nothing was missed**

```bash
grep -rn "asset_change\|from asset\|join asset\|c.asset_id" docs/*.md scripts/ lib/ app/ components/
```

Expected: no hits outside `docs/superpowers/specs/`.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs: describe listings and the asset layer"
```

---

## Self-review

**Spec coverage.** Every phase 1 item in the spec maps to a task: the renames and the capture comment to Task 3; the three new tables with RLS and grants to Task 4; the uniqueness assertion, backfill and `not null` to Task 5; the `ingest_capture` reordering, the slug fallback, the return contract and `set_capture_logo` to Task 6; the view recreation, the additive `listing_id` and `asset_id`, the retired-asset exclusion and the grant assertion to Task 7; the branch-database requirement and the whole phase 1 verification list to Tasks 2 and 8.

Two spec items are deliberately not here because they belong to phase 2: `v_listing_passport` and `v_asset_evidence`, and the `search_blob` and array-containment facet work. The spec assigns all of them to phase 2.

One spec claim is corrected by this plan: the spec says the harvest scripts consume `asset_id` from the ingest result. They do not. Verified across every `.mjs`: they read `status`, `reach` and `risk` only. The return key is still kept and given its new meaning, for the reason stated in Task 6 Step 3.

**Task 1 is not in the spec at all.** The spec was written before the repo-versus-database divergence was found. It is a prerequisite rather than a change of design, and it is documented at the top of this plan.

**Placeholder scan.** No TBD, no "handle errors appropriately", no "similar to Task N". Two steps deliberately instruct the implementer to work from a live dump rather than from pasted SQL: Task 1 Step 1 and Task 7 Step 1. That is not a placeholder, it is the only correct source, because the repo's copies of those objects are known to be stale and pasting them here would bake the staleness in.

**Type consistency.** `v_listing`, `v_asset`, `v_new_listing` and `v_slug_fallback` are declared in Task 6 Step 2 and used in Steps 2 and 3. `listing.asset_id` is created in Task 5 and read by Task 6 and Task 7. `asset.primary_listing_id` is created in Task 4, populated in Task 5 and Task 6. The ingest return keys named in Task 6 Step 3 match those documented in Task 9 Step 3.

---

## After this merges

Task 9 ends the implementation. Nothing above proves the claim phase 1 exists to prove, that the registry after phase 1 is exactly the registry before it, because a branch database has no data to prove it with. That evidence comes only from running the harness against production after the merge. In order:

1. Quiesce the capture worker before the push. Each migration file is its own transaction, so a harvest landing between the rename and the function rewrite fails with `relation "asset" does not exist`, and the `add column` in the backfill migration takes an ACCESS EXCLUSIVE lock that would queue behind an open ingest.

2. Re-capture the baseline immediately before the push: `npm run verify:baseline` against production. So drift in `captures`, `changes` and `last_captured_at` between when the baseline was last written and when the migrations actually land does not produce failures someone has to reason away afterward.

3. Run `npm run verify:asset-layer` against production. Every check must pass, with no expected-failure list this time: production has data, so none of the thirteen branch exceptions in Task 8 Step 3 apply.

4. Run `npm run test:parity`, since `registry_search` joins on `asset_id` and that column changed meaning: it named a listing before this phase and names a real product after it.

5. Confirm `v_logo_status` returns a non-zero count to both `anon` and `service_role`. The definer-to-invoker flip in Task 7 is production-only, since the branch never carried the SECURITY DEFINER version to flip, and its failure mode is silent: a broken invoker view returns an empty result, not an error.

6. Re-run the Supabase linter and confirm the `v_logo_status` SECURITY DEFINER error has cleared.
