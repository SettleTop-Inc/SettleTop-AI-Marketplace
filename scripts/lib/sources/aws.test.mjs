/**
 * The AWS parser, against three real product pages.
 *
 *   node --test scripts/lib/sources/aws.test.mjs
 *
 * The fixtures are AWS Marketplace product pages saved byte for byte as
 * aws.amazon.com served them on 2026-08-20, fetched exactly the way
 * aws-detail.mjs fetches them: plain GET, no browser, no credential.
 *
 *   aws-in-category-prodview-4jqih5hzoxv3a.html
 *       DoiT MCP. In AI Agents & Tools through ONE category whose
 *       parentCategoryId is the GUID. Fulfilment type API, which AWS displays
 *       as "API-Based Agents & Tools", so this is the closest thing in the
 *       corpus to what this registry is actually about. The GUID occurs exactly
 *       once in the whole blob, and that once is the real match.
 *
 *   aws-rated-prodview-g232pyu6l55l4.html
 *       TrendAI Cloud One. In category, and the page where AWS's separate
 *       review scores are visible: the blended average is 5 and the AWSMP
 *       provider average is 4.5 over the same 35 reviews, with a syndicated G2
 *       score beside them. Also carries thirteen usage-based plans, a CustomEula
 *       and two links AWS publishes with no name.
 *
 *   aws-out-of-category-prodview-e6fhzcuaw7pmi.html
 *       EVA for Amazon Connect. NOT in the category, and the GUID appears in
 *       its blob four times anyway, every one of them inside
 *       recommendations.discoRecommendations, which describes other products.
 *       This fixture exists to hold the line against a substring search.
 *
 * WHAT THESE TESTS ARE FOR. The parser's promise is that it copies and never
 * infers, and the ways that promise breaks here are all silent. A substring
 * match for the category GUID keeps three times too many listings and every one
 * of them looks like a normal record. Selecting the listing query by array index
 * yields the Usage query, whose overview has no categories field, and the pass
 * then keeps nothing while reporting success; that happened during research
 * before it was caught. A delisted product answers 200 with a well-formed blob
 * rather than 404. None of those is loud. So half of what follows is not "does
 * it read the page" but "does it refuse a page it can no longer read", each
 * mutation standing for one thing AWS could change.
 *
 * Expected values are read off the fixtures, not copied from a previous run of
 * this parser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CATEGORY,
  CATEGORY_LABEL,
  ID,
  PLAN_RATE_CARD_LIMIT,
  PREDICATE_VERSION,
  PRODUCT_URL,
  RECORD_VERSION,
  REVERSES_A_KEEP,
  SITEMAP_URL,
  extractPageContext,
  inCategory,
  isMissingListing,
  listingQuery,
  parseProductPage,
  productIdsIn,
  toPayload,
} from "./aws.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(HERE, "fixtures", name), "utf8");

const MCP = {
  id: "prodview-4jqih5hzoxv3a",
  url: PRODUCT_URL("prodview-4jqih5hzoxv3a"),
  html: fixture("aws-in-category-prodview-4jqih5hzoxv3a.html"),
};

const RATED = {
  id: "prodview-g232pyu6l55l4",
  url: PRODUCT_URL("prodview-g232pyu6l55l4"),
  html: fixture("aws-rated-prodview-g232pyu6l55l4.html"),
};

const OUTSIDE = {
  id: "prodview-e6fhzcuaw7pmi",
  url: PRODUCT_URL("prodview-e6fhzcuaw7pmi"),
  html: fixture("aws-out-of-category-prodview-e6fhzcuaw7pmi.html"),
};

/** Parse a fixture with one literal substitution, which is what a change to the page looks like. */
const mutate = (page, from, to, over = {}) => {
  assert.ok(page.html.includes(from), `fixture no longer contains ${JSON.stringify(from)}`);
  return parseProductPage({ ...page, html: page.html.replace(from, to), ...over });
};

/**
 * Rebuild a fixture around an edited page context.
 *
 * Some changes worth testing are structural rather than textual: reordering the
 * query cache, emptying it, moving a field. Editing the blob and re-wrapping it
 * in the same markup is how those are expressed without hand-writing 450 KB of
 * HTML that would then not be a real page.
 */
function rebuild(page, edit) {
  const marker = '<script id="vike_pageContext" type="application/json">';
  const start = page.html.indexOf(marker) + marker.length;
  const end = page.html.indexOf("</script>", start);
  const ctx = JSON.parse(page.html.slice(start, end));
  edit(ctx);
  return {
    ...page,
    html: page.html.slice(0, start) + JSON.stringify(ctx) + page.html.slice(end),
  };
}

// ------------------------------------------------------------ the predicate

test("the GUID matches as a PARENT category, which is the only way it ever matches", () => {
  const { outcome, record } = parseProductPage(MCP);
  assert.equal(outcome, "kept");

  // One category, and it is in the category through its parent.
  assert.deepEqual(record.category_ids, [
    {
      name: "Finance & Accounting",
      id: "d0c382f0-7183-4a48-99dd-b18d2507e18d",
      parent_id: CATEGORY,
    },
  ]);
  // The listing's own categoryId is NOT the GUID. A predicate testing
  // categoryId alone keeps nothing at all: that is the measured result across
  // every page ever sampled, not a hypothetical.
  assert.notEqual(record.category_ids[0].id, CATEGORY);
});

test("a categoryId-only predicate would reject this page, so the parent half is load-bearing", () => {
  const cats = [
    { categoryName: "Finance & Accounting", categoryId: "d0c382f0", parentCategoryId: CATEGORY },
  ];
  assert.equal(inCategory(cats), true);
  assert.equal(
    cats.some((c) => c.categoryId === CATEGORY),
    false
  );
});

test("the GUID as a listing's own categoryId matches too, for the day AWS lists the parent", () => {
  assert.equal(inCategory([{ categoryName: "AI Agents & Tools", categoryId: CATEGORY }]), true);
});

test("a listing in no matching category is rejected", () => {
  assert.equal(
    inCategory([{ categoryName: "Storage", categoryId: "abc", parentCategoryId: "579164ab" }]),
    false
  );
  assert.equal(inCategory([]), false);
  assert.equal(inCategory(null), false);
  assert.equal(inCategory(undefined), false);
});

// --------------------------------------------------- discoRecommendations

test("discoRecommendations NEVER influences the decision", () => {
  // The fixture's blob really does carry the GUID, and every occurrence of it
  // is about a different product. This is the whole reason the fixture exists,
  // so assert the trap is still baited before asserting the parser avoids it.
  const ctx = extractPageContext(OUTSIDE.html);
  const blob = JSON.stringify(ctx);
  const occurrences = blob.split(CATEGORY).length - 1;
  assert.ok(occurrences >= 1, "fixture no longer contains the GUID anywhere");

  const own = listingQuery(ctx, "Detail").listingDetail.overview.categories;
  assert.equal(
    own.filter((c) => c.categoryId === CATEGORY || c.parentCategoryId === CATEGORY).length,
    0,
    "fixture is no longer an out-of-category page"
  );

  // Every place the GUID occurs, named. All of them are inside
  // discoRecommendations, which is the "you might also like" block and
  // describes OTHER products. The recommendations block lives inside the query
  // cache, not at the top of the page context, so a check anchored on a
  // top-level key would pass while proving nothing.
  const where = [];
  (function walk(node, path) {
    if (node === null || typeof node !== "object") {
      if (node === CATEGORY) where.push(path);
      return;
    }
    for (const k of Object.keys(node)) walk(node[k], `${path}.${k}`);
  })(ctx, "$");

  assert.ok(where.length > 0, "the GUID is no longer anywhere in this fixture");
  for (const path of where) {
    assert.match(
      path,
      /discoRecommendations/,
      `the GUID now also occurs at ${path}, which this test does not account for`
    );
  }

  // A whole-blob substring search would keep it. The parser does not.
  assert.equal(blob.includes(CATEGORY), true);
  assert.equal(parseProductPage(OUTSIDE).outcome, "out_of_category");
});

test("a rejected page produces no record at all", () => {
  const r = parseProductPage(OUTSIDE);
  assert.equal(r.record, undefined);
  // The categories it does have are reported, so the ledger line says why.
  assert.deepEqual(r.categories, ["Security", "Contact Center", "CRM"]);
});

// ------------------------------------------------------- query selection

test("the listing query is selected by queryName, never by index", () => {
  const ctx = extractPageContext(MCP.html);
  const withListingDetail = ctx.dehydratedState.queries.filter((q) => q?.state?.data?.listingDetail);

  // Two queries carry a listingDetail. Taking the first one with a listingDetail
  // is the mistake this test exists to prevent.
  assert.ok(withListingDetail.length >= 2, "expected both Detail and Usage to carry a listingDetail");

  const detail = listingQuery(ctx, "Detail");
  const usage = listingQuery(ctx, "Usage");
  assert.ok(Array.isArray(detail.listingDetail.overview.categories));
  // Usage's overview, where it has one at all, has no categories field. That is
  // why picking the wrong query keeps zero listings and reports success.
  assert.equal(usage.listingDetail.overview?.categories, undefined);
  assert.equal(usage.listingDetail.usage.fulfillmentOptions.length > 0, true);
});

test("reordering the query cache changes nothing", () => {
  const shuffled = rebuild(MCP, (ctx) => {
    ctx.dehydratedState.queries.reverse();
  });
  const before = parseProductPage(MCP);
  const after = parseProductPage(shuffled);
  assert.equal(after.outcome, "kept");
  assert.deepEqual(after.record.categories, before.record.categories);
  assert.deepEqual(after.record.plans, before.record.plans);
  assert.equal(after.record.name, "DoiT MCP");
});

// ------------------------------------------------------------ the reading

test("the in-category page is transcribed, field for field", () => {
  const { record } = parseProductPage(MCP);

  assert.equal(record.id, "prodview-4jqih5hzoxv3a");
  assert.equal(record.name, "DoiT MCP");
  assert.equal(record.predicate_version, PREDICATE_VERSION);
  assert.deepEqual(record.categories, ["Finance & Accounting"]);

  // The fulfilment type AWS states, both halves. The id is the stable machine
  // value; the name is what AWS displays.
  assert.equal(record.fulfillment_options[0].type_id, "API");
  assert.equal(record.fulfillment_options[0].type_name, "API-Based Agents & Tools");

  // AWS states a date on every page, contradicting the spec. It is the creation
  // date of a delivery option, not a listing-updated stamp.
  assert.equal(record.created_max, "2025-12-16T08:26:46.009Z");

  // Both stamps, and they are separate on purpose: a stale predicate means the
  // listing may not belong in the category at all, a stale record version means
  // a real listing was read by an older extractor.
  assert.equal(record.record_version, RECORD_VERSION);
  assert.notEqual(record.record_version, record.predicate_version);

  assert.equal(record.identifiers.product_id, "prod-j4mno5fang7zo");
  assert.equal(record.identifiers.stated_id, "prodview-4jqih5hzoxv3a");
  // Neither AWS identifier the spec relies on survives onto the keyless route.
  assert.equal(record.identifiers.canonical_listing_reference, null);
  assert.equal(record.url, "https://aws.amazon.com/marketplace/pp/prodview-4jqih5hzoxv3a");
});

test("an agentic listing still states no surface and no integration", () => {
  // The open question the recon could not close, because none of its
  // in-category pages was an agent or an MCP server. This fixture is one, and
  // both candidate holders are still null, so surfaces and works_with have no
  // blob source even here.
  const ctx = extractPageContext(MCP.html);
  const overview = listingQuery(ctx, "Detail").listingDetail.overview;
  assert.equal(overview.solution, null);
  assert.equal(overview.integrationGuide, null);

  const payload = toPayload({ record: parseProductPage(MCP).record, capturedAt: "2026-08-20T00:00:00Z" });
  assert.deepEqual(payload.extract.surfaces, []);
  assert.deepEqual(payload.extract.works_with, []);
});

test("AWS publishes separate blended and native review scores, and they differ", () => {
  const { record } = parseProductPage(RATED);
  // Same review count, two different averages. This is what disproves the
  // spec's claim that AWS publishes one blended average and no native score.
  assert.equal(record.reviews.count, 35);
  assert.equal(record.reviews.native_count, 35);
  assert.equal(record.reviews.rating, 5);
  assert.equal(record.reviews.native_rating, 4.5);
  assert.notEqual(record.reviews.rating, record.reviews.native_rating);

  // And a syndicated score beside them, read generically rather than by a
  // hard-coded provider name.
  assert.equal(record.reviews.external.source, "G2");
  assert.equal(record.reviews.external.count, 186);
});

test("prices are copied exactly as AWS prints them, currency and decimal tail included", () => {
  const { record } = parseProductPage(RATED);
  assert.equal(record.plans.length, 13);
  assert.deepEqual(record.plans[0], {
    name: "Cloud One Workload (Essentials)",
    price: "USD 0.00700000",
    unit: "Units",
    billing: null,
  });
});

test("AWS_SUPPORT is not a product link, and an unnamed link keeps a null label", () => {
  const ctx = extractPageContext(RATED.html);
  const resources = listingQuery(ctx, "Detail").listingDetail.support.supportResources;
  const generic = resources.find((r) => r.resourceLabel === "AWS_SUPPORT");
  assert.equal(generic.resourceValue, "https://aws.amazon.com/premiumsupport/");

  const { record } = parseProductPage(RATED);
  assert.equal(
    record.product_links.some((l) => l.url === "https://aws.amazon.com/premiumsupport/"),
    false,
    "AWS's own infrastructure support link is not this publisher's link"
  );
  // AWS does publish LINK resources with no name. The label stays null rather
  // than being filled in with words of ours.
  assert.ok(record.product_links.some((l) => l.label === null && l.url));
});

test("the support text is the publisher's channels and not AWS's generic one", () => {
  const { record } = parseProductPage(RATED);
  assert.ok(record.support.length > 0);
  for (const line of record.support) {
    assert.notEqual(line.value, "https://aws.amazon.com/premiumsupport/");
  }
});

// -------------------------------------------------------------- the payload

test("the payload states nothing, certifies nothing, and claims no surface", () => {
  const payload = toPayload({
    record: parseProductPage(RATED).record,
    capturedAt: "2026-08-20T00:00:00.000Z",
  });
  const e = payload.extract;

  assert.equal(payload.capture_meta.marketplace_id, ID);
  assert.equal(payload.capture_meta.source_view_url, SITEMAP_URL);
  // The provenance line names the GUID and the display name, because a bare
  // GUID is unreadable in a record meant to be audited.
  assert.ok(payload.capture_meta.source_view_filters.includes(CATEGORY));
  assert.ok(payload.capture_meta.source_view_filters.includes(CATEGORY_LABEL));
  // Never through a disallowed path.
  assert.equal(JSON.stringify(payload).includes("/marketplace/search"), false);

  // 'publisher_attestation' would falsely light the permission scope layer.
  assert.equal(e.certification, "none");
  // A non-empty graph_permissions writes a verified Microsoft Graph evidence row.
  assert.deepEqual(e.cert_detail.graph_permissions, []);
  for (const k of ["hosting", "data_location", "data_handling", "developer_last_updated", "page_last_updated", "full_text"]) {
    assert.equal(e.cert_detail[k], null, `cert_detail.${k} should be null for AWS`);
  }
  assert.deepEqual(e.cert_detail.compliance, []);

  // works_with lights the integrations layer with no evidence row behind it.
  assert.deepEqual(e.works_with, []);
  assert.deepEqual(e.surfaces, []);
  assert.deepEqual(e.industries, []);
  // The category display name is ours, so it never joins the publisher's list.
  assert.equal(e.categories.includes(CATEGORY_LABEL), false);

  // The gate verifies every stated value verbatim. AWS states none.
  for (const [k, v] of Object.entries(e.stated)) assert.deepEqual(v, [], `stated.${k}`);

  // AWS publishes no display price. The pricing layer lights from plan_count.
  assert.equal(e.pricing, null);
  assert.equal(e.plans.length, 13);
  assert.equal(payload.capture_meta.capture_complete, true);
  assert.deepEqual(payload.capture_meta.missing, []);
});

test("a listing AWS does not price is a complete capture that says so", () => {
  // A professional services engagement, expressed here by removing the pricing
  // payload the way AWS does: the query answers with no summary key at all.
  const unpriced = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      if (q?.queryKey?.[2]?.queryName === "Pricing") q.state.data = {};
    }
  });
  const { record } = parseProductPage(unpriced);
  assert.equal(record.pricing_published, false);
  assert.deepEqual(record.plans, []);

  const payload = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" });
  // COMPLETE, and this is the whole point of the test's name. PassportView
  // renders a "Partial capture" tag off this flag, asserting the harvest
  // failed. Nothing failed: AWS publishes no price for a professional services
  // engagement, and every AWS PROFESSIONAL_SERVICES listing would carry that
  // tag. microsoft.mjs:92 reads the column the same way, as a fact about the
  // fetch rather than about how much the publisher chose to say.
  assert.equal(payload.capture_meta.capture_complete, true);
  // The nuance is in `missing`, in words, which is where it belongs.
  assert.deepEqual(payload.capture_meta.missing, [
    "price: AWS publishes no pricing for this listing",
  ]);
});

test("a rate card table too large to be a plan list is omitted and the omission is recorded", () => {
  // AMI listings carry per-instance-type rate cards, up to 1,540 on one page.
  // Blown up here from a real term rather than hand-written, so the shape is
  // AWS's.
  const many = rebuild(RATED, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      const terms = q?.state?.data?.summary?.terms;
      if (!terms) continue;
      for (const t of terms) {
        if (t.termType !== "UsageBasedPricingTerm") continue;
        const card = t.rateCards[0];
        t.rateCards = Array.from({ length: PLAN_RATE_CARD_LIMIT + 1 }, (_, i) => ({
          ...card,
          dimensionKey: `dim${i}`,
          displayName: `dim${i}`,
        }));
        t.totalRateCards = PLAN_RATE_CARD_LIMIT + 1;
      }
    }
  });
  const { record } = parseProductPage(many);
  assert.deepEqual(record.plans, []);
  assert.deepEqual(record.plans_omitted, [
    {
      term_type: "UsageBasedPricingTerm",
      rate_cards: PLAN_RATE_CARD_LIMIT + 1,
      embedded: PLAN_RATE_CARD_LIMIT + 1,
      reason: "above_limit",
    },
  ]);

  const payload = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" });
  // Not silently dropped. The capture says what was left out and how much.
  assert.equal(payload.capture_meta.capture_complete, false);
  assert.match(payload.capture_meta.missing[0], /UsageBasedPricingTerm publishes 51 rate cards/);
});


// -------------------------------------------- what is copied and what is not

test("AWS states zero reviews and zero stars together, and the zero is not a score", () => {
  const { record } = parseProductPage(MCP);
  // AWS's own words, kept in the record and therefore in raw. This is what a
  // listing with no reviews looks like: a count of zero and an average of zero
  // stated side by side, on 102 of the 195 listings the pilot kept.
  assert.equal(record.reviews.count, 0);
  assert.equal(record.reviews.rating, 0);
  assert.equal(record.reviews.native_count, 0);
  assert.equal(record.reviews.native_rating, 0);

  const e = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" }).extract;
  // Null in the extract, because the column is a rating and this is a sentinel.
  // The registry sorts ratings NULLS LAST in both directions precisely so a
  // missing rating never outranks a stated one, and a stored 0.00 is not null.
  assert.equal(e.rating, null);
  assert.equal(e.native_rating, null);
  // The count is still AWS's, and it is what says why the rating is null.
  assert.equal(e.rating_count, 0);
});

test("a rating over real reviews is copied, blended and native alike", () => {
  const { record } = parseProductPage(RATED);
  const e = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" }).extract;
  // The count is the test, never the score, so nothing here is coerced.
  assert.equal(e.rating, 5);
  assert.equal(e.native_rating, 4.5);
  assert.equal(e.rating_count, 35);
});

test("every syndication provider survives onto the record, not just the first", () => {
  // The extract has room for one external source. The record must not lose the
  // others: AWS's own translation table names PeerSpot beside G2, so a second
  // provider is expected rather than hypothetical, and which one comes first is
  // decided by JSON key order rather than by anything AWS states.
  const two = rebuild(RATED, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      const s = q?.state?.data?.SyndicatedReviews;
      if (!s?.G2) continue;
      s.PeerSpot = { ...s.G2, AverageCustomerRating: 4.2, TotalReviews: 9 };
    }
  });
  const { record } = parseProductPage(two);
  assert.deepEqual(record.reviews.syndicated.map((s) => s.source), ["G2", "PeerSpot"]);
  // And the single-valued extract still carries exactly one, by the stated rule.
  const e = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" }).extract;
  assert.equal(e.external_source, "G2");
});

test("AWS's reviews page is not filed among the publisher's links", () => {
  const { record } = parseProductPage(RATED);
  // AWS does publish the address, and it is kept where it is AWS's own.
  assert.match(record.reviews.reviews_url, /aws\.amazon\.com\/marketplace\/reviews\//);

  const e = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" }).extract;
  // The write path files every entry in product_links as capture_link kind
  // 'product'. A label of ours on a link of AWS's would read there as the
  // publisher's own words, which is the reason linksFrom leaves an unnamed
  // link unnamed.
  assert.equal(e.product_links.some((l) => l.url === record.reviews.reviews_url), false);
  assert.equal(e.product_links.some((l) => l.label === "Customer reviews"), false);
});

test("no fulfilment option creation date is presented as a listing-updated date", () => {
  const { record } = parseProductPage(MCP);
  // AWS publishes the date and it is captured, verbatim, on the record.
  assert.equal(record.created_max, "2025-12-16T08:26:46.009Z");
  assert.equal(record.fulfillment_options[0].creation_date, record.created_max);

  const e = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" }).extract;
  // It does not become extract.updated, which the write path stores as
  // listing_updated and the site prints as "Listing updated <date>" while
  // marking the field Disclosed. That sentence would be ours, not AWS's: what
  // AWS stated is when a delivery option was created.
  assert.equal(e.updated, null);
});

test("the listing version is copied only where AWS publishes one delivery option", () => {
  const { record } = parseProductPage(MCP);
  assert.equal(record.fulfillment_options.length, 1);
  const e = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" }).extract;
  assert.equal(e.version, record.fulfillment_options[0].version);

  // With two options, choosing which one speaks for the listing is ours, and
  // fulfillmentOptionVersion is free text: on a SageMaker Model page the two
  // values are "GPU" and "CPU". Storing either as the listing version would
  // flip the field to Disclosed on a word that is not a version.
  const two = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      const f = q?.state?.data?.listingDetail?.usage?.fulfillmentOptions;
      if (!f?.length) continue;
      f.push({ ...f[0], fulfillmentOptionVersion: "GPU", creationDate: "2026-01-01T00:00:00.000Z" });
      f[0] = { ...f[0], fulfillmentOptionVersion: "CPU" };
    }
  });
  const both = parseProductPage(two).record;
  assert.equal(both.fulfillment_options.length, 2);
  assert.deepEqual(both.fulfillment_options.map((o) => o.version), ["GPU", "CPU"]);
  // Both stay in raw, newest first. Neither is presented as the listing's.
  assert.equal(toPayload({ record: both, capturedAt: "2026-08-20T00:00:00.000Z" }).extract.version, null);
});

// ------------------------------------------------------- delivery_ids ------

test("delivery_ids carries the fulfilment type ID, and acquire_using carries the name", () => {
  // Both fixtures state one option, and the two fields answer different
  // questions off the same node: the id is what registry_delivery() switches
  // on, the name is what a reader is shown.
  const mcp = toPayload({
    record: parseProductPage(MCP).record,
    capturedAt: "2026-08-20T00:00:00.000Z",
  }).extract;
  assert.deepEqual(mcp.delivery_ids, ["API"]);
  assert.equal(mcp.acquire_using, "API-Based Agents & Tools");

  const rated = toPayload({
    record: parseProductPage(RATED).record,
    capturedAt: "2026-08-20T00:00:00.000Z",
  }).extract;
  assert.deepEqual(rated.delivery_ids, ["SAAS"]);
  assert.equal(rated.acquire_using, "SaaS");

  // The display name never leaks into the key the derivation reads. AWS
  // renders "API-Based Agents & Tools" through the page's UI translation
  // table and is free to reword it; "API" is the machine value.
  for (const e of [mcp, rated]) {
    for (const id of e.delivery_ids) {
      assert.match(id, /^[A-Z0-9_]+$/);
      assert.equal(id === e.acquire_using, false);
    }
  }
});

test("delivery_ids is distinct, so three AMIs are one delivery method", () => {
  // A multi-version AMI listing publishes one fulfilment option per version,
  // every one of them AMAZON_MACHINE_IMAGE. Repeating the id would say nothing
  // extra and would make the array's length look like a fact about the
  // listing.
  const three = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      const f = q?.state?.data?.listingDetail?.usage?.fulfillmentOptions;
      if (!f?.length) continue;
      const ami = (n, date) => ({
        ...f[0],
        fulfillmentOptionId: `ami-${n}`,
        fulfillmentOptionType: {
          fulfillmentOptionTypeId: "AMAZON_MACHINE_IMAGE",
          fulfillmentOptionTypeName: "Amazon Machine Image",
        },
        fulfillmentOptionVersion: `1.${n}`,
        creationDate: date,
      });
      f.length = 0;
      f.push(ami(1, "2026-01-01T00:00:00.000Z"));
      f.push(ami(2, "2026-02-01T00:00:00.000Z"));
      f.push(ami(3, "2026-03-01T00:00:00.000Z"));
    }
  });
  const { record } = parseProductPage(three);
  assert.equal(record.fulfillment_options.length, 3);
  const e = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" }).extract;
  assert.deepEqual(e.delivery_ids, ["AMAZON_MACHINE_IMAGE"]);
  // acquire_using deduplicates on the same rule, so the two stay in step.
  assert.equal(e.acquire_using, "Amazon Machine Image");
});

test("delivery_ids order is AWS's newest-first, not the blob's array order", () => {
  // Two different types, with the CONTAINER option stated later in the array
  // and created more recently. fulfillmentOptions() sorts on creationDate, a
  // value AWS publishes, so the order is a consequence of AWS's own data
  // rather than of where an entry happens to sit.
  const mixed = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      const f = q?.state?.data?.listingDetail?.usage?.fulfillmentOptions;
      if (!f?.length) continue;
      const base = f[0];
      f.length = 0;
      f.push({
        ...base,
        fulfillmentOptionId: "helm-1",
        fulfillmentOptionType: {
          fulfillmentOptionTypeId: "HELM",
          fulfillmentOptionTypeName: "Helm Chart",
        },
        creationDate: "2024-01-01T00:00:00.000Z",
      });
      f.push({
        ...base,
        fulfillmentOptionId: "ctr-1",
        fulfillmentOptionType: {
          fulfillmentOptionTypeId: "CONTAINER",
          fulfillmentOptionTypeName: "Container Image",
        },
        creationDate: "2026-05-01T00:00:00.000Z",
      });
    }
  });
  const { record } = parseProductPage(mixed);
  const e = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" }).extract;
  assert.deepEqual(e.delivery_ids, ["CONTAINER", "HELM"]);

  // And it is stable: the same page read twice gives the same array. The order
  // carries no weight in the derivation either way, because the SQL tries the
  // ids in a fixed literal precedence rather than reading position 0.
  const again = toPayload({
    record: parseProductPage(mixed).record,
    capturedAt: "2026-08-20T00:00:00.000Z",
  }).extract;
  assert.deepEqual(again.delivery_ids, e.delivery_ids);
});

test("a listing with no fulfilment option states no delivery id, and says so as an empty array", () => {
  // Empty is not the same as absent, and both have to be survivable. Here the
  // adapter states []; on a Microsoft or DRAI payload the key is not emitted at
  // all. The write path reads it with the coalesce(array(...), '{}') shape it
  // already uses for surfaces, so both arrive as an empty text[] and no branch
  // of registry_delivery() can match on them.
  const none = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      const u = q?.state?.data?.listingDetail?.usage;
      if (u?.fulfillmentOptions) u.fulfillmentOptions = [];
    }
  });
  const { record } = parseProductPage(none);
  assert.deepEqual(record.fulfillment_options, []);
  const e = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" }).extract;
  assert.deepEqual(e.delivery_ids, []);
  assert.equal(e.acquire_using, null);
  assert.equal(e.version, null);
});

test("an option AWS states with no type id contributes nothing rather than a blank", () => {
  // An empty string in delivery_ids would be a value the derivation has to
  // reject, and it would count towards the array's length. Dropped instead.
  const nameless = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      const f = q?.state?.data?.listingDetail?.usage?.fulfillmentOptions;
      if (!f?.length) continue;
      f[0] = {
        ...f[0],
        fulfillmentOptionType: {
          fulfillmentOptionTypeId: null,
          fulfillmentOptionTypeName: "Something AWS has not named",
        },
      };
    }
  });
  const { record } = parseProductPage(nameless);
  assert.equal(record.fulfillment_options.length, 1);
  assert.equal(record.fulfillment_options[0].type_id, null);
  const e = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" }).extract;
  assert.deepEqual(e.delivery_ids, []);
  // The name AWS did state still reaches the reader.
  assert.equal(e.acquire_using, "Something AWS has not named");
});

test("a term stating more rate cards than it carries is an omission, not a plan list", () => {
  // Unobserved: totalRateCards, rateCardCount and the array agreed on every
  // page sampled, including terms of 984 and 710 cards. Reading only the array
  // length would make the day they disagree silent, and a partial price table
  // presented as a plan list is a claim AWS never made.
  const short = rebuild(RATED, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      const terms = q?.state?.data?.summary?.terms;
      if (!terms) continue;
      for (const t of terms) {
        if (t.termType !== "UsageBasedPricingTerm") continue;
        t.totalRateCards = 1540;
        t.rateCardCount = 1540;
      }
    }
  });
  const { record } = parseProductPage(short);
  assert.deepEqual(record.plans, []);
  assert.deepEqual(record.plans_omitted, [
    {
      term_type: "UsageBasedPricingTerm",
      rate_cards: 1540,
      embedded: 13,
      reason: "fewer_embedded_than_stated",
    },
  ]);
  const payload = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" });
  assert.match(
    payload.capture_meta.missing[0],
    /states 1540 rate cards and the page carries 13/
  );
});

test("the product id is chosen by carrying one, never by array position", () => {
  // associatedEntities is variable length and every entry carries a
  // manufacturer beside its product, so index 0 chooses arbitrarily the day a
  // second entry appears.
  const shifted = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      const o = q?.state?.data?.listingDetail?.overview;
      if (!o?.associatedEntities?.length) continue;
      o.associatedEntities.unshift({ manufacturer: { manufacturerId: "m-1" } });
    }
  });
  const { record } = parseProductPage(shifted);
  assert.equal(record.identifiers.product_id, "prod-j4mno5fang7zo");
});

test("a page that states no id of its own is refused, as Microsoft refuses one", () => {
  // microsoft.mjs:366 returns a failure for a page stating no ID, with the
  // rationale that there is nothing left to match against and accepting it
  // would file the record under whatever id the caller happened to pass, on
  // the strength of a redirect alone. That argument transfers unchanged.
  const noId = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      if (q?.queryKey?.[2]?.queryName === "Detail") q.state.data.id = null;
    }
  });
  const r = parseProductPage({ ...noId, id: "prodview-aaaaaaaaaaaaa" });
  // Retryable rather than terminal: data.id was present on 40 of 40 pages, so
  // an absent one means the template changed, and permanently excluding a real
  // listing on a parse failure is the error this ledger is shaped to avoid.
  assert.equal(r.outcome, "unreadable");
  assert.equal(r.record, undefined);
});

// ------------------------------------------------- reversing an earlier keep

test("a verdict that reverses an earlier keep removes the record it wrote", () => {
  // The detail pass rewrites details.jsonl from a map of keepers, and
  // aws-ingest.mjs reads that file and applies no membership test of its own.
  // A first run keeps a listing; a later run, triggered by a version bump or a
  // widened predicate, re-reads it and reverses the verdict. If the record
  // stays, ingest loads a listing AWS has delisted or moved out of the
  // category, with a fresh captured_at, while the summary prints it as a
  // reject. This walks that sequence with the real parser.
  const keepers = new Map();
  const resolve = (page) => {
    const parsed = parseProductPage(page);
    if (REVERSES_A_KEEP.has(parsed.outcome)) keepers.delete(page.id);
    if (parsed.outcome === "kept") keepers.set(page.id, parsed.record);
    return parsed.outcome;
  };

  assert.equal(resolve(MCP), "kept");
  assert.equal(keepers.size, 1);

  // AWS recategorises it: the same page, with its one in-category parent
  // replaced by a category that has nothing to do with the GUID.
  const moved = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      const cats = q?.state?.data?.listingDetail?.overview?.categories;
      if (!cats) continue;
      for (const c of cats) c.parentCategoryId = "00000000-0000-0000-0000-000000000000";
    }
  });
  assert.equal(resolve({ ...moved, id: MCP.id }), "out_of_category");
  assert.equal(keepers.size, 0, "the record kept by the first run must not survive the second");
});

test("a delisted product also removes its record, and an unreadable page does not", () => {
  const keepers = new Map();
  const resolve = (page) => {
    const parsed = parseProductPage(page);
    if (REVERSES_A_KEEP.has(parsed.outcome)) keepers.delete(page.id);
    if (parsed.outcome === "kept") keepers.set(page.id, parsed.record);
    return parsed.outcome;
  };

  resolve(MCP);
  assert.equal(keepers.size, 1);

  // A page that cannot be read is a fact about our reading, not about the
  // product, so a transient failure must not throw away a good record.
  const broken = { ...MCP, html: "<html><body>nothing here</body></html>" };
  assert.equal(resolve(broken), "unreadable");
  assert.equal(keepers.size, 1);

  // AWS serving no listing for the id is terminal, and it does remove it.
  const gone = rebuild(MCP, (ctx) => {
    ctx.pageId = "/lib/frontend/pages/ppV2/default";
    ctx.dehydratedState.queries = [];
  });
  assert.equal(resolve({ ...gone, id: MCP.id }), "gone");
  assert.equal(keepers.size, 0);
});

test("unreadable is deliberately absent from the reversal set", () => {
  assert.deepEqual(
    [...REVERSES_A_KEEP].sort(),
    ["gone", "identity_mismatch", "out_of_category"]
  );
  assert.equal(REVERSES_A_KEEP.has("unreadable"), false);
  assert.equal(REVERSES_A_KEEP.has("kept"), false);
});
// ------------------------------------------------------------- the refusals

test("no blob at all is unreadable, not out of category", () => {
  assert.equal(extractPageContext("<html><body>nothing here</body></html>"), null);
  const r = parseProductPage({ id: MCP.id, html: "<html><body>nothing here</body></html>" });
  assert.equal(r.outcome, "unreadable");
  assert.match(r.reason, /no vike_pageContext/);
});

test("a blob that does not parse is unreadable, not out of category", () => {
  const r = mutate(MCP, '"listingName":"DoiT MCP"', '"listingName":BROKEN');
  assert.equal(r.outcome, "unreadable");
});

test("a real page with no overview is unreadable, never out of category", () => {
  // A template change or a partial hydration. Recording it as out of category
  // would permanently exclude a real listing on the strength of a parse
  // failure, which is the exact error this registry exists to avoid.
  const noOverview = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      if (q?.queryKey?.[2]?.queryName === "Detail") delete q.state.data.listingDetail.overview;
    }
  });
  const r = parseProductPage(noOverview);
  assert.equal(r.outcome, "unreadable");
  assert.match(r.reason, /no listingDetail.overview/);
});

test("a real page whose overview states no categories is unreadable, never out of category", () => {
  const noCategories = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      if (q?.queryKey?.[2]?.queryName === "Detail") {
        delete q.state.data.listingDetail.overview.categories;
      }
    }
  });
  const r = parseProductPage(noCategories);
  assert.equal(r.outcome, "unreadable");
  assert.match(r.reason, /states no categories/);
});

test("a renamed Detail query is unreadable rather than silently empty", () => {
  const renamed = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      if (q?.queryKey?.[2]?.queryName === "Detail") q.queryKey[2].queryName = "DetailV2";
    }
  });
  assert.equal(parseProductPage(renamed).outcome, "unreadable");
});

test("a product AWS no longer serves is gone, and gone is not a fetch failure", () => {
  // AWS answers 200 with a well-formed blob and an empty query cache. Treating
  // it as retryable would refetch it on every run for the life of the registry.
  const absent = rebuild(MCP, (ctx) => {
    ctx.pageId = "/lib/frontend/pages/ppV2/default";
    ctx.dehydratedState.queries = [];
    ctx.routeParams = { locale: "en" };
  });
  assert.equal(isMissingListing(extractPageContext(absent.html)), true);
  const r = parseProductPage(absent);
  assert.equal(r.outcome, "gone");
  assert.equal(r.record, undefined);
});

test("the real page is not mistaken for a gone one", () => {
  assert.equal(isMissingListing(extractPageContext(MCP.html)), false);
  assert.equal(isMissingListing(null), false);
});

test("a page stating a different product id is an identity mismatch, and writes nothing", () => {
  const r = parseProductPage({ ...MCP, id: "prodview-somethingelse" });
  assert.equal(r.outcome, "identity_mismatch");
  assert.equal(r.stated_id, "prodview-4jqih5hzoxv3a");
  // Never re-filed under the id the page stated. That is a second product
  // arriving through the wrong door.
  assert.equal(r.record, undefined);
});

test("the identity guard reads the blob, not the router", () => {
  // routeParams.listingId, urlPathname and the query key all echo the URL the
  // request landed on, so all three would agree with a redirect. Changing only
  // them must not change the verdict.
  const routerLies = rebuild(MCP, (ctx) => {
    ctx.routeParams.listingId = "prodview-elsewhere00";
    ctx.urlPathname = "/en/pp/prodview-elsewhere00/index.html";
  });
  assert.equal(parseProductPage(routerLies).outcome, "kept");

  const blobLies = rebuild(MCP, (ctx) => {
    for (const q of ctx.dehydratedState.queries) {
      if (q?.queryKey?.[2]?.queryName === "Detail") q.state.data.id = "prodview-elsewhere00";
    }
  });
  assert.equal(parseProductPage(blobLies).outcome, "identity_mismatch");
});

// -------------------------------------------------------------- the sitemap

test("sitemap ids come from product locs only, never from a bare id match", () => {
  const xml =
    "<urlset>" +
    "<loc>https://aws.amazon.com/marketplace/pp/prodview-4jqih5hzoxv3a</loc>" +
    "<loc>https://aws.amazon.com/marketplace/pp/prodview-4jqih5hzoxv3a</loc>" +
    "<loc>https://aws.amazon.com/marketplace/reviews/reviews-list/prodview-reviewonly01</loc>" +
    "<loc>https://aws.amazon.com/marketplace/customer-connect/private-offer/prodview-offeronly001</loc>" +
    "<loc>https://aws.amazon.com/marketplace/b/f1d47436-8a98-40db-b687-696723ec32cb</loc>" +
    "<loc>https://aws.amazon.com/marketplace/search</loc>" +
    "</urlset>";

  // Deduped, and the reviews-only and offer-only ids are NOT admitted: their
  // product page may not exist, and the detail pass would then file them gone
  // forever. The bare-id shortcut returns the same answer only by coincidence.
  assert.deepEqual(productIdsIn(xml), ["prodview-4jqih5hzoxv3a"]);
  assert.equal(productIdsIn(xml).length, 1);
  assert.equal([...xml.matchAll(/prodview-[a-z0-9]+/g)].length, 4);

  // The one disallowed loc in the real sitemap never becomes a fetch.
  assert.equal(productIdsIn(xml).some((id) => id.includes("search")), false);
});

test("the sitemap parser survives the file being a single line", () => {
  // The real file is 5 MB with no newline in it. A line-oriented parser reads
  // it as one record and finds nothing.
  const one = Array.from(
    { length: 3 },
    (_, i) => `<loc>https://aws.amazon.com/marketplace/pp/prodview-aaaaaaaaaaa${i}0</loc>`
  ).join("");
  assert.equal(one.includes("\n"), false);
  assert.equal(productIdsIn(one).length, 3);
});
