#!/usr/bin/env node
/**
 * Pass 2 of 4 — product detail.
 *
 *   node scripts/harvest-detail.mjs [--limit N]
 *
 * One fetch per product returns Description, LargeIconUri, Images, WorksWith,
 * Capabilities, AppVersion, ReleaseDate and the support/privacy links, all from
 * the server-rendered state. Writes data/details.jsonl.
 *
 * Resumable: products already in the output file are skipped, so re-running
 * after an interruption picks up where it stopped.
 *
 * ~6,800 products, roughly five minutes.
 */
import { PRODUCT_URL, fetchState, pool, readJsonl, writeJsonl } from "./lib/marketplace.mjs";

const TILES = "data/tiles.jsonl";
const OUT = "data/details.jsonl";
const CONCURRENCY = 8;

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

const tiles = await readJsonl(TILES);
if (!tiles.length) {
  console.error(`No ${TILES}. Run harvest-catalog.mjs first.`);
  process.exit(1);
}

const existing = await readJsonl(OUT);
const done = new Set(existing.map((d) => d.id));
let todo = tiles.filter((t) => !done.has(t.entityId));
if (limit) todo = todo.slice(0, limit);

console.log(`${tiles.length} products, ${done.size} already fetched, ${todo.length} to go\n`);

const failures = [];
const fetched = await pool(
  todo,
  CONCURRENCY,
  async (t) => {
    const { ok, state, status, error } = await fetchState(PRODUCT_URL(t.entityId));
    if (!ok) { failures.push({ id: t.entityId, status, error }); return null; }
    const apps = state.apps || {};
    const info = Object.values(apps.offerDetailInformationData || {})[0] || null;
    const coreWrap = Object.values(apps.offerDetailsData || {})[0] || null;
    const core = coreWrap?.data || null;
    if (!info && !core) { failures.push({ id: t.entityId, status, error: "no detail block" }); return null; }
    return { id: t.entityId, info: info || {}, core: core || {} };
  },
  (d, n) => process.stdout.write(`\r  ${d}/${n}`)
);

const rows = existing.concat(fetched.filter(Boolean));
await writeJsonl(OUT, rows);

const withDesc = rows.filter((r) => r.info?.Description).length;
const withLarge = rows.filter((r) => r.info?.LargeIconUri).length;
console.log(`\n\n${rows.length} details stored -> ${OUT}`);
console.log(`with description: ${withDesc}   with large logo: ${withLarge}   failed: ${failures.length}`);
if (failures.length) {
  console.log("\nfailures (re-run to retry):");
  failures.slice(0, 20).forEach((f) => console.log(`  ${f.id}: ${f.status || ""} ${f.error || ""}`));
  if (failures.length > 20) console.log(`  and ${failures.length - 20} more`);
}
