#!/usr/bin/env node
/**
 * AWS pass 2 of 3: read each product page, and filter.
 *
 *   node scripts/aws-detail.mjs --limit 200
 *   node scripts/aws-detail.mjs
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
import { ID, PRODUCT_URL, PREDICATE_VERSION, parseProductPage } from "./lib/sources/aws.mjs";

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

const { limit } = parseCliArgs({ numbers: ["limit"] });

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
 * cost a re-run, not a manual delete. term_types was the last field added, so
 * a keeper without it predates the current extraction and is re-read.
 */
const currentShape = (d) => Array.isArray(d?.term_types);

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
    (limit && backlog > limit ? `, capped at ${limit} this run` : "") +
    `\npredicate ${PREDICATE_VERSION}, concurrency ${CONCURRENCY}\n`
);
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

await pool(
  todo,
  CONCURRENCY,
  async ({ id }) => {
    if (stopped) return;

    const prior = ledger.get(id);
    const attempts = (prior?.attempts ?? 0) + 1;
    const res = await fetchText(PRODUCT_URL(id));

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
    } else {
      note(parsed.outcome, { reason: parsed.reason });
    }

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
