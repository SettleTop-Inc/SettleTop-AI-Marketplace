#!/usr/bin/env node
/**
 * DRAI pass 2 — read each launch post.
 *
 *   node scripts/drai-detail.mjs
 *   node scripts/drai-detail.mjs --limit 3
 *
 * Only agents with a post have a listing body to read. The name-only ones are
 * not failures and are not fetched: DRAI publishes a catalog line for them and
 * nothing else, which their capture records honestly rather than treating as a
 * gap to fill.
 *
 * Resumable in the same way as the Microsoft detail pass — anything already in
 * details.jsonl is skipped, so a re-run costs only what it did not get last
 * time. Concurrency is deliberately low: this is one small publisher's site,
 * not a marketplace CDN, and there are only ~20 pages to read.
 */
import { readJsonl, writeJsonl, dataPath, pool } from "./lib/marketplace.mjs";
import { ID, parsePost } from "./lib/sources/drai.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const CONCURRENCY = 3;

const TILES = dataPath(ID, "tiles.jsonl");
const OUT = dataPath(ID, "details.jsonl");

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

const agents = await readJsonl(TILES);
if (!agents.length) {
  console.error(`No ${TILES}. Run scripts/drai-catalog.mjs first.`);
  process.exit(1);
}

const have = new Map((await readJsonl(OUT)).map((d) => [d.slug, d]));
const posted = agents.filter((a) => a.post_url);

// Resume skips what we already have, but only where "what we have" was written
// by the parser now in the file. A record from an older shape — details written
// when a bare "Tier 3" mention was read as a price — is re-read rather than
// trusted, so correcting the parser costs a re-run and not a manual delete.
const currentShape = (d) => Array.isArray(d.plans);
const reread = posted.filter((a) => have.has(a.slug) && !currentShape(have.get(a.slug)));

let todo = posted.filter((a) => !have.has(a.slug) || !currentShape(have.get(a.slug)));
if (limit) todo = todo.slice(0, limit);

console.log(
  `${agents.length} agents | ${posted.length} with a post | ` +
    `${have.size - reread.length} already read | ${todo.length} to go` +
    (reread.length ? ` (${reread.length} re-read: older parse)` : "") +
    "\n"
);

const failures = [];

await pool(todo, CONCURRENCY, async (agent) => {
  try {
    const res = await fetch(agent.post_url, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const post = parsePost(await res.text());

    // A post that yields no prose is a parse failure, not an empty listing.
    // Storing it would put an empty overview_text into the registry and look
    // like the publisher wrote nothing.
    if (!post.text || post.text.length < 200) {
      throw new Error(`article body too short (${post.text?.length ?? 0} chars)`);
    }

    have.set(agent.slug, { slug: agent.slug, url: agent.post_url, ...post });
    const price = post.plans.length ? `${post.plans.length} priced tier(s)` : "no price stated";
    console.log(`  ✓ ${agent.slug.padEnd(38)} ${String(post.text.length).padStart(5)} chars  ${price}`);
  } catch (e) {
    failures.push([agent.slug, e.message]);
    console.error(`  ✗ ${agent.slug.padEnd(38)} ${e.message}`);
  }
});

await writeJsonl(OUT, [...have.values()]);

const priced = [...have.values()].filter((d) => d.plans?.length).length;
console.log(`\n${have.size} posts read -> ${OUT}`);
console.log(`${priced} publish a price, ${have.size - priced} do not`);
if (failures.length) {
  console.log(`\n${failures.length} failed. Re-run to retry — reading is resumable.`);
  for (const [slug, msg] of failures) console.log(`  ${slug}: ${msg}`);
}
process.exit(failures.length ? 1 : 0);
