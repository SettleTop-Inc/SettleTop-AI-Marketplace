#!/usr/bin/env node
/**
 * AWS pass 2 of 3: read each product page, and filter.
 *
 *   node scripts/aws-detail.mjs                 # capped at DEFAULT_LIMIT pages
 *   node scripts/aws-detail.mjs --limit 2000    # one larger run, deliberately
 *   AWS_FULL_SWEEP=1 node scripts/aws-detail.mjs
 *
 * This is the expensive pass and it is the only place the category filter can
 * live, because a listing's categories are stated only on its own record. It
 * fetches /marketplace/pp/<id>, parses the embedded blob, and writes a details
 * row ONLY for listings inside AI Agents & Tools. On the measured hit rate a
 * full sweep is roughly 43,104 fetches for roughly 5,000 kept rows.
 *
 * THREE FILES, ONE WRITER EACH.
 *
 *   data/aws/ids.jsonl      aws-catalog.mjs writes it. Enumeration.
 *   data/aws/seen.jsonl     this pass writes it. One row per RESOLVED id,
 *                           including every reject. The resume ledger.
 *   data/aws/details.jsonl  this pass writes it. Kept listings only.
 *
 * WHY THE LEDGER EXISTS. The Microsoft resume pattern, `done = new Set(existing
 * .map(d => d.id))` at scripts/harvest-detail.mjs:34, does not transfer. It
 * works there because that pass keeps everything it fetches. Here roughly seven
 * eighths of what is fetched produces no output row, so resuming from
 * details.jsonl would refetch every rejected id on every run, forever: about
 * 38,000 wasted pages and 40 wasted minutes each time.
 *
 * WHY KEEPERS ARE A SEPARATE FILE rather than rows with a flag. aws-ingest.mjs
 * must be structurally incapable of seeing a reject. If rejects lived in the
 * file ingest reads, one filter bug would ingest 38,000 listings with null
 * everything, which is exactly the "never invent a value" failure this registry
 * exists to prevent. drai-catalog.mjs makes the same argument for keeping
 * tiles.jsonl apart from announced.jsonl, so this is the established precedent
 * here rather than a new idea.
 *
 * CHECKPOINTS ARE NOT AN OPTIMISATION. The existing detail passes write once at
 * the end, which is fine for five minutes and unacceptable for forty-five over
 * 43,104 pages: a crash at minute 40 would lose everything. Both files are
 * flushed every CHECKPOINT completions, and seen.jsonl is written LAST so the
 * worst case of a torn checkpoint is a re-fetch rather than a lost keeper.
 */
import { fetchText, pool, readJsonl, writeJsonl, dataPath, parseCliArgs } from "./lib/marketplace.mjs";
import {
  ID,
  PRODUCT_URL,
  PREDICATE_VERSION,
  RECORD_VERSION,
  REVERSES_A_KEEP,
  parseProductPage,
} from "./lib/sources/aws.mjs";

const IDS = dataPath(ID, "ids.jsonl");
const SEEN = dataPath(ID, "seen.jsonl");
const OUT = dataPath(ID, "details.jsonl");

/**
 * Measured: 36 pages at concurrency 4 ran clean at 16.6 pages/sec, p50 201 ms,
 * with zero 429 and zero 503. DO NOT RAISE IT. Concurrency above 4 has never
 * been tested against AWS, and every response was a CloudFront MISS with
 * cache-control no-cache, so each request is real origin work rather than an
 * edge hit. A 2.2 second burst is not evidence about a 45 minute sweep.
 *
 * No fixed inter-request delay. At 225 ms mean latency and c=4, the 250 ms
 * pause harvest-certification.mjs uses would roughly halve throughput for no
 * measured benefit. fetchText's own 400 * 2^n backoff on 403, 429 and 5xx is
 * the per-request throttle handling, and the brake below is the global one.
 */
const CONCURRENCY = 4;
const CHECKPOINT = 500;

/**
 * The adaptive brake. fetchText backs off per request, which is the wrong shape
 * for a sustained throttle: 43,000 individual backoffs is not a response, it is
 * a very slow failure. Counting refusals across the run and stopping lets the
 * operator resume later from the ledger at no cost.
 */
const THROTTLE_STOP = 20;

/**
 * The default cap on one run, and why an unbounded default would be wrong here.
 *
 * Every other stage in this repo reads what its catalog enumerated and stops.
 * This one would read 43,104 product pages: about 45 minutes, about 4.8 GB on
 * the wire, and roughly 19 GB parsed. That is not a thing to start by accident,
 * and `npm run harvest` with no arguments would start it, because the driver
 * runs every source's every stage with no flags.
 *
 * So a run with no --limit takes this cap and says so. The pass is fully
 * resumable, so repeated runs converge on the whole catalogue, and after the
 * first sweep a nightly run only has the sitemap delta to read and never comes
 * near the cap at all.
 *
 * Set AWS_FULL_SWEEP=1 to remove it, or pass --limit for one larger run. That
 * is the opt-in the recon asks for when it says to stage the sweep rather than
 * start it: discovering a throttle at request 200 costs seconds, discovering it
 * at request 40,000 costs the run.
 *
 * WHY THE DEFAULT IS THE PILOT SIZE AND NOT THE STAGING SIZE. 2,000 was the
 * first figure here, and it is a reasonable second stage, but it is not a safe
 * default: `npm run harvest` passes no flags, so whatever this number says is
 * what an unattended run fetches from AWS with nobody asking for it. The
 * sanctioned pilot budget is 200 pages, so 200 is the number that may fire by
 * accident. Raising it is a decision, and a decision should be typed.
 */
const DEFAULT_LIMIT = 200;
const FULL_SWEEP = process.env.AWS_FULL_SWEEP === "1";

const { limit: limitFlag } = parseCliArgs({ numbers: ["limit"] });
const limit = limitFlag || (FULL_SWEEP ? 0 : DEFAULT_LIMIT);

const ids = await readJsonl(IDS);
if (!ids.length) {
  console.error(`No ${IDS}. Run scripts/aws-catalog.mjs first.`);
  process.exit(1);
}

const ledger = new Map((await readJsonl(SEEN)).map((r) => [r.id, r]));
const keepers = new Map((await readJsonl(OUT)).map((r) => [r.id, r]));

/**
 * A keeper written by the parser now in this file, rather than an earlier one.
 *
 * Same job as drai-detail.mjs's currentShape(): correcting the parser should
 * cost a re-run, not a manual delete. The stamp is explicit rather than
 * inferred from whichever field happened to be added last, so bumping it is a
 * deliberate act taken in the same commit as the parser change.
 */
const currentShape = (d) => d?.record_version === RECORD_VERSION;

/**
 * What still needs fetching.
 *
 * Terminal outcomes are skipped. "unreadable" is always retried, because it
 * means a network failure, a missing blob or a template change, none of which
 * is a statement about the product. The predicate stamp is what makes widening
 * the category filter an ordinary resumable run instead of a blind re-sweep:
 * bump PREDICATE_VERSION and every stale decision is re-read, nothing else.
 */
const isStale = (r) =>
  !r ||
  r.outcome === "unreadable" ||
  r.predicate_version !== PREDICATE_VERSION ||
  // A torn checkpoint, or a keeper from an older parser. Both self heal, and
  // the first is the reason seen.jsonl is written after details.jsonl.
  (r.outcome === "kept" && !currentShape(keepers.get(r.id)));

let todo = ids.filter(({ id }) => isStale(ledger.get(id)));
const backlog = todo.length;
if (limit) todo = todo.slice(0, limit);

const resolved = ids.length - backlog;
console.log(
  `${ids.length.toLocaleString()} ids | ${resolved.toLocaleString()} already resolved | ` +
    `${backlog.toLocaleString()} to read` +
    (limit && backlog > limit ? `, capped at ${limit.toLocaleString()} this run` : "") +
    `\npredicate ${PREDICATE_VERSION}, record ${RECORD_VERSION}, concurrency ${CONCURRENCY}\n`
);
if (!limitFlag && !FULL_SWEEP && backlog > DEFAULT_LIMIT) {
  console.log(
    `Capped at the ${DEFAULT_LIMIT.toLocaleString()} page default. Reading all ${backlog.toLocaleString()} ` +
      "would be about 45 minutes and 4.8 GB.\nThis pass resumes, so re-running works through the rest " +
      `${DEFAULT_LIMIT.toLocaleString()} at a time. --limit N raises it for one run, AWS_FULL_SWEEP=1 removes it.\n`
  );
}
if (!todo.length) {
  console.log("nothing to do");
  process.exit(0);
}

const tally = { kept: 0, out_of_category: 0, gone: 0, identity_mismatch: 0, unreadable: 0 };
const problems = [];
let throttled = 0;
let stopped = false;
let sinceFlush = 0;

async function flush() {
  // details.jsonl first. If the process dies between the two writes, the
  // ledger simply has not learned about the keeper yet and the id is re-read.
  await writeJsonl(OUT, [...keepers.values()]);
  await writeJsonl(SEEN, [...ledger.values()]);
}

const started = Date.now();

/**
 * One id, from request to ledger row. Never throws to pool().
 *
 * pool() catches every worker exception into its results array
 * (marketplace.mjs:129-133) and this pass never reads that array, so an
 * exception escaping here would write no file, increment no tally and name no
 * problem. The run would print a healthy-looking report over a silently
 * smaller number of pages: `read` is the sum of the tally, so a shape change
 * that made the parser throw on 160 of 2,000 pages would simply print 1,840
 * pages read, with every other line looking fine and the backlog figure
 * indistinguishable from ordinary remaining work.
 */
async function readOne(id) {
  const prior = ledger.get(id);
  const attempts = (prior?.attempts ?? 0) + 1;
  // Declared before the try so the catch below can still file a ledger row.
  let res = { ok: false, status: 0, url: null, html: null };

  const note = (outcome, extra = {}) => {
    ledger.set(id, {
      id,
      outcome,
      checked_at: new Date().toISOString(),
      predicate_version: PREDICATE_VERSION,
      final_url: res.url ?? null,
      status: res.status ?? 0,
      attempts,
      ...extra,
    });
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  };

  try {
    res = await fetchText(PRODUCT_URL(id));

    if (!res.ok) {
      // 403, 429 and 5xx already exhausted fetchText's retries by the time they
      // arrive here, so seeing one means a sustained refusal, not a blip.
      if (res.status === 429 || res.status === 503 || res.status === 403 || res.status === 0) {
        throttled++;
        if (throttled === 1) {
          console.log(`\n  first refusal from AWS: http ${res.status} on ${id}`);
        }
        if (throttled >= THROTTLE_STOP && !stopped) {
          stopped = true;
          console.log(
            `\n  ${throttled} refusals: stopping rather than grinding through backoffs.` +
              " The ledger keeps the progress, so re-running resumes here."
          );
        }
      }
      note("unreadable", { reason: `http ${res.status} ${res.error ?? ""}`.trim() });
      problems.push({ id, outcome: "unreadable", reason: `http ${res.status}` });
      return;
    }

    const parsed = parseProductPage({ id, html: res.html, url: res.url });

    /**
     * A VERDICT THAT REVERSES REMOVES THE RECORD THE LAST RUN WROTE.
     *
     * details.jsonl is rewritten from the keepers map, and aws-ingest.mjs
     * reads that file and applies no membership test of its own beyond the
     * stamps a kept row carries. Without this line a listing kept on an
     * earlier run and rejected on a later one would keep its row: the ledger
     * would say out_of_category, the summary would print a correct-looking
     * reject count, and ingest would still load the listing with a fresh
     * captured_at, asserting a current in-category observation of a product
     * AWS had delisted or moved out. Nothing on screen would contradict it,
     * and the file the operator would check says the opposite of the file
     * ingest reads.
     *
     * Not hypothetical. Bumping RECORD_VERSION or widening the predicate,
     * both of which this design plans for and one of which has already
     * happened, marks every keeper stale and so sends every keeper back
     * through here.
     *
     * Which outcomes reverse a keep is the adapter's vocabulary, not this
     * script's, so the set lives beside the outcomes themselves. It excludes
     * `unreadable` on purpose.
     */
    if (REVERSES_A_KEEP.has(parsed.outcome)) keepers.delete(id);

    if (parsed.outcome === "kept") {
      keepers.set(id, parsed.record);
      note("kept");
    } else if (parsed.outcome === "identity_mismatch") {
      // Never re-filed under the id the page stated. That is a second product
      // arriving through the wrong door, and it should be a visible anomaly
      // rather than an automatic substitution.
      note("identity_mismatch", { stated_id: parsed.stated_id, reason: parsed.reason });
      problems.push({ id, outcome: "identity_mismatch", reason: parsed.reason });
    } else if (parsed.outcome === "unreadable") {
      note("unreadable", { reason: parsed.reason, http_bytes: res.html.length });
      problems.push({ id, outcome: "unreadable", reason: parsed.reason });
    } else if (parsed.outcome === "out_of_category") {
      /**
       * The categories the verdict was reached on are stored WITH the verdict.
       *
       * These rows are permanent and a full sweep makes roughly 38,000 of
       * them. The predicate stamp exists so the owner can widen the filter and
       * re-read, but a row saying only "no" cannot answer which rejections a
       * proposed wider predicate would flip without fetching all 38,000 pages
       * again. The names cost a few bytes a row and make the reject set
       * auditable offline, which is the argument this file already makes for
       * keeping a ledger at all. parseProductPage has always returned them.
       */
      note("out_of_category", { categories: parsed.categories ?? [] });
    } else {
      note(parsed.outcome, { reason: parsed.reason });
    }
  } catch (e) {
    // Retryable, like any other unreadable: an exception is a fact about our
    // reading, not about the product. Named in the summary rather than lost.
    const reason = `threw: ${e.message}`.slice(0, 300);
    note("unreadable", { reason });
    problems.push({ id, outcome: "unreadable", reason });
  }
}

await pool(
  todo,
  CONCURRENCY,
  async ({ id }) => {
    if (stopped) return;
    await readOne(id);

    // The worker returns nothing on purpose. pool() keeps every return value
    // for the whole run in an array as long as the input, so a worker returning
    // the parsed blob would hold gigabytes across 43,104 items. Letting the
    // html and the blob fall out of scope keeps the live set to the four pages
    // actually in flight.
    if (++sinceFlush >= CHECKPOINT) {
      sinceFlush = 0;
      await flush();
    }
  },
  (d, n) => process.stdout.write(`\r  ${d}/${n}`)
);

await flush();

const secs = (Date.now() - started) / 1000;
const read = Object.values(tally).reduce((a, b) => a + b, 0);
const decided = tally.kept + tally.out_of_category;

console.log(`\n\n${read} pages read in ${secs.toFixed(1)}s (${(read / secs).toFixed(1)}/sec)`);
console.log(`  kept, in AI Agents & Tools                   : ${tally.kept}`);
console.log(`  rejected, out of AI Agents & Tools           : ${tally.out_of_category}`);
// Printed even at zero. Detection of the gone case rests on an internal AWS
// build path string; if AWS changes it, gone products start being retried on
// every run and this line staying at zero is the only visible symptom.
console.log(`  gone, sitemap lists it and AWS serves nothing : ${tally.gone}`);
console.log(`  identity mismatch, page states another id    : ${tally.identity_mismatch}`);
console.log(`  failed to read (retried next run)            : ${tally.unreadable}`);
if (decided) {
  console.log(`\nkeep rate this run: ${((100 * tally.kept) / decided).toFixed(1)}% of pages that stated a category`);
}
console.log(`${keepers.size} listings held -> ${OUT}`);
console.log(`${ledger.size} decisions held -> ${SEEN}`);

if (tally.unreadable) {
  // Never capped and silently dropped: an id that stops failing is a product
  // that came back, and losing it quietly is worse than a few wasted requests.
  const stubborn = [...ledger.values()].filter((r) => r.outcome === "unreadable" && r.attempts >= 3);
  console.log(`\n${tally.unreadable} failed to read. Re-run to retry, reading is resumable.`);
  if (stubborn.length) console.log(`${stubborn.length} of them have now failed 3 or more times.`);
  for (const p of problems.slice(0, 10)) console.log(`  ${p.id}: ${p.reason}`);
  if (problems.length > 10) console.log(`  and ${problems.length - 10} more`);
}

const left = ids.filter(({ id }) => isStale(ledger.get(id))).length;
if (left) console.log(`\n${left.toLocaleString()} ids still to read. Re-run, or raise --limit.`);

/**
 * A run AWS refused is a FAILED run, and it has to exit saying so.
 *
 * harvest.mjs treats any zero exit as `{ok: true}` and moves straight on
 * (harvest.mjs:57-59), so returning 0 here after twenty refusals would print
 * "aws ok" and then run aws-ingest.mjs live against whatever partial
 * details.jsonl the run managed to write. aws-ingest.mjs already ends with
 * process.exit(failures.length ? 1 : 0), so the convention exists in this
 * source; this pass was simply not following it.
 *
 * Only the throttle stop is fatal. Ordinary unreadable rows are the normal
 * cost of reading 43,104 pages and are retried on the next run by design.
 */
if (stopped) {
  console.log("\nAWS refused this run, so it is not a complete pass. Re-run later.");
  process.exit(1);
}
