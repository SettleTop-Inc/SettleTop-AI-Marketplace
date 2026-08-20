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
 * The cert_detail block, from a certification record or from nothing.
 *
 * Nothing is the common case: 6,636 of 6,855 products have no certification
 * page at all, and for those every field stays null and every list stays empty,
 * exactly as before this pass existed. Absence of a page is not a value.
 *
 * The seven keys are the contract in docs/capture-integration.md, plus
 * full_text. Only hosting, data_location and graph_permissions move a layer;
 * data_handling and compliance exist to be read verbatim by the evidence gate
 * and to be shown as the publisher wrote them.
 */
function certDetail(cert) {
  return {
    hosting: cert?.hosting ?? null,
    data_location: cert?.data_location ?? null,
    data_handling: cert?.data_handling ?? null,
    graph_permissions: cert?.graph_permissions ?? [],
    compliance: cert?.compliance ?? [],
    developer_last_updated: cert?.developer_last_updated ?? null,
    page_last_updated: cert?.page_last_updated ?? null,
    full_text: cert?.full_text ?? null,
  };
}

/**
 * Build the ingest_capture payload from a tile, optional detail block, optional
 * plans, and the optional certification record.
 *
 * The `stated` evidence block is deliberately left EMPTY. The database verifies
 * every stated value verbatim against the capture's own text, and structured
 * marketplace fields are not the publisher's prose — asserting "integrates with
 * Teams" because a taxonomy field says so is exactly the inference the registry
 * refuses. Only LanguagesSupported maps across, because it is an explicit
 * enumeration rather than a claim about the build.
 */
export function toPayload({ tile, detail, plans, cert = null, capturedAt }) {
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
      cert_detail: certDetail(cert),
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
    // The certification record joins raw only when there is one. capture.raw is
    // written from payload.raw and nothing else, so this is the only way the
    // page text survives the write: cert_detail.full_text is read by no column
    // and no haystack. A product without a certification page keeps the payload
    // it has always had, key for key.
    raw: { tile, detail: detail || null, ...(cert ? { cert } : {}) },
    ingest_source: "dual_write",
  };
}


// -------------------------------------------------------- certification ----

/**
 * The Microsoft 365 app certification page.
 *
 * Every certified or self-attested product carries a CertificationLink to
 * docs.microsoft.com/.../forward/<id>, which redirects twice to a Learn page
 * under /microsoft-365-app-certification/{saas|teams}/<publisher-slug>. The
 * slug is not derivable from the product id, so the stored link is the only
 * way in, and the resolved URL is what provenance should point at.
 *
 * The page is one questionnaire the publisher filled in, rendered as six
 * sibling <div class="zone has-pivot" data-pivot="NAME"> blocks, each holding
 * one two-column Information/Response table. Microsoft-certified pages append a
 * seventh zone holding the audit result. That is the ONLY structural difference
 * between the two tiers, so one parser reads all 219 pages.
 *
 * Everything below transcribes. It never summarises, never normalises a value,
 * and never fills a field the page left blank: an app that does not answer the
 * geographic storage question has no residency claim, and inventing one from
 * its headquarters or its cloud provider would be exactly the inference this
 * registry exists to refuse.
 */

/** The six zones every page has. A page missing one is not a page we can read. */
const CERT_ZONES = ["general", "data", "security", "compliance", "privsection", "zerotrust"];

/**
 * Question text, verbatim, including Microsoft's own typos. "infastructure" is
 * theirs. Matching a corrected spelling silently finds nothing, and a parser
 * that silently finds nothing looks exactly like a product that disclosed
 * nothing.
 */
const Q_HOSTING = "What is the hosting environment or service model used to run your app?";
const Q_PROVIDERS = "Which hosting cloud providers does the app use?";
const Q_GEOGRAPHY =
  "If underlying infastructure processes or stores Microsoft customer data, where is this data geographically stored?";

const NO_GRAPH = "This application does not use Microsoft Graph.";
const ZONE_RE = /<div class="zone has-pivot" data-pivot="([^"]+)"[^>]*>/g;

/**
 * Cell text.
 *
 * htmlToText is the shared converter and is right for a cell, which holds only
 * text, <a> and <strong>. It is NOT run over a whole table: it emits no
 * separator for </td>, so a two-column row would collapse into
 * "questionanswer" with nothing between them. Whitespace is then flattened
 * because three question strings on these pages carry stray double spaces and
 * one is missing a space altogether, and a raw comparison misses all of them.
 *
 * Case is left alone. The evidence gate is a case-sensitive substring test and
 * the page writes "Aws" and "Saas"; normalising here would break verification
 * with no visible symptom.
 */
const cellText = (html) => htmlToText(html).replace(/\s+/g, " ").trim();

/**
 * Split the article into its zone blocks. The zone divs are siblings, so the
 * next marker is the end of the current block and no depth tracking applies.
 */
function certZones(html) {
  const body = html.split('<div id="ms--additional-resources-mobile"')[0];
  const marks = [...body.matchAll(ZONE_RE)];
  const zones = new Map();
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    if (!zones.has(m[1])) zones.set(m[1], body.slice(m.index, end));
  });
  return zones;
}

const tablesIn = (zone) => zone.match(/<table[\s\S]*?<\/table>/g) || [];

/**
 * Rows of raw cell HTML. Raw, because the certification table encodes its
 * hierarchy as leading &nbsp; entities, which decoding would erase.
 */
const rowsOf = (table) =>
  [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, r]) =>
    [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, c]) => c)
  );

/**
 * The Information/Response table of a zone, as question to answer.
 *
 * A present question with a blank answer is dropped rather than stored as "".
 * 49 such cells exist across the corpus; an empty string would create a field
 * backed by nothing.
 */
function qaTable(zone) {
  for (const table of tablesIn(zone)) {
    const rows = rowsOf(table).map((cells) => cells.map(cellText));
    if (rows[0]?.[0] !== "Information" || rows[0]?.[1] !== "Response") continue;
    const qa = new Map();
    for (const [q, a] of rows.slice(1)) {
      if (q && a && !qa.has(q)) qa.set(q, a);
    }
    return qa;
  }
  return null;
}

const qaLines = (qa) => [...qa].map(([q, a]) => `${q}: ${a}`);

/**
 * The Graph permission table, or null when the page has none.
 *
 * null and [] are different answers and the difference matters: a single
 * element of any content writes a verified "Microsoft Graph" evidence row and
 * lights the tools layer. Only column 0 of a table whose header says
 * "Graph Permission" is ever allowed to become one.
 */
function graphRows(zone) {
  for (const table of tablesIn(zone)) {
    const rows = rowsOf(table).map((cells) => cells.map(cellText));
    if (rows[0]?.[0] !== "Graph Permission") continue;
    return rows.slice(1).filter((r) => r[0]);
  }
  return null;
}

/**
 * Microsoft's own audit result, on certified pages only.
 *
 * This is Microsoft's scope of assessment, not a publisher claim, so it stays
 * out of `compliance`, where every element is published as a certification the
 * product holds. "In Scope" is not a certification, and "PASS" is Microsoft's
 * word rather than the publisher's.
 */
function certResults(zone) {
  if (!zone) return null;
  for (const table of tablesIn(zone)) {
    const rows = rowsOf(table);
    if (cellText(rows[0]?.[0] ?? "") !== "Control") continue;
    return rows
      .slice(1)
      .map((cells) => ({
        control: cellText(cells[0] ?? ""),
        result: cellText(cells[1] ?? ""),
        // Sub-controls are indented with five &nbsp; entities and section rows
        // are not. Read off the raw cell: after decoding, both start with
        // whitespace and the distinction is gone.
        level: /^\s*&nbsp;/.test(cells[0] ?? "") ? "control" : "section",
      }))
      .filter((r) => r.control && r.result);
  }
  return null;
}

const MONTHS = {
  January: "01", February: "02", March: "03", April: "04", May: "05", June: "06",
  July: "07", August: "08", September: "09", October: "10", November: "11", December: "12",
};

/**
 * "August 28, 2025" to "2025-08-28". A month table rather than Date parsing, so
 * the result cannot shift with the machine's locale or timezone.
 */
function developerDate(html) {
  const m = html.match(/Last updated by the developer on:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  const month = m && MONTHS[m[1]];
  return month ? `${m[3]}-${month}-${m[2].padStart(2, "0")}` : null;
}

/**
 * The Learn footer date. Note what this is: the element carries
 * data-article-date-source="calculated", so it is the docs build date, not
 * something the publisher stated. Unrelated pages share it after a bulk
 * rebuild. It is on the page, so it is storable, but it is not a claim.
 *
 * The page's <meta> dates disagree with the rendered value on some pages, so
 * the rendered element is the one read.
 */
function pageDate(html) {
  const tag = html.match(/<local-time[^>]*data-article-date-source[^>]*>/)?.[0];
  return tag?.match(/datetime="(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

/**
 * Parse one certification page into the record stored in certifications.jsonl.
 *
 * Returns `{ ok: false, reason }` for anything that is not a readable
 * certification page. That distinction is load-bearing: a rejected page is
 * reported and retried on the next run, while a page written with null fields
 * would be indistinguishable from a product that disclosed nothing.
 */
export function parseCertificationPage({ id, html, url }) {
  if (!/\/microsoft-365-app-certification\/(teams|saas)\//.test(url)) {
    // The programme's landing page answers 200 with no questionnaire on it.
    // Left undetected it becomes an all-null record that reads as a real
    // capture.
    return { ok: false, reason: `did not resolve to a certification page: ${url}` };
  }

  const zones = certZones(html);
  const missing = CERT_ZONES.filter((z) => !zones.has(z));
  if (missing.length) return { ok: false, reason: `missing zones: ${missing.join(", ")}` };

  const tables = Object.fromEntries(CERT_ZONES.map((z) => [z, qaTable(zones.get(z))]));
  const tableless = CERT_ZONES.filter((z) => !tables[z]);
  if (tableless.length) return { ok: false, reason: `no question table in: ${tableless.join(", ")}` };

  // Every page states its own product id. Checking it is what stops one
  // product's answers being filed under another when a redirect misbehaves.
  const statedId = tables.general.get("ID");
  if (statedId && statedId !== id) return { ok: false, reason: `page states ID ${statedId}` };

  const hosting = tables.general.get(Q_HOSTING) ?? null;
  if (!hosting) return { ok: false, reason: "no hosting answer" };

  // A page either lists Graph permissions or says it uses none. Both at once,
  // or neither, means the template changed and the safe reading of an empty
  // permission list is no longer available.
  const graph = graphRows(zones.get("zerotrust"));
  const saysNone = zones.get("zerotrust").includes(NO_GRAPH);
  if ((graph !== null) === saysNone) {
    return {
      ok: false,
      reason: graph
        ? "Graph table and the no-Graph sentence both present"
        : "no Graph table and no no-Graph sentence",
    };
  }

  /**
   * data_handling carries the page's own words, transcribed.
   *
   * It lights no layer. Its job is to be the haystack: hay_cert is built from
   * hosting, data_location, data_handling, graph_permissions and compliance,
   * and this is the only one of those large enough to hold the prose in which
   * a publisher names what its app touches. The cloud providers live here
   * rather than in `hosting` because `hosting` alone decides the public
   * delivery facet, by substring match, and a provider name has no business
   * influencing that.
   */
  const dataHandling =
    [
      [Q_HOSTING, Q_PROVIDERS]
        .filter((q) => tables.general.has(q))
        .map((q) => `${q}: ${tables.general.get(q)}`),
      qaLines(tables.data),
      qaLines(tables.privsection),
      graph ? graph.map(([permission, type, why]) => `${permission} (${type}): ${why ?? ""}`.trim()) : [],
    ]
      .filter((block) => block.length)
      .map((block) => block.join("\n"))
      .join("\n\n") || null;

  /**
   * compliance keeps the publisher's whole sentence, question and answer both.
   *
   * Each element is published as a certification the product holds. The page
   * never says "ISO 27001": it asks whether the app complies, and records Yes.
   * Distilling that to a label would turn a self-assessment into a credential.
   * Only Yes rows qualify: N/A is not a negative, and No is not a claim. On
   * roughly two fifths of these pages every answer is No or N/A, and an empty
   * array is then the correct reading.
   */
  const compliance = [...tables.compliance]
    .filter(([, answer]) => answer === "Yes")
    .map(([question, answer]) => `${question} ${answer}`);

  const fullText = [...zones]
    .map(([, zone]) => {
      const qa = qaTable(zone);
      const g = graphRows(zone);
      const results = certResults(zone);
      return [
        qa ? qaLines(qa).join("\n") : "",
        g ? g.map((r) => r.join(" | ")).join("\n") : "",
        results ? results.map((r) => `${r.control}: ${r.result}`).join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

  return {
    ok: true,
    record: {
      id,
      resolved_url: url,
      // What the page itself shows, recorded as an observation. The catalog's
      // CertificationState and this can disagree, in both directions.
      // Reconciling them is not this pass's job, and neither value is allowed
      // to overwrite the other.
      badge: /media\/certified\.png/.test(html)
        ? "certified"
        : /media\/attested\.png/.test(html)
          ? "attested"
          : null,
      certification_results: certResults(zones.get("certification")),
      hosting,
      data_location: tables.data.get(Q_GEOGRAPHY) ?? null,
      data_handling: dataHandling,
      graph_permissions: graph ? graph.map((r) => r[0]) : [],
      compliance,
      developer_last_updated: developerDate(html),
      page_last_updated: pageDate(html),
      full_text: fullText || null,
    },
  };
}
