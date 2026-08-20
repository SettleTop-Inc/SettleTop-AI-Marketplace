# Registry Asset Layer, Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the read surface asset-keyed, so the registry presents products rather than listings, while assets and listings are still 1:1 and therefore no number moves.

**Architecture:** Two migrations and an app change. The views become asset-keyed and gain the columns a multi-listing asset needs; `registry_search` matches a blob spanning every listing rather than the primary one; the app resolves a slug to an asset and renders one panel per listing. Nothing merges yet, so the whole read path can be proved correct before any data moves.

**Tech Stack:** Postgres 17 on Supabase, migrations under `supabase/migrations` applied by the GitHub to Supabase integration on push to `main`. Node 23 scripts, plain `fetch` against PostgREST. Next 16, `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-19-registry-asset-layer-design.md`

**Inherited context:** `docs/asset-layer-phase-2-handoff.md` lists what phase 1 knowingly left. Read it before Task 1. Several items in it are this plan's work.

## Scope

Phase 2 only. Phase 3 owns `merge_assets`, `unmerge_asset` and the act of merging. Nothing here creates a second listing on any asset, so every check in this plan runs under 1:1 and every number must be unchanged at the end.

## Global Constraints

Copied from the spec and from what phase 1 established by experiment. Every task's requirements include these.

- **A view's existing columns keep their names, types and order. New ones are appended.** `create or replace view` refuses anything else with `cannot change name of view column`. Phase 1 hit this and it aborted the migration.
- **Every view carries its `grant` immediately after it, in the same migration**, and the migration ends with an assertion. A column-compatible replace does preserve grants; a `drop view` loses them, and a column shape change forces one.
- **A row count only proves something where every source is an inner join.** `v_registry_card` and `v_asset_change_feed` satisfy that. `v_logo_status`, `v_asset_passport`, `v_registry_stats` and both new views do not: they reach their payloads through outer joins and correlated subqueries, so a policy failure empties the payload while the count holds. Assert on values.
- **A missing grant is loud (`42501`). A missing RLS policy is silent: success, zero rows, no error.** Both were reproduced against a container in phase 1. Mitigations differ.
- **`ingest_capture` carries the evidence verification gate and it is not to be relaxed for any reason.** Phase 2 does not touch that function. If a task finds itself editing it, stop and report.
- **Assets and listings are 1:1 for all of phase 2.** `v_registry_stats` must return identical values before and after, and `npm run verify:asset-layer` must stay at 31 of 31.
- **`npm run gate` must still pass**, and its migration glob needs updating for this phase's files. See Task 1.
- **No em dashes in any prose a person reads**, including SQL comments, doc updates and commit messages.

---

## File structure

| file | responsibility |
|---|---|
| `supabase/migrations/20260820100000_asset_keyed_views.sql` | `v_registry_card` and `v_asset_passport` asset-keyed, plus `v_listing_passport` and `v_asset_evidence` |
| `supabase/migrations/20260820100100_registry_search_asset_keyed.sql` | `registry_search` over `search_blob`, source facet by array containment |
| `scripts/verify-asset-layer.mjs` | extended with the phase 2 invariants |
| `scripts/gate/` | glob fixed for this phase; new views added to the read and value checks |
| `lib/registry.ts`, `lib/registry-query.ts`, `lib/types.ts` | slug resolution, `search_blob`, the compare fixes |
| `app/agent/[id]/page.tsx`, `components/registry/` | per-listing panels, compare keyed on a stable id |

The two migrations are separate files because they are separately reviewable, and they land in one push because `registry_search` reads `v_registry_card`.

---

### Task 1: Extend the gate and the harness for phase 2

**Files:**
- Modify: `scripts/verify-asset-layer.mjs`
- Modify: `scripts/gate/run.sh`, `scripts/gate/04-reads.sql`, `scripts/gate/05-negative.sql`

**Interfaces:**
- Consumes: the phase 1 harness and gate as they stand on `main`.
- Produces: checks that fail now and pass after Task 2, and a gate that applies this phase's migrations in the right order.

Written first and failing first, exactly as phase 1 did. This is the task that makes every later task provable.

- [ ] **Step 1: Fix the gate's migration ordering**

`scripts/gate/run.sh` globs `supabase/migrations/*.sql` and skips `2026081910*`, applying everything else before the rename. A `20260820*` file would therefore be applied **before** the schema it depends on. There is a comment at that line saying this would happen; make it not happen.

Change the split so the pre-rename set is everything before `20260819095000` and the post-rename set is everything from `20260819095000` onward, in filename order. Do not enumerate files by name: the next phase will add more.

- [ ] **Step 2: Run the gate and confirm it still passes**

Run: `npm run gate`
Expected: `GATE PASS`, exit 0. The ordering change must not alter the outcome, only make it durable.

- [ ] **Step 3: Add the phase 2 checks to the harness**

In `scripts/verify-asset-layer.mjs`, add these inside the existing `check()` wrapper, in the same style as their neighbours:

```js
await check("v_registry_card carries the asset-level columns", async () => {
  const r = await fetch(`${URL_BASE}/rest/v1/v_registry_card?select=marketplace_ids,listing_count,search_blob&limit=1`,
    { headers: head(ANON) });
  return { ok: r.ok, detail: r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}` };
});

await check("v_asset_passport carries listings", async () => {
  const r = await fetch(`${URL_BASE}/rest/v1/v_asset_passport?select=listings&limit=1`, { headers: head(ANON) });
  return { ok: r.ok, detail: r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}` };
});

for (const v of ["v_listing_passport", "v_asset_evidence"]) {
  await check(`anon can select from ${v}`, async () => {
    const r = await fetch(`${URL_BASE}/rest/v1/${v}?select=*&limit=1`, { headers: head(ANON) });
    return { ok: r.ok, detail: r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}` };
  });
}

// A row count proves nothing on these two: both reach their payload through
// correlated subqueries, so a policy failure empties the payload and leaves the
// count intact. Assert on values.
await check("v_asset_evidence carries real capture rows", async () => {
  const r = await fetch(`${URL_BASE}/rest/v1/v_asset_evidence?select=capture_id,captured_at,content_hash&limit=1`,
    { headers: head(ANON) });
  if (!r.ok) return { ok: false, detail: `${r.status}` };
  const [row] = await r.json();
  return {
    ok: Boolean(row?.capture_id && row?.captured_at && row?.content_hash),
    detail: row ? `capture ${row.capture_id?.slice(0, 8)}` : "no rows",
  };
});

await check("v_registry_card.search_blob is populated", async () => {
  const r = await fetch(`${URL_BASE}/rest/v1/v_registry_card?select=name,search_blob&limit=1`, { headers: head(ANON) });
  if (!r.ok) return { ok: false, detail: `${r.status}` };
  const [row] = await r.json();
  const ok = Boolean(row?.search_blob) && row.search_blob.includes(String(row.name ?? "").toLowerCase());
  return { ok, detail: ok ? `${row.search_blob.length} chars` : "blob empty or missing the name" };
});
```

Also add `evidence_rows` to `snapshot()` and to the completeness validation, recording the row count of `v_asset_evidence`. It must equal the capture count, currently 30,900, and Task 2's verification checks that.

- [ ] **Step 4: Run the harness and watch the new checks fail**

Run: `npm run verify:asset-layer`
Expected: the five new checks FAIL because the columns and views do not exist; the existing 31 still PASS. Record the tally in your report as the RED evidence.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-asset-layer.mjs scripts/gate
git commit -m "test: phase 2 checks, and fix the gate's migration ordering"
```

---

### Task 2: Asset-keyed views

**Files:**
- Create: `supabase/migrations/20260820100000_asset_keyed_views.sql`

**Interfaces:**
- Consumes: `asset`, `listing`, `asset_slug`, `capture`, `capture_extract` and the phase 1 views.
- Produces: `v_registry_card` and `v_asset_passport` keyed by asset; `v_listing_passport`, one row per listing; `v_asset_evidence`, one row per capture keyed by asset. Task 3 reads `v_registry_card.search_blob` and `marketplace_ids`. Task 4 reads `v_asset_passport.listings`.

- [ ] **Step 1: `v_registry_card` becomes asset-keyed**

Its grain changes from one row per listing to one row per asset. Under 1:1 that is the same rows, which is why this is provable now.

Existing columns keep their names, types and positions, and their sources become the primary listing except where the spec's aggregation rules say otherwise:

| field | rule |
|---|---|
| `last_captured_at` | `max` across the asset's listings |
| `capture_count` | `sum` |
| `first_seen_at` | `min` |
| `certification` | **any listing**, not the primary. `provenance`, `risk`, `evidence_tier` and `cert_label` follow the qualifying listing |

Append exactly three columns, in this order:

```sql
  l_agg.marketplace_ids,   -- text[], every listing's marketplace, sorted
  l_agg.listing_count,     -- int
  l_agg.search_blob        -- text, see step 2
```

Do not add a separate uuid column for the asset. `asset_id` has held the asset's own uuid since phase 1, so a second one would be the same value under a new name.

Exclude retired assets: join through `listing`, which a retired asset has none of, so they fall out naturally. Do not add a `merged_into` filter to a view that joins through listings; state in a comment why it is unnecessary.

- [ ] **Step 2: Build `search_blob` across every listing**

Nine fields, in exactly this order, matching `searchBlob()` in `lib/registry-query.ts:90-98`:

```
name, publisher, function_category, tagline, marketplace_name,
evidence_tier, delivery, cert_label, surfaces joined by a space
```

concatenated for **every** listing of the asset, lowercased, space separated, with empty fields dropped rather than leaving double spaces. `concat_ws` drops nulls but not empty strings, so `nullif(x, '')` each field, exactly as `registry_search` already does in its own `concat_ws`.

The reason this spans listings: a product whose AWS description names vLLM but whose Microsoft page does not must still match a search for vLLM. That is the no-flattening rule applied to the query layer.

- [ ] **Step 3: `v_asset_passport` becomes asset-keyed and gains `listings`**

Existing 60 columns keep their names, types and positions, sourced from the primary listing except for the aggregation rules above. Append one column:

```sql
  (select coalesce(jsonb_agg(jsonb_build_object(
            'listing_id', l2.id,
            'marketplace_id', l2.marketplace_id,
            'marketplace_name', m2.name,
            'source_product_id', l2.source_product_id,
            'listing_url', l2.listing_url,
            'is_primary', l2.id = a.primary_listing_id,
            'last_captured_at', l2.last_captured_at,
            'pricing', x2.pricing,
            'certification', x2.certification,
            'rating', x2.rating,
            'categories', to_jsonb(x2.categories))
          order by (l2.id = a.primary_listing_id) desc, m2.name), '[]'::jsonb)
     from listing l2
     join marketplace m2 on m2.id = l2.marketplace_id
     join capture_extract x2 on x2.capture_id = l2.current_capture_id
    where l2.asset_id = a.id)                                   as listings
```

This is what the page renders as one panel per marketplace. The fields chosen are the ones the spec says must never be flattened: price, certification, rating and categories are exactly where marketplaces disagree.

- [ ] **Step 4: `v_listing_passport`, one row per listing**

What `v_asset_passport` was before this migration: the same select list, keyed by listing, with no aggregation and no `listings` column. Add `asset_id` so a caller can get back to the product.

Its purpose is that the merged page can still show what a single marketplace said, unaggregated, and phase 3's merge review needs exactly that.

- [ ] **Step 5: `v_asset_evidence`, one row per capture**

```sql
select
  l.asset_id,
  l.id                as listing_id,
  l.marketplace_id,
  l.source_product_id,
  c.id                as capture_id,
  c.captured_at,
  c.content_hash,
  c.ingest_source,
  c.method,
  c.capture_complete,
  c.missing,
  (c.raw is not null) as has_raw
from capture c
join listing l on l.id = c.listing_id
order by l.asset_id, c.captured_at desc
```

This is the spec's answer to "always point back to it or run AI over it": given an asset, every marketplace's every observation, newest first. It deliberately does not select `raw` itself, which is large and already publicly readable on `capture`; `has_raw` says whether the source material is there.

- [ ] **Step 6: Grants, immediately after each view**

```sql
grant select on public.v_registry_card    to anon, authenticated;
grant select on public.v_asset_passport   to anon, authenticated;
grant select on public.v_listing_passport to anon, authenticated;
grant select on public.v_asset_evidence   to anon, authenticated;
```

Then extend the phase 1 assertion at the end of the file to cover the two new views as well as the five existing ones.

- [ ] **Step 7: Verify against a container**

Run `npm run gate`. Then, in the same container, check by value and not by row count:

- `v_registry_card` row count equals the asset count, and `search_blob` on a seeded asset contains its name, its publisher and its marketplace name, all lowercased.
- `v_asset_passport.listings` is a non-empty array whose single element has `is_primary` true.
- `v_listing_passport` row count equals the listing count.
- `v_asset_evidence` row count equals the capture count, and no row has a null `content_hash`.
- Every view reports `security_invoker = true` from `pg_class.reloptions`.
- Drop `capture_extract_public_read`, confirm the value assertions go red while row counts stay green, then restore. This is the check that phase 1 learned the hard way.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260820100000_asset_keyed_views.sql
git commit -m "feat: asset-keyed card and passport, plus listing passport and evidence views"
```

---

### Task 3: `registry_search` over the whole asset

**Files:**
- Create: `supabase/migrations/20260820100100_registry_search_asset_keyed.sql`

**Interfaces:**
- Consumes: `v_registry_card.search_blob` and `.marketplace_ids` from Task 2.
- Produces: `registry_search` with the same signature and the same return shape. Task 4 relies on the shape being unchanged.

- [ ] **Step 1: Start from the current definition**

`supabase/migrations/20260818134538_registry_search.sql` is the live function, reconciled in phase 1. Copy it whole and change only what the next steps name. Its signature and its `jsonb_build_object('total', 'rows', 'facets')` return shape must not change.

- [ ] **Step 2: Match against `search_blob`**

Replace the nine-field `concat_ws` in the `byq` CTE with `v.search_blob`. The escaping of `%`, `_` and backslash in the needle stays exactly as it is: a visitor searching "100% managed" must not match every row.

Keep the comment explaining why the field order matters, and update it to say the order now lives in the view rather than here.

- [ ] **Step 3: The source facet matches any of the asset's marketplaces**

`f_source` is currently `coalesce(nullif(v.marketplace_name, ''), 'Unknown')`, a single value compared with `= any(p_source)`. An asset listed on two marketplaces must match a filter for either.

Change the match to array containment against `v.marketplace_ids`, and change the facet **counting** to unnest, so an asset on two marketplaces contributes to both counts. Every other facet stays single-valued.

Take care with the `Unknown` bucket: `marketplace_ids` is never empty for a live asset, since an asset with no listings does not appear, so `Unknown` cannot arise here. Say so in a comment rather than writing a branch that can never run.

- [ ] **Step 4: Preserve the grant**

```sql
grant execute on function registry_search to anon, authenticated;
```

- [ ] **Step 5: Verify**

In the gate container, confirm: a search for a term appearing only in a seeded listing's tagline still returns that asset; the `source` facet counts sum correctly; `total` equals the number of matching assets rather than listings; and the sort orders are unchanged.

Then run `npm run test:parity` against production once this is deployed, not before. It compares `registry_search` against `runQuery` over the live registry and is the strongest available check that the two agree.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260820100100_registry_search_asset_keyed.sql
git commit -m "feat: search the whole asset, not just its primary listing"
```

---

### Task 4: The app reads assets

**Files:**
- Modify: `lib/registry.ts`, `lib/registry-query.ts`, `lib/types.ts`

**Interfaces:**
- Consumes: Task 2's views and Task 3's function.
- Produces: `getPassportBySlug(slug)`, `getListingPassports(assetId)`, `getAssetEvidence(assetId)`. Task 5 renders them.

- [ ] **Step 1: `searchBlob()` returns the server's blob**

`lib/registry-query.ts:90-98` rebuilds the nine-field string on the client from a single card's fields. That agrees with the server only while an asset has one listing. Once it has two, the server's blob spans both and the client's does not, and the parity test starts failing for a correct reason, which is the worst kind.

Make the card carry `search_blob` and have `searchBlob(c)` return it, falling back to the old construction only if the field is absent. Then the two are identical by construction rather than by coincidence.

Add `search_blob`, `marketplace_ids` and `listing_count` to `RegistryCard` in `lib/types.ts`.

- [ ] **Step 2: `getAllProductIds` reads every slug**

It currently selects `source_product_id` from `v_registry_card`, which after Task 2 emits only primary listings. A merged-away product's URL would stop being pre-rendered. Read every row of `asset_slug` instead, paged with an explicit order on `slug`, and rename it `getAllSlugs`.

- [ ] **Step 3: Resolve a slug to an asset**

Add `getPassportBySlug(slug)`, which looks the slug up in `asset_slug` and then reads `v_asset_passport` by `asset_id`. Keep returning `ReadResult<AssetPassport | null>`, so a failed read stays distinct from a missing record. That distinction is why the 404 page once claimed a record did not exist during an outage.

Keep `getPassport(sourceProductId)` working, since it is what the current route calls, and mark it deprecated in a comment naming its replacement.

- [ ] **Step 4: Add the two new readers**

`getListingPassports(assetId)` over `v_listing_passport`, and `getAssetEvidence(assetId)` over `v_asset_evidence`, both ordered explicitly and both returning `ReadResult`.

- [ ] **Step 5: Fix the compare identity**

Per `docs/asset-layer-phase-2-handoff.md`: `app/registry/compare/page.tsx:75` detects missing ids with `.some(a => a.asset_id === id)`, and `components/registry/CompareTable.tsx:159,196` keys cells on `asset_id`. Both are correct only while ids are unique per row. Since the card is now one row per asset, `asset_id` is unique by construction, so **these are now correct rather than accidentally correct**. Add a test asserting that, so the guarantee is recorded rather than assumed.

- [ ] **Step 6: Tests**

Extend `lib/registry-query.test.ts`: `searchBlob` returns the server blob when present and falls back when absent; a card with two marketplaces matches a source filter for either. Run `npm test`, expect the existing 18 to pass plus the new ones.

- [ ] **Step 7: Commit**

```bash
git add lib
git commit -m "feat: read the registry by asset, and make search parity structural"
```

---

### Task 5: The product page shows every marketplace

**Files:**
- Modify: `app/agent/[id]/page.tsx`
- Create: `components/registry/ListingPanels.tsx`

**Interfaces:**
- Consumes: `getPassportBySlug`, `v_asset_passport.listings`.
- Produces: the rendered page. Nothing consumes it.

- [ ] **Step 1: Route by slug**

`generateStaticParams` uses `getAllSlugs`. The page calls `getPassportBySlug`. Existing URLs are unchanged, because every slug is still its listing's `source_product_id`.

- [ ] **Step 2: Render one panel per listing**

`ListingPanels.tsx` takes `passport.listings` and renders one panel each: the marketplace name, a link to the listing, when it was last captured, and the four fields that are allowed to disagree, which are price, certification, rating and categories.

**No flattening.** Where the listings agree on a field, show it once. Where they disagree, show every value with its marketplace named. Never average, never silently pick, never present a consensus no source stated. Cross-marketplace disagreement is the most interesting thing this registry knows.

With one listing, which is every asset today, the panel section shows a single panel. That is correct and is what proves the component before any merge exists.

- [ ] **Step 3: Label the header**

The page leads with the primary listing's description. Say so: name the marketplace the headline came from. Do not present it as a neutral summary of all of them.

- [ ] **Step 4: Verify in the browser**

Run the dev server, open `/agent/redhat.rh-rhaie` and `/agent/opp-shredder-agent`, and confirm each renders one panel naming its marketplace, that the header says where its description came from, and that the page is unchanged in every other respect. Take a screenshot of each.

- [ ] **Step 5: Commit**

```bash
git add app components
git commit -m "feat: show what each marketplace says about a product"
```

---

### Task 6: Verify and document

**Files:**
- Modify: `docs/runbooks.md`, `docs/asset-layer-phase-2-handoff.md`

- [ ] **Step 1: Run everything**

```bash
npm test && npm run typecheck && npm run gate && npm run verify:asset-layer
```

The harness must report every phase 1 check still passing plus the five new ones. `v_registry_stats` must be identical field for field: assets and listings are still 1:1, so a moved number means something is wrong.

- [ ] **Step 2: Update the handoff document**

`docs/asset-layer-phase-2-handoff.md` lists items phase 2 was going to fix. Strike the ones now fixed, and leave the ones that are genuinely phase 3: the `certified` and `attested` `merged_into` guard, and `certified + attested` exceeding `agents`.

- [ ] **Step 3: Update the runbook**

The health checks now have `v_listing_passport` and `v_asset_evidence` available. Add one query showing every marketplace's view of one product, since that is the question this phase exists to answer.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: phase 2 landed, and what phase 3 still inherits"
```

---

## After this merges

1. Quiesce the capture worker before the push, for the same reason as phase 1: each migration is its own transaction.
2. Run `npm run verify:asset-layer` against production. Every check must pass.
3. Run `npm run test:parity`. This is the check that `registry_search` and `runQuery` still agree after the search rewrite, and it is the one most likely to catch a real mistake in Task 3.
4. Open one agent page and confirm the panel renders.
5. Re-run the Supabase linter and confirm no new advisory appeared.

## Self-review

**Spec coverage.** Every phase 2 item in the spec maps to a task: the view grain table to Task 2, the aggregation rules to Task 2 Step 1, `search_blob` and the source facet to Tasks 2 and 3, `v_listing_passport` and `v_asset_evidence` to Task 2, `getAllProductIds` to Task 4 Step 2, and the product page to Task 5.

**One thing this plan adds that the spec does not have.** The spec says `search_blob` spans every listing but does not say what the client does. Task 4 Step 1 makes the card carry the blob and the client use it, because otherwise the parity test passes only while 1:1 and fails for a correct reason afterwards. That is a design decision, recorded here.

**One thing deliberately not done.** `v_registry_card` gains no `merged_into` filter. It joins through `listing`, and a retired asset has none, so retired assets fall out by construction. A filter would be a second, weaker guard on the same property.

**Placeholder scan.** No TBD, no "handle errors appropriately", no "similar to Task N". Every code step carries the actual content. Where a step says not to do something, it says it in prose rather than showing the wrong code, because a wrong line inside a code block gets copied.

**Type consistency.** `getPassportBySlug`, `getListingPassports`, `getAssetEvidence` and `getAllSlugs` are defined in Task 4 and consumed in Task 5. `search_blob`, `marketplace_ids` and `listing_count` are produced in Task 2, typed in Task 4 Step 1, and consumed in Tasks 3 and 4.
