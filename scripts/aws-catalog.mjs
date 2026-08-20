#!/usr/bin/env node
/**
 * AWS pass 1 of 3: enumerate the catalogue.
 *
 *   node scripts/aws-catalog.mjs
 *
 * ONE request, about half a second, no credential and no browser. The sitemap
 * that robots.txt names lists every product page AWS Marketplace publishes, so
 * enumeration here is nothing like the Microsoft catalog pass: no rotating
 * shards, no cache-busting, no coupon-collector rounds. Whatever that file says
 * today IS the catalogue.
 *
 * WHAT THIS PASS CANNOT DO, and it is the shape of the whole source. The
 * sitemap carries no category, so this cannot filter. Every id goes in the
 * file, and aws-detail.mjs applies the AI Agents & Tools predicate after
 * fetching each product page, because a listing's categories are stated only on
 * its own record. Roughly seven of every eight ids enumerated here will be read
 * and rejected there.
 *
 * The file is only ever added to, never replaced, following the rule
 * scripts/harvest-catalog.mjs already states: a bad fetch can then never
 * destroy an enumeration that took a real crawl to build. last_in_sitemap is
 * refreshed each run instead, which makes a product that has LEFT the sitemap
 * visible without deleting its row.
 *
 * Touches no database.
 */
import { fetchText, readJsonl, writeJsonl, dataPath, parseCliArgs } from "./lib/marketplace.mjs";
import { ID, SITEMAP_URL, PRODUCT_URL, productIdsIn } from "./lib/sources/aws.mjs";

const OUT = dataPath(ID, "ids.jsonl");

/**
 * The band the id count must land in.
 *
 * 43,104 distinct prodview ids were counted on the live file twice on
 * 2026-08-20. A catalogue does not move by a third overnight, so a count
 * outside this band means the sitemap changed shape or the fetch was truncated,
 * and either is worth stopping for rather than quietly writing a short file
 * that the detail pass then treats as the whole catalogue.
 */
const EXPECTED = 43104;
const BAND_LOW = Math.round(EXPECTED * 0.7);
const BAND_HIGH = Math.round(EXPECTED * 1.5);

parseCliArgs({});

const runAt = new Date().toISOString();

console.log(`reading ${SITEMAP_URL}`);
const res = await fetchText(SITEMAP_URL);
if (!res.ok) {
  console.error(`sitemap fetch failed: http ${res.status} ${res.error ?? ""}`);
  console.error(`${OUT} is left exactly as it was. Re-run.`);
  process.exit(1);
}

const ids = productIdsIn(res.html);
console.log(`  ${res.html.length.toLocaleString()} bytes, ${ids.length.toLocaleString()} distinct product ids`);

if (ids.length < BAND_LOW || ids.length > BAND_HIGH) {
  console.error(
    `\n${ids.length} ids is outside the expected band ${BAND_LOW} to ${BAND_HIGH} ` +
      `(${EXPECTED} counted on 2026-08-20).`
  );
  console.error("Refusing to write: either the sitemap changed shape or the body was truncated.");
  console.error("Nothing has been written. Inspect the sitemap before re-running.");
  process.exit(1);
}

// Keyed by id so a re-run refreshes last_in_sitemap without losing first_seen
// and without dropping a row for an id AWS has since removed.
const known = new Map((await readJsonl(OUT)).map((r) => [r.id, r]));
const before = known.size;

for (const id of ids) {
  const prev = known.get(id);
  if (prev) prev.last_in_sitemap = runAt;
  else known.set(id, { id, url: PRODUCT_URL(id), first_seen: runAt, last_in_sitemap: runAt });
}

const rows = [...known.values()];
await writeJsonl(OUT, rows);

const added = rows.length - before;
const gone = rows.filter((r) => r.last_in_sitemap !== runAt);

console.log(`\n${rows.length.toLocaleString()} product ids -> ${OUT}`);
if (before) {
  console.log(
    `last run held ${before.toLocaleString()}: ` +
      `+${added.toLocaleString()} new, ${gone.length.toLocaleString()} no longer listed`
  );
  // Not deleted, and not an error. A listing can leave the sitemap and come
  // back, and the detail pass will find the page gone on its own terms.
  if (gone.length) {
    console.log("ids that left the sitemap keep their row; this file is only ever added to");
    for (const r of gone.slice(0, 5)) console.log(`  ${r.id}  last seen ${r.last_in_sitemap}`);
    if (gone.length > 5) console.log(`  and ${gone.length - 5} more`);
  }
} else {
  console.log("first run, so there is nothing to compare against");
}
console.log("\nNext: node scripts/aws-detail.mjs --limit 200");
