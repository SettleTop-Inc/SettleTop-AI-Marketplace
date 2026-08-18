#!/usr/bin/env node
/**
 * Pass 1 of 4 — enumerate the category.
 *
 *   node scripts/harvest-catalog.mjs
 *
 * The storefront does not paginate deterministically, and this script is built
 * around that fact rather than against it.
 *
 * One full walk of the ~114 pages returns about 6,800 tile slots but only
 * ~5,100 distinct products: roughly a quarter of every result set repeats a
 * product already returned by another page, and *which* quarter changes over
 * time. Re-fetching a single page is stable, so the loss happens across page
 * boundaries, not within them. Partitioning by subcategory does not rescue it
 * — every slice sheds the same ~25% internally, and the four slices together
 * came back with fewer distinct products than the flat walk did.
 *
 * What works is accumulation. Measured over consecutive passes:
 *
 *     pass 1  flat        +836 ->  836
 *     pass 2  flat (now)    +0 ->  836   identical: the pages are cached
 *     pass 3  subcats    +1140 -> 1976
 *     pass 4  flat       +3585 -> 5561   cache rotated, different slice
 *     pass 5  subcats     +848 -> 6409   against a reported total of ~6812
 *
 * So the enumeration unions instead of replacing. It seeds from whatever
 * data/tiles.jsonl already holds, sweeps repeatedly with a pause between
 * passes so the cache turns over, alternates the flat walk with the
 * subcategory walks because they duplicate differently, and stops once passes
 * stop finding anything new. Re-running it tomorrow keeps closing the gap
 * rather than starting over — and, critically, can no longer *lose* products
 * a previous run had already found.
 *
 * Touches no database. Enumeration is cheap and re-runnable, and keeping it
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
  sleep,
} from "./lib/marketplace.mjs";

const OUT = "data/tiles.jsonl";
const CONCURRENCY = 8;
const TILE_PAGE = 60; // tiles per storefront page
const MAX_PASSES = Number(process.env.HARVEST_PASSES ?? 10);
const COOL_MS = Number(process.env.HARVEST_COOL_MS ?? 20_000);
const DRY_LIMIT = 2; // consecutive passes finding nothing new before we stop

// Hardcoded because the payload does not carry a facet list to read them from
// — window.__INITIAL_STATE__.apps has no facets/filters key. subcategories is
// also the *only* query parameter the server actually honours: productType,
// pricingModel and publisher are applied client-side after hydration and come
// back unfiltered, and no sort parameter is honoured at all.
const SUBCATEGORIES = [
  "bot-services",
  "ai-for-business",
  "cognitive-services",
  "business-robotic-process-automation",
];

const SUB_URL = (slug) => (p) =>
  `${ORIGIN}/en-us/search/products?category=${CATEGORY}&subcategories=${slug}&page=${p}`;

/** Walk one query to exhaustion, returning every tile slot it hands back. */
async function sweep(urlFor) {
  const head = await fetchState(urlFor(1));
  const count = head.ok ? head.state?.apps?.count ?? null : null;
  // Page from the reported count with a margin rather than probing for an
  // empty page: the total drifts upward while you crawl (6788 -> 6801 within
  // 90 minutes observed), and a short read is cheaper than a missed tail.
  const pages = count ? Math.ceil(count / TILE_PAGE) + 2 : 120;

  const got = await pool(
    Array.from({ length: pages }, (_, i) => i + 1),
    CONCURRENCY,
    async (p) => {
      const { ok, state } = await fetchState(urlFor(p));
      return ok ? state.apps?.galleryTiles ?? [] : [];
    }
  );
  return { count, tiles: got.flat() };
}

const seen = new Map();
for (const t of await readJsonl(OUT)) {
  if (t?.entityId) seen.set(t.entityId, t);
}

const resume = seen.size;
console.log(
  resume
    ? `enumerating AI Apps and Agents — resuming from ${resume} already known\n`
    : "enumerating AI Apps and Agents\n"
);

let reportedTotal = null;
let dry = 0;

for (let pass = 1; pass <= MAX_PASSES && dry < DRY_LIMIT; pass++) {
  // Alternate: the flat walk and the subcategory walks duplicate differently,
  // so each is a fresh angle on the same catalogue rather than a repeat.
  const useSubs = pass % 2 === 0;
  const before = seen.size;
  let slots = 0;

  if (useSubs) {
    for (const slug of SUBCATEGORIES) {
      const { tiles } = await sweep(SUB_URL(slug));
      slots += tiles.length;
      for (const t of tiles) if (t?.entityId && !seen.has(t.entityId)) seen.set(t.entityId, t);
    }
  } else {
    const { count, tiles } = await sweep(PAGE_URL);
    if (count) reportedTotal = count;
    slots += tiles.length;
    for (const t of tiles) if (t?.entityId && !seen.has(t.entityId)) seen.set(t.entityId, t);
  }

  const added = seen.size - before;
  dry = added === 0 ? dry + 1 : 0;
  const of = reportedTotal ? ` of ~${reportedTotal}` : "";
  console.log(
    `  pass ${pass} ${useSubs ? "subcats" : "flat   "}: ${slots} slots, +${added} new, ${seen.size}${of} unique`
  );

  // Written every pass, not just at the end: a run interrupted half way
  // through still leaves the catalogue further along than it found it.
  await writeJsonl(OUT, [...seen.values()]);

  const done = dry >= DRY_LIMIT || pass >= MAX_PASSES;
  if (!done) await sleep(COOL_MS); // let the page cache rotate
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
if (reportedTotal && tiles.length < reportedTotal) {
  console.log(
    `marketplace reports ${reportedTotal}; ${reportedTotal - tiles.length} still unseen — ` +
      `re-run to keep closing the gap (this file is never overwritten, only added to)`
  );
}
console.log(`with logo: ${withIcon}   with pricing: ${priced}   certification: ${JSON.stringify(certs)}`);
if (tiles.length === 0) process.exit(1);
