#!/usr/bin/env node
/**
 * Reconcile ingest.
 *
 * The capture skill dual-writes: Drive first (the durable "stored" event),
 * then ingest_capture() over the Supabase REST endpoint. This script is the
 * safety net for the second half — replay capture payloads that failed both
 * attempts, or backfill a directory of capture files.
 *
 *   node scripts/ingest.mjs ./captures            # every *.json in a folder
 *   node scripts/ingest.mjs ./captures/one.json   # a single file
 *   cat payload.json | node scripts/ingest.mjs -  # from stdin
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY. ingest_capture() is granted to
 * service_role and revoked from everyone else, so the publishable key the
 * website uses cannot reach it.
 *
 * Idempotent: a payload whose drive_file_id is already stored returns
 * "already_ingested" and changes nothing. Re-running is always safe.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_BASE || !SERVICE_KEY) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n" +
      "The service role key is in Supabase → Project Settings → API. Never commit it."
  );
  process.exit(1);
}

async function ingest(payload) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/ingest_capture`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ payload }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return JSON.parse(text);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Accepts either a capture payload ({capture_meta, extract}) or a bare capture
 * file. A bare file is wrapped so the original is preserved in capture.raw —
 * losing the raw observation is the one mistake that cannot be undone later.
 */
function toPayload(obj, filename) {
  if (obj.capture_meta && obj.extract) return obj;
  if (obj.capture_meta) {
    return {
      capture_meta: { ...obj.capture_meta, drive_file_name: obj.capture_meta.drive_file_name ?? filename },
      extract: obj.extract ?? obj,
      raw: obj,
      ingest_source: "reconcile",
    };
  }
  throw new Error(`${filename}: not a capture file, no capture_meta block`);
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/ingest.mjs <file|dir|->");
    process.exit(1);
  }

  let files = [];
  if (target === "-") {
    files = [{ name: "<stdin>", text: await readStdin() }];
  } else if (extname(target) === ".json") {
    files = [{ name: target, text: await readFile(target, "utf8") }];
  } else {
    const names = (await readdir(target)).filter((n) => n.endsWith(".json"));
    files = await Promise.all(
      names.map(async (n) => ({ name: n, text: await readFile(join(target, n), "utf8") }))
    );
  }

  const tally = { created: 0, updated: 0, already_ingested: 0, failed: 0, rejected: 0, changes: 0 };
  for (const f of files) {
    let payloads;
    try {
      const parsed = JSON.parse(f.text);
      payloads = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      console.error(`  ✗ ${f.name}: unparseable JSON — ${e.message}`);
      tally.failed++;
      continue;
    }
    for (const p of payloads) {
      try {
        const r = await ingest(toPayload(p, f.name));
        tally[r.status] = (tally[r.status] ?? 0) + 1;
        tally.rejected += r.evidence_rejected ?? 0;
        tally.changes += r.changes ?? 0;
        const id = p.capture_meta?.source_product_id ?? f.name;
        const note =
          r.status === "already_ingested"
            ? "already stored"
            : `${r.status}, reach ${r.reach}%, risk ${r.risk}` +
              (r.changes ? `, ${r.changes} change${r.changes === 1 ? "" : "s"}` : "") +
              (r.evidence_rejected ? `, ${r.evidence_rejected} evidence value(s) rejected` : "");
        console.log(`  ✓ ${id} — ${note}`);
      } catch (e) {
        tally.failed++;
        console.error(`  ✗ ${p.capture_meta?.source_product_id ?? f.name}: ${e.message}`);
      }
    }
  }

  console.log(
    `\ncreated ${tally.created} · updated ${tally.updated} · already stored ${tally.already_ingested} · failed ${tally.failed}`
  );
  console.log(`${tally.changes} change events recorded, ${tally.rejected} evidence values rejected as unverifiable`);
  if (tally.rejected > 0) {
    console.log(
      "Rejected values could not be found verbatim in their own capture text.\n" +
        "That is the honesty gate doing its job — investigate the capture, do not loosen the gate."
    );
  }
  process.exit(tally.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
