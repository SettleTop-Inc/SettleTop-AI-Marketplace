#!/usr/bin/env node
/**
 * Pass 4 of 4 — merge and load.
 *
 *   node scripts/harvest-ingest.mjs [--limit N] [--dry]
 *
 * Merges tiles + details + plans into one capture per product and sends it
 * through ingest_capture(), then records the logo via set_capture_logo().
 *
 * Kept separate from the fetch passes on purpose: the JSONL files ARE the raw
 * observation, so extraction can be improved and re-run without touching the
 * marketplace again. Re-running this is safe and cheap.
 *
 * One capture per product per sweep — the three fetch passes contribute to a
 * single observation rather than three, so the change feed stays meaningful.
 */
import { readJsonl, supabaseEnv, rpc, pool, dataPath } from "./lib/marketplace.mjs";
import { toPayload, ID } from "./lib/sources/microsoft.mjs";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;
const dry = process.argv.includes("--dry");

const env = dry ? null : supabaseEnv();
const capturedAt = new Date().toISOString();

const tiles = await readJsonl(dataPath(ID, "tiles.jsonl"));
if (!tiles.length) { console.error("No data/tiles.jsonl. Run harvest-catalog.mjs first."); process.exit(1); }

const details = new Map((await readJsonl(dataPath(ID, "details.jsonl"))).map((d) => [d.id, d]));
const plans = new Map((await readJsonl(dataPath(ID, "plans.jsonl"))).map((p) => [p.id, p.plans]));

let work = tiles;
if (limit) work = work.slice(0, limit);

console.log(`${work.length} products | details ${details.size} | pricing ${plans.size}${dry ? " | DRY RUN" : ""}\n`);

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
  const sample = toPayload({
    tile: work[0],
    detail: details.get(work[0].entityId) || null,
    plans: plans.get(work[0].entityId) || [],
    capturedAt,
  });
  console.log("\nsample payload:");
  console.log(JSON.stringify(sample.extract, null, 1).slice(0, 1600));
}

if (failures.length) {
  console.log("\nfailures (re-run to retry, ingest is idempotent):");
  failures.slice(0, 20).forEach((f) => console.log(`  ${f.id}: ${f.error}`));
}
if (!dry) {
  console.log("\nNext: node scripts/archive-logos.mjs   (fetches the logo bytes into Storage)");
}
