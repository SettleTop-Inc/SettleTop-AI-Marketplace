# Splitting the overview from the marketplace

**Date:** 2026-08-16
**Status:** design approved; adversarially reviewed; pending implementation plan

## The problem

`/` currently does two incompatible jobs. [`components/RegistryApp.tsx`](../../../components/RegistryApp.tsx)
is a single client component holding the marketing site — hero, use cases, top
agents, provenance workbench, vendor CTA — *and* the working registry: 140 cards
with a filter rail.

The marketing half is right; it reads like a company website and that is what it
is for. The registry half is styled to match, which makes it a showcase rather
than a tool: no sort, no pagination, no URL state, no density control, no way to
put two agents side by side. A visitor who decides to go looking for an agent has
nowhere better to go.

This splits the two. The overview stays and becomes the front door. A new
marketplace route becomes the place you dive into.

## Decisions taken

| Decision | Choice |
|---|---|
| What `/` becomes | Marketing **plus** its existing grid, unchanged in kind |
| The tool's route | `/marketplace` — SettleTop is a marketplace of AI, and inventorying other marketplaces is part of that |
| Visual language | Brand-continuous: the shell, cards and spacing of the existing design |
| Where filtering runs | In the browser, over the full card set, state in the URL. `v_registry_card` is 167 kB / 140 rows (~1,225 B/row); backlog 4 sets the switch-to-server threshold near 1 MB, so this holds to ~850 agents |
| `q` scope | **One nine-field blob shared by both surfaces** |
| History | **`push` for facet/sort/view changes, `replace` for the debounced `q`** |
| Zero-count facet values | **Rendered disabled, showing their `0`** |
| Compare key | **`asset_id`** |

### Non-goals

- Moving filtering into Postgres (backlog 4) or full-text search (backlog 5).
- Any change to `ingest_capture()`, the evidence gate, or any migration.
- Any change to the stylesheet (see *CSS*), or to what the passport renders.

## Routes and flow

```
/                              marketing + demo grid            kept, re-pointed
  hero search              ->  /marketplace?q=…
  use-case card (:360)     ->  /marketplace?function=…
  Popular chip (:245)      ->  /marketplace?function=…       shares pickUseCase (:174)
  "Browse agents" (:203)   ->  /marketplace
  "Explore the full agent
   registry" (:404)        ->  /marketplace
  "View all use cases →"
   (:351)                  ->  /marketplace
  nav "Registry" (:197)    ->  stays #registry — an in-page anchor beside
                               Use cases / Top agents / Provenance
  "Open these results →"   ->  /marketplace?…current criteria…
  top-agent "View details" ->  passport modal (unchanged)

/marketplace                   the tool                          new
  facets / sort / page / view  ->  querystring
  "Open passport"          ->  /agent/[id]?from=marketplace
  select 2–3 → Compare     ->  /marketplace/compare?ids=<asset_id>,…
  "← Overview"             ->  /

/marketplace/compare           provenance side by side           new
/agent/[id]                    passport                          unchanged except back link
```

**Step 5 is mechanical:** grep `scrollTo("registry")` in `RegistryApp`. Every call
site becomes a `/marketplace` navigation. The nav anchor at `:197` is the sole
exception — it is an in-page section anchor and that section still exists.

**The back link's mechanism.** `app/agent/[id]/page.tsx:33-39` hardcodes
`href="/"`. Cards minted on `/marketplace` link to `/agent/[id]?from=marketplace`;
the passport reads that param and defaults to `/` when absent. It is a *search*
param, so the no-`decodeURIComponent` rule below applies.

The grid on `/` keeps its dropdowns and instant filtering — that liveness is what
makes the landing page feel real. It gains one hand-off control that serialises
the visitor's current criteria into a `/marketplace?…` link, which is what makes
the duplication an on-ramp rather than a competing tool.

## Components

```
app/page.tsx (server)                 app/marketplace/page.tsx (server)        NEW
  getCards · getStats                   getCards() + getLogos()
  getFeatured · getLogos                + the same logo merge
  + logo merge                                 |
        |                                      v
        v                             <Suspense fallback={…}>                  REQUIRED
components/LandingApp.tsx               components/marketplace/
  (renamed from RegistryApp)              MarketplaceApp.tsx (client)          NEW
  imports searchBlob()                      URL <-> criteria only
        |                                          |
        |                                          v
        |                               lib/marketplace-query.ts (pure)        NEW
        |                               searchBlob(card)
        |                               (cards, criteria) => {rows, facets, total}
        |                                          |
        +--------------------+---------------------+
                             v
              components/AgentCard.tsx      extracted; "use client"
              components/AgentLogo.tsx      existing, reused
              components/PassportView.tsx   unchanged
```

- **One read.** Both routes call the existing `getCards()`.
- **`MarketplaceApp` owns nothing but URL ⇄ state.** It never filters inline.
- **`lib/marketplace-query.ts` is pure and imports no React.** Every number the
  interface asserts is produced there and nowhere else.
- **`searchBlob(card)` lives there too and is the only definition of what `q`
  matches.** `LandingApp` imports it and the `useMemo` at `RegistryApp.tsx:83-105`
  is deleted. One definition, two surfaces.
- **`AgentCard` is extracted**, carries `"use client"` (it has an `onClick`), and
  renders `<AgentLogo>`.
- **`AgentCard`'s `onOpen` prop becomes optional.** It is required today
  (`RegistryApp.tsx:656`) and its only consumer is the "View details" button that
  opens the landing page's modal. `/marketplace` has no modal in this design, so
  the card renders without that button when `onOpen` is absent. Without this, step
  3 would have to reproduce the modal, its passport fetch and its state purely to
  satisfy a prop.
- **`RegistryApp` becomes `LandingApp`.**

### The logo merge is not optional

`AgentCard` renders `<AgentLogo … logo={c.logo}/>`, and `c.logo` is **not**
returned by `getCards()` — it is merged in `app/page.tsx` from a separate
`getLogos()` read of `v_logo_status`. Any new route rendering `AgentCard` must
repeat that merge or every card silently falls back to initials with no error.
Because it is now needed in three places it moves to a shared helper. The
reasoning for not joining it in SQL — logos have a separate archival lifecycle
from the capture — still holds.

> **Live state:** `v_logo_status` has **0** rows in `state='archived'`, so every
> agent renders initials today. A broken merge would look exactly like normal
> operation. Archive a logo before testing this or you are testing nothing.

## The URL contract

| Param | Values | Behaviour |
|---|---|---|
| `q` | free text | Substring over the shared blob: `name`, `publisher`, `tagline`, `function_category`, `marketplace_name`, `evidence_tier`, `delivery`, `cert_label`, `surfaces.join(' ')`. Single value. |
| `source` | `marketplace_name` | Repeatable |
| `function` | one of the 12 use cases | Repeatable |
| `provenance` | `Verified` `Disclosed` `Unknown` | Repeatable |
| `risk` | `Low` `Medium` `High` | Repeatable |
| `tier`, `delivery`, `price` | values from the view | Repeatable |
| `sort` | `reach` `rating` `name` `captured` | Default `reach` |
| `dir` | `asc` `desc` | Default `desc` for reach/rating/captured, `asc` for name |
| `page` | 1-based integer | Default 1. **Any change to `q`, a facet, `sort` or `dir` resets `page` to 1** (drops the param). Clamping to the last page applies only to *inbound* URLs — bookmarked, hand-typed or stale. |
| `view` | `grid` `list` | Default `grid` |

1. **Different facets AND together; values within one facet OR together.**
2. **Defaults are never written to the URL.** The plain case stays `/marketplace`.
3. An unrecognised value is dropped and the URL rewritten to what was applied.
4. **Page size is a named exported constant** in `marketplace-query.ts`, not a URL
   parameter.
5. **Navigation:** `push` for facet, sort and view changes so Back undoes one
   filter; `replace` for the debounced `q` so typing does not flood history. Both
   pass `{ scroll: false }`.

`source` is listed first in the facet rail and stays visible at one source. Backlog
8 notes `asset` is keyed by `(marketplace_id, source_product_id)`, so the axis
costs nothing now and would be a rework later.

## Facets, counts, and the Unknown rule

Every facet is backed by a `RegistryCard` field. CLAUDE.md rule 1 governs nulls: a
null is the literal string `Unknown`, and `Unknown` is a selectable facet value
like any other.

`marketplace-query.ts` normalises the four nullable fields — `function_category`,
`delivery`, `evidence_tier`, `price_band` — to the single `UNKNOWN` constant from
`lib/present.ts`, and **collapses a SQL literal `'Unknown'` with a JS `null`** so
one facet cannot split into two rows with divided counts.

Two existing idioms are the wrong template and must not be copied: `RegistryApp.tsx:69`
buckets a null `function_category` as `"Unclassified"` — a fourth spelling of
Unknown — and `:61` *drops* a literal `'Unknown'` delivery instead of offering it.
Both are latent today (0 nulls in either field across 140 rows); they are listed so
the new module does not inherit them.

### Facet counts are self-excluding

**Facet F's counts are computed over the rows matching `q` and every *other*
facet, with F's own selection removed.** A count is a preview of what selecting
that value would yield — the only reading consistent with OR-within-facet.

Getting this wrong is not cosmetic. Under intersection counting, ticking
`risk=Low` renders `Low 36, Medium 0, High 0` while 16 Medium and 88 High agents
exist, telling the visitor that adding a value adds nothing when it adds 88 rows.
That is both a dead end and CLAUDE.md rule 1's "blank that reads as zero".

Because every facet is single-valued and nullables normalise to `Unknown`, each
row falls in exactly one bucket per facet, so:

- F's counts sum **exactly** to its self-excluded base;
- which equals `total` **when F is unselected**.

`surfaces` is a `string[]` and is deliberately **not** a facet — no URL param, no
rail entry. Promoting it would put one row in two buckets of one facet and break
that equality independently of any selection. Its presence in the `q` blob does
not affect counts, because `q` produces no facet rows.

**A value whose count is 0 in that base renders disabled, showing its `0`** — the
rail is a map of the registry, not of the current query.

### The risk facet carries its explanation

CLAUDE.md rule 5 forbids presenting evidence risk as a security rating, and the
passport carries a footnote saying so. Making `risk` a counted, deep-linkable
facet on a new route would strip that. Therefore `/marketplace` renders, inside
the risk facet group, the same sentence the passport uses — *evidence risk
measures how much of the build you cannot see before you deploy, not a safety
score* — and each card keeps `risk_basis` as the band's subtext, so the band is
never shown bare. This is new copy on a new route; `PassportView` is untouched.

## Sort must be a total order

No planned sort key is unique and the ties are large:

| Key | Nulls | Largest tie |
|---|---|---|
| `rating` | 28 | 61 rows share 5.00 |
| `reach` | 0 | 33 rows; only 9 distinct values |

Without a total order, pagination is unstable — the same agent appears on two
pages, or vanishes. Therefore:

- **Nulls form a terminal group, last in *both* directions.** The existing
  `(b.rating ?? 0) - (a.rating ?? 0)` at `RegistryApp.tsx:130` is wrong for the
  ascending direction this design adds: it ranks 28 unrated agents above a
  genuinely 3.4-star agent, asserting a rating of zero no source stated.
- **Terminal tie-break on `asset_id`**, which is unique. `source_product_id` is
  unique only per marketplace.
- **One pinned `Intl.Collator`** shared by grid, list and compare.

## Compare

`/marketplace/compare?ids=<asset_id>,<asset_id>[,<asset_id>]` — 2–3 agents,
fetched server-side as full passports because card rows carry no evidence,
permissions or compliance.

**Key choice.** `asset_id` is collision-proof, where `source_product_id` is unique
only per marketplace. The cost is that the site now has two public agent
identifiers: `/agent/[id]` resolves `source_product_id`, compare resolves
`asset_id`. That is deliberate and should be recorded in backlog 8 so a second
marketplace does not surprise anyone.

**Reads.** `getPassport` returns `null` for both a missing row and a failed read,
so compare must not use it. Add `getPassports(assetIds)` — a single
`.in('asset_id', ids)` against `v_asset_passport` — returning the same
failure-expressing type as `getCards`. A Supabase error renders the whole page as
"could not load"; only ids absent from a *successful* result are named as not
found. `getPassport`'s existing call sites are unchanged.

**Do not `decodeURIComponent` the `ids` param.** Next decodes search params before
they reach the page; only *path* params arrive encoded, which is why
`app/agent/[id]/page.tsx:17` correctly decodes and this must not. A second decode
throws `URIError` on a literal `%` and corrupts `%2F` and `%2B`.

**Rows** are exactly the provenance layers the passport tracks, in its order.
Compare introduces no new claims; it transposes a record that exists.

**Three-state row marking.** A binary same/differs marker cannot tell the truth
here:

| Row state | Marking |
|---|---|
| Values differ, all stated | **Difference** — knowable and the reason to open the page |
| Some agents state a value, others are `Unknown` | **Difference** — the asymmetry is knowable |
| *All* agents are `Unknown` | **Neither.** Rendered plainly as "no evidence to compare" |

Marking an all-Unknown row as *matching* would assert we know the agents are the
same. Marking it as *differing* would assert the records differ when they are
identical. Both are inferences rule 1 forbids; the honest answer is that the row
is not comparable.

## Error handling and honest empty states

Every reader in `lib/registry.ts` logs and returns a success-shaped empty value:
`getCards` `[]` at :69, `getStats` `null` at :51, `getPassport` `null` at :84,
`getFeatured` `null` at :104, `getLogos` `{}` at :32. A Supabase outage is
indistinguishable from an empty registry.

On the landing page that degrades quietly. On a marketplace it renders a full
facet rail of zeros next to "No matching agents — try clearing one or more
filters", blaming the user for filters they never set.

`getCards` and the new `getPassports` need return types that can express failure.
`getCards`'s only current import site is `app/page.tsx`, so the change is contained.

| Edge case | Honest behaviour |
|---|---|
| Unknown facet value in URL | Drop it, rewrite the URL to what was applied |
| Facet / sort change while on page N | **Reset to page 1**, not clamp |
| Inbound `page` beyond the last page | Clamp to last page |
| Malformed `sort` key | Fall back to default, rewrite URL |
| `ids` absent from a successful compare read | Name them as not found |
| Supabase read fails | "Could not load", never "0 results" |
| `risk` facet rendered with counts | Group labelled with the rule-5 sentence; band never shown bare |

## Accessibility

`globals.css` has zero `:focus` rules and sets `outline:0` on `.registry-search
input`. On a surface whose entire purpose is filtering, that is not acceptable:

- **`aria-live="polite"` on the result count.** Sort, pagination, view toggle and
  facet ticks all replace the results region while focus stays on the control. A
  repo-wide grep returns zero `aria-live`, and a same-route soft navigation
  produces no route-announcer message — so today the change is silent. WCAG 2.1
  SC 4.1.3. The dropped-facet correction must be announced through the same region.
- **`:focus-visible` restored** for all marketplace controls, scoped under `.mkt-`.
- **Facet rail is a real fieldset/legend group** with checkbox semantics, operable
  by keyboard; disabled zero-count values use `aria-disabled`.
- **Compare is a real `<table>`** with row and column headers, not a div grid.
- **Verified / Disclosed / Unknown never rely on colour alone** — each pill keeps
  its text label.

## CSS

**Naming note:** CLAUDE.md:186 freezes a file called `styles.css`, which does not
exist. The only stylesheet is `app/globals.css`, imported by `app/layout.tsx:2`.
This spec treats `globals.css` as the frozen file. *Worth correcting in CLAUDE.md
separately.*

`globals.css` is imported by the **root layout**, so it is live on `/marketplace`
from first paint, and App Router never removes route CSS from `<head>` once
loaded. A bare class name in a marketplace stylesheet that `globals.css` also
defines will therefore repaint `/` after a client-side back-navigation — a
heisenbug that will not reproduce on a hard reload.

**Every new class is prefixed `mkt-`** (0 occurrences in `globals.css`). Do not use
`marketplace-`: `.marketplace-heading` is already live. Never re-declare
`.registry-card`, `.registry-grid`, `.filters`, `.section`, `.container`,
`.empty-state` or `.prov-pill`.

- **Do not reuse `.filters`** for a checkbox rail: `position:sticky; top:92px`
  tuned to `.nav{height:72px}`, a 2-column collapse at 820px, and a label/select
  layout built for dropdowns.
- **Grid overflow.** `.registry-layout` and `.registry-grid` default to
  `min-width:auto`; the results column needs `min-width:0` and the grid
  `minmax(0,1fr)`. The compare table needs an `overflow-x:auto` wrapper.
- **Element selectors leak.** `footer{…}` will style a compare tray built as a
  `<footer>`. `html{scroll-behavior:smooth}` makes programmatic scrolls animate
  unless the caller passes `behavior:'instant'`.
- **Breakpoints are 1050 / 820 / 580** — verified; there is no 768 or 1024. The
  facet rail collapses at 820, where `.registry-layout` already stacks.
- **`.nav-links{display:none}` below 1050px with no hamburger**, so any nav-only
  entry point is invisible on phones. `.nav-actions` "Browse agents" is never
  hidden and is the mobile path into the marketplace.

## Next.js constraints

Verified against Next 15.5.23 in this repo:

- **`useSearchParams()` in a client component fails `next build`.** A statically
  prerendered route using it exits non-zero with *"useSearchParams() should be
  wrapped in a suspense boundary"*. Confirmed with a throwaway probe.
  `MarketplaceApp` must sit inside an explicit `<Suspense>` in
  `app/marketplace/page.tsx`; there is no `loading.tsx`, `error.tsx` or
  `template.tsx` under `app/` to supply an implicit one.
- **The Suspense fallback renders the static shell** — header, facet rail
  skeleton and toolbar — never a bare spinner, so the page does not reflow.
- **`next dev` renders every request dynamically, so this failure is invisible in
  dev.** Gate on `npm run build`.
- **Directories prefixed `_` are private folders** and produce no route at all.
- **`router.push`/`replace` default to `scroll:true`.** Every navigation passes
  `{ scroll: false }`.
- **`searchParams` is Promise-typed in Next 15** and must be awaited. Declare page
  props inline as `app/agent/[id]/page.tsx:9` does; do not rely on the generated
  `PageProps`, since `.next/` and `next-env.d.ts` are gitignored and a fresh clone
  would fail `npm run typecheck`.
- **Debounce `q`** at ~300 ms into a `replace`, with the input bound to local state.

## Testing

Add Node's built-in runner (`node:test`, zero dependencies) and an `npm test`
script, scoped to the pure module:

- each facet alone; two facets AND-ing; two values in one facet OR-ing
- **each facet's counts sum exactly to its self-excluded base, and to `total` when
  that facet is unselected**
- **regression guard against self-filtered counting:** after selecting one value,
  that facet's other values still report non-zero counts where rows exist —
  `risk=Low` still shows Medium 16, High 88
- **`q` parity:** `|landing(q)| === marketplaceQuery(cards,{q}).total`, asserted
  with a `surfaces`-only needle — `"Virtual Machines"` matches **28** rows through
  the nine-field blob and **0** through a five-field one
- `Unknown` is selectable, and a SQL literal `'Unknown'` collapses with `null`
- sort: each key, both directions, nulls last in **both**, `asset_id` tie-break —
  assert stability across a page boundary on `rating`, where 61 rows tie
- pagination: reset on criteria change, clamp on inbound, boundaries, page size
- URL round trip is lossless and defaults are absent from the serialised form

`marketplace-query.ts` is where a wrong count silently becomes a false claim.

## Measured facts

Against the live database and repo:

- `v_registry_card`: 140 rows, 167 kB, ~1,225 B/row
- `risk`: Low 36, Medium 16, High 88 · `provenance`: Verified 15, Disclosed 31,
  Unknown 94
- `rating`: 28 nulls, largest tie 61 · `reach`: 9 distinct values, largest tie 33
- `function_category`: 10 distinct, 0 nulls (2 of 12 use cases have no agents);
  `delivery`: 0 nulls, 0 literal `'Unknown'`
- `"Virtual Machines"`: 28 rows via the nine-field blob, 0 via five fields
- `v_logo_status`: 0 rows archived
- Views: `v_registry_card`, `v_asset_passport`, `v_asset_change_feed`,
  `v_registry_stats`, `v_logo_status`

## Sequencing

1. Extract `AgentCard` (`"use client"`, `AgentLogo`, optional `onOpen`); lift the
   logo merge into a shared helper; rename `RegistryApp` → `LandingApp`. No
   behaviour change.
2. `lib/marketplace-query.ts` — `searchBlob`, filtering, self-excluding counts,
   sort, pagination — plus its tests. No UI.
3. `/marketplace`: Suspense boundary and shell fallback, facet rail with counts and
   the rule-5 sentence, toolbar, grid, pagination, URL sync with `push`/`replace`
   as specified, `scroll:false`, debounced `q`, `aria-live` count.
4. List view toggle.
5. Re-point the landing page: grep `scrollTo("registry")`, swap `LandingApp` to the
   shared `searchBlob`, add the hand-off link. **This deliberately changes `/`** —
   unlike step 1 — because the search definition becomes shared.
6. Reader error contracts (`getCards`, `getPassports`) and the two distinct empty
   states.
7. Compare: selection model, tray, `/marketplace/compare`, three-state row marking.

Steps 1 and 2 are independent and carry no visual risk. Compare is last, but its
selection model is designed into step 3 rather than bolted on.
