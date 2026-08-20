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

---

# What phase 3 inherits from phase 2

Phase 2 made the read surface asset-keyed. `v_registry_card` and
`v_asset_passport` are one row per product; `v_listing_passport` and
`v_asset_evidence` are new. Assets and listings are still 1:1, so nothing a
visitor sees has changed, and that is exactly why the items below are all
statements about the first merge rather than about today.

## THE CERTIFICATION GROUP IS A CUT COMPONENT. READ THIS FIRST.

This is the open question of the phase and the one thing phase 3 must decide
before it merges an asset for real.

Nine columns move together, from the qualifying listing rather than the primary
one: `certification`, `cert_label`, `provenance`, `evidence_tier`, `risk`,
`risk_basis`, `known_layers`, `layers_known` and `reach`. That set was arrived
at over three corrections, each of which had drawn the boundary one derivation
step too close in.

**The set is still not closed, and the rule that produced it cannot see why.**
It was stated as a downstream cone: everything computed *from* `certification`.
But `known_layers` is not a source, it is a twelve-entry summary, and eleven of
those twelve entries are exact functions of columns the views still take from
the **primary** listing:

| layer | computed from |
|---|---|
| vendor identity | `publisher` |
| model | `capture_evidence`, kind `model`, verified |
| framework | `capture_evidence`, kind `framework`, verified |
| tools and MCP | `capture_evidence` kind `tool_mcp`, or `capture_permission` |
| data sources | `capture_evidence`, kind `data_source`, verified |
| integrations | `capture_evidence` kind `integration`, or `works_with` |
| hosting | `cert_hosting` |
| data residency | `cert_data_location` |
| pricing | `pricing`, or `capture_plan` |
| access model | `acquire_using` |
| support channel | `support` |

Only the twelfth, permission scope, is a function of the certification, and it
is the only one that travelled into the lateral with it.

So the layer **count** describes the qualifying listing while the eleven facts
it summarises describe the primary one. The correct formulation is the
connected component under "is a function of" treated as **undirected**, and by
that rule the component is cut. The migration now states it that way; the
downstream phrasing is what let three rounds of corrections each miss the next
one.

Reproduced against a container rather than predicted. A synthetic two-listing
asset returns:

```
 layers_known | reach | cert_hosting | cert_data_location | acquire_using | support | evidence_kinds | plans
            7 |    58 | (null)       | (null)             | (null)        | (null)  |              1 |     0
```

which is a passport drawing a ledger reading "7 of 12 traced" and 58 per cent
directly above "Hosting: Unknown", "Data residency: Unknown", no framework and
no plans. It is the same contradiction `reach` was moved to fix, over eleven
columns instead of one.

**Nothing today is wrong.** Under 1:1 the qualifying listing is the primary
listing and every one of those columns is that one listing's own. What is wrong
is the rule somebody applies next.

It is deliberately not closed, because closing it means choosing between two
options that have never been compared against a real merged asset:

- **(a) Move the whole disclosure block** into the lateral: `publisher`,
  `cert_hosting`, `cert_data_location`, `acquire_using`, `support`,
  `works_with`, `pricing`, `plans` and the evidence subquery. The passport then
  describes the qualifying listing almost entirely, and the primary listing
  supplies little more than the name and the URL.
- **(b) Return `known_layers`, `layers_known` and `reach` to the primary
  listing** and accept that `risk_basis` states a layer count belonging to a
  different listing, **attributed as such** in the sentence rather than left to
  look like the ledger's own number.

Whichever is chosen, the choice is between two coherent things. The present
arrangement is neither, and it must not survive phase 3.

**No assertion in the gate detects this.** `gate.check_cert_group_coherent`
compares the layer count against its three copies and the certification label
against its two, which catches a split *within* the group. Nothing in these
views restates "did this listing disclose its hosting" in a second place, so
there is nothing to compare. A green coherence check does not cover the cut.

## Two front-page numbers changed basis

`v_registry_stats` was not recreated by phase 2, but it reads `v_registry_card`
four times and the card moved underneath it. Both are identical today.

- **`publishers`** is `count(distinct publisher)` over the card, and the card is
  now one row per asset sourced from its primary listing. A publisher named
  only on a secondary listing stops being counted. The number becomes
  "publishers we show on a product's headline" rather than "publishers named
  anywhere in the registry".
- **`mean_reach`** is `avg(reach)` over the card, and `reach` now comes from the
  qualifying listing, so it is the mean over qualifying listings rather than
  over every listing.

`certified` and `attested` already resolved as any listing before phase 2 and
still do. `agents` and `marketplaces` never read the card.

## Four smaller things, each correct today and wrong at the first merge

**The qualifying-listing ordering prefers `none` over `not_eligible`.** The
`cert` lateral ranks certifications `microsoft_365_certified` (0),
`publisher_attestation` (1), `none` (2), `not_eligible` (3). So an asset holding
one listing that says nothing and one that says certification does not apply
resolves to the first. The labels are "No attestation published" and "Not
eligible for certification", and the second is the more informative of the two:
it tells a reader the absence is structural rather than a gap. The ranking was
written to put attested above unattested and the tail was never argued.
Reversing 2 and 3 is a one-line change and a spec decision.

**The retired-asset exclusion has no permanent gate check.** Retired assets are
excluded by `and l.asset_id = a.id` in the join, not by a `merged_into` filter:
a merge moves the listing away, so the retired asset's `primary_listing_id`
points at a listing that no longer names it back. That was verified by hand
against a container, with `merged_into` deliberately left unset, and it worked.
But there is no standing assertion, because nothing in the gate constructs a
retired asset: `asset_merge` gets one synthetic row purely so `anon` has
something to read, and it deliberately does not set `merged_into` so no view's
counts move. Phase 3 is the first code that can build the state, and it should
bring the check with it.

**`search_blob` stops being character-identical to `searchBlob()`.** Today it is
byte-for-byte what `registry_search` builds inline and what
`lib/registry-query.ts:90-98` produces, verified over every row. Under two
listings it is the concatenation of one such blob per listing, and
`searchBlob()` in TypeScript still builds one from the single card row. The
parity test `lib/registry-search.parity.test.ts` compares SQL against
TypeScript over the live registry and will start failing at the first merge, not
because either side is wrong but because they are answering different
questions. Update the test before phase 3 merges anything, or it fails for the
right reason at the wrong moment.

**`listing_count` can exceed `jsonb_array_length(listings)`.** `listing_count`
and `marketplace_ids` count through a LEFT JOIN to `capture_extract`, so they
include a listing that has no capture yet; `listings` and `search_blob`
inner-join it, so they exclude one. Production has no such listing today and
`ingest_capture` cannot create one, since it writes the listing and its capture
together. It is reachable only if a future write path inserts a listing before
its first capture. If Task 5 renders "listed on N marketplaces" from
`listing_count` beside N panels built from `listings`, those two can disagree by
one.

## What Task 5 owes the reader

The spec already requires the passport header to name where its description
came from. It now also has to name where the certification came from, because
the group can resolve to a listing other than the one whose description is on
the page. After phase 2 that is not only the certification badge: the layer
ledger, the reach figure, the risk band and the risk sentence can all come from
the other marketplace too.
