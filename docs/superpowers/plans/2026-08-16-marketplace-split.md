# Marketplace Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `/` as the marketing overview and add `/marketplace`, a real browsing tool with URL-encoded filter state, self-excluding facet counts, sort, pagination, a list toggle and provenance compare.

**Architecture:** Both routes call the same `getCards()`. A pure, unit-tested module `lib/marketplace-query.ts` owns every claim the UI makes — what `q` matches, which rows match, what each facet count is, sort order and paging. `MarketplaceApp` is a thin client component that only maps URL ⇄ criteria. `AgentCard` is extracted so both surfaces render an identical card.

**Tech Stack:** Next.js 15.5.23 App Router, React 19, TypeScript 5.7, Supabase JS v2, `node:test` with native type stripping.

**Spec:** [`docs/superpowers/specs/2026-08-16-marketplace-split-design.md`](../specs/2026-08-16-marketplace-split-design.md)

## Global Constraints

- **Never touch `ingest_capture()`, the evidence gate, or any migration.** No schema work in this plan.
- **`app/globals.css` ships byte-unchanged.** All new CSS goes in `app/marketplace.css`, every class prefixed **`mkt-`**. Never re-declare `.registry-card`, `.registry-grid`, `.filters`, `.section`, `.container`, `.empty-state`, `.prov-pill`. Do not use the `marketplace-` prefix — `.marketplace-heading` is already live.
- **Unknown means Unknown.** Nullable card fields normalise to the `UNKNOWN` constant from `lib/present.ts` (`"Unknown"`), and a SQL literal `'Unknown'` collapses into the same bucket as `null`. Never invent a default, never render a blank that reads as zero.
- **Evidence risk is not a security rating.** Any surface showing the risk band shows its explanation and keeps `risk_basis` as subtext.
- **Verify with `npm run build`, never `npm run dev`.** `next dev` renders every request dynamically and hides the Suspense failure this plan depends on.
- **Every `router.push`/`router.replace` passes `{ scroll: false }`.**
- **Node version floor: 22.6.** Tests run `node --experimental-strip-types --test`. Verified working on the local Node v23.0.0.
- Breakpoints in this codebase are **1050 / 820 / 580**. There is no 768 or 1024.

---

### Task 1: Extract AgentCard, share the logo merge, rename RegistryApp

No behaviour change. `/` must render identically before and after.

**Files:**
- Create: `components/AgentCard.tsx`
- Create: `lib/logos.ts`
- Modify: `components/RegistryApp.tsx` → rename to `components/LandingApp.tsx`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `RegistryCard` from `lib/types.ts`; `AgentLogo` from `components/AgentLogo.tsx`; `UNKNOWN`, `statusClass` from `lib/present.ts`.
- Produces: `AgentCard({ c, compact?, onOpen? })` — **`onOpen` is optional**; when absent the "View details" button is not rendered. `withLogos(cards, logos)` and `withLogo(card, logos)` from `lib/logos.ts`.

- [ ] **Step 1: Create the shared logo merge helper**

`lib/logos.ts`:

```ts
import type { RegistryCard } from "@/lib/types";

/**
 * Merge archived logos onto cards.
 *
 * Kept out of SQL deliberately: logos have a separate archival lifecycle from
 * the capture, and joining them in the view would imply they are part of the
 * observation. A product missing from the map has no logo we hold.
 */
export function withLogo<T extends { source_product_id: string }>(
  row: T,
  logos: Record<string, string>
): T & { logo: string | null } {
  return { ...row, logo: logos[row.source_product_id] ?? null };
}

export function withLogos(
  cards: RegistryCard[],
  logos: Record<string, string>
): RegistryCard[] {
  return cards.map((c) => withLogo(c, logos));
}
```

- [ ] **Step 2: Create `components/AgentCard.tsx`**

Move the `AgentCard` function out of `RegistryApp.tsx` verbatim, with two changes: add the `"use client"` directive, and make `onOpen` optional so the marketplace can render a card without the landing page's modal.

```tsx
"use client";

import Link from "next/link";
import AgentLogo from "@/components/AgentLogo";
import { UNKNOWN, statusClass } from "@/lib/present";
import type { RegistryCard } from "@/lib/types";

export default function AgentCard({
  c,
  compact = false,
  onOpen,
}: {
  c: RegistryCard;
  compact?: boolean;
  /** Absent on surfaces with no passport modal — the button is then omitted. */
  onOpen?: (m: { kind: "agent"; id: string }) => void;
}) {
  return (
    <article className={compact ? "top-agent-card" : "registry-card"}>
      <div className="agent-card-head">
        <AgentLogo name={c.name} id={c.source_product_id} logo={c.logo} />
        <div className="agent-title">
          <h3>{c.name}</h3>
          <span>{c.publisher ?? UNKNOWN}</span>
        </div>
        <button className="bookmark" title="Save agent">
          ☆
        </button>
      </div>
      <p className="agent-description">{c.tagline ?? "Not stated"}</p>
      <div className="agent-tags">
        <span>{c.function_category}</span>
        <span>{c.delivery}</span>
        <span>{c.cert_label}</span>
      </div>
      <div className="agent-meta-row">
        <span>
          {c.rating ? (
            <>
              <b>{c.rating}</b> ★ <small>({c.rating_count})</small>
            </>
          ) : (
            <>
              <b>Not rated</b> <small>(0 reviews)</small>
            </>
          )}
        </span>
        <span className={`prov-pill ${statusClass(c.provenance)}`}>{c.provenance}</span>
      </div>
      <div className="availability-row">
        <span className="availability-pill available">Available</span>
        <span>{c.marketplace_name}</span>
      </div>
      <div className="evidence-tier-row">
        <span>{c.evidence_tier}</span>
        <small>Marketplace listing</small>
      </div>
      <div className="reach-mini">
        <div>
          <span>Provenance reach</span>
          <b>{c.reach}%</b>
        </div>
        <div className="reach-track">
          <i style={{ width: `${c.reach}%` }} />
        </div>
      </div>
      <div className="agent-bottom">
        <div>
          <b>{c.price_band}</b>
          <small>{c.price_note}</small>
        </div>
        <div className="risk-label">
          <span>Evidence risk</span>
          <b className={`risk-${c.risk.toLowerCase()}`}>{c.risk}</b>
        </div>
      </div>
      <div className="card-buttons">
        {onOpen && (
          <button onClick={() => onOpen({ kind: "agent", id: c.source_product_id })}>
            View details
          </button>
        )}
        <Link
          className="get-btn"
          href={`/agent/${encodeURIComponent(c.source_product_id)}`}
          style={{ display: "grid", placeItems: "center" }}
        >
          Open passport
        </Link>
      </div>
    </article>
  );
}
```

- [ ] **Step 3: Rename the component file and delete the moved code**

```bash
git mv components/RegistryApp.tsx components/LandingApp.tsx
```

In `components/LandingApp.tsx`:
1. Rename the default export function `RegistryApp` → `LandingApp`.
2. Delete the local `AgentCard` function entirely (it was at the end of the file, after the default export).
3. Add `import AgentCard from "@/components/AgentCard";`.
4. Remove now-unused imports if `Link` and `statusClass` are no longer referenced elsewhere in the file — check with the typecheck in step 5.

- [ ] **Step 4: Update `app/page.tsx` to use the shared merge**

```tsx
import LandingApp from "@/components/LandingApp";
import { withLogo, withLogos } from "@/lib/logos";
import { getCards, getFeatured, getLogos, getStats } from "@/lib/registry";

export const revalidate = 300;

export default async function HomePage() {
  const [cards, stats, featured, logos] = await Promise.all([
    getCards(),
    getStats(),
    getFeatured(),
    getLogos(),
  ]);

  return (
    <LandingApp
      cards={withLogos(cards, logos)}
      stats={stats}
      featured={featured ? withLogo(featured, logos) : null}
    />
  );
}
```

- [ ] **Step 5: Verify nothing changed**

```bash
npm run typecheck && npm run build
```

Expected: both clean. The route table still shows exactly `/`, `/_not-found`, `/agent/[id]`, and `/` stays `○ (Static)`.

- [ ] **Step 6: Commit**

```bash
git add components/AgentCard.tsx components/LandingApp.tsx lib/logos.ts app/page.tsx
git commit -m "refactor: extract AgentCard, share logo merge, rename RegistryApp to LandingApp"
```

---

### Task 2: The pure query module and its tests

The whole task is off-screen. No UI.

**Files:**
- Create: `lib/marketplace-query.ts`
- Create: `lib/marketplace-query.test.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `RegistryCard` from `lib/types.ts`; `UNKNOWN` from `lib/present.ts`.
- Produces: `PAGE_SIZE`, `SortKey`, `SortDir`, `FacetKey`, `Criteria`, `FacetGroup`, `QueryResult`, `searchBlob(card)`, `defaultCriteria()`, `parseCriteria(sp)`, `serializeCriteria(c)`, `runQuery(cards, criteria)`, `FACET_LABELS`.

- [ ] **Step 1: Enable TS-extension imports and add the test script**

In `tsconfig.json`, add one line inside `compilerOptions` directly after `"noEmit": true,`:

```json
    "allowImportingTsExtensions": true,
```

In `package.json`, add to `scripts`:

```json
    "test": "node --experimental-strip-types --test lib/marketplace-query.test.ts"
```

Both are required: Node's test runner resolves ESM with explicit extensions, and TypeScript rejects `.ts` import specifiers without the flag. Verified compatible with `next build`.

- [ ] **Step 2: Write the failing tests**

`lib/marketplace-query.test.ts`:

```ts
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
    card({ asset_id: "a2", risk: "High", price_band: "Paid" }),
  ];
  const base = defaultCriteria();
  const r = runQuery(cards, { ...base, facets: { ...base.facets, risk: ["Low"] } });
  const price = r.facets.find((f) => f.key === "price")!;
  const byValue = Object.fromEntries(price.values.map((v) => [v.value, v.count]));
  assert.equal(byValue["Free"], 1);
  assert.equal(byValue["Paid"], 0, "other facets must reflect the risk selection");
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
  const cards = Array.from({ length: PAGE_SIZE + 5 }, (_, i) =>
    card({ asset_id: `a${String(i).padStart(3, "0")}`, rating: 5 })
  );
  const p1 = runQuery(cards, { ...defaultCriteria(), sort: "rating", page: 1 });
  const p2 = runQuery(cards, { ...defaultCriteria(), sort: "rating", page: 2 });
  const seen = new Set([...p1.rows, ...p2.rows].map((r) => r.asset_id));
  assert.equal(seen.size, cards.length, "an agent appeared twice or vanished across pages");
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
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module './marketplace-query.ts'`.

- [ ] **Step 4: Implement the module**

`lib/marketplace-query.ts`:

```ts
import { UNKNOWN } from "./present.ts";
import type { RegistryCard } from "./types.ts";

/** Rows per page. Not a URL parameter — changing it must not break saved links. */
export const PAGE_SIZE = 24;

export type SortKey = "reach" | "rating" | "name" | "captured";
export type SortDir = "asc" | "desc";
export type ViewMode = "grid" | "list";
export type FacetKey =
  | "source" | "function" | "provenance" | "risk" | "tier" | "delivery" | "price";

export const FACET_KEYS: FacetKey[] = [
  "source", "function", "provenance", "risk", "tier", "delivery", "price",
];

export const FACET_LABELS: Record<FacetKey, string> = {
  source: "Source marketplace",
  function: "Function",
  provenance: "Provenance",
  risk: "Evidence risk",
  tier: "Evidence tier",
  delivery: "Deployment",
  price: "Pricing",
};

const SORT_KEYS: SortKey[] = ["reach", "rating", "name", "captured"];
/** Descending is the useful default for magnitudes; ascending for names. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  reach: "desc", rating: "desc", captured: "desc", name: "asc",
};

export interface Criteria {
  q: string;
  facets: Record<FacetKey, string[]>;
  sort: SortKey;
  dir: SortDir;
  page: number;
  view: ViewMode;
}

export interface FacetValue { value: string; count: number; selected: boolean }
export interface FacetGroup { key: FacetKey; label: string; values: FacetValue[] }

export interface QueryResult {
  rows: RegistryCard[];
  facets: FacetGroup[];
  total: number;
  page: number;
  pageCount: number;
}

export function defaultCriteria(): Criteria {
  return {
    q: "",
    facets: { source: [], function: [], provenance: [], risk: [], tier: [], delivery: [], price: [] },
    sort: "reach",
    dir: DEFAULT_DIR.reach,
    page: 1,
    view: "grid",
  };
}

/**
 * The single definition of what free-text search matches. Both surfaces import
 * this — if they diverge, the landing page's hand-off link lands the visitor on
 * an empty grid and blames their filters.
 *
 * Field order is preserved from the original landing-page implementation so a
 * needle spanning a field boundary behaves identically on both surfaces.
 */
export function searchBlob(c: RegistryCard): string {
  return [
    c.name, c.publisher, c.function_category, c.tagline, c.marketplace_name,
    c.evidence_tier, c.delivery, c.cert_label, (c.surfaces ?? []).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Null and the SQL literal 'Unknown' are the same bucket. Never a third spelling. */
function norm(v: string | null | undefined): string {
  return v && v !== UNKNOWN ? v : UNKNOWN;
}

function facetValueOf(c: RegistryCard, key: FacetKey): string {
  switch (key) {
    case "source": return norm(c.marketplace_name);
    case "function": return norm(c.function_category);
    case "provenance": return norm(c.provenance);
    case "risk": return norm(c.risk);
    case "tier": return norm(c.evidence_tier);
    case "delivery": return norm(c.delivery);
    case "price": return norm(c.price_band);
  }
}

function matchesFacet(c: RegistryCard, key: FacetKey, selected: string[]): boolean {
  return selected.length === 0 || selected.includes(facetValueOf(c, key));
}

function matchesQ(c: RegistryCard, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return !needle || searchBlob(c).includes(needle);
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function compare(a: RegistryCard, b: RegistryCard, sort: SortKey, dir: SortDir): number {
  const flip = dir === "asc" ? 1 : -1;

  if (sort === "name") return collator.compare(a.name, b.name) * flip || tie(a, b);

  const av = sort === "reach" ? a.reach : sort === "rating" ? a.rating : a.last_captured_at;
  const bv = sort === "reach" ? b.reach : sort === "rating" ? b.rating : b.last_captured_at;

  // Nulls are a terminal group, last in BOTH directions. A missing rating is
  // not a rating of zero, and must never outrank a stated one.
  const aNull = av === null || av === undefined;
  const bNull = bv === null || bv === undefined;
  if (aNull && bNull) return tie(a, b);
  if (aNull) return 1;
  if (bNull) return -1;

  const cmp = typeof av === "number" && typeof bv === "number"
    ? av - bv
    : collator.compare(String(av), String(bv));
  return cmp * flip || tie(a, b);
}

/** asset_id is unique; source_product_id is unique only per marketplace. */
function tie(a: RegistryCard, b: RegistryCard): number {
  return a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0;
}

function countFacet(cards: RegistryCard[], key: FacetKey, selected: string[]): FacetValue[] {
  const counts = new Map<string, number>();
  for (const c of cards) {
    const v = facetValueOf(c, key);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  // A selected value with no rows in the base must still appear, or it would
  // vanish from the rail while active in the URL.
  for (const v of selected) if (!counts.has(v)) counts.set(v, 0);
  return [...counts.entries()]
    .sort((x, y) => collator.compare(x[0], y[0]))
    .map(([value, count]) => ({ value, count, selected: selected.includes(value) }));
}

export function runQuery(cards: RegistryCard[], criteria: Criteria): QueryResult {
  const byQ = cards.filter((c) => matchesQ(c, criteria.q));

  const rows = byQ
    .filter((c) => FACET_KEYS.every((k) => matchesFacet(c, k, criteria.facets[k])))
    .sort((a, b) => compare(a, b, criteria.sort, criteria.dir));

  // Each facet is counted over a base with its OWN selection removed, so a
  // count reads as "what selecting this adds". Counting against the final
  // result set would print 0 beside every unselected sibling.
  const facets: FacetGroup[] = FACET_KEYS.map((key) => {
    const base = byQ.filter((c) =>
      FACET_KEYS.every((k) => (k === key ? true : matchesFacet(c, k, criteria.facets[k])))
    );
    return { key, label: FACET_LABELS[key], values: countFacet(base, key, criteria.facets[key]) };
  });

  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, criteria.page), pageCount);
  const start = (page - 1) * PAGE_SIZE;

  return { rows: rows.slice(start, start + PAGE_SIZE), facets, total, page, pageCount };
}

export function parseCriteria(sp: URLSearchParams): Criteria {
  const d = defaultCriteria();
  const sort = SORT_KEYS.includes(sp.get("sort") as SortKey) ? (sp.get("sort") as SortKey) : d.sort;
  const dirRaw = sp.get("dir");
  const view = sp.get("view") === "list" ? "list" : "grid";
  const pageRaw = Number(sp.get("page"));

  const facets = { ...d.facets };
  for (const k of FACET_KEYS) facets[k] = sp.getAll(k).filter((v) => v.trim() !== "");

  return {
    q: sp.get("q") ?? "",
    facets,
    sort,
    dir: dirRaw === "asc" || dirRaw === "desc" ? dirRaw : DEFAULT_DIR[sort],
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    view,
  };
}

/** Defaults are never serialised, so the plain case stays `/marketplace`. */
export function serializeCriteria(c: Criteria): string {
  const sp = new URLSearchParams();
  if (c.q.trim()) sp.set("q", c.q);
  for (const k of FACET_KEYS) for (const v of c.facets[k]) sp.append(k, v);
  if (c.sort !== "reach") sp.set("sort", c.sort);
  if (c.dir !== DEFAULT_DIR[c.sort]) sp.set("dir", c.dir);
  if (c.page > 1) sp.set("page", String(c.page));
  if (c.view !== "grid") sp.set("view", c.view);
  return sp.toString();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: `pass 12`, `fail 0`.

- [ ] **Step 6: Verify the app still builds with the tsconfig change**

```bash
npm run typecheck && npm run build
```

Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add lib/marketplace-query.ts lib/marketplace-query.test.ts tsconfig.json package.json
git commit -m "feat: pure marketplace query module with self-excluding facet counts"
```

---

### Task 3: The /marketplace route

**Files:**
- Create: `app/marketplace/page.tsx`
- Create: `app/marketplace.css`
- Create: `components/marketplace/MarketplaceApp.tsx`
- Create: `components/marketplace/FacetRail.tsx`
- Create: `components/marketplace/ResultToolbar.tsx`
- Create: `components/marketplace/Pagination.tsx`

**Interfaces:**
- Consumes: `runQuery`, `parseCriteria`, `serializeCriteria`, `defaultCriteria`, `PAGE_SIZE`, `FacetGroup`, `FacetKey`, `Criteria`, `SortKey` from `lib/marketplace-query.ts`; `withLogos` from `lib/logos.ts`; `AgentCard`.
- Produces: the `/marketplace` route. `MarketplaceApp({ cards })`.

- [ ] **Step 1: Write the stylesheet**

`app/marketplace.css` — every class `mkt-` prefixed. `globals.css` is untouched and already provides cards, pills, reach bars and risk colours.

```css
/* Marketplace-only styles. globals.css ships unchanged; every class here is
   mkt- prefixed because App Router never unloads route CSS, so a bare class
   name shared with globals.css would repaint "/" after a back-navigation. */
.mkt-shell { background: #f8fafc; min-height: 100vh; }
.mkt-bar { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; gap: 12px;
  padding: 12px 0; background: rgba(255,255,255,.97); border-bottom: 1px solid #e1e6ec;
  backdrop-filter: blur(16px); }
.mkt-back { font-size: 12px; font-weight: 700; color: #0b2b52; text-decoration: none; white-space: nowrap; }
.mkt-search { flex: 1; display: grid; grid-template-columns: 30px 1fr; align-items: center;
  height: 38px; background: #fff; border: 1px solid #d7dde8; border-radius: 8px; min-width: 0; }
.mkt-search span { text-align: center; color: #8a94a5; }
.mkt-search input { border: 0; background: transparent; font-size: 12px; padding-right: 10px; min-width: 0; }
.mkt-search input:focus-visible { outline: 2px solid #0b2b52; outline-offset: 2px; border-radius: 6px; }
.mkt-layout { display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 22px; padding: 22px 0 60px; }
.mkt-rail { background: #fff; border: 1px solid #e1e6ec; border-radius: 10px; padding: 14px;
  height: max-content; position: sticky; top: 74px; }
.mkt-rail-head { display: flex; justify-content: space-between; align-items: center;
  padding-bottom: 10px; border-bottom: 1px solid #e1e6ec; }
.mkt-rail-head b { font-size: 12px; }
.mkt-clear { border: 0; background: transparent; color: #c58d1d; font-size: 10px; font-weight: 700; }
.mkt-group { border: 0; padding: 12px 0 0; margin: 0; }
.mkt-group legend { font-size: 9px; font-weight: 800; letter-spacing: .08em;
  text-transform: uppercase; color: #8a94a5; padding: 0; }
.mkt-note { font-size: 9px; line-height: 1.5; color: #6d788c; margin: 5px 0 7px; }
.mkt-facet { display: flex; align-items: center; gap: 7px; font-size: 10.5px; color: #44516a;
  padding: 3px 0; cursor: pointer; }
.mkt-facet input { margin: 0; }
.mkt-facet input:focus-visible { outline: 2px solid #0b2b52; outline-offset: 2px; }
.mkt-facet[aria-disabled="true"] { color: #a9b2c0; cursor: not-allowed; }
.mkt-count { margin-left: auto; font-size: 9.5px; color: #8a94a5; font-variant-numeric: tabular-nums; }
.mkt-results { min-width: 0; }
.mkt-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.mkt-total b { font-size: 20px; }
.mkt-total span { font-size: 10px; color: #8a94a5; margin-left: 5px; }
.mkt-spacer { margin-left: auto; }
.mkt-control { border: 1px solid #d4dae5; background: #fff; color: #44516a; border-radius: 6px;
  padding: 8px 10px; font-size: 11px; font-weight: 700; }
.mkt-control:focus-visible { outline: 2px solid #0b2b52; outline-offset: 2px; }
.mkt-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 13px; }
.mkt-empty { background: #fff; border: 1px dashed #cbd3df; border-radius: 10px; text-align: center; padding: 46px; }
.mkt-empty b { font-size: 14px; display: block; }
.mkt-empty p { color: #5f6d7e; font-size: 11px; }
.mkt-error { background: #fff5f5; border: 1px solid #f0c9c7; border-left: 3px solid #c23b36;
  border-radius: 8px; padding: 18px; }
.mkt-error b { font-size: 13px; display: block; color: #c23b36; }
.mkt-error p { font-size: 11px; color: #5f6d7e; margin: 6px 0 0; }
.mkt-pages { display: flex; justify-content: center; gap: 5px; margin-top: 24px; }
.mkt-page { min-width: 30px; height: 30px; border: 1px solid #d4dae5; background: #fff;
  border-radius: 6px; font-size: 11px; color: #44516a; }
.mkt-page[aria-current="page"] { background: #0b2b52; color: #fff; border-color: #0b2b52; }
.mkt-page:disabled { opacity: .4; }
.mkt-page:focus-visible { outline: 2px solid #0b2b52; outline-offset: 2px; }
.mkt-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 1050px) { .mkt-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 820px) {
  .mkt-layout { grid-template-columns: 1fr; }
  .mkt-rail { position: static; }
}
@media (max-width: 580px) { .mkt-grid { grid-template-columns: minmax(0, 1fr); } }
```

- [ ] **Step 2: Write the facet rail**

`components/marketplace/FacetRail.tsx`:

```tsx
"use client";

import type { FacetGroup, FacetKey } from "@/lib/marketplace-query";

/**
 * CLAUDE.md rule 5: evidence risk is not a safety score. The passport carries
 * that footnote, so this route must carry it too rather than showing a bare band.
 */
const RISK_NOTE =
  "How much of the build you cannot see before you deploy — not a security rating.";

export default function FacetRail({
  facets,
  onToggle,
  onClear,
  hasFilters,
}: {
  facets: FacetGroup[];
  onToggle: (key: FacetKey, value: string) => void;
  onClear: () => void;
  hasFilters: boolean;
}) {
  return (
    <aside className="mkt-rail" aria-label="Filters">
      <div className="mkt-rail-head">
        <b>Filters</b>
        {hasFilters && (
          <button className="mkt-clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      {facets.map((g) => (
        <fieldset className="mkt-group" key={g.key}>
          <legend>{g.label}</legend>
          {g.key === "risk" && <p className="mkt-note">{RISK_NOTE}</p>}
          {g.values.map((v) => {
            const disabled = v.count === 0 && !v.selected;
            return (
              <label
                className="mkt-facet"
                key={v.value}
                aria-disabled={disabled || undefined}
              >
                <input
                  type="checkbox"
                  checked={v.selected}
                  disabled={disabled}
                  onChange={() => onToggle(g.key, v.value)}
                />
                <span>{v.value}</span>
                <span className="mkt-count">{v.count}</span>
              </label>
            );
          })}
        </fieldset>
      ))}
    </aside>
  );
}
```

- [ ] **Step 3: Write the toolbar and pagination**

`components/marketplace/ResultToolbar.tsx`:

```tsx
"use client";

import type { SortDir, SortKey } from "@/lib/marketplace-query";

const OPTIONS: Array<{ key: SortKey; dir: SortDir; label: string }> = [
  { key: "reach", dir: "desc", label: "Provenance reach" },
  { key: "rating", dir: "desc", label: "Rating" },
  { key: "captured", dir: "desc", label: "Recently captured" },
  { key: "name", dir: "asc", label: "Name (A–Z)" },
];

export default function ResultToolbar({
  total,
  sort,
  onSort,
}: {
  total: number;
  sort: SortKey;
  onSort: (key: SortKey, dir: SortDir) => void;
}) {
  return (
    <div className="mkt-toolbar">
      <div className="mkt-total" aria-live="polite">
        <b>{total.toLocaleString()}</b>
        <span>{total === 1 ? "agent" : "agents"}</span>
      </div>
      <div className="mkt-spacer" />
      <label className="mkt-sr" htmlFor="mkt-sort">
        Sort results by
      </label>
      <select
        id="mkt-sort"
        className="mkt-control"
        value={sort}
        onChange={(e) => {
          const picked = OPTIONS.find((o) => o.key === e.target.value)!;
          onSort(picked.key, picked.dir);
        }}
      >
        {OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
```

`components/marketplace/Pagination.tsx`:

```tsx
"use client";

export default function Pagination({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  const nums = Array.from({ length: pageCount }, (_, i) => i + 1).filter(
    (n) => n === 1 || n === pageCount || Math.abs(n - page) <= 2
  );

  return (
    <nav className="mkt-pages" aria-label="Result pages">
      <button className="mkt-page" onClick={() => onPage(page - 1)} disabled={page === 1}>
        ‹
      </button>
      {nums.map((n, i) => (
        <span key={n} style={{ display: "contents" }}>
          {i > 0 && n - nums[i - 1] > 1 && <span className="mkt-page" aria-hidden="true">…</span>}
          <button
            className="mkt-page"
            aria-current={n === page ? "page" : undefined}
            onClick={() => onPage(n)}
          >
            {n}
          </button>
        </span>
      ))}
      <button className="mkt-page" onClick={() => onPage(page + 1)} disabled={page === pageCount}>
        ›
      </button>
    </nav>
  );
}
```

- [ ] **Step 4: Write the client shell**

`components/marketplace/MarketplaceApp.tsx` — this owns URL ⇄ criteria and nothing else.

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import AgentCard from "@/components/AgentCard";
import FacetRail from "@/components/marketplace/FacetRail";
import Pagination from "@/components/marketplace/Pagination";
import ResultToolbar from "@/components/marketplace/ResultToolbar";
import {
  type Criteria,
  type FacetKey,
  type SortDir,
  type SortKey,
  defaultCriteria,
  parseCriteria,
  runQuery,
  serializeCriteria,
} from "@/lib/marketplace-query";
import type { RegistryCard } from "@/lib/types";

export default function MarketplaceApp({ cards }: { cards: RegistryCard[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const criteria = useMemo(
    () => parseCriteria(new URLSearchParams(searchParams.toString())),
    [searchParams]
  );

  const result = useMemo(() => runQuery(cards, criteria), [cards, criteria]);

  // The text box is local so typing stays instant; the URL catches up on a
  // debounce with `replace`, so a search does not leave 12 history entries.
  const [text, setText] = useState(criteria.q);
  useEffect(() => setText(criteria.q), [criteria.q]);

  const write = useCallback(
    (next: Criteria, mode: "push" | "replace") => {
      const qs = serializeCriteria(next);
      router[mode](qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router]
  );

  useEffect(() => {
    if (text === criteria.q) return;
    const t = setTimeout(() => write({ ...criteria, q: text, page: 1 }, "replace"), 300);
    return () => clearTimeout(t);
  }, [text, criteria, write]);

  // Any criteria change resets to page 1. Clamping is only for inbound URLs —
  // without this, changing a facet on page 4 strands the visitor mid-way
  // through a different result set.
  const toggleFacet = (key: FacetKey, value: string) => {
    const current = criteria.facets[key];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    write({ ...criteria, facets: { ...criteria.facets, [key]: next }, page: 1 }, "push");
  };

  const setSort = (sort: SortKey, dir: SortDir) =>
    write({ ...criteria, sort, dir, page: 1 }, "push");

  const setPage = (page: number) => write({ ...criteria, page }, "push");

  const clear = () => write({ ...defaultCriteria(), view: criteria.view }, "push");

  const hasFilters =
    criteria.q.trim() !== "" ||
    Object.values(criteria.facets).some((v) => v.length > 0);

  return (
    <div className="mkt-shell">
      <div className="container">
        <div className="mkt-bar">
          <Link className="mkt-back" href="/">
            ← Overview
          </Link>
          <div className="mkt-search">
            <span aria-hidden="true">⌕</span>
            <label className="mkt-sr" htmlFor="mkt-q">
              Search agents
            </label>
            <input
              id="mkt-q"
              type="search"
              placeholder={`Search ${cards.length} agents`}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </div>

        <div className="mkt-layout">
          <FacetRail
            facets={result.facets}
            onToggle={toggleFacet}
            onClear={clear}
            hasFilters={hasFilters}
          />

          <div className="mkt-results">
            <ResultToolbar total={result.total} sort={criteria.sort} onSort={setSort} />

            {result.total === 0 ? (
              <div className="mkt-empty">
                <b>No agents match these filters</b>
                <p>The registry holds {cards.length} agents. Try removing a filter.</p>
                <button className="mkt-control" onClick={clear}>
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="mkt-grid">
                {result.rows.map((c) => (
                  <AgentCard key={c.asset_id} c={c} />
                ))}
              </div>
            )}

            <Pagination page={result.page} pageCount={result.pageCount} onPage={setPage} />
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write the route with its mandatory Suspense boundary**

`app/marketplace/page.tsx`. **Without the `<Suspense>` this fails `next build`** — `useSearchParams()` in a prerendered client tree throws `BailoutToCSRError`. It will not fail in `next dev`.

```tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import MarketplaceApp from "@/components/marketplace/MarketplaceApp";
import { withLogos } from "@/lib/logos";
import { getCards, getLogos } from "@/lib/registry";
import "@/app/marketplace.css";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Browse AI agents — SettleTop Agent Registry",
  description:
    "Filter AI agents by function, source marketplace, provenance, evidence tier, deployment, pricing and evidence risk.",
};

export default async function MarketplacePage() {
  const [cards, logos] = await Promise.all([getCards(), getLogos()]);

  return (
    <Suspense fallback={<div className="mkt-shell" aria-busy="true" />}>
      <MarketplaceApp cards={withLogos(cards, logos)} />
    </Suspense>
  );
}
```

- [ ] **Step 6: Give the passport its context-aware back link**

The spec requires returning from a passport not to discard the search you built.
`app/agent/[id]/page.tsx:33-39` hardcodes `href="/"`.

Add an optional `from` prop to `components/AgentCard.tsx` — extend the prop type
with `from?: string;` and change the passport `Link`'s href to:

```tsx
          href={`/agent/${encodeURIComponent(c.source_product_id)}${from ? `?from=${from}` : ""}`}
```

Pass `from="marketplace"` from `MarketplaceApp`'s `<AgentCard>` usage. Then in
`app/agent/[id]/page.tsx`, accept search params and branch the back link.
**`from` is a search param, so it must not be `decodeURIComponent`'d** — unlike
the path param `id` on the line above it, which must.

```tsx
type Params = Promise<{ id: string }>;
type Search = Promise<{ from?: string }>;

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  const a = await getPassport(decodeURIComponent(id));
  if (!a) notFound();

  const back =
    from === "marketplace"
      ? { href: "/marketplace", label: "← Back to the marketplace" }
      : { href: "/", label: "← Back to the registry" };
```

and use `back.href` / `back.label` in the existing `<Link>`. Leave
`generateMetadata` unchanged — it takes only `params`.

- [ ] **Step 7: Verify the build, and that the route is present**

```bash
npm run typecheck && npm run build
```

Expected: clean, and the route table now lists `/marketplace`. If the build fails with *"useSearchParams() should be wrapped in a suspense boundary"*, the boundary in step 5 is missing or sits inside the component that calls the hook.

- [ ] **Step 8: Verify behaviour in the browser**

```bash
npm run dev
```

Check, at `http://localhost:3000/marketplace`:
1. 140 agents, 24 per page, 6 pages.
2. Tick **Evidence risk → Low**: results drop to 36, and Medium still reads **16**, High still reads **88**. If those read 0, facet counting is self-filtered — go back to Task 2.
3. The URL reads `/marketplace?risk=Low`. Reload: same screen.
4. Go to page 3, tick another facet: you land on page 1, not mid-way.
5. Press Back: the facet is undone, not the whole page.

- [ ] **Step 9: Commit**

```bash
git add app/marketplace app/marketplace.css components/marketplace components/AgentCard.tsx "app/agent/[id]/page.tsx"
git commit -m "feat: /marketplace route with URL-encoded filter state and facet counts"
```

---

### Task 4: List view toggle

**Files:**
- Create: `components/marketplace/ResultList.tsx`
- Modify: `components/marketplace/ResultToolbar.tsx`
- Modify: `components/marketplace/MarketplaceApp.tsx`
- Modify: `app/marketplace.css`

**Interfaces:**
- Consumes: `ViewMode` from `lib/marketplace-query.ts`; `RegistryCard`.
- Produces: `ResultList({ rows })`; `ResultToolbar` gains `view` and `onView` props.

- [ ] **Step 1: Add list styles to `app/marketplace.css`**

```css
.mkt-list { display: grid; gap: 6px; }
.mkt-row { display: grid; grid-template-columns: 34px minmax(0, 2fr) minmax(0, 1fr) 96px 90px 64px;
  gap: 12px; align-items: center; background: #fff; border: 1px solid #e1e6ec;
  border-radius: 7px; padding: 9px 12px; }
.mkt-row-name { font-size: 12px; font-weight: 700; margin: 0; }
.mkt-row-sub { font-size: 9.5px; color: #8a94a5; }
.mkt-row-reach { display: flex; align-items: center; gap: 7px; font-size: 10px; }
.mkt-row-reach .reach-track { flex: 1; margin: 0; }
.mkt-toggle { display: flex; border: 1px solid #d4dae5; border-radius: 6px; overflow: hidden; }
.mkt-toggle button { border: 0; border-right: 1px solid #e2e6ee; background: #fff;
  padding: 8px 11px; font-size: 11px; font-weight: 700; color: #667085; }
.mkt-toggle button:last-child { border-right: 0; }
.mkt-toggle button[aria-pressed="true"] { background: #eef3f8; color: #0b2b52; }
.mkt-toggle button:focus-visible { outline: 2px solid #0b2b52; outline-offset: -2px; }
@media (max-width: 820px) {
  .mkt-row { grid-template-columns: 34px minmax(0, 1fr) 90px; }
  .mkt-row-sub.hide-sm, .mkt-row-reach { display: none; }
}
```

- [ ] **Step 2: Write `components/marketplace/ResultList.tsx`**

```tsx
"use client";

import Link from "next/link";
import AgentLogo from "@/components/AgentLogo";
import { UNKNOWN, statusClass } from "@/lib/present";
import type { RegistryCard } from "@/lib/types";

export default function ResultList({ rows }: { rows: RegistryCard[] }) {
  return (
    <div className="mkt-list">
      {rows.map((c) => (
        <article className="mkt-row" key={c.asset_id}>
          <AgentLogo name={c.name} id={c.source_product_id} logo={c.logo} />
          <div>
            <h3 className="mkt-row-name">
              <Link href={`/agent/${encodeURIComponent(c.source_product_id)}?from=marketplace`}>
                {c.name}
              </Link>
            </h3>
            <div className="mkt-row-sub">{c.publisher ?? UNKNOWN}</div>
          </div>
          <div className="mkt-row-sub hide-sm">{c.function_category ?? UNKNOWN}</div>
          <span className={`prov-pill ${statusClass(c.provenance)}`}>{c.provenance}</span>
          <div className="mkt-row-reach">
            <div className="reach-track">
              <i style={{ width: `${c.reach}%` }} />
            </div>
            <b>{c.reach}%</b>
          </div>
          <div className="risk-label">
            <b className={`risk-${c.risk.toLowerCase()}`}>{c.risk}</b>
          </div>
        </article>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Add the toggle to `ResultToolbar`**

Extend the props to `{ total, sort, onSort, view, onView }` where `view: ViewMode` and `onView: (v: ViewMode) => void`, importing `ViewMode` from `@/lib/marketplace-query`. Insert directly before the closing `</div>`:

```tsx
      <div className="mkt-toggle" role="group" aria-label="Result layout">
        <button aria-pressed={view === "grid"} onClick={() => onView("grid")}>
          ▦ Grid
        </button>
        <button aria-pressed={view === "list"} onClick={() => onView("list")}>
          ▤ List
        </button>
      </div>
```

- [ ] **Step 4: Wire it into `MarketplaceApp`**

Add the import `import ResultList from "@/components/marketplace/ResultList";`, add the handler, pass the new props, and branch the results region:

```tsx
  const setView = (view: ViewMode) => write({ ...criteria, view }, "push");
```

```tsx
            <ResultToolbar
              total={result.total}
              sort={criteria.sort}
              onSort={setSort}
              view={criteria.view}
              onView={setView}
            />
```

```tsx
              criteria.view === "list" ? (
                <ResultList rows={result.rows} />
              ) : (
                <div className="mkt-grid">
                  {result.rows.map((c) => (
                    <AgentCard key={c.asset_id} c={c} />
                  ))}
                </div>
              )
```

Import `ViewMode` alongside the other types from `@/lib/marketplace-query`.

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm run build && npm test
```

Then in the browser: toggle to list, confirm the URL gains `?view=list`, reload and confirm list persists, and confirm the toggle survives a facet change.

- [ ] **Step 6: Commit**

```bash
git add components/marketplace app/marketplace.css
git commit -m "feat: list view toggle on the marketplace"
```

---

### Task 5: Re-point the landing page and share the search definition

**This deliberately changes `/`** — unlike Task 1. The landing grid begins using the shared `searchBlob`, and its browse affordances start navigating instead of scrolling.

**Files:**
- Modify: `components/LandingApp.tsx`
- Modify: `components/AgentCard.tsx`

**Interfaces:**
- Consumes: `searchBlob`, `serializeCriteria`, `defaultCriteria` from `lib/marketplace-query.ts`.
- Produces: no new exports.

- [ ] **Step 0: Stop showing the evidence-risk band bare**

CLAUDE.md rule 5 forbids presenting evidence risk as a safety score, and the
card currently shows the band with no basis. `RegistryCard.risk_basis` already
carries the explanation (`"<attestation label> · n of d disclosable layers
stated"`). In `components/AgentCard.tsx`, replace the `risk-label` block with:

```tsx
      <div className="risk-label">
          <span>Evidence risk</span>
          <b className={`risk-${c.risk.toLowerCase()}`}>{c.risk}</b>
          {c.risk_basis && <small>{c.risk_basis}</small>}
        </div>
```

`.risk-label small` is not styled in `globals.css`, but `.agent-bottom small`
is (`display:block; color:#8a94a5; font-size:9px`) and it applies here, so no
stylesheet change is needed. This is a deliberate visible change on `/` as well
as the marketplace — both surfaces share the card, and the rule applies to both.

- [ ] **Step 1: Replace the local search blob with the shared one**

Delete the `searchBlob` `useMemo` (the block beginning `const searchBlob = useMemo(() => {`) and replace with:

```tsx
  const blobs = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cards) m.set(c.asset_id, searchBlob(c));
    return m;
  }, [cards]);
```

Update the `filtered` memo to read `blobs.get(c.asset_id)` instead of `searchBlob.get(c.asset_id)`, and add the import:

```tsx
import { defaultCriteria, searchBlob, serializeCriteria } from "@/lib/marketplace-query";
```

- [ ] **Step 2: Add the hand-off link builder**

Add inside the component, after the existing state declarations:

```tsx
  const router = useRouter();

  /** Carry whatever the visitor has already narrowed to into the tool. */
  const marketplaceHref = () => {
    const c = defaultCriteria();
    if (q.trim()) c.q = q;
    if (fn) c.facets.function = [fn];
    if (mp) c.facets.source = [mp];
    if (dep) c.facets.delivery = [dep];
    if (tier) c.facets.tier = [tier];
    if (prov) c.facets.provenance = [prov];
    if (price) c.facets.price = [price];
    if (risk) c.facets.risk = [risk];
    const qs = serializeCriteria(c);
    return qs ? `/marketplace?${qs}` : "/marketplace";
  };
```

Add `import { useRouter } from "next/navigation";` at the top.

- [ ] **Step 3: Re-point every browse affordance**

Run `grep -n 'scrollTo("registry")' components/LandingApp.tsx`. Every call site becomes a marketplace navigation **except** the nav anchor `<a href="#registry">Registry</a>`, which stays an in-page anchor beside Use cases / Top agents / Provenance.

Replace each as follows:

- `pickUseCase` (used by both the Popular chips and the use-case cards — changing it changes both):
  ```tsx
  const pickUseCase = (name: string) => {
    const c = defaultCriteria();
    c.facets.function = [name];
    router.push(`/marketplace?${serializeCriteria(c)}`);
  };
  ```
- `runHeroSearch`:
  ```tsx
  const runHeroSearch = () => {
    const c = defaultCriteria();
    if (heroQ.trim()) c.q = heroQ;
    const qs = serializeCriteria(c);
    router.push(qs ? `/marketplace?${qs}` : "/marketplace");
  };
  ```
- Nav **"Browse agents"** button → `onClick={() => router.push("/marketplace")}`
- **"View all use cases →"** → `onClick={() => router.push("/marketplace")}`
- **"Explore the full agent registry"** → `onClick={() => router.push("/marketplace")}`

- [ ] **Step 4: Add the hand-off control to the on-page registry section**

In the `registry-title` section heading, beside the `result-total` block:

```tsx
              <Link className="link-btn" href={marketplaceHref()}>
                Open these results in the marketplace →
              </Link>
```

- [ ] **Step 5: Verify the parity that this task exists to guarantee**

```bash
npm run typecheck && npm run build
```

Then in the browser on `/`:
1. Type `Virtual Machines` into the registry search. Note the "matching agents" count — it should be **28**.
2. Click **"Open these results in the marketplace →"**.
3. `/marketplace?q=Virtual+Machines` must show the **same 28**. If it shows 0, the two surfaces are not sharing `searchBlob`.
4. Click a use-case card: it navigates to `/marketplace?function=…` rather than scrolling.
5. Click "Explore the full agent registry": it navigates.
6. Click nav "Registry": it still scrolls down the page.

- [ ] **Step 6: Commit**

```bash
git add components/LandingApp.tsx
git commit -m "feat: route landing-page browse affordances into the marketplace"
```

---

### Task 6: Reader error contracts and honest empty states

Today a Supabase outage renders as "0 agents" beside a rail of zeros, blaming filters the visitor never set.

**Files:**
- Modify: `lib/registry.ts`
- Modify: `app/marketplace/page.tsx`
- Modify: `components/marketplace/MarketplaceApp.tsx`

**Interfaces:**
- Produces: `type ReadResult<T> = { ok: true; data: T } | { ok: false; error: string }`; `getCardsResult(): Promise<ReadResult<RegistryCard[]>>`; `getPassports(assetIds: string[]): Promise<ReadResult<AssetPassport[]>>`. `getCards()` is retained unchanged for the landing page.

- [ ] **Step 1: Add the result type and the two new readers to `lib/registry.ts`**

```ts
/**
 * A read that can say it failed.
 *
 * The older readers return [] or null on error, which is survivable on a
 * marketing page and dishonest on a tool: "the registry is down" and "your
 * filters matched nothing" must never render the same.
 */
export type ReadResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function getCardsResult(): Promise<ReadResult<RegistryCard[]>> {
  const { data, error } = await supabase
    .from("v_registry_card")
    .select("*")
    .order("name", { ascending: true });
  if (error) {
    console.error("getCardsResult", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, data: (data ?? []) as RegistryCard[] };
}

/**
 * Compare needs full passports, keyed by asset_id. getPassport() cannot be
 * reused: it returns null for both a missing row and a failed read, so compare
 * would report an agent as "not found" during an outage.
 */
export async function getPassports(
  assetIds: string[]
): Promise<ReadResult<AssetPassport[]>> {
  if (assetIds.length === 0) return { ok: true, data: [] };
  const { data, error } = await supabase
    .from("v_asset_passport")
    .select("*")
    .in("asset_id", assetIds);
  if (error) {
    console.error("getPassports", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, data: (data ?? []) as AssetPassport[] };
}
```

- [ ] **Step 2: Use it in the marketplace route**

In `app/marketplace/page.tsx`, swap `getCards()` for `getCardsResult()` and pass the failure through:

```tsx
  const [cards, logos] = await Promise.all([getCardsResult(), getLogos()]);

  return (
    <Suspense fallback={<div className="mkt-shell" aria-busy="true" />}>
      <MarketplaceApp
        cards={cards.ok ? withLogos(cards.data, logos) : []}
        loadFailed={!cards.ok}
      />
    </Suspense>
  );
```

- [ ] **Step 3: Render the two states distinctly**

In `MarketplaceApp`, add `loadFailed`: `{ cards, loadFailed }: { cards: RegistryCard[]; loadFailed?: boolean }`, and put this ahead of the `result.total === 0` branch:

```tsx
            {loadFailed ? (
              <div className="mkt-error" role="alert">
                <b>The registry could not be loaded</b>
                <p>
                  This is a fault on our side, not an empty result. No agents are
                  being hidden by your filters. Try again shortly.
                </p>
              </div>
            ) : result.total === 0 ? (
```

When `loadFailed` is true the facet rail and pagination must not render — an empty rail of zeros next to an error is the confusion this task removes. Wrap `<FacetRail …/>` and `<Pagination …/>` in `{!loadFailed && ( … )}`.

- [ ] **Step 4: Verify both states**

```bash
npm run typecheck && npm run build && npm test
```

To exercise the failure path, temporarily change the table name in `getCardsResult` from `v_registry_card` to `v_registry_card_nope`, run `npm run dev`, load `/marketplace`, and confirm you see **"The registry could not be loaded"** and *not* "No agents match these filters". **Revert the table name.**

- [ ] **Step 5: Commit**

```bash
git add lib/registry.ts app/marketplace components/marketplace
git commit -m "feat: distinguish a failed registry read from an empty result"
```

---

### Task 7: Compare

**Files:**
- Create: `app/marketplace/compare/page.tsx`
- Create: `components/marketplace/CompareTable.tsx`
- Create: `components/marketplace/CompareTray.tsx`
- Modify: `components/marketplace/MarketplaceApp.tsx`
- Modify: `components/AgentCard.tsx`
- Modify: `app/marketplace.css`

**Interfaces:**
- Consumes: `getPassports`, `ReadResult` from `lib/registry.ts`; `AssetPassport`; `evidence`, `listed`, `permissionValue`, `UNKNOWN` from `lib/present.ts`.
- Produces: `CompareTable({ agents })`; `CompareTray({ selected, onClear, onRemove })`; `AgentCard` gains optional `selected` and `onSelect`.

- [ ] **Step 1: Add compare styles to `app/marketplace.css`**

```css
.mkt-tray { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; background: #0b2b52;
  color: #fff; padding: 11px 0; box-shadow: 0 -8px 24px rgba(11,35,66,.18); }
.mkt-tray-inner { display: flex; align-items: center; gap: 12px; font-size: 12px; font-weight: 700; }
.mkt-tray-list { display: flex; gap: 7px; flex-wrap: wrap; }
.mkt-chip { background: rgba(255,255,255,.13); border: 0; color: #fff; border-radius: 999px;
  padding: 5px 10px; font-size: 10.5px; }
.mkt-cmp-wrap { overflow-x: auto; border: 1px solid #dce2eb; border-radius: 9px; background: #fff; }
.mkt-cmp { border-collapse: collapse; width: 100%; min-width: 640px; }
.mkt-cmp th, .mkt-cmp td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #f0f3f7;
  font-size: 11px; vertical-align: top; }
.mkt-cmp thead th { background: #fbfcfe; border-bottom: 1px solid #e1e6ec; font-size: 12px; }
.mkt-cmp tbody th { background: #fbfcfe; color: #5f6d7e; font-weight: 600; width: 170px; }
.mkt-cmp tr.mkt-diff th { border-left: 3px solid #f2b84b; }
.mkt-cmp tr.mkt-diff { background: #fffdf7; }
.mkt-cmp .mkt-none { color: #8a94a5; font-style: italic; }
.mkt-cmp-legend { display: flex; gap: 16px; font-size: 10.5px; color: #5f6d7e; margin-top: 10px; }
```

- [ ] **Step 2: Add selection to `AgentCard`**

Add two optional props and a checkbox in the card head. Extend the prop type with:

```tsx
  selected?: boolean;
  onSelect?: (assetId: string) => void;
```

and replace the bookmark button with:

```tsx
        {onSelect ? (
          <label title="Select to compare">
            <span className="mkt-sr">Select {c.name} to compare</span>
            <input
              type="checkbox"
              checked={!!selected}
              onChange={() => onSelect(c.asset_id)}
            />
          </label>
        ) : (
          <button className="bookmark" title="Save agent">
            ☆
          </button>
        )}
```

- [ ] **Step 3: Write the tray**

`components/marketplace/CompareTray.tsx`:

```tsx
"use client";

import Link from "next/link";
import type { RegistryCard } from "@/lib/types";

export default function CompareTray({
  selected,
  onRemove,
  onClear,
}: {
  selected: RegistryCard[];
  onRemove: (assetId: string) => void;
  onClear: () => void;
}) {
  if (selected.length === 0) return null;
  const href = `/marketplace/compare?ids=${selected.map((s) => s.asset_id).join(",")}`;

  return (
    <div className="mkt-tray" role="region" aria-label="Compare selection">
      <div className="container mkt-tray-inner">
        <span>{selected.length} selected</span>
        <div className="mkt-tray-list">
          {selected.map((s) => (
            <button className="mkt-chip" key={s.asset_id} onClick={() => onRemove(s.asset_id)}>
              {s.name} ×
            </button>
          ))}
        </div>
        <div className="mkt-spacer" />
        {selected.length >= 2 ? (
          <Link className="mkt-control" href={href}>
            Compare provenance
          </Link>
        ) : (
          <span style={{ opacity: 0.7, fontWeight: 400 }}>Select one more to compare</span>
        )}
        <button className="mkt-chip" onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire selection into `MarketplaceApp`**

Selection is component state, not URL state — it is a scratch pad, not a view. Cap it at three.

```tsx
  const [selected, setSelected] = useState<string[]>([]);

  const toggleSelect = (assetId: string) =>
    setSelected((s) =>
      s.includes(assetId) ? s.filter((x) => x !== assetId) : s.length >= 3 ? s : [...s, assetId]
    );

  // Selection survives filtering and paging, so candidates can be gathered from
  // more than one screen. Resolve against all cards, not the current page.
  const selectedCards = useMemo(
    () => selected.map((id) => cards.find((c) => c.asset_id === id)).filter(Boolean) as RegistryCard[],
    [selected, cards]
  );
```

Pass `selected={selected.includes(c.asset_id)}` and `onSelect={toggleSelect}` to each `AgentCard`, and render `<CompareTray selected={selectedCards} onRemove={toggleSelect} onClear={() => setSelected([])} />` as the last child of `.mkt-shell`.

- [ ] **Step 5: Write the compare table with three-state row marking**

`components/marketplace/CompareTable.tsx`:

```tsx
import { UNKNOWN, evidence, listed, permissionValue } from "@/lib/present";
import type { AssetPassport } from "@/lib/types";

type Row = { label: string; value: (a: AssetPassport) => string };

/** The passport's own layers, in the passport's order. No new claims. */
const ROWS: Row[] = [
  { label: "Creator / vendor", value: (a) => a.publisher ?? UNKNOWN },
  { label: "Primary model", value: (a) => evidence(a.evidence ?? {}, "model") },
  { label: "Framework", value: (a) => evidence(a.evidence ?? {}, "framework") },
  { label: "Tools / MCP", value: (a) => evidence(a.evidence ?? {}, "tool_mcp") },
  { label: "Data sources", value: (a) => evidence(a.evidence ?? {}, "data_source") },
  { label: "Integrations", value: (a) => evidence(a.evidence ?? {}, "integration") },
  { label: "Hosting model", value: (a) => a.cert_hosting ?? UNKNOWN },
  { label: "Data residency", value: (a) => a.cert_data_location ?? UNKNOWN },
  { label: "Graph permissions", value: (a) => permissionValue(a) },
  { label: "Compliance", value: (a) => listed(a.compliance, 3) },
  { label: "Deployment", value: (a) => a.delivery ?? UNKNOWN },
  { label: "Access model", value: (a) => a.acquire_using ?? UNKNOWN },
];

/**
 * Three states, not two.
 *
 * All-Unknown is neither a match nor a difference: calling it a match asserts
 * the agents are the same, calling it a difference asserts the records differ
 * when they are identical. Both are inferences the source does not support.
 */
function rowState(values: string[]): "same" | "differs" | "no-evidence" {
  if (values.every((v) => v === UNKNOWN)) return "no-evidence";
  return new Set(values).size === 1 ? "same" : "differs";
}

export default function CompareTable({ agents }: { agents: AssetPassport[] }) {
  return (
    <>
      <div className="mkt-cmp-wrap">
        <table className="mkt-cmp">
          <thead>
            <tr>
              <th scope="col">Provenance layer</th>
              {agents.map((a) => (
                <th scope="col" key={a.asset_id}>
                  {a.name}
                  <div className="mkt-row-sub">{a.publisher ?? UNKNOWN}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => {
              const values = agents.map((a) => r.value(a));
              const state = rowState(values);
              return (
                <tr key={r.label} className={state === "differs" ? "mkt-diff" : undefined}>
                  <th scope="row">{r.label}</th>
                  {values.map((v, i) => (
                    <td key={agents[i].asset_id} className={v === UNKNOWN ? "mkt-none" : undefined}>
                      {state === "no-evidence" && i === 0 ? "No evidence to compare" : v}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mkt-cmp-legend">
        <span>Highlighted rows differ</span>
        <span className="mkt-none">Unknown — the source is silent</span>
      </div>
    </>
  );
}
```

- [ ] **Step 6: Write the compare route**

`app/marketplace/compare/page.tsx`. **Do not `decodeURIComponent` `ids`** — Next has already decoded search params.

```tsx
import Link from "next/link";
import type { Metadata } from "next";
import CompareTable from "@/components/marketplace/CompareTable";
import { getPassports } from "@/lib/registry";
import "@/app/marketplace.css";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Compare agent provenance — SettleTop Agent Registry",
};

type Search = Promise<{ ids?: string }>;

export default async function ComparePage({ searchParams }: { searchParams: Search }) {
  const { ids } = await searchParams;
  const wanted = (ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const result = await getPassports(wanted);

  return (
    <div className="mkt-shell">
      <div className="container" style={{ paddingTop: 22, paddingBottom: 60 }}>
        <p style={{ marginBottom: 16 }}>
          <Link className="mkt-back" href="/marketplace">
            ← Back to the marketplace
          </Link>
        </p>

        {!result.ok ? (
          <div className="mkt-error" role="alert">
            <b>The registry could not be loaded</b>
            <p>This is a fault on our side. These agents have not been removed.</p>
          </div>
        ) : (
          <>
            <CompareTable agents={result.data} />
            {(() => {
              const found = new Set(result.data.map((a) => a.asset_id));
              const missing = wanted.filter((id) => !found.has(id));
              return missing.length ? (
                <p className="mkt-note" style={{ marginTop: 12 }}>
                  Not found in the registry: {missing.join(", ")}. They were not
                  dropped from the comparison silently.
                </p>
              ) : null;
            })()}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Verify**

```bash
npm run typecheck && npm run build && npm test
```

In the browser:
1. On `/marketplace`, select two agents. The tray appears; "Compare provenance" is enabled only at two or more.
2. Change a facet — the selection survives.
3. Open compare. Rows where the agents differ are highlighted; rows where **both** say Unknown are marked "No evidence to compare" and are **not** highlighted.
4. Append a junk id to the URL: it is named as not found rather than silently dropped.

- [ ] **Step 8: Commit**

```bash
git add app/marketplace components/marketplace components/AgentCard.tsx app/marketplace.css
git commit -m "feat: compare provenance side by side"
```

---

## Final verification

- [ ] `npm test` — all query-module tests pass
- [ ] `npm run typecheck` — clean
- [ ] `npm run build` — clean; route table lists `/`, `/agent/[id]`, `/marketplace`, `/marketplace/compare`
- [ ] `git status` — `app/globals.css` **not** modified
- [ ] `grep -c "mkt-" app/globals.css` returns 0
- [ ] On `/marketplace`, ticking `risk=Low` shows 36 results with Medium **16** and High **88** still in the rail
- [ ] Searching `Virtual Machines` on `/` and handing off to `/marketplace` yields the same 28 results on both
