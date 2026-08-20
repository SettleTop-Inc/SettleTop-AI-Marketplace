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
  assert.equal(payload.capture_meta.capture_complete, false);
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
    { term_type: "UsageBasedPricingTerm", rate_cards: PLAN_RATE_CARD_LIMIT + 1 },
  ]);

  const payload = toPayload({ record, capturedAt: "2026-08-20T00:00:00.000Z" });
  // Not silently dropped. The capture says what was left out and how much.
  assert.equal(payload.capture_meta.capture_complete, false);
  assert.match(payload.capture_meta.missing[0], /UsageBasedPricingTerm publishes 51 rate cards/);
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
