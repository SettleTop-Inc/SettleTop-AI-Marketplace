/**
 * Shared harvest helpers.
 *
 * The storefront is server-rendered and embeds its whole payload in
 * window.__INITIAL_STATE__. Everything except plan pricing can therefore be had
 * with a plain HTTP fetch — no browser, no API key. Plan pricing lives only in
 * React component state after hydration, so that one pass needs Playwright.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export const ORIGIN = "https://marketplace.microsoft.com";
export const CATEGORY = "ai-apps-and-agents";
export const PAGE_URL = (p) =>
  `${ORIGIN}/en-us/search/products?category=${CATEGORY}&page=${p}`;
export const PRODUCT_URL = (id) =>
  `${ORIGIN}/en-us/product/${encodeURIComponent(id)}`;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** Pull window.__INITIAL_STATE__ out of a server-rendered page. */
export function extractState(html) {
  const m = html.match(/__INITIAL_STATE__\s*=\s*/);
  if (!m) return null;
  const start = html.indexOf("{", m.index + m[0].length);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function fetchState(url, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`http ${res.status}`);
      }
      if (!res.ok) return { ok: false, status: res.status, state: null };
      const state = extractState(await res.text());
      if (!state) throw new Error("no __INITIAL_STATE__ in response");
      return { ok: true, status: res.status, state };
    } catch (e) {
      lastErr = e;
      // back off: the marketplace throttles bursts rather than blocking
      await sleep(400 * Math.pow(2, attempt) + Math.random() * 250);
    }
  }
  return { ok: false, status: 0, state: null, error: lastErr?.message };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `worker` over `items` with bounded concurrency, reporting progress. */
export async function pool(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e.message };
      }
      done++;
      if (onProgress && done % 25 === 0) onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
  if (onProgress) onProgress(done, items.length);
  return results;
}

// ---------------------------------------------------------------- files ----

export async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

export async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// -------------------------------------------------------------- mapping ----

const CERT_MAP = {
  MicrosoftCertified: "microsoft_365_certified",
  SelfAttested: "publisher_attestation",
  None: "none",
};

/** HTML description to plain text, preserving paragraph and list structure. */
export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|tr)\s*>/gi, "\n\n")
    .replace(/<\s*li[^>]*>/gi, "\n* ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

// -------------------------------------------------------------- supabase ----

export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  return { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

export async function rpc(env, fn, body) {
  const res = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: env.headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
