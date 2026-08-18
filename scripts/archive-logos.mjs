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
import { pool } from "./lib/marketplace.mjs";

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "logos";
const CONCURRENCY = 6;

if (!URL_BASE || !KEY) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;

const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };

/**
 * PostgREST caps a response at 1000 rows and says nothing about it — no error,
 * no truncation flag, just a short array. Asking for 6,820 pending logos got
 * exactly 1000 back, which read as "1000 logos to archive" when the real
 * backlog was nearly seven times that. Page explicitly with Range so the
 * caller gets the whole set or a real failure, never a silent slice.
 */
const PAGE = 1000;

async function pending() {
  const state = force ? "in.(url_only_not_archived,archived)" : "eq.url_only_not_archived";
  const all = [];
  for (let from = 0; ; from += PAGE) {
    // A page is capped by whichever is smaller: the page size or what is left
    // of an explicit --limit.
    const want = limit ? Math.min(PAGE, limit - all.length) : PAGE;
    if (want <= 0) break;
    const url =
      `${URL_BASE}/rest/v1/v_logo_status?state=${state}` +
      `&select=marketplace_id,source_product_id,name,link_id,logo_url` +
      // Ordered by a unique column: link_id is one row per capture link, so no
      // two rows can straddle a page boundary and be served twice or skipped.
      `&order=link_id.asc` +
      `&offset=${from}&limit=${want}`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`list: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    all.push(...rows);
    if (rows.length < want) break;
  }
  return all;
}

/**
 * Supabase Storage rejects keys containing characters outside a small safe set,
 * and 120 products carry AppSource-style ids full of pipes —
 * PUBID.publisher|AID.offer|PAPPID.guid — which come back as 400 InvalidKey.
 *
 * Only out-of-range characters are rewritten, so every id that was already
 * legal keeps byte-identical the path it was archived under; the logos already
 * in the bucket are not orphaned by this change. Where a rewrite does happen a
 * short digest of the original id is appended, so two ids that differ only in
 * the characters being replaced cannot collide on one object.
 */
const STORAGE_SAFE = /[^A-Za-z0-9!\-_.*'()]/g;

/**
 * The bucket prefix is the marketplace, not a constant. It was hardcoded to
 * "microsoft/" when there was only one source; a DRAI slug written under that
 * prefix would claim to be a Microsoft product, and two sources are free to
 * mint the same slug.
 *
 * Existing objects are untouched by this change: Microsoft rows carry
 * marketplace_id "microsoft", so they resolve to byte-identical paths and the
 * 6,820 logos already in the bucket stay where they are.
 */
function storageKey(marketplaceId, sourceProductId, ext) {
  const safe = sourceProductId.replace(STORAGE_SAFE, "-");
  const stem =
    safe === sourceProductId
      ? sourceProductId
      : `${safe}-${createHash("sha256").update(sourceProductId).digest("hex").slice(0, 8)}`;
  return `${marketplaceId}/${stem}.${ext}`;
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
  const path = storageKey(row.marketplace_id, row.source_product_id, EXT[type]);

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

console.log(`${rows.length} logo(s) to archive, ${CONCURRENCY} at a time\n`);
let ok = 0;
const failed = [];

// Each logo is a fetch from a publisher CDN followed by an upload to Storage,
// and the two are unrelated between products — so awaiting them one at a time
// spent almost the whole run idle on network. Every other harvest pass already
// runs its work through pool(); this one was the exception, and at ~5,500 rows
// that is the difference between minutes and hours.
//
// Deliberately modest, and lower than the detail pass's 8: this hits publisher
// CDNs and our own Storage at once, and the point is to stop being serial, not
// to extract the last request per second from someone else's infrastructure.
await pool(rows, CONCURRENCY, async (row) => {
  try {
    const r = await archiveOne(row);
    ok++;
    console.log(`  ✓ ${row.name} — ${(r.bytes / 1024).toFixed(0)}KB ${r.type} ${r.hash.slice(0, 12)}`);
  } catch (e) {
    failed.push([row.source_product_id, e.message]);
    console.error(`  ✗ ${row.name} — ${e.message}`);
  }
});

console.log(`\narchived ${ok}, failed ${failed.length}`);
if (failed.length) {
  // Do not characterise every failure as a publisher 404. Six of these were
  // Storage rejecting our own object key, and calling that a removed image
  // sends the reader looking at the wrong system.
  console.log("\nFailures are data, not noise. A fetch 404 means the publisher removed the");
  console.log("image since capture, which is worth recording; anything else is ours to fix.");
  console.log("Re-run to retry — archiving is resumable and skips what is already held.");
  for (const [id, msg] of failed) console.log(`  ${id}: ${msg}`);
}
process.exit(failed.length ? 1 : 0);
