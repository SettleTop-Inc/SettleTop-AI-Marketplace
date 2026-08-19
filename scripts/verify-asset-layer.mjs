#!/usr/bin/env node
/**
 * Phase 1 verification for the registry asset layer.
 *
 *   node scripts/verify-asset-layer.mjs --baseline   # before the migrations
 *   node scripts/verify-asset-layer.mjs              # after
 *
 * Point it at a branch database by exporting NEXT_PUBLIC_SUPABASE_URL and the
 * two keys before running. The branch has to pass this in full before
 * production sees the migrations.
 *
 * Grants are checked by reading as anon over PostgREST rather than by reading
 * information_schema. The outage this guards against was a read that returned
 * {} to the site, not a missing catalog row, so the check is the read itself.
 *
 * Every paged read orders by a unique key. PostgREST caps a response at 1000
 * rows and pages without a total order overlap; both have silently truncated
 * this project's reads before.
 */
import fs from "node:fs";

const BASELINE = "data/asset-layer-baseline.json";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const head = (key) => ({ apikey: key, Authorization: `Bearer ${key}` });

async function count(path) {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    headers: { ...head(ANON), Prefer: "count=exact", Range: "0-0" },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return Number(r.headers.get("content-range").split("/")[1]);
}

async function rpc(key, fn, body) {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...head(key), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

/** anon must be able to SELECT from every public read surface. */
const READ_SURFACES = [
  "v_registry_card", "v_asset_passport", "v_asset_change_feed",
  "v_registry_stats", "v_logo_status",
];
const NEW_TABLES = ["asset", "asset_slug", "asset_merge"];

async function snapshot() {
  const r = await fetch(`${URL_BASE}/rest/v1/v_registry_stats?select=*`, { headers: head(ANON) });
  const stats = (await r.json())[0];
  return { stats, listings: await count("v_registry_card?select=asset_id") };
}

const baselineMode = process.argv.includes("--baseline");

if (baselineMode) {
  const snap = await snapshot();
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(snap, null, 2));
  console.log(`baseline written to ${BASELINE}`);
  console.log(JSON.stringify(snap, null, 2));
  process.exit(0);
}

console.log("Phase 1 verification\n");

// 1. anon can read every public surface, including the new tables.
for (const v of [...READ_SURFACES, ...NEW_TABLES]) {
  const r = await fetch(`${URL_BASE}/rest/v1/${v}?select=*&limit=1`, { headers: head(ANON) });
  record(`anon can select from ${v}`, r.ok, r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}`);
}

// 2. Counts and the 1:1 invariant.
const listings = await count("v_registry_card?select=asset_id");
const assets = await count("asset?select=id");
const slugs = await count("asset_slug?select=slug");
const canonical = await count("asset_slug?select=slug&is_canonical=is.true");
const retired = await count("asset?select=id&merged_into=not.is.null");

const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : null;
record("baseline exists", Boolean(base), base ? "" : `run --baseline first`);
if (base) {
  record("listing count unchanged", listings === base.listings, `${listings} vs ${base.listings}`);
}
record("one asset per listing", assets === listings, `${assets} assets, ${listings} listings`);
record("one canonical slug per asset", canonical === assets, `${canonical} canonical, ${assets} assets`);
record("slug count is at least the asset count", slugs >= assets, `${slugs} slugs`);
record("nothing retired yet in phase 1", retired === 0, `${retired} retired`);

// 3. v_registry_stats is identical, field by field.
if (base) {
  const now = (await snapshot()).stats;
  for (const k of Object.keys(base.stats)) {
    record(`v_registry_stats.${k} unchanged`, String(now[k]) === String(base.stats[k]),
      `${now[k]} vs ${base.stats[k]}`);
  }
}

// 4. v_asset_change_feed exposes both ids.
{
  const r = await fetch(`${URL_BASE}/rest/v1/v_asset_change_feed?select=listing_id,asset_id&limit=1`,
    { headers: head(ANON) });
  record("v_asset_change_feed exposes listing_id and asset_id", r.ok,
    r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}`);
}

// 5. The write path still executes. A function that still names `asset` after
//    the rename fails here and nowhere else. Neither call writes anything.
if (!SERVICE) {
  record("write path exercised", false, "SKIPPED: SUPABASE_SERVICE_ROLE_KEY not set. This is a FAIL, not a skip.");
} else {
  const a = await rpc(SERVICE, "ingest_capture", { payload: {} });
  record("ingest_capture reaches its own validation",
    a.text.includes("capture_meta.source_product_id"),
    a.text.slice(0, 110));

  const b = await rpc(SERVICE, "set_capture_logo",
    { p_product_id: "__verify_no_such_product__", p_url: "https://example.invalid/x.png", p_marketplace_id: "microsoft" });
  record("set_capture_logo executes and reports no_capture",
    b.text.includes("no_capture"), b.text.slice(0, 110));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
