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
- **The customer-connect links stay, and the premiumsupport link does not**,
  and the difference is not the hostname. `premiumsupport` is byte-identical on
  every listing carrying it, so it says nothing about the product and describes
  AWS's own infrastructure support. The customer-connect links carry the
  listing's own `prodview-` id and route a buyer to **this** publisher, so they
  are that publisher's channel expressed through AWS's plumbing.
- **AWS's reviews page is not a product link.** `ProviderSummaries[AWSMP].Url`
  is AWS's address and the only label available for it would be words of ours.
  The write path files every `product_links` entry as a `capture_link` of kind
  `'product'`, indistinguishable from a link the publisher offered, so it is
  left in `raw` at `record.reviews.reviews_url` until a field exists that says
  what it is.

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
as first-published.

**`extract.updated` is null, and the switch `UPDATED_FROM_FULFILLMENT_CREATION_DATE`
is off.** Copying the value would be AWS's; calling it "updated" is ours, and the
name is where the harm is. The write path stores `extract.updated` as
`listing_updated`, `LandingApp.tsx:400` prints `Listing updated <date>`, and
`PassportView.tsx:333` marks the field **Disclosed** purely because the value is
non-null. On `prodview-g232pyu6l55l4` the site would state "Listing updated
2016-09-23" and vouch for it, when what AWS published is the creation date of
that listing's one SAAS delivery option. Putting one field's value under another
field's name is exactly the substitution this registry exists to refuse.

Nothing is lost by declining. Every option's `creationDate` stays in `raw`, and
`created_max` and `created_min` stay on the record, so a column that says what
the date actually is would find the value already captured. Turn the switch back
on only alongside such a column.

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

`surfaces` being empty is what `delivery_ids` exists to answer. AWS states a
fulfilment option type instead, and that id is what `registry_delivery()` reads
for an AWS listing. See "Delivery" below.

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
publishes, so `capture_complete` stays **true** and the `missing` array carries
the nuance in words: `price: AWS publishes no pricing for this listing`.

`capture_complete` is a fact about whether the capture succeeded, never about
how much the publisher chose to say. `PassportView.tsx:225` renders a **Partial
capture** tag off that flag, which asserts the harvest failed, and every AWS
`PROFESSIONAL_SERVICES` listing would carry it otherwise. `microsoft.mjs:92`
reads the column the same way (`capture_complete: !!detail`), so a Microsoft
listing with no price is complete and an AWS one must be too, or one column
means two things depending on which marketplace the row came from.

**The one incomplete case is `plans_omitted`**, where data AWS did publish was
read and then deliberately not stored. That is a real gap and it is marked as
one.

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
| `out_of_category` | yes | categories read, predicate said no. The row stores the category **names** it was judged on |
| `gone` | yes | 200 with the default `pageId` |
| `identity_mismatch` | yes | the page states a different product |
| `unreadable` | **no** | network failure, no blob, unparseable blob, or a real page missing Detail, overview or categories |

`unreadable` being retryable is load-bearing. A real page whose Detail query is
absent is a template change, and recording it as out of category would
permanently exclude a real listing on the strength of a parse failure.

### Two stamps, and they mean different things

`predicate_version` says which rule decided that a listing belongs in the
category. `record_version` says which extractor read it. A row can be stale in
one sense and current in the other, and the two carry different weight:

- **Stale predicate**: the listing may not belong in the category at all. That
  is a membership error.
- **Stale record version**: the row was written by a parser that has since been
  corrected, and a parser is not only ever widened. `aws-record-v1` put AWS's own
  `https://aws.amazon.com/premiumsupport/` into `extract.product_links`; v2 cut
  it because it is AWS's infrastructure support rather than the publisher's
  channel. 109 of the 195 rows the pilot kept carry it.

**`aws-ingest.mjs` refuses a row failing either stamp**, names how many it
skipped and why, and tells the operator to re-read. The detail pass treats both
kinds of staleness as a reason to re-fetch, so refusing costs a re-run rather
than a manual delete, which is the rule `drai-detail.mjs` already follows for an
older parse shape. Loading a superseded row would instead be silent, and that
asymmetry is what decides it.

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
about 19 GB parsed, under 30 MB kept.

**A run with no `--limit` is capped at 200 pages**, and says so. Unlike every
other stage in this repo, an unbounded AWS detail run reads the whole
marketplace, and `npm run harvest` would start one with no flags and no one
asking. The pass resumes, so repeated runs converge, and after the first sweep a
nightly run only has the sitemap delta and never approaches the cap.

**200 rather than 2,000 because the default is what fires by accident.** 2,000
is a sensible second stage, but the driver passes no flags, so whatever this
number says is what an unattended run fetches from AWS with nobody asking. 200
is the sanctioned pilot budget. `--limit N` raises it for one run and
`AWS_FULL_SWEEP=1` removes it entirely; both are decisions, and a decision
should be typed.

The cap is also the staging the measurements ask for: 200, then 2,000, then
5,000, then the rest. Discovering a throttle at request 200 costs seconds;
discovering it at 40,000 costs the run.

**A run AWS refuses exits non-zero.** `harvest.mjs` treats any zero exit as a
successful stage and runs the next one, so a throttle-stopped detail pass would
otherwise be reported as `aws ok` and followed by a live ingest of whatever
partial file the run wrote.

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
- **Calling `fulfillmentOptions[].creationDate` "updated"**, which is why the
  switch is off and `extract.updated` is null.
- **Substituting `product.productId` for `CanonicalListingReference`.** Note the
  value is not always a `prod-` prefixed id: 188 of the 195 pilot listings read
  `prod-j4mno5fang7zo`, and 7 read a bare UUID. It is copied either way and
  nothing is parsed out of it.
- **Choosing which delivery option speaks for the listing.** So
  `extract.version` is filled only where AWS publishes exactly **one** option,
  which is 185 of the 195 pilot listings. `fulfillmentOptionVersion` is free
  text: on a SageMaker Model page the two options read "GPU" and "CPU", and a
  newest-first pick would store `listing_version = "GPU"` and mark the field
  Disclosed. Filtering instead to values that look like versions was rejected,
  because the real strings include "TetherfiMXDocker_3.2" and "Production-ready
  Qwen 3.6 35B-A3B", every one the publisher's own words. A count can be
  checked; a shape is an opinion. Every option's version stays in `raw`.
- **Reading AWS's zero as "no rating" rather than as a score.** A listing with
  no reviews states `TotalReviews 0` and `AverageCustomerRating 0` together:
  102 of the 195 pilot listings. `extract.rating` and `extract.native_rating`
  are null when the matching count is zero, which is how `microsoft.mjs:111`
  and `drai.mjs:456` already write the column, and the registry sorts ratings
  NULLS LAST in both directions on the stated rule that a missing rating must
  never outrank a stated one. The counts stay AWS's, and `raw` keeps the
  literal zeros.
- **Which syndication provider reaches `external_source`.** The extract holds
  one; AWS publishes no ranking between providers, so the first in AWS's own
  key order is taken. Every provider stays on the record at
  `record.reviews.syndicated`.
- **Nothing about the primary rating column, and that is worth stating.** AWS's
  `AverageCustomerRating` is the **blended** average including syndicated
  reviews, while `native_rating` is the AWS-only score: 5 against 4.5 over the
  same 35 reviews on `prodview-g232pyu6l55l4`. `microsoft.mjs:111-113` fills
  both from one native score. Each value is copied verbatim, so nothing is
  invented, but the column means blended-with-syndication for AWS and
  native-only for Microsoft, and `lib/present.ts:48-52` renders both in one
  line.
- **`industries` left empty.** AWS's Industries branch children arrive in the
  same `categories` array with no branch label, so "is this an industry" can
  only be answered from a GUID table we would build. Deriving it later is
  possible from the observed parent GUID `48bf064f`, and it must then be
  labelled ours.
- **The mapping from a fulfilment option type id onto a delivery value.** The
  INPUT is AWS's, the id it publishes at
  `fulfillmentOptions[].fulfillmentOptionType.fulfillmentOptionTypeId`, copied
  verbatim into `extract.delivery_ids` and never parsed. The OUTPUT is the
  registry's own vocabulary, and five of the ten observed ids are left unmapped
  rather than given a label that would misdescribe them. The table is under
  "Delivery" below.
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

## Delivery: `delivery_ids`, and the mapping onto the registry's own values

`registry_delivery()` used to read `surfaces` first and fall back to
`cert_hosting`, and AWS publishes neither, so **every AWS listing derived
delivery `Unknown`**. That is discharged by
`supabase/migrations/20260820140000_registry_delivery_aws.sql`, which gives the
function a third parameter and an AWS branch. The follow-up note at the end of
`20260820120000_add_aws_marketplace.sql` is the note that migration answers. It
is left as written because production stores a migration's full text in
`supabase_migrations.schema_migrations.statements`, so editing an already
applied file would put the repo out of step with the record of what ran.

`extract.delivery_ids` is the new key: a string array of the **distinct
fulfilment option type ids**. The name is deliberately source neutral.
`registry_delivery()` is shared with Microsoft and DRAI, and a shared function
reaching into AWS-shaped JSON would be a source switch inside the derivation.
Microsoft and DRAI emit no such key, so it arrives absent, reads as an empty
`text[]` in the write path, and cannot reach the AWS branch at all.

**Ids, never display names.** AWS publishes both, side by side:
`fulfillmentOptionTypeId` `AMAZON_MACHINE_IMAGE` against
`fulfillmentOptionTypeName` `Amazon Machine Image`. The id is the stable machine
value. The name is a rendered label, already localised through the page's UI
translation table, and a CASE written against it would fall quietly to
`Unknown` the day AWS reworded one, with nothing failing and the column simply
ceasing to fill. The names are not lost: `extract.acquire_using` carries them
verbatim and joined, and that is what a reader sees. `delivery_ids` is only what
the derivation switches on.

**Order and precedence.** `delivery_ids` is ordered by the `creationDate` AWS
publishes, newest delivery option first, deduplicated by first occurrence, the
same shape `acquire_using` uses. The sort is the adapter's, not an order AWS
states. It carries no weight in the result either way: the SQL tries the ids in
a fixed literal precedence and takes the first match, so a listing carrying
several fulfilment options resolves identically whatever order they arrive in.
Checked over every permutation of a two-option listing.

What that fixed precedence **decides** is a separate thing from whether it is
deterministic, and it is ours to justify. The rule is: the more of the stack the
buyer runs, the higher the id ranks. An AMI hands over a whole machine, a
container image or Helm chart hands over a workload to schedule, and SaaS or an
API hands over nothing but an endpoint. So `AMAZON_MACHINE_IMAGE` beats
`CONTAINER`, `HELM`, `SAAS` and `API`, and `CONTAINER` and `HELM` beat `SAAS`
and `API`. A listing AWS sells both as SaaS and as an AMI reads `Virtual
machine` here, which is the registry naming a primary delivery AWS never
designated. How often that happens is unmeasured: of the 195 records cached in
`data/aws/details.jsonl` exactly two carry more than one id,
`AMAZON_MACHINE_IMAGE + CLOUDFORMATION_TEMPLATE` and `CONTAINER + HELM`, and
neither pits two mapped families against each other.

**The mapping is ours, not AWS's**, as every value in the delivery column always
has been. It stays inside the set the function already returned before this
change. That is a curation choice, not a technical constraint: see below.

| Fulfilment type id | Delivery | Why |
| --- | --- | --- |
| `AMAZON_MACHINE_IMAGE` | Virtual machine | An AMI boots as an EC2 instance. Microsoft's `Virtual Machines` surface chip already maps here. |
| `CONTAINER` | Container | Direct. |
| `HELM` | Container | A Helm chart is a Kubernetes package of container images, and containers are what the buyer runs. |
| `SAAS` | SaaS | Direct. |
| `API` | SaaS | Reached over the network on infrastructure the seller runs, which is what SaaS means in this column. It collapses two ids AWS keeps apart, in the same way the Microsoft branch collapses twelve surface chips into `Microsoft 365 app`. `acquire_using` still says "API-Based Agents & Tools" in AWS's own words. |
| `CLOUDFORMATION_TEMPLATE` | Unknown | A template deployed into the buyer's own AWS account. Its structural counterpart in the set is `Azure application`, and naming Azure on an AWS listing would be false. |
| `SAGEMAKER_MODEL` | Unknown | Container packaging is an implementation detail the listing does not state, so `Container` would be our inference presented as AWS's. |
| `SAGEMAKER_ALGORITHM` | Unknown | The same. |
| `DATA_EXCHANGE` | Unknown | A data product, not a software delivery method. No value in the set describes it. |
| `PROFESSIONAL_SERVICES` | Unknown | A human engagement. Nothing is delivered to run. |

Five of the ten stay `Unknown` on purpose, and `Unknown` is a true statement
about what this function can say. `acquire_using` carries AWS's own words for
all ten regardless.

**A correction, and what the five actually cost.** An earlier version of this
page said widening the value set "touches the facet rail and every card". That
is false. `delivery` is an open, data-driven facet: `registry_search` builds its
options with `union all select 'delivery', f_delivery, ... from matched group by
f_delivery`, `listing.delivery` is plain text, `lib/types.ts` types it `string |
null`, and `lib/registry-query.ts` says in its own comment that `delivery` is
"open free text pulled from live listing data" rather than one of the two facets
backed by a closed TS union. Grepping every `.ts`, `.tsx`, `.css` and `.json`
for `Vendor cloud`, `ISV hosted` or `Azure application` returns nothing outside
the migrations, and the rail renders whatever the RPC hands it. Adding
`Data product` or `Professional services` would need zero application change.

So keeping the vocabulary tight is a decision, not a constraint, and it is the
owner's to take. Here is the price of not taking it, counted over the 195
records cached in `data/aws/details.jsonl`:

| Fulfilment type id | Records | Derives |
| --- | ---: | --- |
| `PROFESSIONAL_SERVICES` | 86 | Unknown |
| `SAAS` | 69 | SaaS |
| `AMAZON_MACHINE_IMAGE` | 30 | Virtual machine |
| `CONTAINER` | 6 | Container |
| `HELM` | 2 | Container |
| `CLOUDFORMATION_TEMPLATE` | 1 | Unknown |
| `SAGEMAKER_MODEL` | 1 | Unknown |
| `SAGEMAKER_ALGORITHM` | 1 | Unknown |
| `API` | 1 | SaaS |
| `DATA_EXCHANGE` | 0 in this sample | Unknown |

Two of the 195 carry two ids, the rest carry one, so roughly 45 percent of the
sample derives `Unknown` and almost all of that is the single id
`PROFESSIONAL_SERVICES`. The five refusals each still stand on their own merits,
and this change does not widen the set unilaterally. But the door is not locked,
opening it is cheap, and the number belongs in front of whoever decides.

**Where the tests are.** Two places, and they cover different halves.
`scripts/lib/sources/aws.test.mjs` covers the adapter: that `delivery_ids`
carries the id and not the name, is distinct, is ordered by `creationDate`, and
is empty rather than absent when a record states no fulfilment option. Step 10
of `scripts/gate/07-final.sql` covers the SQL that consumes it, under
`npm run gate`: all ten ids individually, precedence in both directions for
every mixed pair, the whole write path through `ingest_capture` including the
shapes where `delivery_ids` is not an array, and a 360-pair comparison against a
verbatim copy of the pre-migration function so a Microsoft or DRAI regression
cannot pass. Step `10i` deliberately mis-expects three of those checks, so a
green result there would mean the rest proves nothing.

**What this does not fix.** Microsoft listings mostly still derive `Unknown`,
for two causes that have nothing to do with this function: `microsoft.mjs` reads
a products field that is a bitmask object rather than an array, so `surfaces`
arrives empty, and `cert_hosting` is null because the certification pass has not
been run over the catalogue. Neither is touched here, and a reader finding
Microsoft still mostly `Unknown` is looking at those two rather than at a
regression.

The asymmetry issue #43 is about still stands: **AWS listings will know fewer
layers than Microsoft ones, and that is a true statement about what AWS
publishes.**

**The migration ordering note survives unchanged.**
`20260820120000_add_aws_marketplace.sql` still goes first. `ingest_capture()`
inserts into `listing`, whose `marketplace_id` is a foreign key, so until the
`aws` row exists every AWS capture fails on the reference. `npm run harvest`
runs `aws-ingest.mjs` with no flags, which is the live path, so the first
harvest after this branch merges produces a wall of failures and exit 1 unless
the migration has been applied. Nothing is corrupted either way: the failures
are per record and caught.

## Still open

- **Whether a term can state more rate cards than it embeds.** `totalRateCards`,
  `rateCardCount` and the array agreed on every page sampled, including terms of
  984, 710 and 585 cards. `readPlans` treats a disagreement as an omission
  anyway, because a partial price table presented as a plan list is a claim AWS
  never made, but the branch is unexercised by live data.
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
