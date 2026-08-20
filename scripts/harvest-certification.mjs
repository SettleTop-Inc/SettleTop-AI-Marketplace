#!/usr/bin/env node
/**
 * Pass 4 of 5: certification pages.
 *
 *   node scripts/harvest-certification.mjs [--limit N] [--refresh]
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
 *
 * Resuming carries old records forward VERBATIM. It does not re-parse them, so
 * a change to what the parser stores reaches only the pages read after it: the
 * file would then hold two generations of parse policy at once, and nothing in
 * the output would say so. Any change to parseCertificationPage therefore ends
 * with --refresh, which ignores the existing file and reads all 219 pages
 * again.
 */
import { fetchText, pool, readJsonl, writeJsonl, sleep, dataPath, parseCliArgs } from "./lib/marketplace.mjs";
import { parseCertificationPage, ID } from "./lib/sources/microsoft.mjs";

const TILES = dataPath(ID, "tiles.jsonl");
const OUT = dataPath(ID, "certifications.jsonl");

// learn.microsoft.com is a docs host, not the storefront, and 219 requests is a
// small ask of it. Four at a time with a pause between them swept the whole set
// in under two minutes with no throttling.
const CONCURRENCY = 4;
const PAUSE_MS = 250;

const { limit, refresh } = parseCliArgs({ booleans: ["refresh"], numbers: ["limit"] });

// A refresh rewrites the file from what this run read. Capped, it would rewrite
// 219 records as the handful the cap allowed, and the pages it never asked for
// would simply be gone.
if (refresh && limit) {
  console.error("--refresh reads every page and rewrites the file, so it cannot be capped with --limit.");
  process.exit(1);
}

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

// --refresh ignores the existing records rather than deleting the file first,
// so an interrupted refresh leaves the old file intact. A page that cannot be
// read during a refresh does lose its old record, and that is the point of
// asking for one: the file then holds what this parser could read today, in one
// generation, rather than two.
const existing = refresh ? [] : await readJsonl(OUT);
const done = new Set(existing.map((c) => c.id));
let todo = certified.filter((t) => !done.has(t.entityId));
if (limit) todo = todo.slice(0, limit);

console.log(
  `${tiles.length} products, ${certified.length} with a certification page, ` +
    `${done.size} already read, ${todo.length} to go${refresh ? " (--refresh: reading every page again)" : ""}\n`
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

// pool() turns a thrown worker into { error }, which is truthy. Written, that
// becomes a permanent row with no id: the resume set cannot match it, so the
// real product is never retried, and every later run trips over it. A record is
// a record only if it carries the id it was filed under.
const read = fetched.filter((r) => r && r.id);
const thrown = fetched.filter((r) => r && !r.id).length;

const rows = existing.concat(read);
await writeJsonl(OUT, rows);

// The counts describe THIS RUN, not the file. A resumed pass that read nothing
// new has read nothing new, and printing the file's totals as the run's is how
// a pass that fetched zero pages comes to look like a full sweep.
const has = (f) => read.filter(f).length;
// A page that answered the questionnaire and disclosed nothing past its hosting
// model is a real reading, not a failure. It is counted apart from the pages we
// could not read at all, because the two mean opposite things.
const silent = read.filter(
  (r) => !r.data_location && !r.graph_permissions?.length && !r.compliance?.length
).length;

console.log(`\n\n${read.length} pages read this run, ${rows.length} records in the file -> ${OUT}`);
console.log(
  `hosting: ${has((r) => r.hosting)}   residency: ${has((r) => r.data_location)}   ` +
    `graph permissions: ${has((r) => r.graph_permissions?.length)}   ` +
    `compliance: ${has((r) => r.compliance?.length)}`
);
console.log(
  `audit result table: ${has((r) => r.certification_results)}   ` +
    `${thrown ? `dropped after a worker threw: ${thrown}   ` : ""}` +
    `nothing stated beyond hosting: ${silent}   not read: ${failures.length}`
);

if (failures.length) {
  console.log("\nnot read (re-run to retry):");
  failures.slice(0, 20).forEach((f) => console.log(`  ${f.id}: ${f.status || ""} ${f.error || ""}`));
  if (failures.length > 20) console.log(`  and ${failures.length - 20} more`);
}
