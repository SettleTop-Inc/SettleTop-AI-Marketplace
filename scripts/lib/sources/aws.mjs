/**
 * AWS Marketplace source adapter.
 *
 * Written from docs/aws-source.md, which records what was read off the live
 * pages and, as importantly, which values are our classification rather than
 * AWS's. Read that file before changing anything here. The merged spec
 * (docs/superpowers/specs/2026-08-20-aws-marketplace-source-design.md) chose an
 * authenticated Discovery API; the owner declined a credential requirement, so
 * this is the KEYLESS route and three of the spec's field claims are wrong
 * against the page. Each correction is marked below.
 *
 * HOW AWS IS READ. Plain fetch, no browser, no credential. A product page at
 * /marketplace/pp/<prodview-id> embeds its whole record as JSON in
 * <script id="vike_pageContext" type="application/json">, a dehydrated TanStack
 * Query cache. Enumeration comes from the sitemap, which robots.txt names.
 *
 * ROBOTS. https://aws.amazon.com/robots.txt disallows /marketplace/search* for
 * every agent. Nothing here ever constructs such a URL. The sitemap carries one
 * disallowed loc, https://aws.amazon.com/marketplace/search, which is why
 * enumeration anchors on the /marketplace/pp/ prefix rather than taking locs as
 * given: the prefix filter is the correctness rule and the robots safeguard at
 * the same time.
 *
 * THE ORDER OF EVENTS THAT MAKES AWS DIFFERENT. Microsoft and DRAI can filter
 * while enumerating. AWS cannot: a listing's category is knowable only from its
 * own product record, so the expensive detail pass is also the filter. Roughly
 * seven of every eight pages fetched are read and then rejected, which is why
 * aws-detail.mjs keeps an outcome ledger rather than resuming from its output.
 */
export const ID = "aws";
export const ORIGIN = "https://aws.amazon.com";

/**
 * The address robots.txt itself publishes, without the .xml suffix.
 *
 * Both forms answer 200 with byte-identical bodies and neither redirects, so
 * .xml is an alias rather than a forward. The robots-named form is the one AWS
 * states, so it is the one recorded as provenance.
 */
export const SITEMAP_URL = `${ORIGIN}/marketplace/sitemap`;
export const PRODUCT_URL = (id) => `${ORIGIN}/marketplace/pp/${id}`;

/**
 * AI Agents & Tools.
 *
 * CATEGORY_LABEL is carried alongside the GUID because a bare GUID is
 * unreadable in a provenance record. Note what it is NOT: the parent category
 * is never itself listed on a product, so the string "AI Agents & Tools" does
 * not appear in the blob. It is AWS's display name for this GUID, copied from
 * AWS's own category page, and it is a constant of ours rather than a value
 * read from the listing. It must never be merged into extract.categories.
 */
export const CATEGORY = "f1d47436-8a98-40db-b687-696723ec32cb";
export const CATEGORY_LABEL = "AI Agents & Tools";

/**
 * The human address of the category. A citation, not a source: the page is a
 * client-rendered shell carrying zero prodview ids, so nothing is read from it.
 */
export const CATEGORY_URL = `${ORIGIN}/marketplace/b/${CATEGORY}`;

/**
 * Stamped on every ledger row in data/aws/seen.jsonl.
 *
 * Roughly seven eighths of the catalogue resolves to a permanent
 * "out_of_category" decision, each made by THIS predicate on a specific day.
 * Widen the filter, and every one of those decisions is stale. Bump this string
 * whenever the predicate changes and the detail pass re-reads the rows that
 * carry an older stamp, which turns widening the filter into an ordinary
 * resumable run instead of a blind 43,104 page re-sweep.
 */
export const PREDICATE_VERSION = "category-parent-v1";

/**
 * Rate cards stored as plans, per pricing term.
 *
 * OURS, NOT AWS'S, and the most consequential judgement in this file. AWS makes
 * no distinction between a plan list and a price table: both arrive as
 * terms[].rateCards. On SaaS and Data Exchange listings the entries are real
 * publisher plans ("Freshchat User License"). On AMI and SageMaker listings
 * they are per-instance-type rate cards where displayName equals description
 * equals dimensionKey ("t3a.medium"), up to 1,540 on a single listing and 5,039
 * across twelve AMI pages sampled.
 *
 * The rule is deliberately mechanical rather than editorial: a term publishing
 * more than this many rate cards contributes NO plans, and the omission is
 * recorded in capture_meta.missing naming the term and the count AWS itself
 * publishes at terms[].totalRateCards. Truncating to the first N was rejected
 * because a partial price table presented as a plan list is a claim AWS never
 * made. Excluding AMI and SageMaker by fulfilment type was rejected because
 * that is a judgement about what those listings are; a count is not.
 */
export const PLAN_RATE_CARD_LIMIT = 50;

/**
 * Whether extract.updated carries max(fulfillmentOptions[].creationDate).
 *
 * THE SPEC IS WRONG WHERE IT SAYS AWS PUBLISHES NO DATE. It publishes one on
 * every page. What it does not publish is a listing-updated stamp: this is the
 * creation date of a DELIVERY OPTION. On a multi-version AMI the maximum is the
 * publish date of the newest version and it agrees with the version string. On
 * SaaS and Professional Services there is one option, so the date reads as
 * first-published rather than last-updated.
 *
 * Copying it is defensible, because the value is taken verbatim from a named
 * AWS field and nothing is inferred. Calling it "updated" is the part that is
 * ours. The switch is here so the owner can decline it in one line; either way
 * every option's creationDate stays in raw, so declining loses nothing.
 */
export const UPDATED_FROM_FULFILLMENT_CREATION_DATE = true;

// ------------------------------------------------------------- sitemap ----

/**
 * Product ids from the sitemap.
 *
 * The whole 5 MB file is ONE LINE with no newline in it, so a line-oriented
 * parser reads it as a single record and finds nothing. This matches over the
 * whole string.
 *
 * Anchored on the full /marketplace/pp/ loc, never on a bare prodview- match.
 * The sitemap also lists /marketplace/reviews/reviews-list/<prodview-id> and one
 * /marketplace/customer-connect/private-offer/<prodview-id>. Today every id
 * under those also has a pp page, so a bare match returns the same 43,104 by
 * coincidence. That is not an invariant: an id appearing only under
 * reviews-list would be admitted as a product whose page does not exist, and
 * the detail pass would then file it "gone" forever.
 */
const PP_LOC = /<loc>https:\/\/aws\.amazon\.com\/marketplace\/pp\/(prodview-[a-z0-9]{13})<\/loc>/g;

export function productIdsIn(xml) {
  return [...new Set([...xml.matchAll(PP_LOC)].map((m) => m[1]))];
}

// ---------------------------------------------------------------- blob ----

const VIKE = /<script id="vike_pageContext" type="application\/json">/;

/**
 * The embedded page context, or null when the page carries none.
 *
 * A plain indexOf("</script>") slice is safe here: across 100 pages the JSON
 * contained no literal script close tag, no "</" at all and no < escape.
 * The shared extractState() brace walk also works, and is not used only because
 * this parser needs the final URL that fetchText returns and fetchState does
 * not.
 *
 * Returns the blob whenever the blob parses, INCLUDING for a product AWS no
 * longer serves. That case is a well-formed blob with an empty query cache, and
 * classifying it here would be expensive: fetchState treats a null parse as a
 * retryable failure and would spend four requests and eleven seconds of backoff
 * on every delisted id. Classification belongs to the caller.
 */
export function extractPageContext(html) {
  const m = html.match(VIKE);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf("</script>", start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
}

/**
 * AWS serves a product it does not have as HTTP 200, not 404.
 *
 * The body is 288,629 bytes of a well-formed default page whose query cache is
 * empty and whose routeParams carry no listingId. pageId is the cleanest single
 * test; the missing listingId corroborates it. queries.length === 0 is
 * equivalent today and is a weaker test, because it cannot tell "AWS has no
 * such listing" from "the cache failed to hydrate".
 *
 * This string is an internal build path and AWS can change it without notice.
 * When it does, delisted products start being classified unreadable and retried
 * on every run, which is why aws-detail.mjs prints the gone count even when it
 * is zero.
 */
const MISSING_LISTING_PAGE_ID = "/lib/frontend/pages/ppV2/default";

export const isMissingListing = (ctx) => ctx?.pageId === MISSING_LISTING_PAGE_ID;

const queries = (ctx) => ctx?.dehydratedState?.queries ?? [];

/**
 * A listing query, selected by its queryName and never by array index.
 *
 * dehydratedState.queries varies in length and order by fulfilment type. TWO
 * entries carry state.data.listingDetail: Detail and Usage. Taking the first
 * one with a listingDetail yields Usage, whose overview has no categories
 * field, at which point the category predicate matches nothing and the whole
 * pass keeps zero listings while reporting success. That happened during
 * research before it was caught.
 *
 * The split is: Detail carries {overview, support}, Usage carries {usage},
 * Pricing carries no listingDetail at all, only summary.
 */
export const listingQuery = (ctx, queryName) =>
  queries(ctx).find(
    (q) =>
      q?.queryKey?.[0] === "disco" &&
      q?.queryKey?.[1] === "get-listing-view" &&
      q?.queryKey?.[2]?.queryName === queryName
  )?.state?.data ?? null;

export const reviewsQuery = (ctx) =>
  queries(ctx).find((q) => q?.queryKey?.[1] === "reviewsV2")?.state?.data ?? null;

/**
 * Two sentinels stand in for absent values and both must be stripped.
 *
 * "!undefined" is everywhere: on sourceAgreementId, availabilityEndDate,
 * offerName, several renewal fields, and on 1,977 rate card descriptions.
 * "!Date:" prefixes offer.availableFromTime. Stored raw, either would enter the
 * registry as a value the publisher never wrote.
 */
export const ABSENT = "!undefined";

const text = (v) => {
  if (typeof v !== "string") return v == null ? null : v;
  const t = v === ABSENT ? "" : v.startsWith("!Date:") ? v.slice(6) : v;
  return t.trim() ? t : null;
};

const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);

// ------------------------------------------------------------ category ----

/**
 * Does this listing sit in AI Agents & Tools.
 *
 * THE GUID IS A PARENT CATEGORY. Matching categoryId alone returns zero of
 * every page sampled; every match in 95 pages came through parentCategoryId.
 * Both halves are kept because AWS could list the parent directly one day, and
 * a predicate that only looked at parents would then miss it.
 *
 * SCOPED TO listingDetail.overview.categories AND NOTHING ELSE. A substring
 * search for the GUID over the whole blob matches roughly a third of all pages
 * rather than an eighth, because recommendations.discoRecommendations[] carries
 * the Categories of OTHER products, the "you might also like" block. Never
 * match against discoRecommendations, for this or any purpose.
 *
 * Known limit, recorded rather than papered over: the taxonomy is at least
 * three deep, so a grandchild of this GUID would be missed. None was seen in 95
 * pages, so whether one exists is unverified either way.
 */
export function inCategory(categories) {
  return arr(categories).some(
    (c) => c?.categoryId === CATEGORY || c?.parentCategoryId === CATEGORY
  );
}

// -------------------------------------------------------------- reading ----

/** Fulfilment options, newest delivery option first. */
function fulfillmentOptions(usage) {
  return arr(usage?.listingDetail?.usage?.fulfillmentOptions)
    .map((f) => ({
      fulfillment_option_id: text(f?.fulfillmentOptionId),
      type_id: text(f?.fulfillmentOptionType?.fulfillmentOptionTypeId),
      type_name: text(f?.fulfillmentOptionType?.fulfillmentOptionTypeName),
      // Copied verbatim, never parsed. It is usually a version number, and on a
      // SageMaker Model page the two values are "GPU" and "CPU".
      version: text(f?.fulfillmentOptionVersion),
      creation_date: text(f?.creationDate),
      // AMI only. Joins to EC2 billing, so it is worth keeping in raw.
      product_code: text(f?.productCode),
    }))
    .sort((a, b) => String(b.creation_date ?? "").localeCompare(String(a.creation_date ?? "")));
}

/**
 * Support channels the PUBLISHER offers.
 *
 * Filtered to resourceLabel CREATOR_SUPPORT first, and that filter is what
 * makes the field mean anything: on 28 of 60 pages supportResources[0] is
 * AWS_SUPPORT, AWS's own generic premium-support link, identical on every one
 * of those pages and not a publisher channel at all.
 *
 * resourceName is null on every TEXT entry, so there the value is the text.
 */
function supportLines(detail) {
  return arr(detail?.listingDetail?.support?.supportResources)
    .filter((r) => r?.resourceLabel === "CREATOR_SUPPORT")
    .map((r) => ({
      name: text(r?.resourceName),
      value: text(r?.resourceValue),
      type: text(r?.resourceType),
    }))
    .filter((r) => r.value);
}

const linksFrom = (resources) =>
  arr(resources)
    .filter((r) => r?.resourceType === "LINK" && text(r?.resourceValue))
    .map((r) => ({ label: text(r?.resourceName), url: text(r?.resourceValue) }));

/**
 * The plans this listing publishes, and the terms whose rate cards were too
 * many to store.
 *
 * Five of the nine observed termTypes are priceable, and only three of those
 * publish a price:
 *
 *   UsageBasedPricingTerm           rateCards[].price, metered, no billing cycle
 *   ConfigurableUpfrontPricingTerm  rateCards[].rates[].price, billing is the
 *                                   ISO 8601 duration at rates[].selector.value
 *   RecurringPaymentTerm            flat, no rate cards, has a billingPeriod
 *
 * FreeTrialPricingTerm and ByolPricingTerm publish no price and no name. They
 * are deliberately NOT turned into plans: naming one would mean writing our own
 * words ("Free trial", "Bring your own license") into a display field, and the
 * only place those phrases exist on the page is the UI translation table. They
 * stay in raw, where they are AWS's structure rather than our prose.
 *
 * Prices are copied exactly as published, decimal tail and all, prefixed with
 * the term's own currencyCode. "793.80000000" is what AWS states; rounding it
 * would be a number of ours.
 */
function readPlans(pricing) {
  const plans = [];
  const omitted = [];

  for (const term of arr(pricing?.summary?.terms)) {
    const type = text(term?.termType);
    const currency = text(term?.currencyCode);
    const money = (p) => (text(p) == null ? null : currency ? `${currency} ${p}` : String(p));

    if (type === "RecurringPaymentTerm") {
      plans.push({
        // AWS publishes no name for this term. Inventing one is not on.
        name: null,
        price: money(term?.price),
        unit: null,
        billing: text(term?.billingPeriod),
      });
      continue;
    }

    if (type !== "UsageBasedPricingTerm" && type !== "ConfigurableUpfrontPricingTerm") continue;

    const cards = arr(term?.rateCards);
    // AWS states the count itself, at totalRateCards and rateCardCount, which
    // agreed with each other and with the array on every page sampled.
    const stated = Number(term?.totalRateCards ?? term?.rateCardCount ?? cards.length);
    if (cards.length > PLAN_RATE_CARD_LIMIT) {
      omitted.push({ term_type: type, rate_cards: Number.isFinite(stated) ? stated : cards.length });
      continue;
    }

    for (const card of cards) {
      const name = text(card?.displayName) ?? text(card?.dimensionKey);
      const unit = text(card?.unit);
      const rates = arr(card?.rates);
      if (rates.length) {
        for (const rate of rates) {
          plans.push({
            name,
            price: money(rate?.price),
            unit,
            billing: text(rate?.selector?.value),
          });
        }
      } else {
        plans.push({ name, price: money(card?.price), unit, billing: null });
      }
    }
  }

  return { plans, omitted };
}

/**
 * Reviews, or null when AWS returns none.
 *
 * null is the answer for every PROFESSIONAL_SERVICES and DATA_EXCHANGE listing,
 * whose reviewsV2 query carries a productType of proServ or junto and returns
 * nothing. That is a fact about AWS, not a gap in the record.
 *
 * CORRECTS THE SPEC, which says to null native_rating and external_rating
 * because AWS publishes "one blended average plus a count split". It publishes
 * separate scores: ProviderSummaries[AWSMP].AverageRating is the native one and
 * SyndicatedReviews[provider].AverageCustomerRating is the external one.
 * Whether the native score can differ from the blended average is unverified,
 * because every value in the sample corpus was zero.
 */
function readReviews(reviews) {
  if (!reviews) return null;
  const native = arr(reviews.ProviderSummaries).find((p) => p?.ProviderName === "AWSMP") ?? null;
  // Read the syndication providers generically. G2 is the only key seen, and
  // the UI translation table names PeerSpot too, so more should be expected.
  // A provider with no reviews is not a source: its ExternalUrl reads "N/A".
  const syndicated = Object.entries(reviews.SyndicatedReviews ?? {})
    .map(([source, s]) => ({
      source,
      rating: s?.AverageCustomerRating ?? null,
      count: s?.TotalReviews ?? 0,
    }))
    .filter((s) => s.count > 0);

  return {
    rating: reviews.AverageCustomerRating ?? null,
    count: reviews.TotalReviews ?? 0,
    native_rating: native?.AverageRating ?? null,
    native_count: native?.Count ?? null,
    reviews_url: text(native?.Url),
    external: syndicated[0] ?? null,
    external_total: reviews.ExternalReviewsCount ?? 0,
  };
}

// ---------------------------------------------------------------- parse ----

/**
 * One product page to one outcome.
 *
 * The outcome vocabulary is the ledger's, and the split between terminal and
 * retryable is the whole point of it:
 *
 *   kept              in category, record follows                     TERMINAL
 *   out_of_category   read the categories, predicate said no          TERMINAL
 *   gone              200 with the default pageId, AWS has no listing TERMINAL
 *   identity_mismatch the page states a different product             TERMINAL
 *   unreadable        no blob, unparseable blob, or a real product
 *                     page missing Detail, overview or categories     RETRYABLE
 *
 * The last line matters more than it looks. A real page whose Detail query is
 * absent is a template change or a partial hydration, and recording it as out
 * of category would permanently exclude a real listing on the strength of a
 * parse failure. That is exactly the class of error this registry exists to
 * avoid, so it is retryable and counted separately.
 */
export function parseProductPage({ id, html, url = null }) {
  const ctx = extractPageContext(html);
  if (!ctx) return { outcome: "unreadable", reason: "no vike_pageContext in response" };
  if (isMissingListing(ctx)) return { outcome: "gone", reason: "AWS serves no listing for this id" };

  const detail = listingQuery(ctx, "Detail");
  if (!detail) return { outcome: "unreadable", reason: "no Detail query in the page context" };

  /**
   * The identity guard.
   *
   * data.id is what the listing service returned for the record it served, and
   * it is the analogue of the Microsoft "ID" row at microsoft.mjs:365. Compare
   * against the id from ids.jsonl, never against anything derived from the URL
   * the request landed on.
   *
   * Three other places carry the id and NONE of them is a guard, because all
   * three are router-derived and would agree with a redirect rather than detect
   * it: routeParams.listingId, urlPathname, and the Detail queryKey. Do not
   * "simplify" this onto one of them.
   */
  const statedId = text(detail.id);
  if (statedId && statedId !== id) {
    return { outcome: "identity_mismatch", reason: `page states ${statedId}`, stated_id: statedId };
  }

  const overview = detail.listingDetail?.overview;
  if (!overview) {
    return { outcome: "unreadable", reason: "Detail query carries no listingDetail.overview" };
  }
  if (!Array.isArray(overview.categories)) {
    return { outcome: "unreadable", reason: "overview states no categories" };
  }

  const categories = overview.categories;
  if (!inCategory(categories)) {
    return { outcome: "out_of_category", categories: categories.map((c) => c?.categoryName) };
  }

  const usage = listingQuery(ctx, "Usage");
  const pricing = listingQuery(ctx, "Pricing");
  const { plans, omitted } = readPlans(pricing);
  const options = fulfillmentOptions(usage);
  const dates = options.map((o) => o.creation_date).filter(Boolean).sort();

  const terms = arr(pricing?.summary?.terms);
  const legalTerm = terms.find((t) => t?.termType === "LegalTerm");
  const supportTerm = terms.find((t) => t?.termType === "SupportTerm");

  return {
    outcome: "kept",
    record: {
      id,
      url: PRODUCT_URL(id),
      // Recorded so provenance points at the page that answered rather than at
      // the address requested, which is fetchText's stated reason for returning
      // res.url at marketplace.mjs:88-92.
      fetched_url: url,
      predicate_version: PREDICATE_VERSION,

      name: text(overview.listingName),
      publisher: text(overview.creator?.creatorName),
      tagline: text(overview.shortDescription),
      // Verbatim, in blob order. CATEGORY_LABEL is NOT added: AWS does not list
      // the parent on the product, so adding it would put our words in a field
      // that holds the publisher's.
      categories: categories.map((c) => text(c?.categoryName)).filter(Boolean),
      category_ids: categories.map((c) => ({
        name: text(c?.categoryName),
        id: text(c?.categoryId),
        parent_id: text(c?.parentCategoryId),
      })),
      long_description: text(overview.longDescription),
      // The publisher's own Highlights bullets. Kept OUT of overview_text so
      // that column stays longDescription verbatim and nothing in it is ours.
      highlights: arr(overview.highlights).map(text).filter(Boolean),

      logo_url: text(overview.listingThumbnailUrl),
      // AWS has no screenshot gallery. It does publish promotional images on a
      // small minority of listings, which slightly corrects the spec's "one
      // logo and optional videos". Filter on the type rather than assuming, as
      // __typename implies a video variant exists.
      media_image_urls: arr(overview.embeddedMedia)
        .filter((m) => m?.embeddedMediaType === "IMAGE")
        .map((m) => text(m?.embeddedMediaAssetUrl))
        .filter(Boolean),

      fulfillment_options: options,
      created_max: dates.length ? dates[dates.length - 1] : null,
      created_min: dates.length ? dates[0] : null,

      support: supportLines(detail),
      product_links: [
        ...linksFrom(overview.overviewResources),
        ...linksFrom(usage?.listingDetail?.usage?.usageResources),
        ...linksFrom(detail.listingDetail?.support?.supportResources),
      ],
      legal_documents: arr(legalTerm?.documents).map((d) => ({
        type: text(d?.type),
        url: text(d?.url),
      })),
      // Prose, not a link, so it does not belong in legal_links. AWS publishes
      // no privacy policy URL and no refund policy URL at all.
      refund_policy: text(supportTerm?.refundPolicy),

      plans,
      plans_omitted: omitted,
      // False on Professional Services pages, whose Pricing query returns an
      // empty payload with no summary key: AWS publishes no price for an
      // engagement, which is different from a price we failed to read.
      pricing_published: Boolean(pricing?.summary),

      reviews: readReviews(reviewsQuery(ctx)),

      /**
       * The blob's only Vendor Insights hook, and it is null on every page
       * sampled. The PATH exists on all of them, so null is AWS saying "no
       * security profile" rather than a field we failed to find. Roughly 0.7
       * percent of the marketplace has a profile, so zero observations in 95
       * pages proves nothing about the populated shape. Carried through
       * untouched so the day a profiled listing is harvested the shape is
       * discovered rather than silently dropped.
       */
      vendor_insight: overview.vendorInsight ?? null,

      identifiers: {
        // The strongest candidate for collapsing listing variants: several
        // prodview ids can share one prod- id.
        product_id: text(overview.associatedEntities?.[0]?.product?.productId),
        creator_id: text(overview.creator?.creatorId),
        offer_id: text(pricing?.summary?.offerId),
        stated_id: statedId,
        // NOT AVAILABLE, and the spec must be corrected: CanonicalListingReference
        // does not occur anywhere in the page context, and
        // ProductAttributes.BaseProductId exists only inside
        // recommendations.discoRecommendations, describing OTHER products.
        // Reading it would file a neighbouring product's identity under this
        // listing. product_id is the substitution, and the substitution is ours.
        canonical_listing_reference: null,
      },
    },
  };
}

// --------------------------------------------------------------- payload ----

/**
 * cert_detail, all eight keys null, for AWS and for every AWS listing.
 *
 * This is not a gap. overview.vendorInsight is null on every page, badges are
 * empty on every page, and the seven badge values that do exist elsewhere in
 * the blob (DEPLOYED_ON_AWS, STANDARD_CONTRACT, AWS_SPECIALIZATIONS, FREE_TIER,
 * STANDARD_DATA_AGREEMENT, FREE_TRIAL, BRING_YOUR_OWN_LICENSE) are commercial,
 * not security credentials. "Vendor Insights", "noSecurityProfile" and "FTR"
 * appear only in the UI translation table, which is exactly how a naive string
 * search invents a field.
 *
 * graph_permissions in particular stays empty: one element of any content
 * writes a verified "Microsoft Graph" evidence row and lights tools and MCP.
 */
function certDetail(record) {
  const vi = record.vendor_insight;
  return {
    hosting: null,
    data_location: null,
    data_handling: null,
    graph_permissions: [],
    // Populated only if AWS ever serves a profile here. Nothing in 95 pages
    // did, so this branch is unexercised and deliberately narrow.
    compliance: arr(vi?.securityCertifications).map(text).filter(Boolean),
    developer_last_updated: null,
    page_last_updated: null,
    full_text: null,
  };
}

/**
 * The publisher's support channels as one block of text.
 *
 * `support` is a single text column and lights the `support channel` layer
 * merely by being non-null, so what goes in it should be the publisher's own
 * words rather than a marker. Names are kept where AWS gives one; every TEXT
 * entry has a null name, so there the value stands alone.
 *
 * Deliberately NOT run through htmlToText, unlike the Microsoft description.
 * AWS's support text is markdown, not HTML, and that converter deletes anything
 * between angle brackets. A publisher writing a mail address as the ordinary
 * markdown autolink would have it silently removed.
 */
function supportText(lines) {
  const out = arr(lines)
    .map((l) => (l.name ? `${l.name}: ${l.value}` : l.value))
    .filter(Boolean);
  return out.length ? out.join("\n") : null;
}

export function toPayload({ record, capturedAt }) {
  const options = arr(record.fulfillment_options);
  const latest = options[0] ?? null;

  const missing = [];
  if (!record.pricing_published) {
    missing.push("price: AWS publishes no pricing for this listing");
  }
  for (const o of arr(record.plans_omitted)) {
    missing.push(
      `plans: ${o.term_type} publishes ${o.rate_cards} rate cards, above the ` +
        `${PLAN_RATE_CARD_LIMIT} stored per term, so none of them are stored`
    );
  }

  const reviews = record.reviews;

  return {
    capture_meta: {
      template_version: "3.2-aws",
      marketplace_id: ID,
      source_product_id: record.id,
      listing_url: PRODUCT_URL(record.id),
      captured_at_utc: capturedAt,
      // A professional services listing with no price is not a failed capture.
      // It is a complete capture of everything AWS publishes, and `missing`
      // says which of the registry's fields AWS leaves unstated.
      capture_complete: missing.length === 0,
      missing,
      // The address aws-catalog actually read. NOT a /marketplace/search URL,
      // which robots.txt disallows, and not the category page, which renders
      // client side and carries no ids.
      source_view_url: SITEMAP_URL,
      source_view_filters:
        `category=${CATEGORY} (${CATEGORY_LABEL}), matched on categoryId or ` +
        `parentCategoryId, predicate ${PREDICATE_VERSION}`,
    },
    extract: {
      extract_spec_version: "v3-aws",
      name: record.name,
      publisher: record.publisher,
      // A paragraph, not a one-line tagline: AWS's shortDescription runs to a
      // median of 235 characters. It is the publisher's own prose, so it is
      // stored whole and the card truncates.
      tagline: record.tagline,
      // Empty, and permanently so on the evidence available. The rendered
      // "Supported services" row has NO data node anywhere in the page context:
      // the string exists only as a UI label, and overview.solution and
      // overview.integrationGuide, the two candidate holders, are null on every
      // page. Consequence to know: registry_delivery() reads surfaces first, so
      // every AWS listing derives delivery "Unknown" until that function gains
      // an AWS branch. See docs/aws-source.md.
      surfaces: [],
      categories: arr(record.categories),
      // Empty on purpose. AWS's Industries branch children arrive in the SAME
      // categories array with no branch label, so "is this an industry" can
      // only be answered from a GUID table we build. That would be our
      // classification, not AWS's statement, and it is not worth asserting for
      // a first pass.
      industries: [],
      // Empty, same evidence as surfaces: "Integration protocol" exists only as
      // a UI label. This one matters more than it looks, because works_with
      // lights the `integrations` layer with no evidence row behind it
      // (20260819100300_asset_layer_write_path.sql:214-215). Leaving it empty
      // is both the honest reading and the safe direction.
      works_with: [],
      // AWS publishes no display-price string anywhere. Every price is a raw
      // decimal on a rate card, so plans carries the real data and
      // registry_price() lights the pricing layer from plan_count alone.
      pricing: null,
      acquire_using:
        [...new Set(options.map((o) => o.type_name).filter(Boolean))].join(", ") || null,
      version: latest?.version ?? null,
      updated: UPDATED_FROM_FULFILLMENT_CREATION_DATE
        ? (record.created_max ? record.created_max.slice(0, 10) : null)
        : null,
      // longDescription verbatim, capped as Microsoft caps it. It is markdown.
      // The cap has never bitten: the longest seen is 4,495 characters.
      overview_text: record.long_description ? record.long_description.slice(0, 6000) : null,
      support: supportText(record.support),
      rating: reviews?.rating ?? null,
      rating_count: reviews?.count ?? 0,
      native_rating: reviews?.native_rating ?? null,
      native_count: reviews?.native_count ?? null,
      external_source: reviews?.external?.source ?? null,
      external_rating: reviews?.external?.rating ?? null,
      external_count: reviews?.external?.count ?? null,
      /**
       * Always "none", and this one is load-bearing. AWS publishes no
       * certification page and nothing in the blob supports another value.
       * 'publisher_attestation' would falsely light the `permission scope`
       * layer (write path :218), asserting a permission review AWS never
       * performed.
       */
      certification: "none",
      // The listing page. There is no certification page to point at, and this
      // value reaches no layer either way.
      cert_url: PRODUCT_URL(record.id),
      cert_detail: certDetail(record),
      plans: arr(record.plans),
      product_links: [
        ...arr(record.product_links).filter((l) => l.url),
        ...(reviews?.reviews_url ? [{ label: "Customer reviews", url: reviews.reviews_url }] : []),
      ],
      // type is AWS's own word, StandardEula or CustomEula. There is no privacy
      // policy and no refund policy URL to add beside it.
      legal_links: arr(record.legal_documents)
        .filter((d) => d.url)
        .map((d) => ({ label: d.type, url: d.url })),
      logo_url: record.logo_url ?? null,
      // AWS has no screenshot gallery. Promotional images are a different thing
      // and go to media_image_urls, which is the column for them.
      screenshot_urls: [],
      media_image_urls: arr(record.media_image_urls),
      /**
       * Every key empty, as DRAI does and for a stronger reason.
       *
       * The gate verifies each stated value verbatim against hay_listing (name,
       * tagline, overview_text, works_with) or hay_cert. AWS has no
       * supported-languages field, so Microsoft's one populated key has no
       * counterpart, and it publishes no integration or protocol taxonomy at
       * all on an ordinary listing, so the two chips the spec declined do not
       * even exist to be tempted by.
       */
      stated: {
        models: [], frameworks: [], tools_mcp: [],
        data_sources: [], integrations: [], deployment: [], languages: [],
      },
    },
    reviews_summary: reviews
      ? { available: true, rating: reviews.rating, count: reviews.count }
      : { available: false, note: "AWS returns no reviews for this listing type" },
    raw: { record },
    // The ingest_source enum is dual_write | backfill | reconcile. An invented
    // label is a 400 that fails every capture in the run, not a loose string
    // that flows through.
    ingest_source: "dual_write",
  };
}
