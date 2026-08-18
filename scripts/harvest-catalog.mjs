#!/usr/bin/env node
/**
 * Pass 1 of 4 — enumerate the category.
 *
 *   node scripts/harvest-catalog.mjs
 *
 * Walks category pages until one comes back empty, collecting 60 structured
 * records per page from the server-rendered state. Writes data/tiles.jsonl.
 * Touches no database — enumeration is cheap and re-runnable, and keeping it
 * separate means a bad ingest never costs a re-crawl.
 *
 * ~114 pages, about 20 seconds.
 */
import { PAGE_URL, fetchState, pool, writeJsonl } from "./lib/marketplace.mjs";

const OUT = "data/tiles.jsonl";
const CONCURRENCY = 8;
const BATCH = 16; // pages probed per round

// The total drifts while you crawl (observed 6788 -> 6801 within 90 minutes),
// so page count is never computed from it. We walk until a page is empty.
const seen = new Map();
let page = 1;
let emptyRun = 0;
let reportedTotal = null;

console.log("enumerating AI Apps and Agents\n");

while (emptyRun < 2) {
  const pages = Array.from({ length: BATCH }, (_, i) => page + i);
  page += BATCH;

  const results = await pool(pages, CONCURRENCY, async (p) => {
    const { ok, state, status, error } = await fetchState(PAGE_URL(p));
    if (!ok) return { p, tiles: [], failed: true, status, error };
    const apps = state.apps || {};
    if (reportedTotal === null && apps.count) reportedTotal = apps.count;
    return { p, tiles: apps.galleryTiles || [], total: apps.count };
  });

  let addedThisRound = 0;
  let emptyThisRound = 0;
  for (const r of results.sort((a, b) => a.p - b.p)) {
    if (r.failed) {
      console.error(`  page ${r.p}: FAILED ${r.status || ""} ${r.error || ""}`);
      continue;
    }
    if (r.tiles.length === 0) { emptyThisRound++; continue; }
    for (const t of r.tiles) {
      if (t?.entityId && !seen.has(t.entityId)) { seen.set(t.entityId, t); addedThisRound++; }
    }
  }

  emptyRun = emptyThisRound >= BATCH ? emptyRun + 1 : 0;
  console.log(`  pages ${pages[0]}-${pages[pages.length - 1]}: +${addedThisRound} new, ${seen.size} unique so far`);
  if (emptyThisRound >= BATCH) break;
}

const tiles = [...seen.values()];
await writeJsonl(OUT, tiles);

const priced = tiles.filter((t) => t.hasPrices).length;
const withIcon = tiles.filter((t) => t.iconURL).length;
const certs = tiles.reduce((a, t) => { const k = t.CertificationState || "None"; a[k] = (a[k] || 0) + 1; return a; }, {});

console.log(`\n${tiles.length} unique products -> ${OUT}`);
console.log(`marketplace reported total: ${reportedTotal} (drifts; not used to page)`);
console.log(`with logo: ${withIcon}   with pricing: ${priced}   certification: ${JSON.stringify(certs)}`);
if (tiles.length === 0) process.exit(1);
