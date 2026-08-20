#!/usr/bin/env node
/**
 * Pass 4 of 5: certification pages.
 *
 *   node scripts/harvest-certification.mjs [--limit N]
 *
 * Reads the Microsoft 365 app certification page behind every product that has
 * one, and writes what it says into data/microsoft/certifications.jsonl.
 *
 * Scope is 219 of 6,855. A product whose CertificationState is None has no
 * certification page and no CertificationLink, so there is nothing to fetch and
 * nothing to infer: those are skipped outright rather than probed. This is a
 * 219-request pass.
 *
 * Why it exists: the catalog gives the certification tier cheaply, but the tier
 * alone tells you nothing about where the app runs, where it keeps data, or
 * what it asks of Microsoft Graph. All of that is published, on a page we were
 * already recording the address of and never reading. Until now every Microsoft
 * listing stored an all-null cert_detail, which is why none of them state a
 * hosting model or a data residency.
 *
 * Resumable: products already in the output file are skipped, so re-running
 * after an interruption picks up where it stopped. A page that could not be
 * read is NOT written, so a re-run retries it. That is the difference between
 * "we could not read it" and "it said nothing", and both are counted below.
 */
import { fetchText, pool, readJsonl, writeJsonl, sleep, dataPath } from "./lib/marketplace.mjs";
import { parseCertificationPage, ID } from "./lib/sources/microsoft.mjs";

const TILES = dataPath(ID, "tiles.jsonl");
const OUT = dataPath(ID, "certifications.jsonl");

// learn.microsoft.com is a docs host, not the storefront, and 219 requests is a
// small ask of it. Four at a time with a pause between them swept the whole set
// in under two minutes with no throttling.
const CONCURRENCY = 4;
const PAUSE_MS = 250;

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

const tiles = await readJsonl(TILES);
if (!tiles.length) {
  console.error(`No ${TILES}. Run harvest-catalog.mjs first.`);
  process.exit(1);
}

// Two conditions, both required. A tier without a link cannot be read, and a
// link without a tier is not something this pass was told about.
const certified = tiles.filter(
  (t) => t.CertificationState && t.CertificationState !== "None" && t.CertificationLink
);

const existing = await readJsonl(OUT);
const done = new Set(existing.map((c) => c.id));
let todo = certified.filter((t) => !done.has(t.entityId));
if (limit) todo = todo.slice(0, limit);

console.log(
  `${tiles.length} products, ${certified.length} with a certification page, ` +
    `${done.size} already read, ${todo.length} to go\n`
);

const failures = [];
const fetched = await pool(
  todo,
  CONCURRENCY,
  async (t) => {
    const { ok, status, url, html, error } = await fetchText(t.CertificationLink);
    await sleep(PAUSE_MS);
    if (!ok) {
      failures.push({ id: t.entityId, status, error: error || "not fetched" });
      return null;
    }
    const parsed = parseCertificationPage({ id: t.entityId, html, url });
    if (!parsed.ok) {
      failures.push({ id: t.entityId, status, error: parsed.reason });
      return null;
    }
    return { cert_url: t.CertificationLink, ...parsed.record };
  },
  (d, n) => process.stdout.write(`\r  ${d}/${n}`)
);

const rows = existing.concat(fetched.filter(Boolean));
await writeJsonl(OUT, rows);

const has = (f) => rows.filter(f).length;
// A page that answered the questionnaire and disclosed nothing past its hosting
// model is a real reading, not a failure. It is counted apart from the pages we
// could not read at all, because the two mean opposite things.
const silent = rows.filter(
  (r) => !r.data_location && !r.graph_permissions.length && !r.compliance.length
).length;

console.log(`\n\n${rows.length} certification pages read -> ${OUT}`);
console.log(
  `hosting: ${has((r) => r.hosting)}   residency: ${has((r) => r.data_location)}   ` +
    `graph permissions: ${has((r) => r.graph_permissions.length)}   ` +
    `compliance: ${has((r) => r.compliance.length)}`
);
console.log(
  `audit result table: ${has((r) => r.certification_results)}   ` +
    `nothing stated beyond hosting: ${silent}   not read: ${failures.length}`
);

if (failures.length) {
  console.log("\nnot read (re-run to retry):");
  failures.slice(0, 20).forEach((f) => console.log(`  ${f.id}: ${f.status || ""} ${f.error || ""}`));
  if (failures.length > 20) console.log(`  and ${failures.length - 20} more`);
}
