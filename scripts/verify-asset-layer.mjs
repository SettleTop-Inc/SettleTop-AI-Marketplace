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
 * Every check, including the baseline file's read and parse and the
 * v_registry_stats snapshot used for comparison, runs through check() below,
 * which turns a thrown error into a recorded FAIL instead of aborting the
 * process. Tasks 3 to 7 leave the database in intermediate states where
 * several objects can be absent at once, and a harness that stops at the
 * first missing one, or the first unreadable file, tells us almost nothing
 * about the rest. The run always reaches the end and always prints the full
 * tally; the exit code is still non-zero if anything failed.
 *
 * --baseline validates the snapshot before writing it: every v_registry_stats
 * field present, and listings, logo_status and passports each a positive
 * integer. Everything in phase 1 is measured against that file, so a partial
 * snapshot must never be written silently, and the check run refuses to
 * compare against one that is.
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

// count() never pages: Range: 0-0 fetches a single row and the total comes
// off Content-Range, not off rows returned, so it needs no order key.
// pageAll(), below, is the one place in this file that actually pages, and
// it carries one for exactly that reason.
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

// The only paged read in this file. PostgREST caps a response at 1000 rows and
// pages without a total order overlap, so the order key is load-bearing here in
// a way it is not for the count() calls above.
const pageAll = async (path, size = 1000) => {
  const out = [];
  for (let from = 0; ; from += size) {
    const r = await fetch(`${URL_BASE}/rest/v1/${path}`, {
      headers: { ...head(ANON), Range: `${from}-${from + size - 1}` },
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 90)}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < size) return out;
  }
};

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
  // v_logo_status and v_asset_passport are read surfaces nothing else here
  // requires a row from. A view that silently returns no rows still answers
  // select=*&limit=1 with HTTP 200 and [], which is exactly the shape of the
  // outage that took 6,820 logos off the site: getLogos() swallows the empty
  // result and renders initials. Recording a real row count here, and
  // comparing it against the baseline below, is what turns that into a FAIL.
  const logo_status = await count("v_logo_status?select=state");
  const passports = await count("v_asset_passport?select=asset_id");
  return { stats, listings, logo_status, passports };
}

/** True only when every expected stats field is present and listings,
 * logo_status and passports are each a positive integer. Gates both the
 * --baseline write and any comparison against an existing baseline file,
 * so a hole is never treated as real. */
function isCompleteSnapshot(snap) {
  if (!snap || typeof snap !== "object") return false;
  if (!Number.isInteger(snap.listings) || snap.listings <= 0) return false;
  if (!Number.isInteger(snap.logo_status) || snap.logo_status <= 0) return false;
  if (!Number.isInteger(snap.passports) || snap.passports <= 0) return false;
  if (!snap.stats || typeof snap.stats !== "object") return false;
  return EXPECTED_STATS.every((k) => snap.stats[k] !== undefined && snap.stats[k] !== null);
}

function missingFields(snap) {
  const missing = [];
  if (!Number.isInteger(snap?.listings) || snap.listings <= 0) missing.push("listings");
  if (!Number.isInteger(snap?.logo_status) || snap.logo_status <= 0) missing.push("logo_status");
  if (!Number.isInteger(snap?.passports) || snap.passports <= 0) missing.push("passports");
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
// listings is sourced from the listing table itself, not v_registry_card:
// that view inner-joins capture_extract on current_capture_id, so it counts
// listings with a current capture, not listings. A listing without one still
// needs an asset, and comparing against the card view would hide that case.
await check("one asset per listing", async () => {
  const listings = await count("listing?select=id");
  const assets = await count("asset?select=id");
  return { ok: assets === listings, detail: `${assets} assets, ${listings} listings` };
});

// The count comparison above can pass while the invariant it names is
// violated: two listings sharing one asset and a third with none nets to
// equal totals. This reads every row and checks the actual mapping instead
// of inferring it from totals. rows.length > 0 is deliberate: on an empty
// database every set comparison passes vacuously, and a gate that goes
// green on no data is worse than no gate, so this is expected to FAIL
// against a branch database seeded without data, and that is correct.
await check("every listing maps to a distinct asset", async () => {
  const rows = await pageAll("listing?select=id,asset_id&order=id");
  const assets = new Set(rows.map((r) => r.asset_id));
  const nullish = rows.filter((r) => !r.asset_id).length;
  return {
    ok: rows.length > 0 && nullish === 0 && assets.size === rows.length,
    detail: `${rows.length} listings, ${assets.size} distinct assets, ${nullish} null`,
  };
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
// field. An incomplete baseline file is refused, not diffed against. The
// read and the parse are guarded here, not just isCompleteSnapshot: a
// corrupted or partially written file (writeFileSync is not crash-atomic,
// so an interrupted --baseline run can produce exactly that) throws a
// SyntaxError that must become a recorded FAIL, not a crash.
let rawBase = null;
let baseReadError = null;
if (fs.existsSync(BASELINE)) {
  try {
    rawBase = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  } catch (e) {
    baseReadError = e;
  }
}
const base = !baseReadError && isCompleteSnapshot(rawBase) ? rawBase : null;

await check("baseline exists and is complete", async () => {
  if (!fs.existsSync(BASELINE)) return { ok: false, detail: "run --baseline first" };
  if (baseReadError) {
    return {
      ok: false,
      detail: `data/asset-layer-baseline.json could not be parsed: ${String(baseReadError.message ?? baseReadError).slice(0, 100)}. Re-run --baseline.`,
    };
  }
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

  await check("v_logo_status row count unchanged", async () => {
    const logo_status = await count("v_logo_status?select=state");
    return { ok: logo_status === base.logo_status, detail: `${logo_status} vs ${base.logo_status}` };
  });

  await check("v_asset_passport row count unchanged", async () => {
    const passports = await count("v_asset_passport?select=asset_id");
    return { ok: passports === base.passports, detail: `${passports} vs ${base.passports}` };
  });

  // snapshot() re-reads v_registry_stats and, inside it, counts
  // v_registry_card. Section 1 already records a clean FAIL if the anon
  // grant on v_registry_stats is broken; without this wrapper, a second,
  // redundant failure of that same read would crash the process here
  // instead, before the nine stats comparisons, the change-feed check, or
  // either write-path RPC check ever run.
  let now = null;
  await check("v_registry_stats snapshot is readable for comparison", async () => {
    now = await snapshot();
    return { ok: true, detail: "" };
  });

  if (now) {
    for (const k of EXPECTED_STATS) {
      await check(`v_registry_stats.${k} unchanged`, async () => ({
        ok: String(now.stats?.[k]) === String(base.stats[k]),
        detail: `${now.stats?.[k]} vs ${base.stats[k]}`,
      }));
    }
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

// 6. Phase 2: the asset-keyed read surface. Written first and failing first,
// same as phase 1's checks did: the columns and the two new views these
// name do not exist yet, so every check in this section is expected to FAIL
// until a later task adds them. That is the RED evidence this task records.
await check("v_registry_card carries the asset-level columns", async () => {
  const r = await fetch(`${URL_BASE}/rest/v1/v_registry_card?select=marketplace_ids,listing_count,search_blob&limit=1`,
    { headers: head(ANON) });
  return { ok: r.ok, detail: r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}` };
});

await check("v_asset_passport carries listings", async () => {
  const r = await fetch(`${URL_BASE}/rest/v1/v_asset_passport?select=listings&limit=1`, { headers: head(ANON) });
  return { ok: r.ok, detail: r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}` };
});

for (const v of ["v_listing_passport", "v_asset_evidence"]) {
  await check(`anon can select from ${v}`, async () => {
    const r = await fetch(`${URL_BASE}/rest/v1/${v}?select=*&limit=1`, { headers: head(ANON) });
    return { ok: r.ok, detail: r.ok ? "" : `${r.status} ${(await r.text()).slice(0, 90)}` };
  });
}

// A row count proves nothing on these two: both reach their payload through
// correlated subqueries, so a policy failure empties the payload and leaves the
// count intact. Assert on values.
await check("v_asset_evidence carries real capture rows", async () => {
  const r = await fetch(`${URL_BASE}/rest/v1/v_asset_evidence?select=capture_id,captured_at,content_hash&limit=1`,
    { headers: head(ANON) });
  if (!r.ok) return { ok: false, detail: `${r.status}` };
  const [row] = await r.json();
  return {
    ok: Boolean(row?.capture_id && row?.captured_at && row?.content_hash),
    detail: row ? `capture ${row.capture_id?.slice(0, 8)}` : "no rows",
  };
});

await check("v_registry_card.search_blob is populated", async () => {
  const r = await fetch(`${URL_BASE}/rest/v1/v_registry_card?select=name,search_blob&limit=1`, { headers: head(ANON) });
  if (!r.ok) return { ok: false, detail: `${r.status}` };
  const [row] = await r.json();
  const ok = Boolean(row?.search_blob) && row.search_blob.includes(String(row.name ?? "").toLowerCase());
  return { ok, detail: ok ? `${row.search_blob.length} chars` : "blob empty or missing the name" };
});

// v_asset_evidence reaches capture by inner join only, so a row count is
// sound for it in the way it is not for the passport above. It is asserted
// here as a live, standalone equality against v_registry_stats.captures,
// both read in this same run, rather than folded into snapshot() and the
// baseline: the baseline is the pre-phase-1 record, v_asset_evidence does not
// exist yet to have been captured into it, and requiring the field there
// would make the existing baseline file fail isCompleteSnapshot and take
// every baseline-comparison check down with it.
await check("v_asset_evidence row count equals v_registry_stats.captures", async () => {
  const statsRes = await fetch(`${URL_BASE}/rest/v1/v_registry_stats?select=captures`, { headers: head(ANON) });
  if (!statsRes.ok) return { ok: false, detail: `v_registry_stats: ${statsRes.status}` };
  const [stats] = await statsRes.json();
  const evidence_rows = await count("v_asset_evidence?select=capture_id");
  return {
    ok: evidence_rows === Number(stats?.captures),
    detail: `${evidence_rows} evidence rows vs ${stats?.captures} captures`,
  };
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
