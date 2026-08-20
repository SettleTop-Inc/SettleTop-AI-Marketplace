# AWS Marketplace source design

**Status:** approved for implementation
**Issue:** #59. Implementation follows in #60, #61, #62.
**Date all measurements were taken:** 2026-08-20

AWS Marketplace becomes the registry's third source, after `microsoft` (6,855
listings) and `drai` (23). The point is not more rows. It is that a product
listed on both Microsoft and AWS can become one asset holding one listing per
marketplace, which is what #63 and #64 exist to do.

Implement the adapter from this document, not from memory of how the other two
sources work. AWS differs from both in the one place that matters most: how it is
read.

---

## 1. How AWS is read

**Decision: the AWS Marketplace Discovery API, authenticated with ordinary AWS
credentials supplied at runtime. Not the website, not a browser, not the
website's internal proxy.**

### The mechanism

| | |
|---|---|
| Endpoint | `https://discovery-marketplace.us-east-1.api.aws` |
| API version | `2026-02-05` |
| Protocol | `rest-json`, SigV4, signing name `aws-marketplace` |
| Regions | us-east-1, us-west-2, eu-west-1, and only those |
| Operations | `SearchListings`, `SearchFacets`, `GetListing`, `GetProduct`, `GetOffer`, `GetOfferSet`, `GetOfferTerms`, `ListFulfillmentOptions`, `ListPurchaseOptions` |

The service model is public at
`https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/marketplace-discovery/2026-02-05/service-2.json`
(111,191 bytes). Announced 2026-04-09. The AWS documentation states: "Any AWS
customer can call the Discovery API by configuring the appropriate IAM
permissions."

A browser is not required for any part of this.

### Credentials

Ordinary AWS credentials for a normal account. `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and optionally `AWS_REGION`, read from the environment at
runtime exactly as `supabaseEnv()` in `scripts/lib/marketplace.mjs` already reads
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The adapter must fail with a
clear message naming the missing variable rather than proceeding.

**Nothing is committed to this repository.** This is a real credential for a real
account, not a reverse-engineered one, so it satisfies the rule in
`scripts/harvest-catalog.mjs:38-43` in the same way the Supabase service key
already does.

### Three mechanisms were rejected, and why

**The website's internal proxy.** `POST https://aws.amazon.com/marketplace/api/awsmpdiscovery`
does answer anonymously: 200 from plain curl with no cookie, no CSRF token and no
signature, dispatching `AWSMPDiscoveryService.SearchListings` by `x-amz-target`.
It would be the path of least resistance and it is the wrong choice on two
independent grounds.

First, conduct. `https://aws.amazon.com/robots.txt` contains
`Disallow: /marketplace/search*` for `User-agent: *`. The proxy exists to serve
that disallowed surface. Routing around a stated preference because an endpoint
happens to answer is not how this project behaves, and a provenance registry in
particular does not get to be casual about how it obtained its evidence.

Second, stability. It is an undocumented internal endpoint with no compatibility
promise, it requires a public `integrationId` (`integ-kzv5xkq73lzjw` on
2026-08-20) that can change without notice, and the browser sends an
`AWS4-HMAC-SHA256` header with `Credential=unused`, meaning the shape is
provisional in ways we cannot see.

Note for the record that `discovery.marketplace.us-east-1.amazonaws.com`, the
host named in the page's CSP `connect-src`, resolves to the same IP as the
documented endpoint (44.213.79.46 on 2026-08-20) and accepts the documented REST
path. The private-looking backend and the public API are one service. That is
what makes the documented front door available rather than merely preferable.

**Browser rendering.** Rejected as slower, less accurate and more fragile.
Measured: roughly 92 ms per page by plain fetch against 2 to 5 seconds per page
under Playwright, so about 8 minutes against about 1.5 hours for 5,176 listings,
plus a browser dependency in CI. Accuracy is worse, not better, because the DOM
is rendered from an embedded JSON blob and can only lose fidelity relative to it:
the blob carries `categoryId` UUIDs and per-dimension price strings like
`"0.05000000"`, while the DOM carries concatenated card text needing re-parsing.
The rendered search page also caps its own display at "10,000 results" while the
API reports 43,369.

**The sitemap.** `https://aws.amazon.com/marketplace/sitemap.xml` returns 200,
5,104,666 bytes, 58,761 `<loc>` entries and **43,104 distinct `prodview-` ids on
2026-08-20**. That is the unfiltered catalogue size, recorded here so a later
count can be judged against a number. It is unusable as a primary source because
it carries no category, so it cannot filter, and it is slightly stale against
the API's totals.

### A correction to what this repo believed

`scripts/lib/marketplace.mjs:10-15` says the storefronts it reads "are
server-rendered and embed their whole payload as JSON in the page" and that
"almost nothing here needs a browser". Issue #59 recorded AWS as contradicting
this, on evidence that a product page returned 378,128 bytes with no `<title>`,
no `og:title` and no `application/ld+json`.

That conclusion was wrong. AWS product pages **do** embed their payload, in
`<script id="vike_pageContext" type="application/json">`, holding a dehydrated
TanStack Query cache with the complete listing record. The earlier probe searched
for the wrong markers. The search surface is genuinely client rendered; the
product pages are not.

This does not change the decision above, which rests on robots.txt and on
preferring a documented API. It is recorded because the false conclusion is in a
merged issue and would otherwise mislead the implementer.

---

## 2. What is harvested

### Category

| | |
|---|---|
| Primary category id | `f1d47436-8a98-40db-b687-696723ec32cb` |
| AWS's own display name | `AI Agents & Tools` |
| Listings in it (2026-08-20) | **5,176**, or 4,914 after collapsing variants |

This is the honest structural counterpart to Microsoft's `ai-apps-and-agents`
(`scripts/lib/sources/microsoft.mjs:18`): each is that marketplace's single named
home for AI apps and agents, each is publisher-assigned, and each is broad. The
sizes are comparable, 5,176 against 6,855.

Carry the display name as well as the GUID. A bare GUID is unreadable in a
provenance record, and AWS supplies the name, so we copy it rather than invent
our own words for it.

**Plus one orthogonal facet.** `AGENTIC_TYPE` in `[AGENT, MCP_SERVER, A2A_SERVER,
KNOWLEDGE_BASE, OTHER]` holds 132 listings (Agent 47, MCP Server 67, Other 13,
Knowledge Base 5, A2A Server 1). **21 of those sit outside AI Agents & Tools and
would otherwise be missed.** This is not a second category. It is AWS's own
declaration that a listing is an agent or an agent-callable tool, which is the
closest thing AWS publishes to what this registry is about.

**Expected count after filtering: 5,197 listings** (5,176 category, union 132
agentic, less 111 overlap), collapsing to roughly **4,930 distinct products**
after deduping on `CanonicalListingReference || Id`. Both figures come from full
enumeration on 2026-08-20, not from sampling.

Not included in a first pass: Machine Learning (`c3714653...`, 6,872) and
Generative AI (`f18b0260...`, 3,129). Generative AI is a Machine Learning child
and is mostly models and platforms rather than agents. Its GUID is recorded here
so a later decision to include it does not need rediscovery.

### Phasing

**Ingest the 132 agentic listings first, then widen to the full category.**

The pilot is two API calls, has almost no noise, and immediately produces the
cross-marketplace matching case that #64 needs. Widening afterwards is a
parameter change, not a rewrite.

When widening, note that 2,396 of the 5,176 are professional services
engagements rather than software. Excluding them via `FULFILLMENT_OPTION_TYPE`
brings the set to 2,780. **That exclusion would be our editorial choice, not an
AWS category boundary, and must be labelled as ours if taken.**

### Pagination

`MaxResults` 100 with `NextToken`. Enumeration is deterministic and single pass:
a full walk produced 5,176 distinct ids across 52 pages with zero duplicates and
the token exhausted exactly at the end.

None of the rotating-shard, cache-busting or coupon-collector machinery in
`docs/marketplace-harvest.md` applies here. Instead assert the invariant
**distinct ids collected == `totalResults`** as a run check, and fail the pass
loudly when it does not hold.

---

## 3. Field mapping

### `extract`, against `scripts/lib/sources/microsoft.mjs:96-137`

| key | AWS source |
|---|---|
| `name` | listing title |
| `publisher` | seller name |
| `tagline` | short description |
| `overview_text` | long description. Markdown, carries `###` headings |
| `categories` | category `displayName` values, verbatim |
| `industries` | category UUIDs under AWS's Industries branch |
| `surfaces` | `Supported services` |
| `works_with` | `Integration protocol` and `Type`. See the layer warning below |
| `acquire_using` | fulfillment option type |
| `support` | support link or channel |
| `rating` | blended average |
| `rating_count`, `native_count` | review count |
| `external_source`, `external_count` | review split |
| `plans` | pricing dimensions and rate cards |
| `product_links`, `legal_links` | resources and legal sections |
| `logo_url` | product logo |
| `version` | `Latest version`, AMI and container listings only |
| `cert_url` | listing URL |

Null, each for a stated reason:

| key | why null |
|---|---|
| `updated` | **AWS publishes no listing-updated or release date anywhere public.** |
| `pricing` | AWS publishes no display-price string, only dimension tables. `plans` carries the real data. |
| `native_rating`, `external_rating` | AWS publishes one blended average plus a count split, not separate scores. |
| `screenshot_urls`, `media_image_urls` | AWS publishes one logo and optional videos. There is no screenshot gallery. |
| `certification` | `'none'`. See below, this one is load-bearing. |

### `cert_detail`, against `scripts/lib/sources/microsoft.mjs:47-58`

**Six of the eight are null.** AWS publishes nothing resembling the Microsoft 365
certification questionnaire.

| key | value |
|---|---|
| `compliance` | Vendor Insights "Security credentials achieved" labels, verbatim, where publicly shown |
| `full_text` | the same public block, verbatim |
| `hosting`, `data_location`, `data_handling`, `graph_permissions`, `developer_last_updated`, `page_last_updated` | null |

What AWS publishes instead is an **AWS Marketplace Vendor Insights security
profile**. It is out of scope, and deliberately so: it lives under
`console.aws.amazon.com/marketplace/vendor-insights/...` and 302s into an OAuth
sign-in. It is not to be reached by any credential this repository holds. Its
coverage is thin regardless: 309 profiles marketplace-wide out of roughly 43,369
listings, and 73 of the 5,176 in AI Agents & Tools.

Only the public badge list survives anonymously, which is what `compliance`
carries.

### Three consequences that must not stay implicit

1. **`registry_delivery()` returns `Unknown` for every AWS listing as written**,
   because AWS's fulfilment strings match none of its Microsoft literals. It
   needs an AWS branch. Without one, every AWS listing loses the delivery layer.
2. **`certification` must be `'none'`, not `'publisher_attestation'`.** Setting
   attestation would falsely light the `permission scope` layer through
   `known_layers` (`supabase/migrations/20260819100300_asset_layer_write_path.sql:218`),
   asserting a permission review AWS never performed.
3. **`works_with` lights the `integrations` layer** with no evidence row
   (`:214-215`). Populating it from two taxonomy chips is therefore a
   layer-granting decision, not a cosmetic one. It is taken deliberately here,
   and it is the reason `stated` stays empty.

---

## 4. `extract.stated` is empty on every key

Matching DRAI (`scripts/lib/sources/drai.mjs:479-486`), not Microsoft, which
populates `languages` alone.

The gate verifies every stated value verbatim against `hay_listing` (name,
tagline, overview_text, works_with) or `hay_cert` (hosting, data_location,
data_handling, graph_permissions, compliance), at
`supabase/migrations/20260819100300_asset_layer_write_path.sql:156-160`. Any
populated key must name the haystack field carrying its text.

There is exactly one temptation and it is declined. `Integration protocol: MCP`
and `Type: MCP server` would verify against `hay_listing` through `works_with`.
They are declined because they are AWS's taxonomy chips, not the publisher's
prose, which is precisely the case ruled out by the comment at
`scripts/lib/sources/microsoft.mjs:39-44`.

The technically strongest evidence available, for instance a literal
`mcpServers` configuration block naming its tools, sits in Usage instructions,
which no haystack covers. Promoting it would require first deciding to widen
`overview_text`, which is out of scope here.

AWS also has no supported-languages field, so even Microsoft's single populated
key has no counterpart.

---

## 5. What each marketplace states that the other does not

**AWS states, Microsoft does not:** per-dimension pricing with real unit prices;
fulfilment type across twelve delivery shapes; an explicit agentic type (Agent,
MCP Server, A2A Server, Knowledge Base); a stable seller UUID; a
`CanonicalListingReference` linking listing variants; `DEPLOYED_ON_AWS`.

**Microsoft states, AWS does not:** a certification questionnaire with hosting,
data residency, data handling and Graph permissions; listing version and release
date; supported languages; screenshot galleries; separate native and external
review scores.

The asymmetry is the reason `known_layers` will differ systematically between the
two sources, and it is exactly the situation issue #43 is about. **AWS listings
will know fewer layers than Microsoft ones, and that is a true statement about
what AWS publishes, not a defect in the AWS adapter.**

---

## 6. Our classification, not AWS's

Mirroring `docs/drai-source.md:129-137`. These are values the registry derives.
They must never be presented as AWS statements.

- `function_category`, `delivery`, `price_band`, `risk`, `reach`, `provenance`
- `surfaces` beyond the literal `Supported services` row
- `industries`, if derived from chip names rather than category UUIDs
- the exclusion of professional services fulfilment, if taken
- the canonical dedupe key, although `CanonicalListingReference` is AWS's value
- any cross-marketplace identity between an AWS listing and a Microsoft one.
  **Nothing in the AWS payload asserts that two marketplaces carry the same
  product.** That join is ours, and #64 exists to propose it for confirmation
  rather than assert it.

One rule the other two sources did not need: **AWS marks two blocks as
machine-generated**, the `AI Insights` pricing summary and the
`Smart Category, Generated by AI` facet. Neither may be stored as an AWS
statement about a product, and neither may be merged into `categories`.

`AGENTIC_TYPE` is a special case. It is filterable but absent from the listing
row, so the provenance for "AWS calls this an MCP Server" is the query that
returned it. Record it as such.

---

## 7. Stages

Registered in `scripts/lib/sources/index.mjs` in the shape of its lines 40 to 49:

```js
{
  id: "aws",
  name: "AWS Marketplace",
  stages: [
    "aws-catalog.mjs",   // SearchListings, paged, filtered. Writes data/aws/listings.jsonl
    "aws-detail.mjs",    // GetListing per product.        Writes data/aws/details.jsonl
    "aws-ingest.mjs",    // merge and load through ingest_capture
  ],
}
```

Each pass is standalone, resumable and idempotent, matching the existing passes.
Concurrency 4. `--limit` supported.

There is no certification stage, because AWS publishes no certification page.

`aws-ingest.mjs` must not change `ingest_capture` or the evidence gate. A new
marketplace row is required first: follow
`supabase/migrations/20260818192216_add_drai_marketplace_and_publisher_document.sql`,
whose relevant SQL is a plain insert at lines 19 to 21.

---

## 8. Open questions, recorded rather than guessed

None of these block implementation. All should be resolved by observation during
#60 rather than by assumption.

- **Rate limits.** No 429 was seen in roughly 140 requests, which proves nothing
  about a 52 page walk repeated nightly. Pilot at concurrency 4 with backoff
  before any full run.
- **`NextToken` lifetime** across a long walk or across days is unverified.
- **Whether `AGENTIC_TYPE` is publisher-declared or AWS-assigned** is unverified,
  and it decides how much weight the registry may put on it.
- **Discovery API pricing.** The announcement states no price. Confirm before a
  nightly schedule.
- **Absences rest on a nine-listing sample** spanning four delivery shapes, not
  on a corpus scan. "AWS publishes no date" and "no supported-languages field"
  are observed, not proven. Container, Helm, CloudFormation and SageMaker
  listings were not read.
- **AWS Foundational Technical Review** appeared on none of the nine pages and in
  no facet, but AWS's own documentation was not exhausted.
- **The sitemap's 265 shortfall** against `totalResults` is unexplained.

---

## 9. Rules that do not bend

- The evidence verification gate in `ingest_capture()` is never relaxed.
- The registry never infers. A value is copied from a named source and verified
  against that source's own text, or it is not shown.
- No reverse-engineered credential enters this repository. If AWS ever requires
  a signed identity we cannot legitimately hold, the AWS path stops there rather
  than being worked around.
- `robots.txt` is respected. `/marketplace/search*` is disallowed, which is why
  this design uses the API rather than the website.
