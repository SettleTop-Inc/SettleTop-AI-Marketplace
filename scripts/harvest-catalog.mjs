#!/usr/bin/env node
/**
 * Pass 1 of 4 — enumerate the category.
 *
 *   node scripts/harvest-catalog.mjs
 *
 * The storefront will not simply hand you its catalogue, for two separate
 * reasons that look identical from the outside.
 *
 * The first is that it does not paginate deterministically. Each request is
 * served from a rotating shard, so one full walk returns ~6,800 tile slots but
 * only ~5,100 distinct products, and a sweep re-observes only about 91% of the
 * products we already know exist. Nothing fixes this from the query side:
 * pageSize/$top/skip/offset are all silently ignored (every variant returns the
 * same 60 tiles as the plain page), no sort parameter is honoured, and
 * productType/pricingModel/publisher are client-side filters that come back
 * unfiltered. Partitioning by subcategory is worse than the flat walk.
 *
 * The second is HTTP caching, and it is what made this look hopeless. Responses
 * carry max-age=3600, so repeating a walk inside the hour replays the identical
 * shard and adds nothing — which reads exactly like a catalogue that has been
 * exhausted. It is not. Measured on one page:
 *
 *     page 100, fetched 4x plain          ->  60 distinct ids   (4x TCP_HIT)
 *     page 100, fetched 4x cache-busted   -> 180 distinct ids   (4x TCP_MISS)
 *
 * So every request here carries a cache-buster, and coverage becomes a
 * coupon-collector problem: keep drawing fresh samples and union them.
 *
 * Two angles are drawn from, because they duplicate differently:
 *
 *   flat    — the plain category walk, cache-busted. ~25% internal duplication.
 *   search  — `search=<term>` is the one genuinely server-honoured filter
 *             (search=copilot returns 887, not the unfiltered ~6,810). Slices
 *             duplicate internally at 0.2-1%, so they are far denser per
 *             request than the flat walk, and they reach products a given shard
 *             sample happens to omit.
 *
 * Deliberately NOT used: catalogapi.azure.com. It is deterministic and would
 * retire all of the above, but it requires an API key lifted from the page's
 * client config, and this repository is public. A reverse-engineered credential
 * does not go in it.
 *
 * The file is only ever added to, never replaced. A run that samples badly can
 * no longer destroy what a previous run found.
 *
 * Touches no database — enumeration is cheap and re-runnable, and keeping it
 * separate means a bad ingest never costs a re-crawl.
 */
import {
  ORIGIN,
  CATEGORY,
  PAGE_URL,
  fetchState,
  pool,
  readJsonl,
  writeJsonl,
} from "./lib/marketplace.mjs";

const OUT = "data/tiles.jsonl";
const TILE_PAGE = 60; // tiles per storefront page
const FLAT_CONCURRENCY = 5;
const SEARCH_CONCURRENCY = 3; // 4+ draws sustained 403s on search slices
const SEARCH_MAX_PAGES = 20; // broad terms are capped; narrow ones pay better
const MAX_ROUNDS = Number(process.env.HARVEST_ROUNDS ?? 6);
const MIN_GAIN = Number(process.env.HARVEST_MIN_GAIN ?? 5); // stop below this

/**
 * Defeat the CDN cache. Without this, every repeat of a URL inside the hour
 * replays one shard and the crawl looks finished while most of the catalogue
 * has never been served. The parameter is ignored by the application and
 * changes nothing but the cache key.
 */
const bust = (url) =>
  `${url}${url.includes("?") ? "&" : "?"}cb=${Math.random().toString(36).slice(2, 10)}`;

const SEARCH_URL = (term) => (p) =>
  `${ORIGIN}/en-us/search/products?category=${CATEGORY}&search=${encodeURIComponent(term)}&page=${p}`;

const tilesOf = (r) => (r.ok ? r.state?.apps?.galleryTiles ?? [] : []);

/**
 * Walk one query to exhaustion. Pages that come back empty are retried once: a
 * dropped page is 60 tiles of real coverage lost, not an end-of-results signal,
 * and under concurrency the storefront sheds load fairly often.
 */
async function sweep(urlFor, { concurrency, maxPages = Infinity }) {
  const head = await fetchState(bust(urlFor(1)));
  const count = head.ok ? head.state?.apps?.count ?? null : null;
  if (!count) return { count: null, tiles: tilesOf(head) };

  // Page from the reported count rather than probing for an empty page. The
  // count is not trustworthy as a target — it jitters (6801-6818 observed
  // between identical requests) — but it is a fine upper bound.
  const pages = Math.min(Math.ceil(count / TILE_PAGE) + 1, maxPages);
  const rest = Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => i + 2);

  const got = await pool(rest, concurrency, async (p) => tilesOf(await fetchState(bust(urlFor(p)))));
  const empties = rest.filter((_, i) => got[i]?.length === 0);
  const retried = empties.length
    ? await pool(empties, concurrency, async (p) => tilesOf(await fetchState(bust(urlFor(p)))))
    : [];

  return { count, tiles: [tilesOf(head), ...got, ...retried].flat() };
}

/**
 * Search terms, richest first. The static list is the vocabulary that actually
 * paid during probing — vertical and AI-product nouns. It is then extended with
 * the commonest words in the titles we already hold, so the term list grows
 * with the catalogue instead of staying frozen at whatever seemed sensible when
 * this was written. Terms of one character are useless: they return the
 * unfiltered set and cost a full walk each.
 */
const BASE_TERMS = [
  "assistant", "chatbot", "analytics", "automation", "customer", "generative",
  "llm", "dashboard", "network", "risk", "sentiment", "recommendation",
  "government", "manufacturing", "insurance", "banking", "education",
  "marketing", "legal", "retail", "voice", "security", "monitoring",
  "quality", "audit", "finance", "copilot", "agent", "document", "healthcare",
];

const STOP = new Set([
  "with", "from", "your", "that", "this", "have", "will", "into", "more",
  "using", "used", "based", "solution", "solutions", "platform", "service",
  "services", "microsoft", "azure", "cloud", "data", "management", "system",
  "systems", "software", "business", "enterprise", "powered", "intelligent",
]);

function seedTerms(tiles, want) {
  const freq = new Map();
  for (const t of tiles) {
    const text = `${t.title ?? ""} ${t.displayName ?? ""} ${t.name ?? ""}`.toLowerCase();
    for (const w of text.match(/[a-z]{5,}/g) ?? []) {
      if (STOP.has(w) || BASE_TERMS.includes(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, want)
    .map(([w]) => w);
}

// ------------------------------------------------------------------ run ----

const seen = new Map();
for (const t of await readJsonl(OUT)) if (t?.entityId) seen.set(t.entityId, t);

const resume = seen.size;
console.log(
  resume
    ? `enumerating AI Apps and Agents — resuming from ${resume} already known\n`
    : "enumerating AI Apps and Agents\n"
);

const absorb = (tiles) => {
  let added = 0;
  for (const t of tiles) {
    if (t?.entityId && !seen.has(t.entityId)) {
      seen.set(t.entityId, t);
      added++;
    }
  }
  return added;
};

let reportedTotal = null;

// Flat walks are cheap and dense; search slices cost roughly eight times as
// much per product found. Measured on one run against a 6,627-id file: flat
// +114 from 6,810 slots, search +77 from 38,824, and a second search pass +0
// from 38,840. So keep drawing cheap flat samples while they pay, and bring in
// the search angle only once the flat walk dries up. Search does reach products
// no shard sample happened to include — it is worth having, just not worth
// paying for while the cheap draw is still finding things.
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const flat = await sweep(PAGE_URL, { concurrency: FLAT_CONCURRENCY });
  if (flat.count) reportedTotal = flat.count;
  const flatAdded = absorb(flat.tiles);
  console.log(
    `  round ${round} flat  : ${flat.tiles.length} slots, +${flatAdded} new, ${seen.size} unique`
  );
  await writeJsonl(OUT, [...seen.values()]);
  if (flatAdded >= MIN_GAIN) continue;

  const terms = [...BASE_TERMS, ...seedTerms([...seen.values()], 30)];
  let searchSlots = 0;
  let searchAdded = 0;
  for (const term of terms) {
    const { tiles } = await sweep(SEARCH_URL(term), {
      concurrency: SEARCH_CONCURRENCY,
      maxPages: SEARCH_MAX_PAGES,
    });
    searchSlots += tiles.length;
    searchAdded += absorb(tiles);
  }
  console.log(
    `  round ${round} search: ${searchSlots} slots over ${terms.length} terms, +${searchAdded} new, ${seen.size} unique`
  );
  await writeJsonl(OUT, [...seen.values()]);

  // Both angles below the threshold in the same round: the flat draw has
  // stopped paying and the slices agree. Stopping on the flat walk alone would
  // quit while search still had products to give.
  if (searchAdded < MIN_GAIN) {
    console.log(`  both angles below ${MIN_GAIN} new — stopping`);
    break;
  }
}

const tiles = [...seen.values()];
const priced = tiles.filter((t) => t.hasPrices).length;
const withIcon = tiles.filter((t) => t.iconURL).length;
const certs = tiles.reduce((a, t) => {
  const k = t.CertificationState || "None";
  a[k] = (a[k] || 0) + 1;
  return a;
}, {});

console.log(`\n${tiles.length} unique products -> ${OUT}  (+${tiles.length - resume} this run)`);
if (reportedTotal) {
  // Never presented as a shortfall against a fixed denominator: the storefront's
  // own count jitters by ~15 between identical requests, so "N still missing" is
  // precision the number does not have.
  console.log(`storefront reports ~${reportedTotal} (jitters by ~15 between requests)`);
  if (tiles.length < reportedTotal - 20) {
    console.log("re-run to keep closing the gap — this file is only ever added to, never replaced");
  }
}
console.log(`with logo: ${withIcon}   with pricing: ${priced}   certification: ${JSON.stringify(certs)}`);
if (tiles.length === 0) process.exit(1);
