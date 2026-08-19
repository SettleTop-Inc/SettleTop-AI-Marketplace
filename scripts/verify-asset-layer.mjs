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
 *
 * Every check runs through check(), below, which turns a thrown error into a
 * recorded FAIL instead of aborting the process. Tasks 3 to 7 leave the
 * database in intermediate states where several objects can be absent at
 * once, and a harness that stops at the first missing one tells us almost
 * nothing about the rest. The run always reaches the end and always prints
 * the full tally; the exit code is still non-zero if anything failed.
 *
 * --baseline validates the snapshot before writing it: every v_registry_stats
 * field present, listings a positive integer. Everything in phase 1 is
 * measured against that file, so a partial snapshot must never be written
 * silently, and the check run refuses to compare against one that is.
 */
import fs from "node:fs";

const BASELINE = "data/asset-layer-baseline.json";
const EXPECTED_STATS = [
  "agents", "marketplaces", "certified", "attested",
  "mean_reach", "captures", "changes", "last_captured_at", "publishers",
];

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

/** Runs one check. A thrown error becomes a recorded FAIL, never an abort,
 * so one missing table never hides the results of every check after it. */
const check = async (name, fn) => {
  try {
    const { ok, detail } = await fn();
    record(name, ok, detail);
  } catch (e) {
    record(name, false, `threw: ${String(e?.message ?? e).slice(0, 120)}`);
  }
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
  if (!r.ok) throw new Error(`v_registry_stats: ${r.status} ${await r.text()}`);
  const stats = (await r.json())[0];
  const listings = await count("v_registry_card?select=asset_id");
  return { stats, listings };
}

/** True only when every expected stats field is present and listings is a
 * positive integer. Gates both the --baseline write and any comparison
 * against an existing baseline file, so a hole is never treated as real. */
function isCompleteSnapshot(snap) {
  if (!snap || typeof snap !== "object") return false;
  if (!Number.isInteger(snap.listings) || snap.listings <= 0) return false;
  if (!snap.stats || typeof snap.stats !== "object") return false;
  return EXPECTED_STATS.every((k) => snap.stats[k] !== undefined && snap.stats[k] !== null);
}

function missingFields(snap) {
  const missing = [];
  if (!Number.isInteger(snap?.listings) || snap.listings <= 0) missing.push("listings");
  for (const k of EXPECTED_STATS) {
    if (!snap?.stats || snap.stats[k] === undefined || snap.stats[k] === null) missing.push(`stats.${k}`);
  }
  return missing;
}

const baselineMode = process.argv.includes("--baseline");

if (baselineMode) {
  const snap = await snapshot();
  if (!isCompleteSnapshot(snap)) {
    console.error(`baseline NOT written: snapshot is incomplete, missing ${missingFields(snap).join(", ")}`);
    console.error(JSON.stringify(snap, null, 2));
    process.exit(1);
  }
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(snap, null, 2));
  console.log(`baseline written to ${BASELINE}`);
  console.log(JSON.stringify(snap, null, 2));
  process.exit(0);
}

console.log("Phase 1 verification\n");

// 1. anon can read every public surface, including the new tables.
for (const v of [...READ_SURFACES, ...NEW_TABLES]) {
  await check(`anon can select from ${v}`, async () => {
    const r = await fetch(`${URL_BASE}/rest/v1/${v}?select=*&limit=1`, { headers: head(ANON) });
    return { ok: r.ok, detail: r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}` };
  });
}

// The pre-rename listings table is also called `asset`, so readability alone
// proves nothing. `merged_into` exists only on the asset layer's own table.
await check("asset is the new asset table, not the pre-rename listings table", async () => {
  const r = await fetch(`${URL_BASE}/rest/v1/asset?select=merged_into&limit=1`, { headers: head(ANON) });
  return { ok: r.ok, detail: r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}` };
});

// 2. Counts and the 1:1 invariant. Each check fetches what it needs on its
// own, so one missing table fails only the checks that depend on it.
await check("one asset per listing", async () => {
  const listings = await count("v_registry_card?select=asset_id");
  const assets = await count("asset?select=id");
  return { ok: assets === listings, detail: `${assets} assets, ${listings} listings` };
});

await check("one canonical slug per asset", async () => {
  const assets = await count("asset?select=id");
  const canonical = await count("asset_slug?select=slug&is_canonical=is.true");
  return { ok: canonical === assets, detail: `${canonical} canonical, ${assets} assets` };
});

await check("slug count is at least the asset count", async () => {
  const assets = await count("asset?select=id");
  const slugs = await count("asset_slug?select=slug");
  return { ok: slugs >= assets, detail: `${slugs} slugs, ${assets} assets` };
});

await check("nothing retired yet in phase 1", async () => {
  const retired = await count("asset?select=id&merged_into=not.is.null");
  return { ok: retired === 0, detail: `${retired} retired` };
});

// 3. Baseline comparisons: listing count and v_registry_stats, field by
// field. An incomplete baseline file is refused, not diffed against.
const rawBase = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : null;
const base = isCompleteSnapshot(rawBase) ? rawBase : null;

await check("baseline exists and is complete", async () => {
  if (!fs.existsSync(BASELINE)) return { ok: false, detail: "run --baseline first" };
  if (!base) {
    return {
      ok: false,
      detail: `data/asset-layer-baseline.json is incomplete, missing ${missingFields(rawBase).join(", ")}. Re-run --baseline.`,
    };
  }
  return { ok: true, detail: "" };
});

if (base) {
  await check("listing count unchanged", async () => {
    const listings = await count("v_registry_card?select=asset_id");
    return { ok: listings === base.listings, detail: `${listings} vs ${base.listings}` };
  });

  const now = await snapshot();
  for (const k of EXPECTED_STATS) {
    await check(`v_registry_stats.${k} unchanged`, async () => ({
      ok: String(now.stats?.[k]) === String(base.stats[k]),
      detail: `${now.stats?.[k]} vs ${base.stats[k]}`,
    }));
  }
}

// 4. v_asset_change_feed exposes both ids.
await check("v_asset_change_feed exposes listing_id and asset_id", async () => {
  const r = await fetch(`${URL_BASE}/rest/v1/v_asset_change_feed?select=listing_id,asset_id&limit=1`,
    { headers: head(ANON) });
  return { ok: r.ok, detail: r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}` };
});

// 5. The write path still executes. A function that still names `asset` after
//    the rename fails here and nowhere else. Neither call writes anything.
if (!SERVICE) {
  record("write path exercised", false, "SKIPPED: SUPABASE_SERVICE_ROLE_KEY not set. This is a FAIL, not a skip.");
} else {
  await check("ingest_capture reaches its own validation", async () => {
    const a = await rpc(SERVICE, "ingest_capture", { payload: {} });
    return { ok: a.text.includes("capture_meta.source_product_id"), detail: a.text.slice(0, 110) };
  });

  await check("set_capture_logo executes and reports no_capture", async () => {
    const b = await rpc(SERVICE, "set_capture_logo", {
      p_product_id: "__verify_no_such_product__",
      p_url: "https://example.invalid/x.png",
      p_marketplace_id: "microsoft",
    });
    return { ok: b.text.includes("no_capture"), detail: b.text.slice(0, 110) };
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
