#!/usr/bin/env node
/**
 * DRAI pass 0 — the publisher documents.
 *
 *   node scripts/drai-docs.mjs
 *
 * Runs BEFORE the agents, and that order is not cosmetic: every DRAI capture
 * copies text out of the security statement into cert_detail, and the database
 * verifies evidence against those fields. Capture an agent first and its
 * certification block is empty.
 *
 * A security statement, privacy policy, AI ethics policy and set of terms
 * govern every listing from the publisher and belong to none of them. Storing
 * each once and pointing at it beats copying it into fifteen captures, and it
 * makes a quiet edit to a published security posture provable rather than
 * invisible.
 *
 * ingest_publisher_document hashes the text, so re-running is free: unchanged
 * writes nothing, and a revision keeps the old row rather than overwriting it.
 */
import { supabaseEnv, rpc } from "./lib/marketplace.mjs";
import { ID, DOCS, PUBLISHER, parseSecurityStatement } from "./lib/sources/drai.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const dry = process.argv.includes("--dry");
const env = dry ? null : supabaseEnv();
const capturedAt = new Date().toISOString();

const text = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "’")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "​")
    .join("\n");

console.log(`${Object.keys(DOCS).length} DRAI publisher documents${dry ? " | DRY RUN" : ""}\n`);

const tally = { created: 0, revised: 0, unchanged: 0, failed: 0 };

for (const [doc_type, url] of Object.entries(DOCS)) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const full_text = text(await res.text());
    if (full_text.length < 500) throw new Error(`suspiciously short (${full_text.length} chars)`);

    const payload = {
      marketplace_id: ID,
      publisher: PUBLISHER,
      doc_type,
      title: full_text.split("\n")[0]?.slice(0, 200) ?? doc_type,
      url,
      captured_at_utc: capturedAt,
      full_text,
    };

    if (dry) {
      console.log(`  DRY  ${doc_type.padEnd(20)} ${full_text.length} chars`);
      continue;
    }
    const r = await rpc(env, "ingest_publisher_document", { payload });
    const status = r?.status ?? "unknown";
    tally[status] = (tally[status] ?? 0) + 1;
    console.log(`  ${status.padEnd(10)} ${doc_type.padEnd(20)} ${full_text.length} chars`);
  } catch (e) {
    tally.failed++;
    console.error(`  FAILED     ${doc_type.padEnd(20)} ${e.message}`);
  }
}

// The security statement is the certification equivalent, so a parse failure
// here silently empties cert_detail on every agent captured afterwards. Say so
// loudly rather than letting the agent pass produce evidence-free records.
if (!dry) {
  try {
    const html = await (await fetch(DOCS.security_compliance, { headers: { "user-agent": UA } })).text();
    const cert = parseSecurityStatement(html);
    const missing = ["hosting", "data_location", "data_handling"].filter((k) => !cert[k]);
    console.log(
      `\ncert_detail: ${cert.compliance.length} compliance sentence(s)` +
        (missing.length ? `, MISSING ${missing.join(", ")}` : ", all fields present")
    );
    for (const c of cert.compliance) console.log(`  • ${c.slice(0, 100)}…`);
  } catch (e) {
    console.error(`\ncert_detail: could not parse the security statement (${e.message})`);
  }
}

console.log(`\ncreated ${tally.created ?? 0} · revised ${tally.revised ?? 0} · unchanged ${tally.unchanged ?? 0} · failed ${tally.failed}`);
process.exit(tally.failed ? 1 : 0);
