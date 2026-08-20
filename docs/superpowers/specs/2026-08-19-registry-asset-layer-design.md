# Registry Asset Layer

**Status:** design, approved for planning
**Date:** 2026-08-19

## Goal

One registry entry per product. A marketplace listing stops being the registry's
unit and becomes evidence about a product.

Today `asset` is a listing: `(marketplace_id, source_product_id)`. Red Hat AI
Enterprise is one product with a Microsoft page and an AWS page, and the registry
has no way to say so. This adds the layer that can.

## Why now, and why before AWS

The obvious reason is AWS: `redhat.rh-rhaie` and `prodview-36zfpvh7pl7fy` are the
same product, and ingesting AWS under today's model would put a second Red Hat AI
Enterprise in the registry.

The stronger reason is that the workload already exists. Measured against the live
registry on 2026-08-19:

```
listings                                     6,876   (microsoft 6,853, drai 23)
names appearing on more than one marketplace      0
names duplicated inside a single marketplace    193
name + publisher pairs with >1 listing          137
```

Microsoft duplicates itself 193 times. `ffmpeg` appears three times, `bazel`,
`phpmyadmin` and "Honeywell Forge for Industrials" twice each, and "Cognaio,
Agentic Process Automation" twice under two spellings of one publisher. So this
layer can be built, tested and proven against real duplicates with the data
already in the registry, before AWS exists.

It also means v1 needs no matcher. Merging is a deliberate, reviewable, reversible
act, so automatic candidate generation is a separate concern that can be designed
later, against AWS pairs, once the model it feeds is in place and exercised.

## Scope

**In:** the vocabulary change and rename; the `asset`, `asset_slug` and
`asset_merge` tables; the change to `ingest_capture`; the read surface; the merge
and unmerge operations; the asset passport and registry grid.

**Out, deliberately:**

- Automatic match-candidate generation. Merges are performed by a person.
- The AWS pipeline. Its own spec, built on this.
- Evidence extraction. `capture_evidence` holds 587 rows across 6,876 listings and
  is barely fed by anything. Real, and not this.

## Vocabulary

The rename is the point, not incidental. Two live meanings of "asset" in a schema
whose main virtue is precision would be a permanent tax.

| term | meaning |
|---|---|
| **asset** | the registry's unit: one real product. New table. |
| **listing** | one marketplace's page for something. Today's `asset`, renamed. |
| **capture** | one immutable observation of one listing. Unchanged. |

## Architecture

```
asset  1 ─────< listing  1 ─────< capture
  │                                  │
  └─< asset_slug                     └─ raw jsonb, kept forever
  └─< asset_merge (event log)
```

Nothing is reconciled when written. Each adapter keeps writing its own shape into
its own listing and its own captures. The asset layer brings them together only at
read time. A fourth marketplace costs an adapter and nothing else.

### Invariants

1. Every listing belongs to exactly one asset. `listing.asset_id` is `not null`.
   A newly harvested listing that matches nothing gets a fresh asset of its own,
   so the default state of a scraped listing is "it is its own product", which is
   the honest reading, and there are no orphans and no special case in the UI.
2. A merge moves listings between assets. It never modifies a listing, a capture,
   or an extract. A bad merge therefore damages nothing that cannot be moved back.
3. A slug, once issued, always resolves. Merging repoints it; it never 404s.
4. An asset that has been merged away is retired, not deleted. Its row remains so
   the merge log's references stay valid.

## Schema

### Renames

```sql
alter table asset rename to listing;
alter table capture rename column asset_id to listing_id;
alter table asset_change rename to listing_change;
alter table listing_change rename column asset_id to listing_id;
```

`listing_change` is correct as a name: a change is something one marketplace's page
did between two observations of it. "What changed about this product" becomes a
union across its listings, which is a read path, not a table.

`function_override` is keyed `(marketplace_id, source_product_id)` and is already
listing-level; it needs no change.

### New tables

```sql
create table asset (
  id                 uuid primary key default gen_random_uuid(),
  primary_listing_id uuid,                       -- FK added after listing exists
  merged_into        uuid references asset(id),  -- non-null means retired
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table asset_slug (
  slug         text primary key,
  asset_id     uuid not null references asset(id) on delete cascade,
  is_canonical boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index asset_slug_one_canonical
  on asset_slug (asset_id) where is_canonical;

create table asset_merge (
  id             bigserial primary key,
  from_asset_id  uuid not null references asset(id),
  into_asset_id  uuid not null references asset(id),
  listing_ids    uuid[] not null,
  slugs          text[] not null,
  basis          text not null,
  merged_by      text not null,   -- a handle, never an email. This table is public.
  merged_at      timestamptz not null default now(),
  undone_at      timestamptz
);
```

`merged_by` is publicly readable under the policy below, so it holds a handle. An
email address in that column would be published by the registry.

`asset.primary_listing_id` and `listing.asset_id` reference each other. The
existing schema already has this shape (`asset.current_capture_id` against
`capture.asset_id`) and solves it by adding the constraint in a separate `alter`
once both tables exist. Same approach.

**The primary listing is stored, not derived.** A derivation rule ("most captures",
"best evidenced") would silently change a product's headline whenever data moved.
An explicit pointer is auditable and can be corrected as data.

**Slugs are their own table** so an asset can answer to several, which is what keeps
a merged-away product's URL working. Note the existing unique index is on
`(marketplace_id, source_product_id)`, not on `source_product_id` alone, so slug
uniqueness must be enforced here rather than assumed. It happens to hold today
(6,876 listings, 6,876 distinct `source_product_id`, zero collisions), which is why
the backfill can seed slugs directly, but that is luck and not a constraint.

### RLS and grants

Every new table needs an explicit policy and grant. The existing policies were
created by a loop over a hardcoded array in `registry_core.sql`, so a new table
inherits nothing, and a table with RLS enabled and no policy is invisible to `anon`.

```sql
alter table asset       enable row level security;
alter table asset_slug  enable row level security;
alter table asset_merge enable row level security;
create policy asset_public_read       on public.asset       for select to anon, authenticated using (true);
create policy asset_slug_public_read  on public.asset_slug  for select to anon, authenticated using (true);
create policy asset_merge_public_read on public.asset_merge for select to anon, authenticated using (true);
grant select on public.asset, public.asset_slug, public.asset_merge to anon, authenticated, service_role;
```

The policies on the renamed table keep their old names, so `listing` would carry a
policy called `asset_public_read`. Rename them in the same migration; a policy whose
name contradicts its table is the sort of thing that misleads the next reader.

## Backfill

One asset and one canonical slug per existing listing, so the registry after
phase 1 is exactly the registry before it.

```sql
alter table listing add column asset_id uuid references asset(id);

with made as (
  insert into asset (primary_listing_id)
  select l.id from listing l
  returning id as asset_id, primary_listing_id
)
update listing l set asset_id = made.asset_id
  from made where made.primary_listing_id = l.id;

alter table listing alter column asset_id set not null;

-- Seed slugs are only safe because source_product_id happens to be unique across
-- marketplaces today. Assert it rather than discover a collision as a constraint
-- violation halfway through the migration.
do $$
declare n int;
begin
  select count(*) into n from (
    select source_product_id from listing group by 1 having count(*) > 1) d;
  if n > 0 then
    raise exception 'cannot seed slugs: % source_product_id values are shared by more than one listing', n;
  end if;
end $$;

insert into asset_slug (slug, asset_id, is_canonical)
select l.source_product_id, l.asset_id, true from listing l;
```

`source_product_id` is used as the seed slug because that is what `/agent/[id]`
already carries, so every existing URL keeps resolving with no redirect.

## `ingest_capture`

The function must resolve a listing, and create a singleton asset when the listing
is new.

**The asset has to exist first.** `listing.asset_id` is `not null`, so there is no
moment at which a listing exists without one, and the obvious shape (upsert the
listing, then notice `asset_id` came back null, then create the asset) cannot run.
Deferring the constraint is not an option either: Postgres accepts `DEFERRABLE`
only on `UNIQUE`, `PRIMARY KEY`, `EXCLUDE` and `REFERENCES`, never on `NOT NULL`
or `CHECK`.

So the upsert becomes a lookup, and the insert path creates the asset before the
listing that points at it:

```sql
select id, asset_id into v_listing, v_asset
  from listing
 where marketplace_id = v_mkt and source_product_id = v_pid;

if v_listing is null then
  insert into asset default values returning id into v_asset;

  begin
    insert into listing (marketplace_id, source_product_id, listing_url, asset_id)
    values (v_mkt, v_pid, <the existing listing_url coalesce, unchanged>, v_asset)
    returning id into v_listing;
  exception when unique_violation then
    -- Another transaction created this listing between the select and the insert.
    -- Its asset wins; ours is discarded unused.
    delete from asset where id = v_asset;
    select id, asset_id into v_listing, v_asset
      from listing
     where marketplace_id = v_mkt and source_product_id = v_pid;
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
```

`v_new_listing` is set inside the `begin` block and cleared by the exception
handler, so the slug and `primary_listing_id` work runs only for the transaction
that actually created the listing.

The race is not hypothetical: `harvest.mjs` runs sources as concurrent child
processes. They use different `marketplace_id` values today, so they cannot collide
on this key, but the handler costs nothing and removes the assumption.

**Hard constraint.** `ingest_capture` carries the evidence verification gate, and
that gate is not to be relaxed for any reason. The diff to this function must be
confined to listing and asset resolution at the top and the counter update at the
bottom. The gate block, from `hay_listing :=` through the end of the `kindmap`
loop, must be byte-identical before and after. The plan's review step checks this
explicitly.

**Return contract.** The function currently returns `asset_id`, which the harvest
scripts consume. Silently changing what that key means is a trap. It returns both:

```json
{ "listing_id": "...", "asset_id": "...", "status": "created" }
```

`asset_id` keeps the key but now means the product. Scripts that log it need
updating in the same change.

Slug collision on ingest is possible in principle even though there are none today.
If `source_product_id` is already taken as a slug, the new asset's canonical slug
becomes `{marketplace_id}-{source_product_id}`, and the ingest result records that
it did so.

## Read surface

The app reads five views and one RPC and **never touches a base table**. This was
verified across every `.ts`, `.tsx` and `.mjs` in the repo. It is what makes the
rename safe: as long as the views keep their names and grain, the database can
change without the deployed site changing.

### The one operational fact that makes phase 1 tractable

**Views follow a table rename automatically. Function bodies do not.**

A view records its dependencies by object identity, so `alter table asset rename to
listing` leaves every view working, still reading the same table under its new name.
A plpgsql function body is stored as text and resolved when it runs, so the same
statement silently breaks `ingest_capture` and `set_capture_logo`, which fail at
their next call with "relation asset does not exist".

That asymmetry is why phase 1 can leave the read surface alone while the write path
must be rewritten in the same migration. Every plpgsql function naming `asset` has
to be recreated in the migration that performs the rename: `ingest_capture` and
`set_capture_logo`. Nothing else in the schema names it from inside a function body.

### View grain

This table describes the **end state**, reached in phase 2. Phase 1 keeps every
existing view's grain as it is today, and changes columns only additively.

| view | today | end state |
|---|---|---|
| `v_registry_card` | one row per listing | one row per asset, plus `marketplace_ids text[]` and `listing_count int` |
| `v_asset_passport` | one row per listing | one row per asset, from the primary listing, plus `listings jsonb` |
| `v_asset_change_feed` | per listing, exposes `asset_id` | per listing, exposes **both** `listing_id` and a real `asset_id`, from phase 1 |
| `v_registry_stats` | counts listings | counts assets |
| `v_logo_status` | per listing | per listing, joined through `listing`, same columns |
| `v_listing_passport` | new in phase 2 | one row per listing. What `v_asset_passport` is today |
| `v_asset_evidence` | new in phase 2 | one row per capture, keyed by asset. Every marketplace's every observation |

`v_asset_change_feed` needs care. Its `asset_id` column is consumed by the app's
`ChangeRow` type, and after the rename the underlying id is a listing. Rather than
leave a column whose name contradicts its contents for a whole phase, phase 1 emits
both: `listing_id` for what actually changed, and `asset_id` for the product it
belongs to. They hold different values from phase 3 onward, and `asset_id` is the
more useful of the two for a feed a visitor browses.

**Struck during phase 2. This paragraph was false when written.** It said
`getAllProductIds` feeds `generateStaticParams` for the passport route, and
required phase 2 to point it at `asset_slug` instead.

`generateStaticParams` exists only on `app/news/[slug]` and `app/products/[slug]`.
The passport route has never had one and has never been statically generated, so
`getAllProductIds` had no caller and was dead before any of this work began. Phase
2 deleted it rather than inventing a caller, because adding static generation would
pre-render 6,878 pages at build time, which is a real cost and a behaviour change
nobody asked for.

The reasoning it contained is still correct and worth keeping for whenever
pre-rendering is actually wanted: read `asset_slug`, not `v_registry_card`, because
the card emits only primary listings and a merged-away product's URL would stop
being pre-rendered.

`v_asset_evidence` is the read path for "always point back to it or run AI over it":
given an asset, hand back every listing, every capture, `captured_at`,
`content_hash`, `ingest_source` and whether `raw` is present, newest first.

### Aggregation rules

An asset's card and passport draw their descriptive fields from the primary
listing, but several fields are not descriptive and must not be taken from one
listing. Each is stated here so that nobody has to guess:

| field | rule |
|---|---|
| `last_captured_at` | `max` across the asset's listings |
| `capture_count` | `sum` across the asset's listings |
| `first_seen_at` | `min` across the asset's listings |
| `marketplace_ids` | array of every listing's marketplace, sorted |
| `listing_count` | count of listings |
| `certification` | **any**, not primary. See below |

**Certification is "any listing", and the page names which one.** If Microsoft
certifies a product and AWS does not, the product is certified, and the passport
says who certified it. Taking it from the primary listing would make a real
attestation appear and disappear depending on a stored pointer, which is a worse
answer than either marketplace gives on its own.

The same rule governs `v_registry_stats.certified` and `.attested`: an asset counts
if any of its listings qualifies.

**Amended during phase 2, after getting this wrong three times.** This paragraph
originally said `provenance`, `risk` and `evidence_tier` follow the qualifying
listing. That list was too short, and each attempt to extend it was short again by
whatever sat one derivation further out:

1. `risk_basis` was omitted, so a page could state one risk and explain another.
   It is the sentence `registry_risk()` builds from the same certification as
   `risk`.
2. `known_layers` and `layers_known` were omitted, so a ledger could read
   "7 of 12" beside a `risk_basis` naming a different count. Three of the twelve
   layers only ever appear on a certification page.
3. `reach` was omitted, on the stated grounds that it is not certification
   derived. It is: `reach = round(100 * cardinality(known_layers) / 12)`. It was
   already rendering contradictorily, a 25 percent ring above "7 of 12 layers".

The rule is therefore **not a list of fields**. It is a closure, and it must be
evaluated rather than recalled:

> The certification group is the connected component containing `certification`
> under the relation "is a function of", treated as **undirected**. A column
> belongs to the group if it is computed from something in the component, or if
> something in the component is computed from it. `layers_tracked` is excluded: it
> is a constant from `registry_layers()` and describes no listing.

As of phase 2 the members are `certification`, `cert_label`, `provenance`,
`evidence_tier`, `risk`, `risk_basis`, `known_layers`, `layers_known` and `reach`,
carried by one lateral so they cannot come apart.

**The component is currently cut, and phase 3 must close it.** `known_layers`
summarises twelve facts, and eleven of them still come from the primary listing:
`publisher`, `cert_hosting`, `cert_data_location`, `pricing`, `plans`,
`acquire_using`, `support`, and the five build layers drawn from verified
`capture_evidence` rows. Only permission scope travelled with the certification.
So under two listings a passport can show a ledger reading "7 of 12 traced" above
`Hosting: Unknown` and an empty model list. Phase 3 chooses between moving the
whole disclosure block to the qualifying listing, or returning `known_layers` to
the primary and attributing `risk_basis`. Neither was taken in phase 2, because
1:1 makes the choice untestable.

The passport attributes the group, naming the marketplace its certification came
from separately from the one its description came from.

### Search must span every listing, not just the primary

`registry_search` builds its haystack from `v_registry_card` columns. If the card is
asset-keyed and drawn from the primary listing, text that appears only on a
secondary listing becomes unfindable: a product whose AWS description names vLLM but
whose Microsoft page does not would not match a search for vLLM, though the registry
holds the text. That is the no-flattening rule leaking out of the page and into the
query layer.

Two changes, both in phase 2:

1. `v_registry_card` carries a `search_blob text` built by concatenating the nine
   searched fields **across every listing of the asset**, in the existing field
   order. `registry_search` matches against that instead of against the primary
   listing's columns. The nine-field order must continue to match `searchBlob()` in
   `marketplace-query.ts`, which is what the existing parity test checks.
2. The `source` facet moves from equality on a single `marketplace_name` to
   containment against `marketplace_ids`. An asset listed on Microsoft and AWS must
   match a filter for either. Every other facet stays single-valued and comes from
   the primary listing, except `certification`, which follows the "any" rule above.

### Grants, and the reason this section exists

`create or replace view` drops every grant on the view. This has already taken
every logo off the live site once: `v_logo_status` was replaced to add
`marketplace_id`, the replacement carried no grant block, `anon` lost select, and
`getLogos` returns `{}` on error, so 6,820 archived images silently rendered as
initials.

This work replaces every view in the schema. Therefore:

1. Each view's `grant` statement sits immediately after the view in the same
   migration, never in a separate block or a later file.
2. Each migration ends with an assertion that fails the migration if any expected
   grant is missing.

## Merge

```sql
merge_assets(p_from uuid, p_into uuid, p_basis text, p_by text) returns jsonb
```

1. Move every listing from `p_from` to `p_into`.
2. Move every slug from `p_from` to `p_into`, setting `is_canonical = false` on
   the moved ones so the survivor keeps its own canonical slug.
3. Set `asset.merged_into = p_into` on the retired asset.
4. Write one `asset_merge` row recording the listing ids and slugs that moved, the
   basis, and who did it.

Because slugs are repointed rather than chained, a slug lookup stays a single
indexed read with no recursion.

```sql
unmerge_asset(p_merge_id bigint) returns jsonb
```

Reads the log row, moves the listings and slugs back, clears `merged_into`, stamps
`undone_at`. Captures and extracts are untouched throughout, in both directions.

**The link is our claim, not the marketplaces'.** No marketplace says two listings
are the same product. `basis` and `merged_by` are not bookkeeping; they are the
provenance of an assertion the registry makes on its own authority, and they are
held to the same standard as everything else here.

Merges are invoked by a person. `merge_assets` and `unmerge_asset` are granted to
`service_role` only, like `ingest_capture`.

## The product page

The passport leads with the product, drawn from the primary listing and labelled
with the marketplace it came from. Underneath, one panel per listing.

**No flattening.** Where marketplaces agree on a field, show it once. Where they
disagree on price, category, rating or certification, show every value with its
marketplace named. Never average, never pick a winner silently, never present a
consensus that no source stated. Cross-marketplace disagreement is the most
interesting thing this registry knows and collapsing it would be inventing data.

This is the same rule that took `$3,999/mo to $29,999/mo` off the Opp Shredder card:
a figure belongs to the listing that published it.

The registry grid shows one card per asset with a marketplace badge per listing.

## Migration and deploy order

Three phases, each independently shippable, and the first is invisible to visitors.

**Phase 1 runs on a Supabase branch database first.** The rename is the least
reversible step in this work and there is no down-migration worth trusting for it.
Phase 1 is applied to a branch, the phase 1 verification list is run there in full,
and only then is it merged to production. If it fails on the branch, the branch is
discarded and nothing was risked. This is a requirement of the phase, not a
suggestion for the day.

**Phase 1: schema.** Rename, create, backfill, recreate `ingest_capture` and
`set_capture_logo`, re-grant. Every view keeps its name and grain; the only column
change is the additive one on `v_asset_change_feed`. Assets and listings are 1:1, so
`v_registry_stats` is unchanged and the site behaves exactly as before. No app deploy
required.

**Phase 2: read surface.** Add `v_listing_passport` and `v_asset_evidence`. Move
`v_registry_card` and `v_asset_passport` to asset-keyed with the added columns.
Update the app to resolve a slug to an asset, and to render per-listing panels.
Still 1:1, so still no visible change, which is the point: the read path can be
proven correct before any data moves.

**Phase 3: merge.** `merge_assets` and `unmerge_asset`, then work the 193
within-Microsoft duplicates. This is the first phase where the registry's numbers
move.

`v_registry_stats.agents` becomes a count of products rather than pages, so it
falls as merges land. That is the correct meaning of the number, and it does not
move until phase 3.

**Retired assets must be excluded from every count.** A merged-away asset is kept
rather than deleted, so `select count(*) from asset` would include it and the
headline number would never move no matter how many merges landed. Every count over
`asset` carries `where merged_into is null`. `marketplaces` moves to
`count(distinct marketplace_id) from listing`, since marketplace membership is a
property of listings and always was.

```sql
(select count(*) from asset where merged_into is null)              as agents,
(select count(distinct marketplace_id) from listing)                as marketplaces,
```

The same exclusion applies anywhere else an asset is counted or listed, including
`v_registry_card`, which joins through `listing` and therefore already excludes
them: a retired asset has no listings. The stats view is the one place that counts
`asset` directly, which is exactly why it is the one place that gets this wrong.

## Correction to an existing comment

The comment on `capture` says `raw` is null "only for rows backfilled from a
pre-Supabase index". That is not accurate. Of 30,900 captures, 187 have
`raw = null`: 140 are `backfill`, and **47 are `dual_write`**, all
`template_version 2.0`, all Microsoft, all captured in a two-hour window on
2026-08-17, from the manual capture era. No listing's current capture has null
`raw`, so the live surface is fully backed, but the comment should say what is
true. Fixing it is part of phase 1.

## Verification

Every check below is a query that must pass before the phase is considered done.
All of them order by a unique key: PostgREST paging without a total order returns
overlapping pages, which produced two contradictory answers during the design
review of this document, and the 1,000-row default cap has silently truncated this
project's reads four times.

**Phase 1**, run in full on the branch database before production

- `select count(*) from listing` equals 6,876, unchanged.
- Every listing has exactly one asset: `select count(*) from listing where asset_id is null` is 0.
- Every asset has exactly one canonical slug, and every slug resolves.
- Every pre-existing `/agent/{source_product_id}` resolves to the same passport content as before.
- `v_registry_stats` returns identical values before and after, field by field.
- Every view named in this document has `select` for `anon`, `authenticated` and, where it had one, `service_role`.
- The evidence gate block in `ingest_capture` is byte-identical to its previous text.
- `ingest_capture` and `set_capture_logo` both execute successfully after the rename. A function that still names `asset` fails only when called, so this must be exercised, not inspected.
- A harvest of one DRAI asset produces one listing, one asset, and one capture, and the reported counts match.
- Re-harvesting an existing listing creates no second asset and no second slug.

**Phase 2**

- Row counts of `v_registry_card` and `v_asset_passport` equal the count of assets where `merged_into is null`.
- `v_listing_passport` row count equals the listing count.
- `v_asset_evidence` returns 30,900 rows, one per capture.
- `registry_search` returns the same result set as before for a fixed set of queries, which is still meaningful because assets and listings are 1:1 until phase 3.
- The existing `registry-search.parity.test.ts` passes unchanged, which is what proves `search_blob` still matches `searchBlob()` field for field.

**Phase 3**

- A duplicate set chosen at the time, from the 193 within-Microsoft candidates, merges into one asset holding all its listings, and every one of the original URLs resolves to it. Whether any particular set is genuinely one product is a data judgment made then, not asserted here.
- After that merge, `v_registry_stats.agents` has fallen by exactly the number of listings absorbed minus one.
- `unmerge_asset` restores the exact prior state: listing ownership, slug ownership, canonical flags, and the stats figure.
- No capture, extract, plan, link or evidence row is modified by a merge or an unmerge.
- Searching for text that appears only on an absorbed listing still finds the merged asset.

## Risks

| risk | handling |
|---|---|
| `create or replace view` drops grants and breaks reads silently | grants in the same migration, immediately after each view, plus a failing assertion |
| A new table with RLS and no policy is invisible to `anon` | explicit policy and grant per new table, verified |
| The evidence gate is disturbed while editing `ingest_capture` | gate block must be byte-identical; checked in review |
| The rename breaks the deployed site | the app touches only views, and views follow a rename automatically; phase 1 keeps every view's name and grain |
| The rename breaks the write path, which no view protects | plpgsql bodies are text and do not follow a rename, so `ingest_capture` and `set_capture_logo` are recreated in the same migration and then actually called during verification |
| Phase 1 goes wrong in production with no way back | applied and fully verified on a Supabase branch database first; a failed branch is discarded, not rolled back |
| Search stops finding text held only on a secondary listing | `v_registry_card.search_blob` spans every listing of the asset; the source facet moves to array containment |
| A retired asset keeps being counted, so the headline never moves | every count over `asset` carries `where merged_into is null` |
| A wrong merge publishes a false claim about two products | merges are manual, recorded with basis and author, and fully reversible; listings and captures are never modified |
| Slug collision on a future marketplace | `asset_slug.slug` is a primary key; ingest falls back to `{marketplace_id}-{source_product_id}` and records that it did |
| "Agents indexed" changes on the front page | unchanged until phase 3, then correct by construction, since it becomes a count of products |

## Deferred

- Automatic merge-candidate generation, to be designed against AWS pairs.
- The AWS Marketplace pipeline. Settled separately: scope is the AI Agents & Tools
  category (5,160 listings), enumeration via the `awsmpdiscovery` endpoint with a
  sitemap reconciliation check, detail from `/marketplace/pp/{prodview-id}`, and a
  new `aws_vendor_insights` value on `certification_status`.
- Evidence extraction across all sources.
