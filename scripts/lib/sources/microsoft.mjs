/**
 * Microsoft Marketplace source adapter.
 *
 * Everything here was lifted verbatim out of lib/marketplace.mjs when the
 * harvester gained a second source. Nothing about the behaviour changed: this
 * is the code that captured 6,820 assets, moved rather than rewritten, so the
 * working path carries no risk from the split.
 *
 * What makes a source adapter: the URLs it reads, how it turns a page into a
 * capture payload, and which pipeline stages it has. What stays shared in
 * lib/marketplace.mjs is everything that is true of any source — fetching with
 * backoff, bounded concurrency, jsonl, and the Supabase calls.
 */
import { htmlToText } from "../marketplace.mjs";

export const ID = "microsoft";
export const ORIGIN = "https://marketplace.microsoft.com";
export const CATEGORY = "ai-apps-and-agents";
export const PAGE_URL = (p) =>
  `${ORIGIN}/en-us/search/products?category=${CATEGORY}&page=${p}`;
export const PRODUCT_URL = (id) =>
  `${ORIGIN}/en-us/product/${encodeURIComponent(id)}`;

// -------------------------------------------------------------- mapping ----

const CERT_MAP = {
  MicrosoftCertified: "microsoft_365_certified",
  SelfAttested: "publisher_attestation",
  None: "none",
};

const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
const names = (v) => arr(v).map((x) => (typeof x === "string" ? x : x?.Title || x?.name)).filter(Boolean);

/**
 * Build the ingest_capture payload from a tile, optional detail block, and
 * optional plans.
 *
 * The `stated` evidence block is deliberately left EMPTY. The database verifies
 * every stated value verbatim against the capture's own text, and structured
 * marketplace fields are not the publisher's prose — asserting "integrates with
 * Teams" because a taxonomy field says so is exactly the inference the registry
 * refuses. Only LanguagesSupported maps across, because it is an explicit
 * enumeration rather than a claim about the build.
 */
export function toPayload({ tile, detail, plans, capturedAt }) {
  const info = detail?.info || {};
  const core = detail?.core || {};
  const id = tile.entityId;
  const overview = htmlToText(info.Description || "");

  const productLinks = [];
  if (info.HelpLink) productLinks.push({ label: "Help", url: info.HelpLink });
  if (info.SupportLink) productLinks.push({ label: "Support", url: info.SupportLink });

  const legalLinks = [];
  if (info.PrivacyPolicyUrl) legalLinks.push({ label: "Privacy Policy", url: info.PrivacyPolicyUrl });
  if (tile.licenseTermsUrl) legalLinks.push({ label: "License Terms", url: tile.licenseTermsUrl });

  return {
    capture_meta: {
      template_version: "3.0-embedded-state",
      marketplace_id: "microsoft",
      source_product_id: id,
      listing_url: PRODUCT_URL(id),
      captured_at_utc: capturedAt,
      capture_complete: !!detail,
      missing: detail ? [] : ["product detail page not fetched"],
      source_view_url: `${ORIGIN}/en-us/search/products?category=${CATEGORY}`,
    },
    extract: {
      extract_spec_version: "v3",
      name: tile.title,
      publisher: tile.publisher,
      tagline: tile.shortDescription || null,
      surfaces: names(core.products || tile.products) ,
      categories: names(tile.categoriesDetails),
      industries: names(tile.industriesDetails),
      works_with: names(info.WorksWith),
      pricing: tile.startingPrice?.pricingData?.displayPrice || null,
      acquire_using: tile.actionString || null,
      version: info.AppVersion || null,
      updated: info.ReleaseDate ? String(info.ReleaseDate).slice(0, 10) : null,
      overview_text: overview.slice(0, 6000),
      support: info.SupportLink ? "Support" : null,
      rating: tile.AverageRating || null,
      rating_count: tile.NumberOfRatings || 0,
      native_rating: tile.AverageRating || null,
      native_count: tile.NumberOfRatings || 0,
      external_source: null,
      external_rating: null,
      external_count: null,
      certification: CERT_MAP[tile.CertificationState] || "none",
      cert_url: tile.CertificationLink || null,
      cert_detail: {
        hosting: null, data_location: null, data_handling: null,
        graph_permissions: [], compliance: [],
        developer_last_updated: null, page_last_updated: null, full_text: null,
      },
      plans: plans || [],
      product_links: productLinks,
      legal_links: legalLinks,
      logo_url: info.LargeIconUri || tile.iconURL || null,
      screenshot_urls: arr(info.Images).map((i) => i?.Uri || i).filter((x) => typeof x === "string"),
      media_image_urls: [],
      stated: {
        models: [], frameworks: [], tools_mcp: [], data_sources: [],
        integrations: [], deployment: [],
        languages: names(info.LanguagesSupported),
      },
    },
    raw: { tile, detail: detail || null },
    ingest_source: "dual_write",
  };
}

