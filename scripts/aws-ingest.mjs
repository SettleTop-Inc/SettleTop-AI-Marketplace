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
import { ID, CATEGORY_LABEL, PREDICATE_VERSION, RECORD_VERSION, toPayload } from "./lib/sources/aws.mjs";

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
 * BOTH STAMPS ARE ENFORCED, and a row failing either is not ingested.
 *
 * A kept row carries the predicate that admitted it and the extractor that
 * read it. Each has its own way of being wrong and neither is survivable here.
 *
 * An older PREDICATE means the listing was admitted by a rule the registry no
 * longer applies, so loading it would put a listing in the category on the
 * strength of a decision nobody would make today. That is a membership error.
 *
 * An older RECORD VERSION means the row was written by a parser that has since
 * been corrected, and the correction is the point: a parser is not only ever
 * widened. aws-record-v1 put AWS's own https://aws.amazon.com/premiumsupport/
 * into extract.product_links, which v2 removed because it is AWS's
 * infrastructure support rather than the publisher's channel and a reader
 * seeing it among a product's links would take it for one. The write path
 * turns each entry there into a capture_link of kind 'product', so loading a
 * v1 row would put that URL in front of a reader as the publisher's, with
 * nothing on screen or in this summary saying so. Measured on the pilot
 * corpus: 109 of 195 v1 records carry it.
 *
 * The cost of refusing is a re-run and never a manual delete: aws-detail.mjs
 * treats a keeper carrying either older stamp as stale and re-reads it, which
 * is the rule drai-detail.mjs already follows for an older parse shape. The
 * cost of NOT refusing is silent, which is the deciding difference.
 */
const current = (r) =>
  r.predicate_version === PREDICATE_VERSION && r.record_version === RECORD_VERSION;
const stalePredicate = records.filter((r) => r.predicate_version !== PREDICATE_VERSION);
const staleRecord = records.filter(
  (r) => r.predicate_version === PREDICATE_VERSION && r.record_version !== RECORD_VERSION
);
let work = records.filter(current);
if (limit) work = work.slice(0, limit);

const complete = work.filter((r) => r.pricing_published).length;
console.log(
  `${records.length} kept listings in ${CATEGORY_LABEL} | ${work.length} to load | ` +
    `${complete} publish a price, ${work.length - complete} do not` +
    (stalePredicate.length ? ` | ${stalePredicate.length} skipped: older predicate` : "") +
    (staleRecord.length ? ` | ${staleRecord.length} skipped: older record version` : "") +
    (dry ? " | DRY RUN" : "") +
    "\n"
);
// Named, never merely counted. A skipped row is work the operator has to ask
// for, and a number with no instruction beside it reads like a note.
if (stalePredicate.length) {
  console.log(`predicate is now ${PREDICATE_VERSION}. Re-run scripts/aws-detail.mjs to re-read the rest.\n`);
}
if (staleRecord.length) {
  console.log(
    `${staleRecord.length} rows were written by an older extractor. The parser is now ` +
      `${RECORD_VERSION}, so those rows are not loaded: re-run scripts/aws-detail.mjs, which ` +
      "re-reads them, then run this again.\n"
  );
}
if (!work.length) {
  console.log("Nothing current to load. Re-read first.");
  process.exit(0);
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
