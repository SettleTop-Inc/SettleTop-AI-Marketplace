#!/usr/bin/env node
/**
 * Pass 5 of 5: merge and load.
 *
 *   node scripts/harvest-ingest.mjs [--limit N] [--dry]
 *
 * Run it as node, never as npm run: npm parses flags after -- as its own
 * configuration and drops them, so --dry never reaches this script. The npm
 * script is wired to the dry run for that reason, and harvest:ingest:live is
 * the one that writes.
 *
 * Merges tiles + details + plans + certifications into one capture per product
 * and sends it through ingest_capture(), then records the logo via
 * set_capture_logo().
 *
 * Kept separate from the fetch passes on purpose: the JSONL files ARE the raw
 * observation, so extraction can be improved and re-run without touching the
 * marketplace again. Re-running this is safe and cheap.
 *
 * One capture per product per sweep: the four fetch passes contribute to a
 * single observation rather than four, so the change feed stays meaningful.
 */
import { readJsonl, supabaseEnv, rpc, pool, dataPath, parseCliArgs } from "./lib/marketplace.mjs";
import { toPayload, ID } from "./lib/sources/microsoft.mjs";

// This is the only script in the harvest that writes to the database, so an
// argument it does not recognise stops it. A swallowed --dry looks exactly like
// no --dry, and the run it would start is a full live sweep of every product.
const { limit, dry } = parseCliArgs({ booleans: ["dry"], numbers: ["limit"] });

const env = dry ? null : supabaseEnv();
const capturedAt = new Date().toISOString();

const tiles = await readJsonl(dataPath(ID, "tiles.jsonl"));
if (!tiles.length) { console.error("No data/tiles.jsonl. Run harvest-catalog.mjs first."); process.exit(1); }

const details = new Map((await readJsonl(dataPath(ID, "details.jsonl"))).map((d) => [d.id, d]));
const plans = new Map((await readJsonl(dataPath(ID, "plans.jsonl"))).map((p) => [p.id, p.plans]));
// Absent certifications.jsonl is an empty Map, not an error. Every pass here
// runs on its own, and a merge that refused to run without the newest file
// would make the older ones depend on it.
const certs = new Map((await readJsonl(dataPath(ID, "certifications.jsonl"))).map((c) => [c.id, c]));

let work = tiles;
if (limit) work = work.slice(0, limit);

const carried = work.filter((t) => certs.has(t.entityId)).length;
console.log(
  `${work.length} products | details ${details.size} | pricing ${plans.size} | ` +
    `certifications ${certs.size}, carried by ${carried} of these${dry ? " | DRY RUN" : ""}\n`
);

const tally = { created: 0, updated: 0, already_ingested: 0, failed: 0, rejected: 0, changes: 0, logos: 0 };
const failures = [];

await pool(
  work,
  6,
  async (tile) => {
    const payload = toPayload({
      tile,
      detail: details.get(tile.entityId) || null,
      plans: plans.get(tile.entityId) || [],
      cert: certs.get(tile.entityId) || null,
      capturedAt,
    });

    if (dry) {
      tally.created++;
      return;
    }

    try {
      const r = await rpc(env, "ingest_capture", { payload });
      tally[r.status] = (tally[r.status] ?? 0) + 1;
      tally.rejected += r.evidence_rejected ?? 0;
      tally.changes += r.changes ?? 0;

      const logo = payload.extract.logo_url;
      if (logo && r.status !== "already_ingested") {
        await rpc(env, "set_capture_logo", { p_product_id: tile.entityId, p_url: logo });
        tally.logos++;
      }
    } catch (e) {
      tally.failed++;
      failures.push({ id: tile.entityId, error: e.message.slice(0, 160) });
    }
  },
  (d, n) => process.stdout.write(`\r  ${d}/${n}`)
);

console.log(`\n\ncreated ${tally.created} · updated ${tally.updated} · unchanged ${tally.already_ingested} · failed ${tally.failed}`);
console.log(`${tally.logos} logos recorded · ${tally.changes} change events · ${tally.rejected} evidence values rejected`);

if (dry) {
  // Prefer a product that carries a certification record. Most products have
  // none, so a sample taken from the top of the list shows an empty cert_detail
  // and says nothing about what this run would actually send.
  const pick = work.find((t) => certs.has(t.entityId)) || work[0];
  const sample = toPayload({
    tile: pick,
    detail: details.get(pick.entityId) || null,
    plans: plans.get(pick.entityId) || [],
    cert: certs.get(pick.entityId) || null,
    capturedAt,
  });
  console.log(`\nsample payload (${pick.entityId}):`);
  console.log(JSON.stringify(sample.extract, null, 1).slice(0, 1600));
  console.log("\nsample cert_detail:");
  console.log(JSON.stringify(sample.extract.cert_detail, null, 1).slice(0, 2400));
}

if (failures.length) {
  console.log("\nfailures (re-run to retry, ingest is idempotent):");
  failures.slice(0, 20).forEach((f) => console.log(`  ${f.id}: ${f.error}`));
}
if (!dry) {
  console.log("\nNext: node scripts/archive-logos.mjs   (fetches the logo bytes into Storage)");
}
