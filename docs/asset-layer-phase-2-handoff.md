# Asset layer: what phase 2 inherits

Phase 1 renamed `asset` to `listing` and put a new `asset` table above it. Assets
and listings are 1:1, so nothing a visitor sees changed. Phase 2 makes the read
surface asset-keyed, which is where that 1:1 assumption stops holding.

This file lists what phase 1 knowingly left, found while doing it. Everything
here was verified against the code at the time of writing, not guessed.

## Things that are correct only while assets and listings are 1:1

These are not bugs today. Each one becomes one the first time a merge gives an
asset two listings.

**`getPassports(assetIds)` returns more rows than ids given.** `lib/registry.ts`
selects from `v_asset_passport` with `.in("asset_id", assetIds)`. Two listings
on one asset means two rows for one id. Three places downstream then misbehave:

- `app/registry/compare/page.tsx:75` detects missing ids with
  `.some(a => a.asset_id === id)`, which stops detecting anything once ids
  duplicate.
- `components/registry/CompareTable.tsx:159,196` keys table cells on
  `asset_id`, producing duplicate React keys.
- `lib/registry.ts:126` de-dupes cards by `asset_id`, and
  `lib/registry-query.ts:156-158` uses it as a sort tie-break with a comment
  asserting it is unique.

**`registry_search` fans out.** It joins back with
`v_registry_card v on v.asset_id = p.asset_id` and its comment calls that "by
primary key". True only under 1:1. Two listings on one asset produce two rows in
`matched`, distinct `rn` in `ranked`, and a multiplied page.

**`v_registry_card` is still one row per listing.** So a product with two
listings appears twice in the grid and in search totals, while
`v_registry_stats.agents` counts it once. No number is wrong today; the day the
first merge lands, the grid and the banner disagree.

**`certified` and `attested` have no `merged_into` guard**, where `agents` does.
They rely on a merge relocating every listing, which leaves a retired asset with
none. Nothing enforces that: `asset.merged_into` is a plain column with no
constraint tying it to `listing.asset_id`. A merge that sets `merged_into`
without relocating drops `agents` and leaves the other two, on the same
front-page strip.

**`certified + attested` can exceed `agents`.** Under the any-listing rule, one
asset holding a certified listing and an attested one counts in both. Correct by
the rule, surprising on a proof strip.

## One thing that changes for visitors at merge

Pre-existing `/registry/compare?ids=...` links stop resolving. Those ids are
listing uuids and `asset_id` now means the product. It degrades honestly, the
agents read as not found rather than erroring, and new selections work.

## A rule worth keeping

**A row count only proves something where every source is an inner join.**

Phase 1's gate learned this the expensive way. `v_registry_stats` is nine scalar
subqueries that Postgres never evaluates for a `count(*)`, so the count returned
1 while `anon` had no access at all. The same shape then turned up in
`v_logo_status`, which reaches `capture_link` through a left join, and in
`v_asset_passport`, which pulls plans, links, media, permissions, compliance and
evidence through correlated subqueries. Dropping one RLS policy leaves the row
count intact and empties the payload: every card shows initials, every passport
is hollow, and a row-count assertion says PASS.

`v_registry_card` and `v_asset_change_feed` reach their sources only by inner
join, so counts are sound for them.

Phase 2 adds `v_listing_passport` and `v_asset_evidence`. Both are the second
shape. Assert on values.

## A correction to something this repo used to believe

**A missing grant is loud. A missing RLS policy is silent.**

`revoke select` produces `42501, permission denied`. A missing policy produces a
successful statement with zero rows and no error, because RLS with no applicable
policy is default-deny. Both were reproduced directly against a container during
phase 1.

This matters because the repo previously recorded the failure as "a missing
grant fails silently", which conflated the two and pointed mitigation at the
wrong one. The silence in the 6,820-logo outage was at the application layer:
`getLogos` in `lib/registry.ts` returns `{}` on error, so a loud `42501` from the
database still reached the page as initials.

Related and also corrected: `create or replace view` does **not** drop grants. A
column-compatible replacement preserves them. What loses them is a `drop view`,
and changing a view's column names or order forces one, which is what actually
happened during that outage.

## Known gaps in the phase 1 gate

`scripts/gate/` is the executable record of how phase 1 was verified, and
`npm run gate` re-runs it. Two limits worth knowing before relying on it:

- Its migration loop globs `*.sql` and skips `2026081910*`, so it applies
  everything else before the rename. **A phase 2 migration will be mis-ordered**
  unless the glob is updated. There is a comment at that line saying so.
- Its negative tests cover `capture_link`, `capture_plan`, `capture_permission`
  and `capture_compliance`, but not `capture_evidence`, which
  `check_passport` also reads. The failure class is demonstrated, not covered
  exhaustively.

## Two things phase 1 deliberately did not fix

`publisher_document` has RLS enabled, no policy, and no SELECT granted to any
application role, so nothing can read what `drai-docs.mjs` writes. It fails
closed rather than open, and the write path is now correctly locked to
`service_role`, so it is a functional gap in a feature nothing consumes yet.

Three `SECURITY DEFINER` functions are executable by `anon`:
`registry_graph_evidence`, `suppress_cross_method_change` and
`rls_auto_enable`. The first two are trigger functions, which Postgres refuses to
run when called directly; the third is Supabase-managed. Hygiene rather than an
open door. The one that was an open door, `ingest_publisher_document`, was closed
in phase 1 by `20260819095000`.
