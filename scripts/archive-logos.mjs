#!/usr/bin/env node
/**
 * Archive product logos.
 *
 * The capture worker identifies WHICH image on a listing is the product logo —
 * that needs a live DOM and cannot be guessed from a filename. This script does
 * the other half: fetches the bytes, stores our own copy, and records a hash so
 * a later re-fetch can prove the publisher swapped the image.
 *
 *   node scripts/archive-logos.mjs            # everything not yet archived
 *   node scripts/archive-logos.mjs --limit 20
 *   node scripts/archive-logos.mjs --force    # re-archive even if already held
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY, and network access to the publisher CDNs
 * (catalogartifact.azureedge.net, store-images.s-microsoft.com).
 *
 * A URL on someone else's CDN is a pointer, not a capture. Until this runs, the
 * registry does not actually hold the logo, and v_logo_status says so.
 */
import { createHash } from "node:crypto";

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "logos";

if (!URL_BASE || !KEY) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;

const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function pending() {
  const state = force ? "in.(url_only_not_archived,archived)" : "eq.url_only_not_archived";
  const url =
    `${URL_BASE}/rest/v1/v_logo_status?state=${state}` +
    `&select=source_product_id,name,link_id,logo_url` +
    (limit ? `&limit=${limit}` : "");
  const res = await fetch(url, { headers: h });
  if (!res.ok) throw new Error(`list: ${res.status} ${await res.text()}`);
  return res.json();
}

const EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
};

async function archiveOne(row) {
  const res = await fetch(row.logo_url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const type = (res.headers.get("content-type") || "").split(";")[0].trim();
  if (!EXT[type]) throw new Error(`unexpected content-type ${type || "(none)"}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("empty body");

  const hash = createHash("sha256").update(buf).digest("hex");
  // path is stable per product, so re-archiving overwrites rather than piling up
  const path = `microsoft/${row.source_product_id}.${EXT[type]}`;

  const up = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...h, "Content-Type": type, "x-upsert": "true" },
    body: buf,
  });
  if (!up.ok) throw new Error(`upload ${up.status} ${await up.text()}`);

  const publicUrl = `${URL_BASE}/storage/v1/object/public/${BUCKET}/${path}`;
  const rec = await fetch(`${URL_BASE}/rest/v1/rpc/record_link_archive`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_link_id: row.link_id,
      p_archived_url: publicUrl,
      p_content_hash: hash,
      p_bytes: buf.length,
      p_content_type: type,
    }),
  });
  if (!rec.ok) throw new Error(`record ${rec.status} ${await rec.text()}`);
  return { bytes: buf.length, type, hash, publicUrl };
}

const rows = await pending();
if (rows.length === 0) {
  console.log("Nothing to archive. Every identified logo is already held.");
  console.log("If that is a surprise, check v_logo_status for no_logo_identified —");
  console.log("those need the capture worker's logo pass first, not this script.");
  process.exit(0);
}

console.log(`${rows.length} logo(s) to archive\n`);
let ok = 0;
const failed = [];
for (const row of rows) {
  try {
    const r = await archiveOne(row);
    ok++;
    console.log(`  ✓ ${row.name} — ${(r.bytes / 1024).toFixed(0)}KB ${r.type} ${r.hash.slice(0, 12)}`);
  } catch (e) {
    failed.push([row.source_product_id, e.message]);
    console.error(`  ✗ ${row.name} — ${e.message}`);
  }
}

console.log(`\narchived ${ok}, failed ${failed.length}`);
if (failed.length) {
  console.log("\nFailures are data, not noise: a 404 means the publisher removed the image");
  console.log("since capture, which is itself worth recording. Re-run to retry.");
  for (const [id, msg] of failed) console.log(`  ${id}: ${msg}`);
}
process.exit(failed.length ? 1 : 0);
