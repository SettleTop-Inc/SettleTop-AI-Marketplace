#!/usr/bin/env node
/**
 * DRAI pass 3 — ingest the catalogue into the registry.
 *
 *   node scripts/drai-ingest.mjs
 *   node scripts/drai-ingest.mjs --dry
 *
 * Joins the catalogue, the post bodies and the publisher's security statement
 * into one capture per agent and calls ingest_capture, exactly as the Microsoft
 * pass does. The gate in that function is the reason this pipeline exists in
 * the shape it does, and nothing here tries to work around it.
 *
 * The certification block is fetched once and shared by every capture, because
 * it is publisher-wide: the statement governs all DRAI listings and belongs to
 * none of them. That is also why it must be present — every DRAI evidence
 * value verifies against cert_detail fields rather than the post, so an empty
 * cert block silently costs every agent its evidence.
 */
import { readJsonl, dataPath, supabaseEnv, rpc, pool } from "./lib/marketplace.mjs";
import { ID, DOCS, parseSecurityStatement, toPayload } from "./lib/sources/drai.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const CONCURRENCY = 4;

const dry = process.argv.includes("--dry");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

const env = dry ? null : supabaseEnv();
const capturedAt = new Date().toISOString();

const agents = await readJsonl(dataPath(ID, "tiles.jsonl"));
if (!agents.length) {
  console.error(`No ${dataPath(ID, "tiles.jsonl")}. Run scripts/drai-catalog.mjs first.`);
  process.exit(1);
}
const details = new Map((await readJsonl(dataPath(ID, "details.jsonl"))).map((d) => [d.slug, d]));

// Fetched here rather than read from a file: the statement is small, it is the
// certification equivalent for every capture in this run, and a stale copy
// would attach last week's compliance posture to today's records.
const cert = parseSecurityStatement(
  await (await fetch(DOCS.security_compliance, { headers: { "user-agent": UA } })).text()
);
if (!cert.compliance.length || !cert.data_handling) {
  // Refuse rather than degrade. Ingesting now would write the whole catalogue
  // with no certification evidence and look like DRAI states nothing.
  console.error("Security statement did not parse — compliance or data_handling empty.");
  console.error("Refusing to ingest: every DRAI capture would lose its evidence.");
  process.exit(1);
}

let work = agents;
if (limit) work = work.slice(0, limit);

console.log(
  `${work.length} agents | ${details.size} with a post body | ` +
    `${cert.compliance.length} compliance sentences${dry ? " | DRY RUN" : ""}\n`
);

const tally = { created: 0, updated: 0, unchanged: 0, already_ingested: 0, failed: 0, rejected: 0 };
const failures = [];

await pool(work, CONCURRENCY, async (agent) => {
  const payload = toPayload({ agent, post: details.get(agent.slug) ?? null, cert, capturedAt });

  if (dry) {
    const e = payload.extract;
    console.log(
      `  DRY ${agent.slug.padEnd(38)} ${payload.capture_meta.capture_complete ? "full " : "thin "}` +
        `plans:${e.plans.length} cats:${e.categories.length} cert:${e.certification}`
    );
    return;
  }

  try {
    const r = await rpc(env, "ingest_capture", { payload });
    const status = r?.status ?? "unknown";
    tally[status] = (tally[status] ?? 0) + 1;
    tally.rejected += r?.evidence_rejected ?? 0;
    console.log(
      `  ${status.padEnd(16)} ${agent.slug.padEnd(38)} reach ${String(r?.reach ?? "-").padStart(3)} ${r?.risk ?? ""}` +
        (r?.evidence_rejected ? `  REJECTED ${r.evidence_rejected}` : "")
    );
  } catch (e) {
    tally.failed++;
    failures.push([agent.slug, e.message]);
    console.error(`  FAILED           ${agent.slug.padEnd(38)} ${e.message}`);
  }
});

if (dry) {
  console.log("\nDry run — nothing written.");
  process.exit(0);
}

console.log(
  `\ncreated ${tally.created} · updated ${tally.updated} · unchanged ${tally.unchanged ?? 0} · failed ${tally.failed}`
);

// evidence_rejected above zero means a value we put in `stated` was not found
// in the text the gate reads. For DRAI that is nearly always the same cause:
// the fact lives in the security statement but never reached a cert_detail
// field. The fix is to carry the text, never to assert the value anyway.
if (tally.rejected) {
  console.log(`\n${tally.rejected} evidence value(s) rejected by the gate.`);
  console.log("A stated value was not present in the fields the database verifies against.");
}
if (failures.length) for (const [slug, msg] of failures) console.log(`  ${slug}: ${msg}`);
process.exit(tally.failed ? 1 : 0);
