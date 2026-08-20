# Registry Asset Layer, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `asset` to `listing`, introduce an `asset` table above it, and give every existing listing its own asset and slug, with the deployed site behaving identically throughout.

**Architecture:** Five ordered migrations applied in one push: rename, new tables, backfill, write path, views. Assets and listings stay 1:1, so nothing a visitor sees changes. A verification harness written before the migrations proves the invariants. It was to run against a Supabase branch database before production; the project turned out not to have branching, so Task 8 replaces that gate with a local Postgres container and records the unmet spec requirement as a deviation.

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
- **Phase 1 was to be verified in full on a Supabase branch database before it reaches production, and it was not.** The project does not have branching, so no preview database exists. Task 8 substitutes a local Postgres container carrying production's roles, and states in full which risks that substitution leaves uncovered. This is a live deviation from the spec, not a resolved one.
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

### Task 8: Verify on a local Postgres container

**Files:**
- Create: `scripts/gate/run.sh`, `scripts/gate/01-roles.sql`, `scripts/gate/02-seed.sql`, `scripts/gate/03-harness.sql`, `scripts/gate/04-reads.sql`, `scripts/gate/05-negative.sql`, `scripts/gate/06-sentinel.sql`, `scripts/gate/07-final.sql`

**Interfaces:**
- Consumes: every migration from Tasks 1 to 7.
- Produces: a pass, or a container thrown away and a migration fixed.

The rename has no down-migration worth trusting. Verification happens where failure costs nothing.

**This task was rewritten after the fact.** It originally instructed the operator to push the branch, wait for Supabase to build a preview database for the PR, and point `verify-asset-layer.mjs` at it. **This project does not have Supabase branching.** There is no preview database and there is no way to make one, so none of that could be run. What follows is what was actually run in its place, and it is written so it can be run again: `bash scripts/gate/run.sh`.

#### Deviation from the spec, recorded rather than dropped

The spec, `docs/superpowers/specs/2026-08-19-registry-asset-layer-design.md`, says at "Migration and deploy order":

> **Phase 1 runs on a Supabase branch database first.** [...] This is a requirement of the phase, not a suggestion for the day.

**That requirement is not met.** The reason is that branching is not enabled on this project, which was established after the plan was written. The gate below is a substitute, not an equivalent, and the risks it cannot reach are listed at Step 8. Nobody should read a passing container run as the branch verification the spec asked for.

What makes the substitute worth running rather than skipping: the container replays already done during Tasks 1 to 7 covered the DDL, the data logic and the write path, but every one of them ran as the superuser. The layer none of them touched is the one the site actually reads through, which is `anon` and `service_role` against grants and RLS. That layer is plain Postgres rather than anything Supabase adds, so it reproduces locally, and it is exactly where this project's failures have been silent. A missing grant or a missing policy returns an empty result rather than an error, PostgREST answers it with HTTP 200 and `[]`, and `getLogos` in `lib/registry.ts` turns that into initials. That is how all 6,820 logos left the live site once without anything reporting a fault.

- [ ] **Step 1: Build the container and create the roles the way Supabase has them**

`postgres:17-alpine`, matching production's Postgres 17. Three roles are created before any migration runs, because the migrations grant to them and would fail otherwise. Verified against production on 2026-08-19: `anon` and `authenticated` are `NOBYPASSRLS`, `service_role` is `BYPASSRLS`.

```sql
create role anon          nologin noinherit nobypassrls;
create role authenticated nologin noinherit nobypassrls;
create role service_role  nologin noinherit bypassrls;
grant usage on schema public to anon, authenticated, service_role;
```

Two fidelity decisions are load-bearing and both are argued in `scripts/gate/01-roles.sql`:

`grant usage on schema public to service_role` is in the bootstrap even though no migration in this repo grants it. It has to be, because production evidently has it: `20260818140000` records that `archive-logos.mjs` failed with `42501 permission denied for view v_logo_status`, which is a relation-level error. Had `service_role` lacked schema usage the error would have been `permission denied for schema public` instead.

Supabase's blanket `alter default privileges in schema public grant all on tables to anon, authenticated, service_role` is deliberately **not** reproduced. The same migration records that on production `service_role` "in fact held SELECT on nothing at all in public", which can only be true if those default privileges are absent. Leaving them out also makes the container a lower bound on privilege: every read asserted below passes with fewer grants than production has, so it would pass with more.

- [ ] **Step 2: Replay every migration before the rename**

Filename order, one transaction per file, matching how Supabase applies them. The five asset-layer migrations are held back.

Expected: nineteen files, all OK. Three emit NOTICEs about `drop trigger if exists` on a trigger that does not exist yet and about ICU locale normalisation. Those are benign.

- [ ] **Step 3: Seed through the OLD `ingest_capture`**

This ordering is the point of the step and it is what production will do. Seeding before the rename means every row the checks below read is a row the **backfill** produced, not a row the new code made. Seeding afterwards would prove only that new writes work, which is the easier half.

`scripts/gate/02-seed.sql` calls `ingest_capture` as `service_role`, so the execute grant is exercised rather than assumed. It creates three listings across both marketplaces, re-ingests one of them with changed pricing so the old function writes `asset_change` rows, sets a logo on two of them through `set_capture_logo`, and archives one through `record_link_archive`.

The seed must reach every view. The views inner-join `capture_extract`, so an empty database makes every check below pass vacuously and prove nothing. In particular it must include at least one listing with a logo link, because `v_logo_status` is the view whose failure is silent, and at least one with `graph_permissions`, so `capture_permission` is populated.

- [ ] **Step 4: Apply the five asset-layer migrations**

Rename, tables, backfill, write path, views. Each in its own transaction.

The backfill migration carries its own `raise exception` if listings, assets and canonical slugs do not come out equal, so a wrong backfill aborts here rather than being caught later.

- [ ] **Step 5: Read every view as `anon`, asserting a NON-ZERO row count**

`set role anon`, then `select count(*)` from each of `v_registry_card`, `v_asset_passport`, `v_asset_change_feed`, `v_registry_stats` and `v_logo_status`, and from the three new tables `asset`, `asset_slug` and `asset_merge`.

**A zero-row result is a FAIL, not a pass.** Statement success is not the assertion. A view returning nothing is indistinguishable from a view working unless the count is checked, which is the whole reason this step exists.

Two details that are easy to get wrong:

`v_registry_stats` needs a different assertion from the other four. It is nine independent scalar subqueries, so it returns exactly one row whatever happens underneath, and Postgres does not evaluate a scalar subquery that `count(*)` never reads. A row-count assertion on it is vacuous: Step 7 shows it returning 1 while `anon` holds no SELECT on `capture_extract` at all. Its **values** are what has to be asserted, and `gate.check_stats` does that.

`asset_merge` is legitimately empty after the backfill and will be empty on production too. An empty table cannot demonstrate that `anon` can read it, so the harness inserts one synthetic row for the read to return. It leaves `merged_into` alone, so no view's counts move.

- [ ] **Step 6: Read `v_logo_status` as `service_role`, asserting non-zero**

This is the newly load-bearing one. Task 7 flips this view from SECURITY DEFINER to `security_invoker`, so from here on `service_role` must satisfy grants on `listing`, `capture_extract` and `capture_link` directly rather than inheriting the view owner's rights. `archive-logos.mjs` is the only pass that reads a relation instead of calling a definer function, so it is the only one a missing grant reaches.

The three base tables are read as `service_role` too, so a failure says which grant is missing rather than only that the view is unreadable.

`service_role` getting `42501` on the other four views is the designed grant surface, not a regression: they are granted to `anon` and `authenticated` only, in this repo as on production. The harness records those four as informational.

- [ ] **Step 7: Prove the negative**

A check that has never been observed failing is not known to work. Break `anon`'s access to `capture_extract`, which all five views inner-join, confirm every assertion above goes red, restore it, and confirm they go green again.

Two breakages, because they do not behave the same way and the difference is the subject of this whole gate:

**Drop the RLS policy.** This is the silent one. RLS stays on, `anon` keeps its SELECT grant, every statement succeeds, and the four row-returning views return nothing at all. Nothing reports a fault anywhere.

**Revoke the SELECT grant.** This is the loud one. The views are `security_invoker`, so `anon`'s own rights are what the underlying scan is checked against, and Postgres refuses with `42501 permission denied for table capture_extract`. Loud at the SQL and HTTP layers, though `getLogos` still swallows it into initials.

Expect the stats view to misbehave in an instructive way under the silent breakage. `agents`, `captures`, `changes`, `marketplaces` and `last_captured_at` are read straight off `listing`, `capture` and `listing_change` and stay correct, while everything sourced through `v_registry_card` collapses to zero or null. The banner would keep claiming agents exist while the list below it showed none.

- [ ] **Step 8: Sentinel ingest**

This is the only place `ingest_capture` is proved to resolve the renamed tables. Postgres only syntax-checks a plpgsql body; it does not resolve object names until a statement runs, and `ingest_capture('{}')` raises at its first guard before touching any relation. A version still saying `from asset` would pass the harness probe and fail here.

Call `ingest_capture` as `service_role` with a complete payload for a `source_product_id` that does not exist, then again with the same id and one changed field. Assert `status: created` then `status: updated`, exactly one listing, one asset and one canonical slug for it, and the returned `asset_id` identical across both calls.

Then re-ingest a listing that came from the **backfill**. That is the branch production runs for all 6,876 existing rows, and it is the combination the write path's `else` arm handles: an existing listing whose asset was created by the backfill migration rather than by `ingest_capture`. It must adopt the existing asset and create no second asset and no second slug.

`set_capture_logo` is exercised in the same step, once against the sentinel and once against a product that does not exist, expecting `set` then `no_capture`. Its probe selects `l.current_capture_id from listing l`, so a version still naming `asset` dies right there.

If any of these fails with a message mentioning `relation "asset" does not exist`, Task 6 missed a reference. Find it, fix it, and re-run the gate from Step 1.

- [ ] **Step 9: Catalog audit and the app's own tests**

Read the view options and the grant matrix out of the catalog rather than trusting the migrations: all five views must report `security_invoker=true`, all five must be selectable by `anon` and `authenticated`, and `v_logo_status` by `service_role`. Scan for any surviving object named for the old `asset` other than the ones deliberately named that way.

```bash
npm run typecheck
npm run test
```

Expected: 18 passing, 1 skipped. The skip is the parity test, which needs Supabase credentials.

- [ ] **Step 10: What the container cannot cover, stated before merging**

The gate passing does not mean the spec's requirement was met. These risks reach production unverified, and the "After this merges" section below is the only thing that catches them:

**PostgREST is not in the loop.** Every read above is SQL over a socket, not HTTP through PostgREST as `anon`. PostgREST keeps its own schema cache and reloads it on a DDL event trigger, so a renamed relation can leave it briefly stale. That failure is loud, `404 PGRST205 Could not find the table in the schema cache`, and it is transient, but it is not observed here.

**No JWT is involved.** The container uses `set role`; production reaches `anon` and `service_role` through `authenticator` and a signed JWT. A grant on `authenticator`, or role membership, is not exercised.

**The data is a four-row seed, not 6,876 listings and 30,900 captures.** So this proves the shape of the backfill, not its behaviour at scale: no lock duration, no statement timeout, no query plan is representative. The `add column` in the backfill takes an ACCESS EXCLUSIVE lock on every row in the registry, and `v_registry_stats` has already timed out once against production under load.

**"Identical before and after" is not proved by this gate at all.** The claim phase 1 exists to make is that the registry after it is exactly the registry before it. The container has no production data to compare, so nothing here tests it. That evidence comes only from `npm run verify:asset-layer` against production after the merge.

**Any production-only schema divergence is invisible.** The container is built from the repo. If production holds an object the repo does not describe, which is the exact condition Task 1 existed to fix, this gate cannot see it. The controller checked the five view shapes against production by hand and found no divergence; nothing automated covers it.

**The SECURITY DEFINER to `security_invoker` flip is not observed flipping.** The container never carried the definer version, because the repo's reconstruction restores `security_invoker` at Task 1. So Step 6 proves the invoker form works, not that the transition from the definer form works.

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

**One spec requirement is not met.** "Phase 1 runs on a Supabase branch database first" is unmet because the project does not have branching. Task 8 records it as a deviation, substitutes a local Postgres container carrying production's roles, and lists what the substitution cannot reach. It is not closed by anything in this plan; the "After this merges" sequence is what carries it.

Two spec items are deliberately not here because they belong to phase 2: `v_listing_passport` and `v_asset_evidence`, and the `search_blob` and array-containment facet work. The spec assigns all of them to phase 2.

One spec claim is corrected by this plan: the spec says the harvest scripts consume `asset_id` from the ingest result. They do not. Verified across every `.mjs`: they read `status`, `reach` and `risk` only. The return key is still kept and given its new meaning, for the reason stated in Task 6 Step 3.

**Task 1 is not in the spec at all.** The spec was written before the repo-versus-database divergence was found. It is a prerequisite rather than a change of design, and it is documented at the top of this plan.

**Placeholder scan.** No TBD, no "handle errors appropriately", no "similar to Task N". Two steps deliberately instruct the implementer to work from a live dump rather than from pasted SQL: Task 1 Step 1 and Task 7 Step 1. That is not a placeholder, it is the only correct source, because the repo's copies of those objects are known to be stale and pasting them here would bake the staleness in.

**Type consistency.** `v_listing`, `v_asset`, `v_new_listing` and `v_slug_fallback` are declared in Task 6 Step 2 and used in Steps 2 and 3. `listing.asset_id` is created in Task 5 and read by Task 6 and Task 7. `asset.primary_listing_id` is created in Task 4, populated in Task 5 and Task 6. The ingest return keys named in Task 6 Step 3 match those documented in Task 9 Step 3.

---

## After this merges

Task 9 ends the implementation. Nothing above proves the claim phase 1 exists to prove, that the registry after phase 1 is exactly the registry before it, because the container Task 8 uses holds a four-row seed rather than production's data. That evidence comes only from running the harness against production after the merge, and with no branch database in the picture this sequence is now the whole of the production-shaped verification rather than a second pass over it. In order:

1. Quiesce the capture worker before the push. Each migration file is its own transaction, so a harvest landing between the rename and the function rewrite fails with `relation "asset" does not exist`, and the `add column` in the backfill migration takes an ACCESS EXCLUSIVE lock that would queue behind an open ingest.

2. Re-capture the baseline immediately before the push: `npm run verify:baseline` against production. So drift in `captures`, `changes` and `last_captured_at` between when the baseline was last written and when the migrations actually land does not produce failures someone has to reason away afterward.

3. Run `npm run verify:asset-layer` against production. Every check must pass, with no expected-failure list: production has data, so nothing here is vacuous. The thirteen expected failures the old Task 8 listed belonged to a data-less branch database that no longer exists in this plan.

4. Run `npm run test:parity`, since `registry_search` joins on `asset_id` and that column changed meaning: it named a listing before this phase and names a real product after it.

5. Confirm `v_logo_status` returns a non-zero count to both `anon` and `service_role`. The definer-to-invoker flip in Task 7 is production-only, since the container never carried the SECURITY DEFINER version to flip, and its failure mode is silent: a broken invoker view returns an empty result, not an error. Task 8 proved the invoker form works and that both roles can read it, which is the strongest available evidence short of watching the flip itself.

6. Re-run the Supabase linter and confirm the `v_logo_status` SECURITY DEFINER error has cleared.

7. Render the app against production. Point `.env.local` at production, run `npm run dev`, open `/registry` and one `/agent/<source_product_id>` page, and confirm both render exactly as they did before the merge. Nothing before this step renders a page: Task 8's container was never served to a browser and holds four seeded rows rather than a product id anyone can navigate to. This is what catches a view column the app reads that quietly changed name.
