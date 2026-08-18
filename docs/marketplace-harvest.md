# Marketplace harvest: instructions for Claude Code

**Status:** discovery complete and verified in a live browser. Implementation not
started. This document is the spec.

**Why this exists:** the DOM-scraping capture worker hit structural limits —
enumeration stalled, a virtualizing grid that destroys cards while you scroll,
~30 seconds and four tab navigations per listing, and a logo that could not be
told apart from a screenshot. All of that is now unnecessary. The storefront is
server-rendered and embeds its entire structured payload in the page.

---

## 1. The finding

`marketplace.microsoft.com` performs **zero data XHRs**. A page load fires 18
requests, every one of them Google / LinkedIn / Bing / Clarity telemetry. The
product data is server-rendered into `window.__INITIAL_STATE__`.

Reading that object is exactly as public and unauthenticated as viewing the
page. No API key, no auth, no credential anywhere in the pipeline.

### Why we are not using the documented API — tested, not assumed

`https://catalogapi.azure.com` (Azure Marketplace Catalog) is real and current,
with `/products`, `/search`, `/facets`, `/list-skus`. Every version was called
anonymously from a browser and every one refused:

| Call | Response |
|---|---|
| `/products?api-version=2025-05-01` | `Unauthorized` — "X-API-Key header is required for this endpoint and api version: 2025-05-01" |
| `/search?api-version=2023-01-01-preview` | `Unauthorized` — "'X-API-Key' header is required for this endpoint and API version 2023-01-01-preview" |
| `/products?api-version=2023-05-01-preview` | `Unauthorized` — "X-API-Key header is required for this endpoint and api version: 2023-05-01-preview" |

Keys come from `aka.ms/DiscoveryAPI/keys`. Niles has tried repeatedly and cannot
get one — he gets trapped in an MFA loop where the second factor never arrives.
That is a Microsoft account-flow problem, not something this project can
engineer around, and it is not worth further effort because nothing here needs
a key. There is no anonymous tier on any version tested.

**This is settled. Do not spend time retrying the keyed API.** The embedded
state below returns the same catalog without a key. If someone later obtains a
key, the API becomes an optional accelerator, not a prerequisite.

---

## 2. Scope (decided)

The **full parent category, deduped** — all 6,788.

| Subcategory | `subcategories=` key | Count |
|---|---|---|
| AI Apps | `ai-for-business` | 4,274 |
| Agents | `bot-services` | 2,135 |
| Tools And Connectors | `business-robotic-process-automation` | 846 |
| Azure AI Foundry Services | `cognitive-services` | 721 |
| **Parent, deduped** | `ai-apps-and-agents` | **6,788** |

Parts sum to 7,976 against a parent of 6,788, so ~1,200 products appear in more
than one subcategory. **Dedupe by product id is mandatory.** Harvest the parent
category rather than the four subcategories; it is already deduped.

**The total moves.** `apps.count` read 6,788 and then 6,796 about an hour later
— eight new products in one hour. Never hardcode the total, always read it from
`apps.count` at the start of a sweep, and expect the last page to shift under a
long run. This drift is not noise to be smoothed away; it is the marketplace
moving, which is the thing this registry exists to record.

Depth: **tiles plus full detail for every product.** Both passes, all 6,788.

---

## 3. The data, exactly where it lives

### Category / search page

```
https://marketplace.microsoft.com/en-us/search/products?category=ai-apps-and-agents&page=N
```

Wait ~6s after navigation, then read:

| Path | What it is |
|---|---|
| `window.__INITIAL_STATE__.apps.count` | total in category (6788) |
| `window.__INITIAL_STATE__.apps.galleryTiles` | **60 records per page**, 69 fields each |
| `window.__INITIAL_STATE__.apps.idMap` | product id (lowercased) → index into galleryTiles |
| `window.__INITIAL_STATE__.apps.activeFilters[0]` | category metadata, backend keys, subcategory map |

60 per page × 6,788 ≈ **114 pages**.

**Gallery tile fields** (69 total; the ones that matter):

```
entityId  entityIdLoweredCased  entityType  title  publisher  publisherId
builtFor  iconURL  shortDescription  CertificationState  CertificationLink
AverageRating  NumberOfRatings  ratings  ratingSummary  ratingSummaries
categoriesDetails  industriesDetails  productType  catalogProductType
catalogOfferType  pricingTypes  startingPrice  hasPrices  hasFreeTrials
additionalPurchasesRequired  badges  productLabels  popularity  awards
licenseTermsUrl  handoffURL  downloadLink  operatingSystem  serviceFamily
skuAggregatedData  linkedAddIns  linkedSaaS  licenseManagement  bigId
appCompliance  AzureBenefitEligible  offerType  detailInformation
```

- `iconURL` — **60/60 coverage** on the page sampled. This is the logo. Clean
  CDN paths on `catalogartifact.azureedge.net` and `store-images.s-microsoft.com`,
  no query strings.
- `CertificationState` — `None` | `SelfAttested` | `MicrosoftCertified`.
  Sampled page: 45 / 11 / 4. This gives attestation tier **without** visiting a
  certification page.

### Product detail page

```
https://marketplace.microsoft.com/en-us/product/{entityId}
```

Wait ~9s, then read:

| Path | What it is |
|---|---|
| `window.__INITIAL_STATE__.apps.offerDetailsData[id]` | `{status, data}` — core record |
| `window.__INITIAL_STATE__.apps.offerDetailInformationData[id]` | the detail block below |

**Detail fields (verified on `WA200008024`):**

```
Description            full overview text
LargeIconUri           high-resolution logo
Images                 screenshot gallery
DemoVideos  CollateralDocuments
LanguagesSupported  Keywords  Capabilities  WorksWith
HelpLink  SupportLink  PrivacyPolicyUrl
AppVersion  PlatformVersion  ReleaseDate
Countries  AdditionalPurchasesRequired  SiteLicenseAvailable
IconBackgroundColor  popularity  determinedStorefronts
```

One page load yields all of it. No tab-per-section navigation, no
`read_page` at 50,000 chars, no text parsing.

---

## 4. Do this first — three checks that change the plan

**4.1 Deep pagination — RESOLVED. The UI lies; the state does not.**

Niles reported that in the UI, pagination clicking is the only way past roughly
page 20. He is right about the UI, and the measurement explains why:

| page | `galleryTiles` in state | product links in DOM |
|---|---|---|
| 2 | 60 | 20 |
| 40 | 60 | 20 |
| 113 | 60 | 20 |

**The state always carries 60 records. The DOM only ever renders 20.** That gap
exists on page 2 as much as page 113 — the grid lazily materialises the rest as
you scroll, which is the virtualization the old scraper kept losing cards to.

So there are two different paginations in play. The server pages at 60. The
visible UI behaves as if it pages at 20, and past a certain depth its paging
maths and the server's diverge, which is why clicking is the only thing that
works *on screen*. None of that constrains us: direct URL navigation returns a
correct, fully populated 60-record state at every depth tested.

**Anyone eyeballing a deep page will see 20 cards and conclude the harvest is
losing two thirds of the data. It is not.** Verify against
`__INITIAL_STATE__.apps.galleryTiles.length`, never against what is on screen.

Pages 2, 40 and 113 returned entirely disjoint product ids, so deep pages serve
genuinely distinct data rather than repeating page 1.

**4.2 Enumeration contract — RESOLVED, measured.**

| page | tiles | meaning |
|---|---|---|
| 113 | 60 | last full page |
| 114 | 17 | partial final page |
| 120 | 0 | past the end, clean empty |

113 × 60 + 17 = 6,797, matching `apps.count` at that moment.

**Terminate on an empty `galleryTiles`, not on a computed page count.** The
total is not stable — across about ninety minutes it read 6,788 → 6,796 → 6,788
→ 6,797 → 6,801. Some is real listing churn, some is probably replica variance,
and you cannot tell which from outside. So:

- read `apps.count` for reporting, never to decide when to stop
- walk pages upward until one returns zero tiles
- dedupe globally by `entityId`; a shifting total means page boundaries move
  under a long run and the same product can land on two pages
- treat a short page as possibly-final, not definitely-final — confirm with the
  next page

**`entityId` can contain pipes.** A real page-114 id:
`PUBID.gmsoftlimited1760036575353|AID.inventory-planning|PAPPID.16b338f4-...`
Take the whole string. Never split on the first pipe.

**4.3 Does `offerDetailInformationData` populate for every product type?**

Verified on a Microsoft 365 add-in (`WA200008024`). Check a SaaS offer
(`anthropic.anthropic-claude-opus-4-8-offer`), a VM offer, and an Azure
application. Record which product types come back thin — that is data, not a
failure.

---

## 5. Constraints and gotchas

- **The JS tool filters returns containing query strings.** Probes were blocked
  when the return value included `location.href` or raw page script content.
  Return only the fields you need. Never dump page state, never return
  `location.href`. Icon URLs are clean and pass fine. Do not try to encode or
  obfuscate values to get around this — restructure what you return instead.
- **Container egress blocks every Microsoft host.** `marketplace.microsoft.com`,
  `catalogapi.azure.com`, `learn.microsoft.com`, and both image CDNs all fail
  from the sandbox. Harvesting happens in the browser. `WebFetch` still works
  (it runs Anthropic-side) and is how certification pages are fetched.
- **`WebFetch` gets 403 on the storefront** — bot detection. Browser only.
- Wait 6–9s after navigation before reading state.
- Product ids are case-sensitive in `entityId` but lowercased in `idMap`.
- Ids may contain dots and pipes. Never truncate at the first pipe.

---

## 6. Schema work needed before ingest

### 6.1 Capture method tagging (required — decided)

Niles chose: tag the method, and let the first harvest be a **baseline** rather
than a wave of fake change events. Re-capturing the existing 140 by a different
instrument would otherwise emit `asset_change` rows that describe our tooling,
not the marketplace. The change feed is the product; do not pollute it.

```sql
create type capture_method as enum ('browser_dom', 'embedded_state', 'api', 'backfill');
alter table capture add column method capture_method not null default 'browser_dom';
```

Then modify `ingest_capture()` so the change-detection block is **skipped when
the previous capture's `method` differs from the new one** — record the capture,
update `current_capture_id`, emit no `asset_change` rows. Only same-method
transitions produce change events.

The 140 existing rows are `backfill`. Everything from this harvest is
`embedded_state`.

### 6.2 Logos

Already built, reuse it:

- `set_capture_logo(product_id, url)` — call with `iconURL` from the tile, or
  `LargeIconUri` from the detail page when present (prefer the large one).
- `scripts/archive-logos.mjs` — fetches bytes into the `logos` Supabase Storage
  bucket and records a sha256. **Needs `catalogartifact.azureedge.net` and
  `store-images.s-microsoft.com` on the network allowlist.**
- `v_logo_status` reports `no_logo_identified` / `url_only_not_archived` /
  `archived`. All 140 currently sit at stage one.

The `LOGO PASS` section in the capture skill becomes obsolete once this harvest
runs — logos now arrive with enumeration. Delete it from the skill rather than
leaving a stale procedure behind.

### 6.3 Mapping tile fields into the extract

`ingest_capture()` expects the `extract` shape in
`docs/capture-integration.md`. Map as follows:

| extract field | source |
|---|---|
| `name` | `title` |
| `publisher` | `publisher` |
| `tagline` | `shortDescription` |
| `overview_text` | detail `Description` (strip HTML, keep line structure) |
| `logo_url` | detail `LargeIconUri`, else tile `iconURL` |
| `screenshot_urls` | detail `Images` |
| `works_with` | detail `WorksWith` |
| `categories` / `industries` | `categoriesDetails` / `industriesDetails` |
| `rating` / `rating_count` | `AverageRating` / `NumberOfRatings` |
| `certification` | `CertificationState`: `MicrosoftCertified`→`microsoft_365_certified`, `SelfAttested`→`publisher_attestation`, `None`→`none` |
| `cert_url` | `CertificationLink` |
| `version` / `updated` | `AppVersion` / `ReleaseDate` |
| `pricing` / `plans` | `startingPrice`, `pricingTypes`, `skuAggregatedData` |
| `legal_links` | `licenseTermsUrl`, detail `PrivacyPolicyUrl` |
| `product_links` | detail `HelpLink`, `SupportLink` |
| `languages` (stated) | detail `LanguagesSupported` |

**The `stated` evidence block still obeys the verbatim rule.** Do not populate
`models` / `frameworks` / `tools_mcp` / `data_sources` / `deployment` from
structured fields unless the exact string appears in `Description`. The database
re-checks and will reject anything else. `LanguagesSupported` is the one
exception where a structured list maps directly, because it is an explicit
enumeration rather than prose.

### 6.4 Certification full text

Still fetched separately with `WebFetch` against the resolved
`learn.microsoft.com` URL, per the existing skill. `CertificationState` gives
the tier cheaply; the full text is what lets the honesty gate verify hosting,
residency and Graph permissions. Store it in `cert_detail.full_text`.

---

## 7. Suggested execution order

1. Run the three checks in §4. Report results before building.
2. Apply the `capture_method` migration (§6.1).
3. Build the enumeration harvester: 114 page loads → 6,788 tile records →
   `ingest_capture()` with `method = 'embedded_state'`, plus `set_capture_logo()`.
   Dedupe by `entityId`. This alone completes the registry grid with logos.
4. Run `archive-logos.mjs` once the CDN hosts are allowlisted.
5. Build the detail pass: one page load per product, merge
   `offerDetailInformationData` into a second capture.
6. Certification pass via `WebFetch` for products where
   `CertificationState !== 'None'`.

Steps 3, 5 and 6 are all resumable and idempotent — `drive_file_id` /
content-hash idempotency already exists in `ingest_capture()`. Build them to
checkpoint and resume, because 6,788 products will not finish in one session.

---

## 8. Rules that do not bend

From `CLAUDE.md`, restated because this is a new pipeline and it would be easy
to lose them:

- **Unknown means Unknown.** A structured field being absent is not permission
  to infer it from a neighbour.
- **A URL is not a capture.** An image counts as held only once `archived_url`
  and `content_hash` are set.
- **Captures are immutable.** Corrections arrive as a new capture.
- **The verbatim gate stays.** If `evidence_rejected > 0`, investigate the
  capture. Never loosen the gate.
- **Do not re-capture what is already captured** except where this document
  says so, and record the method when you do.
