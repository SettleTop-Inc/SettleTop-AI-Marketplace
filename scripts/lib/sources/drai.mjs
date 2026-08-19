/**
 * DRAI Agentic-AI Marketplace source adapter.
 *
 * Written from docs/drai-source.md, which records what was read off the live
 * site and — as importantly — which values are our classification rather than
 * DRAI's. Read that file before changing anything here; several plausible
 * values in the capture skill turned out to be constructions, and one is
 * contradicted by the site.
 *
 * DRAI spreads across pages what Microsoft puts on one. The catalog line lives
 * on /platform, the listing body lives in a launch post, and the certification
 * equivalent lives in a publisher-wide security statement. So a DRAI capture is
 * assembled from more than one page, which is why sections_full_text carries a
 * Platform block as well as an Announcement block.
 *
 * Plain fetch throughout. It is a Wix site that server-renders, so the markup
 * arrives complete. The wix-warmup-data blob exists but carries no page content
 * at all — only a contact-form definition — so markup parsing is the only path.
 */
import { htmlToText } from "../marketplace.mjs";

export const ID = "drai";
export const ORIGIN = "https://www.drai-commercial.com";
export const PLATFORM_URL = `${ORIGIN}/platform`;
export const PRESS_URL = `${ORIGIN}/press-room`;
export const PUBLISHER = "Data Room AI (DRAI)";
export const SUPPORT_EMAIL = "corey@product-ties.com";

/**
 * The DRAI site mark, used for every DRAI asset.
 *
 * DRAI publishes no per-agent artwork, so there is nothing per-agent to find.
 * This is the icon the site itself declares — the same image behind its
 * favicon, apple-touch-icon and mask-icon — taken untransformed rather than
 * through one of the Wix resize URLs, because those serve a 192px crop and the
 * source is 174KB at full resolution. Archiving the crop would mean holding a
 * worse copy than the publisher offers.
 *
 * capture_meta.logo_is_publisher_mark is set alongside it so nobody later reads
 * twenty-three identical images as per-agent branding.
 */
export const PUBLISHER_MARK =
  "https://static.wixstatic.com/media/998621_324d126c6a864d4cb77d872e484b12a6~mv2.png";

/** The launch post for the platform itself. It is linked from the GovCon
 *  module tagline, so it looks like an agent link and is not one. */
export const WORKSPACE_POST =
  `${ORIGIN}/post/data-room-ai-launches-secure-workspace-and-agentic-ai-marketplace`;
export const WORKSPACE_SLUG = "drai-secure-workspace";

export const DOCS = {
  security_compliance: `${ORIGIN}/security-compliance`,
  privacy_policy: `${ORIGIN}/privacy-policy`,
  ai_ethics: `${ORIGIN}/ai-ethics`,
  terms_of_service: `${ORIGIN}/terms-of-service`,
};

/**
 * Module headings, matched as literal strings rather than by tag.
 *
 * The GovCon heading is a styled <p>, not an <h3> — selecting modules with
 * h1..h6 silently drops the largest module and 12 of 34 agents. The trailing
 * period on "GovCon Growth." is the publisher's, kept because the module name
 * we store should be what the page says.
 */
export const MODULES = ["GovCon Growth.", "Financial", "Gov Acquisition"];

/** Marketplace-level classification, ours rather than DRAI's. Never evidence. */
const INDUSTRY_BY_MODULE = {
  "GovCon Growth.": ["Government"],
  "Gov Acquisition": ["Government"],
  Financial: ["Financial Services"],
};

// ------------------------------------------------------------------ text ----

const decode = (s) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));

const strip = (html) => decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** Drop the parts of a page that are not the page: scripts, styles, and Wix chrome. */
const contentHtml = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");

/**
 * Split "Name Agent - description" into its two halves.
 *
 * The separator is NOT consistent: four forms appear on the one page — a
 * hyphen-minus followed by a non-breaking space, an en dash, an em dash, and a
 * doubled ASCII hyphen. Splitting on any single character silently mangles
 * three quarters of the rows, so this matches a run of dash characters with
 * whitespace (including NBSP) either side.
 */
const SEPARATOR = /[\s ]+[-‐-―]{1,2}[\s ]+/;

export function splitNameAndDescription(line) {
  const m = line.match(SEPARATOR);
  if (!m) return { name: line.trim(), description: null };
  return {
    name: line.slice(0, m.index).trim(),
    description: line.slice(m.index + m[0].length).trim(),
  };
}

/**
 * Our slug, derived from the display name.
 *
 * DRAI publishes no product ids, so unlike every other source this identifier
 * is ours. It is derived from the display name and never from the post URL:
 * post slugs are announcement-shaped, carry launch verbs that differ per agent,
 * and change if DRAI reposts.
 */
export function slugFor(displayName) {
  return displayName
    .replace(/\s*\(aka[^)]*\)/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function akaFor(displayName) {
  const m = displayName.match(/\(aka\s*([^)]+)\)/i);
  return m ? [m[1].trim()] : [];
}

// --------------------------------------------------------------- platform ----

/**
 * Every agent named on the platform page, in page order.
 *
 * Walks the raw markup rather than a DOM because there is no DOM here. Each
 * agent is one <li>, whose first bold span carries the display name — later
 * bold spans in the same row belong to the description (Defense TechScout Agent
 * bolds "Pre-seed", "Seed" and "Series A+"), so only the first is the name.
 *
 * A <li> wraps a <p>; matching both double-counts every agent, so this matches
 * <li> only.
 */
export function parsePlatform(html) {
  const body = contentHtml(html);
  const found = [];

  // Module boundaries by literal heading string, in the order they appear.
  const bounds = MODULES.map((m) => ({ module: m, at: body.indexOf(m) }))
    .filter((b) => b.at >= 0)
    .sort((a, b) => a.at - b.at);

  for (const [i, b] of bounds.entries()) {
    const end = i + 1 < bounds.length ? bounds[i + 1].at : body.length;
    const section = body.slice(b.at, end);

    for (const li of section.match(/<li[^>]*>[\s\S]*?<\/li>/gi) ?? []) {
      const bold = li.match(/<span[^>]*font-weight:\s*bold[^>]*>([\s\S]*?)<\/span>/i);
      if (!bold) continue;

      const name = strip(bold[1]);
      if (!name || name.length < 3) continue;

      // The coming-soon row is a sentence, not an agent, and it carries both a
      // bold span and a link — so it parses as a perfectly plausible agent
      // called "And many more Solution Architect Specialty Agents Coming Soon".
      // Those names are handled as a verbatim watch list by parseComingSoon.
      if (/^And many more/i.test(name)) continue;

      const href = li.match(/href="([^"]*\/post\/[^"]*)"/i)?.[1] ?? null;
      // The module tagline links to the platform's own launch post. Treating
      // every /post/ link in a section as an agent invents a phantom.
      const postUrl = href && !href.includes(WORKSPACE_POST.split("/post/")[1]) ? href : null;

      const { description } = splitNameAndDescription(strip(li));
      found.push({
        slug: slugFor(name),
        name,
        module: b.module,
        description,
        post_url: postUrl,
        status: postUrl ? "posted" : "named_only",
        also_known_as: akaFor(name),
      });
    }
  }

  // One agent listed under two modules is one asset carrying both module names.
  // Trusted Advisor Agent is printed under GovCon and Financial with the same
  // post URL and different description text.
  const bySlug = new Map();
  for (const a of found) {
    const prev = bySlug.get(a.slug);
    if (!prev) bySlug.set(a.slug, { ...a, modules: [a.module] });
    else {
      if (!prev.modules.includes(a.module)) prev.modules.push(a.module);
      prev.post_url ??= a.post_url;
      if (prev.post_url) prev.status = "posted";
    }
  }
  return [...bySlug.values()].map(({ module, ...a }) => a);
}

/**
 * Agents named only inside a "coming soon" sentence.
 *
 * These are NOT assets and must not become registry rows. DRAI says in its own
 * words that they are "Coming Soon" and "to come", and they carry no
 * description — registering them would advertise an offering the publisher has
 * not made. They are enumerated anyway so that the day one gets a catalog row
 * or a post, it lands as a change rather than as a brand-new discovery.
 *
 * Distinct from the name-only agents above, which DO have a catalog row and a
 * description and are presented as part of the module today.
 */
const SOON = /And many more[\s\S]{0,240}?(?=Financial\b|Gov Acquisition\b|DRAI Acquisition\b|$)/gi;

export function parseComingSoon(html) {
  const text = decode(contentHtml(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  // Stored as the publisher's sentence, not split into names.
  //
  // Splitting was tried and is not safe here: these sentences have no reliable
  // terminator, so a name-splitter ran past the list into the next module's
  // tagline and produced "Private Equity", "Mergers" and "Decision Enhancement
  // Engine" as agents, while missing the four that were really there. A watch
  // list whose only job is to notice change does not need names parsed out of
  // prose — it needs the prose, unaltered, so a future edit is detectable.
  return [...text.matchAll(SOON)].map((m) => ({
    sentence: m[0].trim(),
    status: "announced",
  }));
}

/** Post URLs discoverable on the press room, including ones /platform omits. */
export function parsePressRoom(html) {
  const urls = new Set();
  for (const m of contentHtml(html).matchAll(/href="([^"]*\/post\/[^"?#]*)/gi)) {
    urls.add(m[1].startsWith("http") ? m[1] : ORIGIN + m[1]);
  }
  return [...urls];
}

// ------------------------------------------------------------------- post ----

/**
 * The article body, without the furniture around it.
 *
 * The "Recent Posts" sidebar sits INSIDE the article markup, so a naive text
 * extraction pulls unrelated post titles into overview_text — and it is what
 * produced a false tier match during research. Everything from that marker on
 * is dropped, along with the byline, read-time, Media Contact and About blocks
 * the capture rules exclude.
 */
const POST_TAIL = /Recent Posts|Media Contact|About Data Room AI/i;

export function parsePost(html) {
  const body = contentHtml(html);
  const article = body.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? body;
  let text = htmlToText(article.replace(/<[^>]*>/g, (t) => t));

  const cut = text.search(POST_TAIL);
  if (cut > 0) text = text.slice(0, cut);

  const updated =
    html.match(/Updated:\s*([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})/)?.[1] ??
    html.match(/([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})/)?.[1] ??
    null;

  return {
    text: text.trim(),
    updated: updated ? isoDate(updated) : null,
    plans: plansStatedIn(text),
    images: [...new Set((article.match(/src="(https:\/\/static\.wixstatic\.com\/[^"]+)"/g) ?? [])
      .map((s) => s.slice(5, -1)))],
  };
}

function isoDate(s) {
  const d = new Date(s);
  return Number.isNaN(+d) ? null : d.toISOString().slice(0, 10);
}

/**
 * The subscription plans THIS listing publishes, parsed from its own text.
 *
 * A price only enters the registry from the listing that states it. That rule
 * is why this parses the published table rather than reading a tier number off
 * a post and looking its price up elsewhere: the two look alike and are not.
 *
 * DRAI states the table one row per line, in the Secure Workspace launch post:
 *
 *   Tier 0 – Essentials ($1,499/mo): Entry-level pipeline clarity with ...
 *
 * Agent posts name tiers too, but as bundles rather than as prices. Opp
 * Shredder's reads "can be deployed as a standalone agent or integrated into
 * Tier 1 (Pipeline Edge), Tier 2 (Growth Accelerator), and Tier 3
 * (Hyperscaler) capture intelligence suites" - the cost of a suite holding many
 * agents, next to a standalone option DRAI does not price at all. Charging that
 * range to the agent published a price DRAI never set for it. The shape of the
 * sentence is what separates the two: a dash and a parenthesised /mo figure is
 * a price, a parenthesised suite name is not.
 *
 * The dash class is written as escapes rather than literal characters. The en
 * dashes are the publisher's, and a regex in this file has been mangled by
 * shell escaping once already.
 */
const TIER_ROW =
  /\bTier\s*([0-3])\s*[-\u2010-\u2015]\s*([^(\n]+?)\s*\(\s*(\$[\d,]+(?:\.\d\d)?\s*\/\s*mo)\s*\)/g;

export function plansStatedIn(text) {
  const byTier = new Map();
  for (const [, n, name, price] of text.matchAll(TIER_ROW)) {
    byTier.set(Number(n), {
      name: `Tier ${n} – ${name.trim()}`,
      price: price.replace(/\s+/g, ""),
      unit: "subscription",
      billing: "monthly",
    });
  }
  return [...byTier.keys()].sort().map((n) => byTier.get(n));
}

// ------------------------------------------------------------------ cert ----

/**
 * The certification equivalent, from the publisher-wide security statement.
 *
 * `compliance` holds DRAI's full sentences, not distilled labels. The section
 * is headed "Compliance Roadmap" and opens "We're building toward higher
 * compliance"; a bare "CMMC Level 1" on a registry card reads as CERTIFIED,
 * while the source sentence says aligned with, including documented exceptions
 * and compensating controls. Storing the sentence keeps the publisher's hedge
 * attached to the claim, and satisfies the evidence gate, which compares
 * verbatim.
 *
 * Deliberately excluded from the array and left in full_text: the two roadmap
 * lines (CMMC Level 2, and the SOC 2 / HIPAA / ISO 27001 gap assessments), and
 * the Export Controls line, which is a customer obligation rather than a DRAI
 * posture.
 */
export function parseSecurityStatement(html) {
  const lines = decode(
    contentHtml(html)
      .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "​");

  const pick = (re) => lines.find((l) => re.test(l)) ?? null;

  // Slice by the statement's own numbered headings rather than by keyword.
  // Keyword anchors were tried and picked the wrong blocks: "Subprocessors"
  // appears inside the Definitions section, so data_handling captured a
  // glossary line instead of the sub-processor list — which is the ONLY place
  // DRAI names its model vendors, and therefore the only way a model can be
  // evidenced for this source at all.
  const heads = lines
    .map((l, i) => ({ i, m: l.match(/^(\d+)\.\s+(\S.*)$/) }))
    .filter((h) => h.m)
    .map((h) => ({ n: Number(h.m[1]), title: h.m[2], at: h.i }));

  const sectionByNumber = (n) => {
    const h = heads.find((x) => x.n === n);
    if (!h) return null;
    const next = heads.find((x) => x.at > h.at);
    return lines.slice(h.at, next ? next.at : lines.length).join("\n");
  };

  const hosting = sectionByNumber(2); // 2. Hosting & Data Residency
  const protection = sectionByNumber(3); // 3. Data Protection & Privacy
  const subProcessors = sectionByNumber(5); // 5. Sub-processors & Dependencies

  return {
    hosting,
    // The statement covers hosting and residency in one section, so the same
    // text answers both. Recording it twice is honest to how it is published;
    // inventing a separate residency claim would not be.
    data_location: hosting,
    data_handling: [protection, subProcessors].filter(Boolean).join("\n\n") || null,
    graph_permissions: [], // Microsoft Graph field. A value here writes a false evidence row.
    compliance: lines.filter((l) => /^CMMC Level 1:|^AI Security: Practices align/.test(l)),
    developer_last_updated: isoDate(pick(/^Effective:/)?.replace(/^Effective:\s*/, "") ?? ""),
    page_last_updated: isoDate(pick(/^Version 1\.0/)?.match(/\(([^)]+)\)/)?.[1] ?? ""),
    full_text: lines.join("\n"),
  };
}

// --------------------------------------------------------------- payload ----

export function toPayload({ agent, post, cert, capturedAt }) {
  const posted = agent.status === "posted" && post;
  // `?? []` covers a details.jsonl written by an older parser: no price is the
  // safe direction to fail in, and the detail pass re-reads such records anyway.
  const plans = posted ? post.plans ?? [] : [];
  const overview = posted ? post.text.slice(0, 6000) : null;

  const missing = [];
  if (!posted) missing.push("listing body: no launch post published");
  if (posted && !plans.length) missing.push("price: the listing publishes none");

  return {
    capture_meta: {
      template_version: "3.1-drai",
      marketplace_id: ID,
      source_product_id: agent.slug,
      listing_url: agent.post_url ?? PLATFORM_URL,
      captured_at_utc: capturedAt,
      // An agent named on the catalog with no listing body is not a failed
      // capture; it is a complete capture of everything DRAI publishes about
      // it. capture_complete false plus an explicit `missing` is how the record
      // says so itself, rather than a flag bolted alongside.
      capture_complete: Boolean(posted),
      missing,
      source_view_url: PLATFORM_URL,
      source_view_filters: agent.modules.map((m) => `module=${m}`).join(", ") || null,
      also_known_as: agent.also_known_as,
      logo_is_publisher_mark: true,
    },
    extract: {
      extract_spec_version: "v3-drai",
      name: agent.name,
      publisher: PUBLISHER,
      tagline: agent.description,
      // Ours, not DRAI's: the site publishes no surface, industry or delivery
      // taxonomy. Legitimate registry classification, never evidence.
      surfaces: ["SaaS", "DRAI Secure Workspace"],
      categories: agent.modules,
      industries: [...new Set(agent.modules.flatMap((m) => INDUSTRY_BY_MODULE[m] ?? []))],
      works_with: [],
      // Null unless the listing itself publishes a price, which for DRAI means
      // the Secure Workspace post and nothing else: DRAI prices the platform,
      // not the agents inside it.
      // A range, not every tier chained together: joining four prices with "to"
      // rendered as "$1,499/mo to $3,999/mo to $9,999/mo to $29,999/mo" on the
      // card, which reads as gibberish rather than as a price.
      pricing: plans.length
        ? plans.length === 1
          ? plans[0].price
          : `${plans[0].price} to ${plans[plans.length - 1].price}`
        : null,
      acquire_using: "DRAI subscription",
      version: null,
      updated: posted ? post.updated : null,
      overview_text: overview,
      support: SUPPORT_EMAIL,
      // DRAI publishes no ratings and syndicates none. Null here is a fact
      // about the marketplace, not a gap in the record.
      rating: null,
      rating_count: 0,
      native_rating: null,
      native_count: null,
      external_source: null,
      external_rating: null,
      external_count: null,
      certification: "publisher_attestation",
      cert_url: DOCS.security_compliance,
      cert_detail: cert,
      plans,
      product_links: [
        ...(agent.post_url ? [{ label: "Announcement", url: agent.post_url }] : []),
        { label: "Platform", url: PLATFORM_URL },
        { label: "Press Room", url: PRESS_URL },
      ],
      legal_links: Object.entries(DOCS).map(([k, url]) => ({ label: k, url })),
      // The publisher mark, not a per-agent logo: DRAI has none. Set here
      // rather than by a separate pass, because unlike Microsoft there is no
      // DOM to inspect to decide which image is the logo.
      logo_url: PUBLISHER_MARK,
      screenshot_urls: posted ? post.images : [],
      media_image_urls: [],
      // Left empty on purpose. Every technology DRAI names sits in the security
      // statement's sub-processor list, which reaches the registry through
      // cert_detail.data_handling — where the gate can verify it. Asserting it
      // here as well would duplicate a claim, not evidence one.
      stated: {
        models: [], frameworks: [], tools_mcp: [],
        data_sources: [], integrations: [], deployment: [], languages: [],
      },
    },
    reviews_summary: { available: false, note: "DRAI publishes no ratings or reviews" },
    raw: { agent, post: post ?? null },
    // dual_write is the enum value the harvester already uses for Microsoft.
    // ingest_source is a Postgres enum of dual_write | backfill | reconcile, so
    // an invented label is not a loose string that flows through — it is a 400
    // that fails every capture in the run.
    ingest_source: "dual_write",
  };
}
