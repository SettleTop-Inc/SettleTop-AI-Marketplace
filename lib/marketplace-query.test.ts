import { test } from "node:test";
import assert from "node:assert/strict";
import type { RegistryCard } from "./types.ts";
import {
  PAGE_SIZE,
  defaultCriteria,
  parseCriteria,
  runQuery,
  searchBlob,
  serializeCriteria,
} from "./marketplace-query.ts";

function card(over: Partial<RegistryCard> = {}): RegistryCard {
  return {
    asset_id: over.asset_id ?? "a1",
    source_product_id: over.source_product_id ?? "WA1",
    listing_url: "https://example.test/1",
    marketplace_id: "m1",
    marketplace_name: "Microsoft Marketplace",
    last_captured_at: "2026-08-16",
    capture_count: 1,
    name: "Agent One",
    publisher: "Pub",
    tagline: "does things",
    function_category: "Software Development",
    delivery: "Microsoft 365 app",
    surfaces: [],
    rating: 4,
    rating_count: 10,
    external_source: null,
    external_rating: null,
    certification: "none",
    cert_label: "No attestation published",
    provenance: "Unknown",
    evidence_tier: "Source Confirmed",
    reach: 50,
    risk: "High",
    risk_basis: null,
    price_band: "Free",
    price_note: null,
    listing_version: null,
    listing_updated: null,
    known_layers: [],
    layers_known: 1,
    layers_tracked: 12,
    ...over,
  };
}

test("searchBlob covers all nine fields including surfaces", () => {
  const c = card({ surfaces: ["Virtual Machines", "Teams"] });
  const blob = searchBlob(c);
  for (const needle of [
    "agent one",
    "pub",
    "software development",
    "does things",
    "microsoft marketplace",
    "source confirmed",
    "microsoft 365 app",
    "no attestation published",
    "virtual machines",
  ]) {
    assert.ok(blob.includes(needle), `blob is missing "${needle}"`);
  }
});

test("q matches a surfaces-only needle", () => {
  const cards = [card({ asset_id: "a1", surfaces: ["Virtual Machines"] }), card({ asset_id: "a2" })];
  const r = runQuery(cards, { ...defaultCriteria(), q: "Virtual Machines" });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].asset_id, "a1");
});

test("two facets AND together, two values in one facet OR together", () => {
  const cards = [
    card({ asset_id: "a1", risk: "Low", provenance: "Verified" }),
    card({ asset_id: "a2", risk: "Medium", provenance: "Verified" }),
    card({ asset_id: "a3", risk: "High", provenance: "Unknown" }),
  ];
  const base = defaultCriteria();
  const or = runQuery(cards, { ...base, facets: { ...base.facets, risk: ["Low", "Medium"] } });
  assert.equal(or.total, 2);
  const and = runQuery(cards, {
    ...base,
    facets: { ...base.facets, risk: ["Low", "Medium"], provenance: ["Verified"] },
  });
  assert.equal(and.total, 2);
  const and2 = runQuery(cards, {
    ...base,
    facets: { ...base.facets, risk: ["High"], provenance: ["Verified"] },
  });
  assert.equal(and2.total, 0);
});

test("an unselected facet's counts sum exactly to total", () => {
  const cards = [
    card({ asset_id: "a1", risk: "Low" }),
    card({ asset_id: "a2", risk: "Medium" }),
    card({ asset_id: "a3", risk: "High" }),
  ];
  const r = runQuery(cards, defaultCriteria());
  const risk = r.facets.find((f) => f.key === "risk")!;
  assert.equal(
    risk.values.reduce((n, v) => n + v.count, 0),
    r.total
  );
});

test("facet counts are self-excluding: selecting one value keeps siblings non-zero", () => {
  const cards = [
    card({ asset_id: "a1", risk: "Low" }),
    card({ asset_id: "a2", risk: "Medium" }),
    card({ asset_id: "a3", risk: "High" }),
    card({ asset_id: "a4", risk: "High" }),
  ];
  const base = defaultCriteria();
  const r = runQuery(cards, { ...base, facets: { ...base.facets, risk: ["Low"] } });
  assert.equal(r.total, 1);
  const risk = r.facets.find((f) => f.key === "risk")!;
  const byValue = Object.fromEntries(risk.values.map((v) => [v.value, v.count]));
  assert.equal(byValue["Medium"], 1, "sibling collapsed to zero — self-filtered counting");
  assert.equal(byValue["High"], 2, "sibling collapsed to zero — self-filtered counting");
});

test("a selected facet does not shrink its own counts, but does constrain others", () => {
  const cards = [
    card({ asset_id: "a1", risk: "Low", price_band: "Free" }),
    card({ asset_id: "a2", risk: "Low", price_band: "Paid" }),
    card({ asset_id: "a3", risk: "Low", price_band: "Free" }),
    card({ asset_id: "a4", risk: "High", price_band: "Trial" }),
  ];
  const base = defaultCriteria();
  const r = runQuery(cards, { ...base, facets: { ...base.facets, risk: ["Low"] } });
  const price = r.facets.find((f) => f.key === "price")!;
  const byValue = Object.fromEntries(price.values.map((v) => [v.value, v.count]));
  assert.equal(byValue["Free"], 2);
  assert.equal(byValue["Paid"], 1);
  assert.equal(byValue["Trial"], 0, "other facets must reflect the risk selection");
  // The individual lookups above only prove the three known values are
  // right; they say nothing about whether an extra, unlooked-up bucket
  // (e.g. a phantom key from a seeding bug) inflated the group. Summing
  // catches that: it must equal price's self-excluded base — the rows
  // that pass every facet except price's own (a1, a2, a3) — not r.total,
  // which happens to be the same number here only because price itself
  // is unselected.
  assert.equal(
    price.values.reduce((n, v) => n + v.count, 0),
    3,
    "facet counts must sum to the self-excluded base, not silently include a phantom bucket"
  );
});

test("facet counts sum to their own self-excluded base, not to byQ or total, when q and two other facets narrow differently", () => {
  const cards = [
    card({ asset_id: "a1", risk: "Low", provenance: "Verified", tagline: "alpha bot" }),
    card({ asset_id: "a2", risk: "Medium", provenance: "Verified", tagline: "alpha bot" }),
    card({ asset_id: "a3", risk: "High", provenance: "Verified", tagline: "alpha bot" }),
    card({ asset_id: "a4", risk: "Low", provenance: "Disclosed", tagline: "alpha bot" }),
    card({ asset_id: "a5", risk: "Low", provenance: "Verified", tagline: "beta bot" }),
  ];
  const base = defaultCriteria();
  const r = runQuery(cards, {
    ...base,
    q: "alpha",
    facets: { ...base.facets, risk: ["Low"], provenance: ["Verified"] },
  });
  // q drops a5 (byQ has 4 rows); risk+provenance together leave only a1.
  assert.equal(r.total, 1);
  const risk = r.facets.find((f) => f.key === "risk")!;
  const sum = risk.values.reduce((n, v) => n + v.count, 0);
  // risk's self-excluded base is byQ narrowed by provenance alone
  // (a1, a2, a3 — a4 fails provenance, a5 already failed q): 3 rows.
  // That is neither byQ (4) nor r.total (1); if the sum silently
  // matched either of those, the arithmetic behind the rail would be
  // reading the wrong set.
  assert.equal(sum, 3, "risk's own count sum must equal its self-excluded base, not byQ or total");
});

test("null and the literal 'Unknown' collapse into one bucket", () => {
  const cards = [
    card({ asset_id: "a1", delivery: null }),
    card({ asset_id: "a2", delivery: "Unknown" }),
    card({ asset_id: "a3", delivery: "SaaS" }),
  ];
  const r = runQuery(cards, defaultCriteria());
  const delivery = r.facets.find((f) => f.key === "delivery")!;
  const unknown = delivery.values.filter((v) => v.value === "Unknown");
  assert.equal(unknown.length, 1, "Unknown split into two rows");
  assert.equal(unknown[0].count, 2);
  const sel = runQuery(cards, {
    ...defaultCriteria(),
    facets: { ...defaultCriteria().facets, delivery: ["Unknown"] },
  });
  assert.equal(sel.total, 2);
});

test("nulls sort last in BOTH directions", () => {
  const cards = [
    card({ asset_id: "a1", rating: null }),
    card({ asset_id: "a2", rating: 3.4 }),
    card({ asset_id: "a3", rating: 5 }),
  ];
  const desc = runQuery(cards, { ...defaultCriteria(), sort: "rating", dir: "desc" });
  assert.deepEqual(desc.rows.map((r) => r.asset_id), ["a3", "a2", "a1"]);
  const asc = runQuery(cards, { ...defaultCriteria(), sort: "rating", dir: "asc" });
  assert.deepEqual(asc.rows.map((r) => r.asset_id), ["a2", "a3", "a1"]);
});

test("ties break on asset_id so paging is stable", () => {
  const ids = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => `a${String(i).padStart(3, "0")}`);
  // Feed the cards in DESCENDING id order with identical ratings. Array.sort
  // is spec-stable, so if tie() were deleted (or re-keyed to
  // source_product_id, which the fixture holds constant across all rows),
  // every comparison would return 0 and stability alone would preserve this
  // descending insertion order — the opposite of the ascending order
  // asserted below. Only a real asset_id tie-break produces ascending order
  // from descending input.
  const cards = [...ids].reverse().map((id) => card({ asset_id: id, rating: 5 }));
  const p1 = runQuery(cards, { ...defaultCriteria(), sort: "rating", page: 1 });
  const p2 = runQuery(cards, { ...defaultCriteria(), sort: "rating", page: 2 });
  const ascending = [...ids].sort();
  assert.deepEqual(p1.rows.map((r) => r.asset_id), ascending.slice(0, PAGE_SIZE));
  assert.deepEqual(p2.rows.map((r) => r.asset_id), ascending.slice(PAGE_SIZE));
});

test("inbound page beyond the end clamps to the last page", () => {
  const cards = [card({ asset_id: "a1" })];
  const r = runQuery(cards, { ...defaultCriteria(), page: 99 });
  assert.equal(r.page, 1);
  assert.equal(r.rows.length, 1);
});

test("criteria round-trip is lossless and omits defaults", () => {
  const base = defaultCriteria();
  assert.equal(serializeCriteria(base), "", "defaults must not be written to the URL");
  const c: typeof base = {
    ...base,
    q: "teams",
    facets: { ...base.facets, risk: ["Low", "High"], provenance: ["Verified"] },
    sort: "name",
    dir: "asc",
    page: 3,
    view: "list",
  };
  const round = parseCriteria(new URLSearchParams(serializeCriteria(c)));
  assert.deepEqual(round, c);
});

test("unrecognised values are dropped rather than applied", () => {
  const parsed = parseCriteria(new URLSearchParams("risk=Purple&sort=bogus&page=0"));
  assert.deepEqual(parsed.facets.risk, []);
  assert.equal(parsed.sort, defaultCriteria().sort);
  assert.equal(parsed.page, 1);
});

test("page size is selectable and round-trips through the URL", () => {
  const c = parseCriteria(new URLSearchParams("per=48"));
  assert.equal(c.perPage, 48);
  assert.equal(serializeCriteria(c), "per=48");
});

test("the default page size is never serialised, so old links are unchanged", () => {
  const c = parseCriteria(new URLSearchParams("q=agent"));
  assert.equal(c.perPage, PAGE_SIZE);
  assert.equal(serializeCriteria(c), "q=agent");
});

test("a page size outside the offered set is ignored, not clamped", () => {
  for (const bad of ["5000", "0", "-24", "25", "abc", ""]) {
    const c = parseCriteria(new URLSearchParams(`per=${bad}`));
    assert.equal(c.perPage, PAGE_SIZE, `per=${bad} should fall back to the default`);
  }
});

test("runQuery honours the page size and repaginates around it", () => {
  const cards = Array.from({ length: 30 }, (_, i) => card({ asset_id: `a${i}`, name: `Agent ${i}` }));

  const small = runQuery(cards, { ...defaultCriteria(), perPage: 12 });
  assert.equal(small.rows.length, 12);
  assert.equal(small.pageCount, 3);

  const large = runQuery(cards, { ...defaultCriteria(), perPage: 48 });
  assert.equal(large.rows.length, 30);
  assert.equal(large.pageCount, 1);

  // A page beyond the end still clamps once the size changes under it.
  const clamped = runQuery(cards, { ...defaultCriteria(), perPage: 48, page: 3 });
  assert.equal(clamped.page, 1);
});

test("runQuery rejects a hand-built page size outside the offered set", () => {
  const cards = Array.from({ length: 30 }, (_, i) => card({ asset_id: `a${i}`, name: `Agent ${i}` }));
  const r = runQuery(cards, { ...defaultCriteria(), perPage: 5000 });
  assert.equal(r.rows.length, PAGE_SIZE);
});
