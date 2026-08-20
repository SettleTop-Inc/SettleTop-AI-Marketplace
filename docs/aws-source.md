# AWS source: verified facts and design decisions

Everything here was read off live AWS Marketplace pages, not inherited. Where a
value is our classification rather than something AWS publishes, it says so.
That distinction is the whole point of the file.

Written while building the keyless AWS harvest. The adapter should be
implemented from this, not from the merged spec: the spec
(`docs/superpowers/specs/2026-08-20-aws-marketplace-source-design.md`) chose the
authenticated Discovery API, the owner declined a credential requirement, and
three of the spec's field claims turn out to be wrong against the page.

## How the site is read

Plain `fetch` with a Chrome UA. **No browser, no Playwright, no credential.**

A product page at `https://aws.amazon.com/marketplace/pp/<prodview-id>` embeds
its entire record as JSON in
`<script id="vike_pageContext" type="application/json">`, a dehydrated TanStack
Query cache. The rendered DOM is built from that blob and can only lose fidelity
relative to it, so the blob is what the parser reads.

Enumeration comes from `https://aws.amazon.com/marketplace/sitemap`, the address
`robots.txt` itself names. It is one flat `<urlset>`, not an index, 5,104,666
bytes on 2026-08-20, 58,761 `<loc>` entries, **43,104 distinct `prodview-`
ids**, and no `lastmod`, `changefreq` or `priority` anywhere. There is therefore
no cheap change detection: the catalog stage diffs the id set itself each run.

### robots.txt, and the one rule that shapes everything

`https://aws.amazon.com/robots.txt` contains `Disallow: /marketplace/search*`
for `User-agent: *`. **Nothing in this source ever requests that path.** Not the
page, not the internal `awsmpdiscovery` proxy behind it, not once to check.

Evaluating all 266 `Disallow` rules against every loc in the sitemap: exactly
one sitemap entry is disallowed, and it is
`https://aws.amazon.com/marketplace/search`. Zero `/marketplace/pp/` pages are
disallowed. That is why the sitemap parser anchors on the full
`/marketplace/pp/` loc rather than taking locs as given: the prefix filter is
simultaneously the correctness rule and the robots safeguard, and the catalog
stage never constructs a URL from an arbitrary loc.

### Why keyless, when the spec chose an API

The AWS Marketplace Discovery API is real, public, documented, and would be a
better mechanism in the abstract: deterministic pagination, a category facet, an
`AGENTIC_TYPE` facet, and a `CanonicalListingReference` for collapsing listing
variants. It needs ordinary AWS credentials.

**The owner declined to make the registry depend on holding an AWS credential.**
That decision is what selects the keyless route, and everything below follows
from it. The API details remain accurate and stay in the spec, which is now
amended to record the API as the documented alternative rather than the choice.

Two things are genuinely lost on the keyless route, and neither is recoverable:

- **`AGENTIC_TYPE` is unreachable.** It is an API facet and does not survive
  into the page blob at all: the strings `AGENTIC_TYPE` and `agenticType` occur
  zero times across every page read. The 21 agentic listings that sit outside
  AI Agents & Tools cannot be discovered, and the category predicate is
  therefore the whole filter.
- **`CanonicalListingReference` is unreachable.** It does not occur anywhere in
  the page context. The substitute is `product.productId`, and the substitution
  is ours.

## Extraction traps, all confirmed on live pages

These are the things that make a naive scraper quietly wrong rather than loudly
broken. Every one of them was hit or nearly hit during research.

- **The category GUID is a PARENT.** Matching `categoryId` against
  `f1d47436-8a98-40db-b687-696723ec32cb` returns **zero of every page ever
  sampled**. Every real match arrives through `parentCategoryId`.
- **A substring search for the GUID over the blob is catastrophically wrong.**
  It matches roughly a third of all pages instead of an eighth, because
  `recommendations.discoRecommendations[].Categories[]` describes the "you might
  also like" products. `discoRecommendations` must never be read, for this or
  any purpose.
- **Two queries carry a `listingDetail`.** Selecting the first one with a
  `listingDetail` yields `Usage`, whose overview has **no `categories` field**,
  at which point the predicate matches nothing and the pass keeps zero listings
  while reporting success. This happened during research before it was caught.
  Select by `queryKey[2].queryName`, never by array index: the array's length
  and order both vary by fulfilment type.
- **A product AWS no longer serves answers HTTP 200, not 404**, with a
  well-formed parseable blob whose query cache is empty. Detect it by
  `pageId === "/lib/frontend/pages/ppV2/default"`. Classify it terminally as
  `gone`: it will answer 200 forever, so a retry policy would refetch it on
  every run for the life of the registry.
- **The gone case must not be classified inside a `fetchState` parse hook.**
  `fetchState` treats a null parse as retryable and would spend four requests
  and eleven seconds of backoff on every delisted id. The adapter uses
  `fetchText` plus its own extractor, which also gives the final URL that
  `fetchState` does not return.
- **The sitemap is one single line.** A line-oriented parser reads 5 MB as one
  record and finds nothing.
- **`"!undefined"` is a sentinel, not a value**, and it is everywhere:
  `sourceAgreementId`, `availabilityEndDate`, `offerName`, several renewal
  fields, and 1,977 rate card descriptions. `offer.availableFromTime` carries a
  second sentinel, the prefix `"!Date:"`.
- **`AWS_SUPPORT` resources are not the publisher's.** On roughly half of all
  listings `supportResources[0]` is AWS's own
  `https://aws.amazon.com/premiumsupport/`, identical on every one of them.
  Both `support` and `product_links` filter to `CREATOR_SUPPORT`.
- **A `LINK` resource can have a null `resourceName`.** The customer-connect
  demo and private-offer links on a SaaS listing are exactly that. The label
  stays null rather than being filled in.

## Blocks that must never be read

| block | why |
|---|---|
| `recommendations.discoRecommendations[]` | other products. Source of the substring false positives, and the only home of `ProductAttributes.BaseProductId`, which would file a neighbour's identity under this listing |
| `listing-insight`, `related-listing-insights` | the AI Insights block. Machine generated: key features, review sentiment, category rankings, and its own `listingLogo` |
| `pricingSummaries[].aiPricingSummary`, `pricingFaqs[].aiPricingFaq` | explicitly AI-authored prose about the pricing. Not an AWS statement about the product |
| `initialI18nStore`, `cloudscapeMessages` | UI translation tables, 723 keys. "Supported services", "Integration protocol", "Vendor Insights", "MCP server" and "AI Insights" all live here **and nowhere else**, which is exactly how a naive string search invents a field |

## Register shape

43,104 product ids in the sitemap. Measured on a 1,642-page pilot: **11.9
percent sit in AI Agents & Tools**, which agrees closely with the 5,176 of
43,104 the API reports, so plan on roughly 5,100 listings.

Ten fulfilment types have been observed, with `fulfillmentOptionTypeId` then
display name:

`PROFESSIONAL_SERVICES` Professional Services · `SAAS` SaaS ·
`AMAZON_MACHINE_IMAGE` Amazon Machine Image · `CONTAINER` Container Image ·
`HELM` Helm Chart · `CLOUDFORMATION_TEMPLATE` CloudFormation Template ·
`API` API-Based Agents & Tools · `SAGEMAKER_MODEL` SageMaker Model ·
`SAGEMAKER_ALGORITHM` SageMaker Algorithm · `DATA_EXCHANGE` Data Exchange

`fulfillmentOptions[]` is a discriminated union and each type carries its own
extra fields, but the four the mapping uses (`fulfillmentOptionId`,
`fulfillmentOptionType`, `fulfillmentOptionVersion`, `creationDate`) were
present on every page of every type.

## Three corrections to the merged spec

**1. AWS does publish a date.** The spec says "AWS publishes no listing-updated
or release date anywhere public". It publishes `fulfillmentOptions[].creationDate`
on every page, ISO 8601. What it does not publish is a listing-*updated* stamp:
this is the creation date of a **delivery option**. On a multi-version AMI the
maximum is the publish date of the newest version and it agrees with the version
string; on SaaS and Professional Services there is one option and the date reads
as first-published. `extract.updated` carries `max(creationDate)` behind the
switch `UPDATED_FROM_FULFILLMENT_CREATION_DATE`, and every option's date stays
in `raw` either way. **Copying the value is AWS's; calling it "updated" is
ours.**

Two other real dates exist and neither may become `updated`:
`Pricing.summary.authoredDate` is when the current offer was authored, a pricing
fact; `offer.availableFromTime` duplicates it behind the `!Date:` sentinel.

**2. AWS publishes separate review scores.** The spec says AWS publishes "one
blended average plus a count split, not separate scores", and nulls
`native_rating` and `external_rating` on that basis. It is wrong. On
`prodview-g232pyu6l55l4` the blended `AverageCustomerRating` is 5 and
`ProviderSummaries[AWSMP].AverageRating` is **4.5**, over the same 35 reviews,
with a syndicated G2 score of 4 over 186 reviews beside them. All three are
mapped. Syndication providers are read generically from the keys of
`SyndicatedReviews`, because the translation table names PeerSpot as well as G2.

**3. Neither AWS identifier the spec relies on exists here.**
`CanonicalListingReference` occurs zero times in the page context.
`ProductAttributes.BaseProductId` exists only inside `discoRecommendations` and
describes other products. See the keyless section above.

Two smaller ones: AWS does publish promotional images, on a small minority of
listings (`embeddedMedia[]` filtered to `IMAGE`), which is what
`media_image_urls` is for; and `surfaces` and `works_with` have no source at
all, which the spec assumed they had.

## `surfaces` and `works_with` are empty, and probably permanently

The rendered "Supported services" and "Integration protocol" rows have **no data
node anywhere in the page context**. Both strings occur only at
`initialI18nStore.en.common`, as UI labels. The two candidate holders,
`overview.solution` and `overview.integrationGuide`, are `null` on every page
read.

The recon could not close this, because none of its in-category pages was an
agent or an MCP server. **It is closed now.** `prodview-4jqih5hzoxv3a`, DoiT
MCP, is an `API-Based Agents & Tools` listing inside the category, and both
nodes are still null on it. The fixture and the test are in the repo.

`works_with` being empty matters more than it looks: it lights the
`integrations` layer with no evidence row behind it
(`supabase/migrations/20260819100300_asset_layer_write_path.sql:214-215`), so
filling it from a taxonomy chip would be a layer-granting decision. There is no
chip to fill it from, which settles the question the spec's section 4 discusses.

## `cert_detail` is null on all eight keys

AWS publishes nothing resembling the Microsoft 365 certification questionnaire,
and this is a fact rather than a gap:

- `overview.vendorInsight` is `null` on every page. The **path exists** on all
  of them, so this is AWS saying "no security profile", not a field we failed to
  find. It is the blob's only Vendor Insights hook, and the parser carries it
  through untouched so that the day a profiled listing is harvested the shape is
  discovered rather than silently dropped.
- `overview.badges` is `[]` on every page.
- `listingSummaryView.badges` does carry values, and none is a security
  credential: `DEPLOYED_ON_AWS`, `STANDARD_CONTRACT`, `AWS_SPECIALIZATIONS`,
  `FREE_TIER`, `STANDARD_DATA_AGREEMENT`, `FREE_TRIAL`,
  `BRING_YOUR_OWN_LICENSE`. All commercial.
- `"FTR"` and `"Foundational Technical"` occur zero times, which answers the
  spec's open question about AWS Foundational Technical Review for the blob.

`graph_permissions` stays `[]` specifically: a single element of any content
writes a verified "Microsoft Graph" evidence row and lights the tools and MCP
layer.

Vendor Insights profiles exist for roughly 0.7 percent of the marketplace, so
zero observations across the pages read is consistent with the field being
populated on a rare minority rather than never.

**`certification` is `'none'`, never `'publisher_attestation'`.** Attestation
would falsely light the `permission scope` layer, asserting a permission review
AWS never performed.

## Pricing: a plan list and a price table look identical

`Pricing.summary.terms[]`. Nine `termType` values seen; five are priceable and
only three publish a figure:

| term | price path | billing |
|---|---|---|
| `UsageBasedPricingTerm` | `rateCards[].price` | none, it is metered |
| `ConfigurableUpfrontPricingTerm` | `rateCards[].rates[].price` | `rates[].selector.value`, an ISO 8601 duration such as `P12M` |
| `RecurringPaymentTerm` | `price` | `billingPeriod` |

`FreeTrialPricingTerm` and `ByolPricingTerm` publish no price **and no name**.
They are not turned into plans: naming one would mean writing our own words into
a display field, and the only place phrases like "Free trial" exist on the page
is the UI translation table. They stay in `raw`, and `capture_meta.missing` says
in AWS's own term names that the listing states purchase terms but no priced
plan.

Prices are copied exactly as printed, `"USD 793.80000000"`, decimal tail and
all. Rounding would be a number of ours.

Professional Services listings have no `Pricing.summary` key at all: AWS
publishes no price for an engagement. That is a **complete** capture of what AWS
publishes, recorded as `capture_complete: false` with an explicit `missing`
entry, exactly as DRAI marks an agent with no launch post.

### The rate card volume problem

On SaaS and Data Exchange listings, rate cards are real publisher plans
("Freshchat User License", "Cloud One Workload (Essentials)"). On AMI and
SageMaker listings they are per-instance-type price tables where `displayName`
equals `description` equals `dimensionKey` ("t3a.medium"), **up to 1,540 on a
single listing**, and the pilot found in-category listings publishing 753 rate
cards across two terms.

**Any rule separating a price table from a plan list is our classification, not
AWS's**, because AWS makes no such distinction: both arrive as
`terms[].rateCards`.

The rule taken is deliberately mechanical rather than editorial. A term
publishing more than `PLAN_RATE_CARD_LIMIT` (50) rate cards contributes **no**
plans, and the omission is recorded in `capture_meta.missing` naming the term
and the count AWS itself publishes at `terms[].totalRateCards`.

Two alternatives were considered and rejected:

- **Truncate to the first N.** A partial price table presented as a plan list is
  a claim AWS never made.
- **Exclude AMI and SageMaker by fulfilment type.** That is a judgement about
  what those listings *are*. A count is not.

**This is the one decision in the source that most deserves the owner's
review.** The limit is a single exported constant.

## Resumability, and why AWS needs a ledger

The Microsoft resume pattern does not transfer. `harvest-detail.mjs` resumes
from its own output because it keeps everything it fetches. Here roughly seven
eighths of what is fetched produces no output row, so resuming from
`details.jsonl` would refetch every rejected id on every run, forever.

Three files, one writer each:

| file | writer | contents |
|---|---|---|
| `data/aws/ids.jsonl` | `aws-catalog.mjs` | one row per sitemap id, append only, `last_in_sitemap` refreshed each run |
| `data/aws/seen.jsonl` | `aws-detail.mjs` | one row per **resolved** id, rejects included, stamped with the predicate version |
| `data/aws/details.jsonl` | `aws-detail.mjs` | kept listings only |

Keepers are a separate file rather than rows behind a flag so that
`aws-ingest.mjs` is **structurally incapable** of seeing a reject. If rejects
lived in the file ingest reads, one filter bug would ingest 38,000 listings with
null everything, which is precisely the failure this registry exists to prevent.
`drai-catalog.mjs` makes the same argument for keeping `tiles.jsonl` apart from
`announced.jsonl`.

Outcome vocabulary, terminal outcomes skipped on resume:

| outcome | terminal | meaning |
|---|---|---|
| `kept` | yes | in category |
| `out_of_category` | yes | categories read, predicate said no |
| `gone` | yes | 200 with the default `pageId` |
| `identity_mismatch` | yes | the page states a different product |
| `unreadable` | **no** | network failure, no blob, unparseable blob, or a real page missing Detail, overview or categories |

`unreadable` being retryable is load-bearing. A real page whose Detail query is
absent is a template change, and recording it as out of category would
permanently exclude a real listing on the strength of a parse failure.

**`predicate_version` is not optional.** Roughly 38,000 rows will carry a
permanent `out_of_category` decision made by one predicate on one day. Widen the
filter and every one is stale. With the stamp, widening is an ordinary resumable
run; without it, the only way is to delete the file and blindly re-read 43,104
pages. It cannot be backfilled after the fact.

Checkpointing every 500 completions is a required departure from the existing
passes, not an optimisation: they write once at the end, which loses a
45-minute run to any crash. `seen.jsonl` is written **after** `details.jsonl`,
so a torn checkpoint costs a re-fetch rather than a lost keeper.

## Politeness

Measured: 36 pages at concurrency 4 ran at 16.6 pages/sec, p50 201 ms, zero 429,
zero 503, zero `Retry-After`. **Concurrency stays at 4.** Nothing above it has
ever been tested against AWS, and every response was a CloudFront **MISS** with
`cache-control: no-cache`, so each request is real origin work rather than an
edge hit. A short burst is not evidence about a sustained sweep.

No fixed inter-request delay: at 225 ms mean latency and c=4, the 250 ms pause
`harvest-certification.mjs` uses would roughly halve throughput for no measured
benefit. `fetchText`'s existing backoff handles a per-request refusal, and the
pass counts refusals across the run and stops on the twentieth rather than
grinding through 43,000 backoffs.

Projected full sweep: about 45 to 60 minutes, about 4.8 GB on the wire (gzip),
about 19 GB parsed, under 30 MB kept. **Stage the first full sweep with
`--limit`** (2,000, then 5,000, then the rest). Discovering a throttle at
request 2,000 costs two minutes; discovering it at 40,000 costs the run.

## Ours, not AWS's, and never in `stated`

Mirroring `docs/drai-source.md`. These are values the registry derives or
supplies. They must never be presented as AWS statements.

- **`CATEGORY_LABEL`, "AI Agents & Tools".** The parent category is never itself
  listed on a product, so the string does not appear in the blob at all. It is
  AWS's display name for the GUID, copied from AWS's own category page, but it
  is a constant of ours. **It is never merged into `extract.categories`.**
- **The category predicate itself**, including its two-level reach. The taxonomy
  is at least three deep ("Classification-Text" sits under "Text" under "Machine
  Learning"), so a grandchild of the GUID would be missed. None was seen, so
  whether one exists is unverified either way.
- **`PLAN_RATE_CARD_LIMIT`**, and the omission it produces.
- **Calling `fulfillmentOptions[].creationDate` "updated"**, as above.
- **Substituting `product.productId` for `CanonicalListingReference`.**
- **`industries` left empty.** AWS's Industries branch children arrive in the
  same `categories` array with no branch label, so "is this an industry" can
  only be answered from a GUID table we would build. Deriving it later is
  possible from the observed parent GUID `48bf064f`, and it must then be
  labelled ours.
- `function_category`, `delivery`, `price_band`, `risk`, `reach`, `provenance`,
  as for every source.
- Any cross-marketplace identity between an AWS listing and a Microsoft one.
  **Nothing in the AWS payload asserts that two marketplaces carry the same
  product.**

`extract.stated` is empty on every key. The gate verifies each stated value
verbatim against `hay_listing` or `hay_cert`; AWS has no supported-languages
field, so even Microsoft's single populated key has no counterpart, and it
publishes no integration or protocol taxonomy on an ordinary listing, so the two
chips the spec declined do not exist to be tempted by.

## Known consequence: `registry_delivery()` returns `Unknown`

`registry_delivery(surfaces, cert_hosting)` decides delivery from the surface
chips first and falls back to certification hosting. AWS listings have neither,
for the reasons above, so **every AWS listing derives delivery `Unknown` as the
function is written today**.

What AWS states instead is the fulfilment option type id, which the adapter
carries verbatim into `extract.acquire_using` and keeps in `raw`. An AWS branch
of that function would switch on the id, never on the display name. It is not
written in this branch on purpose: `registry_delivery` is shared with Microsoft,
so changing it is a schema change needing its own review and its own migration.
The follow-up and the ten ids are recorded at the end of
`supabase/migrations/20260820120000_add_aws_marketplace.sql`.

Until it lands, `Unknown` is a true statement about what that function can read,
not a defect in the adapter. This is the asymmetry issue #43 is about: **AWS
listings will know fewer layers than Microsoft ones, and that is a true
statement about what AWS publishes.**

## Still open

- **Whether AI Agents & Tools has grandchild categories.** If one exists, the
  two-level predicate misses it. Bumping `PREDICATE_VERSION` is how a widened
  predicate would be rolled out.
- **Whether the blended and native ratings ever diverge in a way that matters.**
  They do diverge (5 against 4.5), but only one such page has been read closely.
- **The full sweep has never been run**, so nothing here predicts AWS's
  behaviour at 43,104 sustained requests.
- **A redirect to a different product has never been observed** (zero of every
  request made). The identity guard is written against a guardable but unproven
  hazard. It would also not detect AWS serving product B's content under id A
  without a redirect, and no evidence such a case exists.
