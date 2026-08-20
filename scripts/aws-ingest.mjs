#!/usr/bin/env node
/**
 * AWS pass 3 of 3: load the kept listings into the registry.
 *
 *   node scripts/aws-ingest.mjs --dry
 *   node scripts/aws-ingest.mjs --dry --limit 5
 *   node scripts/aws-ingest.mjs
 *
 * Run it as node, never as npm run. npm parses flags after -- as its own
 * configuration and drops them, so --dry never reaches this script; the npm
 * script harvest:aws:ingest is wired to the dry run for exactly that reason and
 * harvest:aws:ingest:live is the one that writes. This is the only AWS script
 * that touches the database, so an argument it does not recognise stops the
 * run: a swallowed --dry looks identical to no --dry, and the run it would
 * start is a live sweep of the whole kept set.
 *
 * Reads data/aws/details.jsonl and nothing else. That file holds only listings
 * the detail pass kept, which is the point of the file being separate: a
 * rejected listing is not somewhere in here behind a flag, it is not here at
 * all, so no filter bug in this script can ingest one.
 *
 * Calls the existing ingest_capture() unchanged, then set_capture_logo(). The
 * evidence verification gate inside that function is not touched, worked
 * around, or relaxed. Adding a source does not touch the write path.
 *
 * Re-running is safe and cheap: the JSONL is the raw observation, so extraction
 * can be improved and re-loaded without fetching a single AWS page again.
 */
import { readJsonl, supabaseEnv, rpc, pool, dataPath, parseCliArgs } from "./lib/marketplace.mjs";
import { ID, CATEGORY_LABEL, PREDICATE_VERSION, toPayload } from "./lib/sources/aws.mjs";

const DETAILS = dataPath(ID, "details.jsonl");
const CONCURRENCY = 4;

const { limit, dry } = parseCliArgs({ booleans: ["dry"], numbers: ["limit"] });

const env = dry ? null : supabaseEnv();
const capturedAt = new Date().toISOString();

const records = await readJsonl(DETAILS);
if (!records.length) {
  console.error(`No ${DETAILS}. Run scripts/aws-detail.mjs first.`);
  process.exit(1);
}

/**
 * Records written by an older predicate are not ingested.
 *
 * A kept row carries the stamp of the predicate that admitted it. If that
 * predicate has since changed, this record was admitted by a rule the registry
 * no longer applies, and loading it would put a listing in the category on the
 * strength of a decision nobody would make today. The detail pass re-reads
 * those rows on its next run, so refusing here costs a re-run and not a manual
 * delete, the same way drai-detail.mjs handles an older parse shape.
 */
const stale = records.filter((r) => r.predicate_version !== PREDICATE_VERSION);
let work = records.filter((r) => r.predicate_version === PREDICATE_VERSION);
if (limit) work = work.slice(0, limit);

const complete = work.filter((r) => r.pricing_published).length;
console.log(
  `${records.length} kept listings in ${CATEGORY_LABEL} | ${work.length} to load | ` +
    `${complete} publish a price, ${work.length - complete} do not` +
    (stale.length ? ` | ${stale.length} skipped: older predicate` : "") +
    (dry ? " | DRY RUN" : "") +
    "\n"
);
if (stale.length) {
  console.log(`predicate is now ${PREDICATE_VERSION}. Re-run scripts/aws-detail.mjs to re-read the rest.\n`);
}

const tally = { created: 0, updated: 0, unchanged: 0, already_ingested: 0, failed: 0, rejected: 0, changes: 0, logos: 0 };
const logoMisses = [];
const failures = [];

await pool(
  work,
  CONCURRENCY,
  async (record) => {
    const payload = toPayload({ record, capturedAt });

    if (dry) {
      const e = payload.extract;
      console.log(
        `  DRY ${record.id.padEnd(24)} ${payload.capture_meta.capture_complete ? "full" : "thin"} ` +
          `plans:${String(e.plans.length).padStart(3)} cats:${e.categories.length} ` +
          `links:${e.product_links.length} legal:${e.legal_links.length} cert:${e.certification}  ${e.name}`
      );
      tally.created++;
      return;
    }

    try {
      const r = await rpc(env, "ingest_capture", { payload });
      const status = r?.status ?? "unknown";
      tally[status] = (tally[status] ?? 0) + 1;
      tally.rejected += r?.evidence_rejected ?? 0;
      tally.changes += r?.changes ?? 0;

      // ingest_capture does not create the logo link; set_capture_logo does.
      // The third argument is required: it defaults to microsoft, so omitting
      // it looks up a Microsoft asset with an AWS product id and quietly
      // returns no_capture.
      const logo = payload.extract.logo_url;
      if (logo && status !== "already_ingested") {
        const lr = await rpc(env, "set_capture_logo", {
          p_product_id: record.id,
          p_url: logo,
          p_marketplace_id: ID,
        });
        if (lr === "no_capture") logoMisses.push(record.id);
        else tally.logos++;
      }
    } catch (e) {
      tally.failed++;
      failures.push({ id: record.id, error: e.message.slice(0, 200) });
    }
  },
  (d, n) => (dry ? undefined : process.stdout.write(`\r  ${d}/${n}`))
);

if (dry) {
  /**
   * Show a listing that carries plans, because most of what makes an AWS
   * payload different from a Microsoft one is in there. A sample taken from the
   * top of the file is very often a professional services engagement, whose
   * plans array is empty and whose extract therefore says nothing about how AWS
   * publishes a price.
   */
  const pick = work.find((r) => r.plans.length) ?? work[0];
  const sample = toPayload({ record: pick, capturedAt });
  console.log(`\nsample payload (${pick.id}):`);
  console.log("capture_meta:");
  console.log(JSON.stringify(sample.capture_meta, null, 1));
  console.log("\nextract:");
  console.log(JSON.stringify(sample.extract, null, 1).slice(0, 3200));
  console.log("\ncert_detail:");
  console.log(JSON.stringify(sample.extract.cert_detail, null, 1));
  console.log("\nDry run. Nothing written.");
  process.exit(0);
}

console.log(
  `\n\ncreated ${tally.created} · updated ${tally.updated} · ` +
    `unchanged ${tally.unchanged + tally.already_ingested} · failed ${tally.failed}`
);
console.log(`${tally.logos} logos recorded · ${tally.changes} change events · ${tally.rejected} evidence values rejected`);

if (tally.rejected) {
  // Expected to stay at zero for AWS. Every `stated` key is empty, so there is
  // nothing for the gate to verify and nothing for it to reject. A non-zero
  // count here means someone populated `stated`, and the fix is to carry the
  // text the value came from, never to assert the value anyway.
  console.log("\nA stated value was not present in the fields the database verifies against.");
  console.log("AWS captures state nothing, so this should be zero. Check what was added to extract.stated.");
}
if (logoMisses.length) console.log(`\n${logoMisses.length} logos had no capture to attach to: ${logoMisses.slice(0, 5).join(", ")}`);
if (failures.length) {
  console.log("\nfailures (re-run to retry, ingest is idempotent):");
  for (const f of failures.slice(0, 20)) console.log(`  ${f.id}: ${f.error}`);
}
console.log("\nNext: node scripts/archive-logos.mjs   (fetches the logo bytes into Storage)");
process.exit(failures.length ? 1 : 0);
