import { UNKNOWN } from "./present.ts";
import type { ProvenanceStatus, RegistryCard, RiskBand } from "./types.ts";

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

function countFacet(
  all: RegistryCard[],
  base: RegistryCard[],
  key: FacetKey,
  selected: string[]
): FacetValue[] {
  const counts = new Map<string, number>();
  // Seed from the query-filtered set (siblings NOT applied) so a value that a
  // sibling selection has driven to zero still appears in the rail instead of
  // silently disappearing — a shown 0 tells the visitor "still exists,
  // narrowed away"; an absent row is indistinguishable from "never existed".
  for (const c of all) counts.set(facetValueOf(c, key), 0);
  for (const c of base) {
    const v = facetValueOf(c, key);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  // A selected value with no rows anywhere in the base must still appear, or
  // it would vanish from the rail while active in the URL.
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
    return {
      key,
      label: FACET_LABELS[key],
      values: countFacet(byQ, base, key, criteria.facets[key]),
    };
  });

  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, criteria.page), pageCount);
  const start = (page - 1) * PAGE_SIZE;

  return { rows: rows.slice(start, start + PAGE_SIZE), facets, total, page, pageCount };
}

// risk and provenance are the only facets backed by a closed TS union on
// RegistryCard; the rest (source, function, tier, delivery, price) are open
// free text pulled from live listing data, so there is no static "wrong
// value" for them — only these two can be validated without the card set.
const RISK_VALUES = ["Low", "Medium", "High"] as const satisfies readonly RiskBand[];
const PROVENANCE_VALUES = ["Verified", "Disclosed", "Unknown"] as const satisfies readonly ProvenanceStatus[];

// `satisfies` above only checks the arrays don't contain a value OUTSIDE the
// union (a typo, or a value the union later drops) — it says nothing about
// the other direction. If RiskBand or ProvenanceStatus ever GAINS a member
// (e.g. "Critical") and this array is not updated, parseCriteria would
// silently strip that value out of every inbound URL: the facet rail could
// offer it, a shared link naming it would come back unfiltered, and the
// count shown beside it would contradict the page — the exact silent-wrong-
// number failure this module exists to prevent. AssertNever turns that
// omission into a `npm run typecheck` failure instead: if Exclude<...>
// leaves any member over, that member fails to satisfy `never` and the
// build breaks at this declaration.
type AssertNever<T extends never> = T;
type _RiskValuesExhaustive = AssertNever<Exclude<RiskBand, (typeof RISK_VALUES)[number]>>;
type _ProvenanceValuesExhaustive = AssertNever<Exclude<ProvenanceStatus, (typeof PROVENANCE_VALUES)[number]>>;

const FACET_VALIDATORS: Partial<Record<FacetKey, readonly string[]>> = {
  risk: RISK_VALUES,
  provenance: PROVENANCE_VALUES,
};

export function parseCriteria(sp: URLSearchParams): Criteria {
  const d = defaultCriteria();
  const sort = SORT_KEYS.includes(sp.get("sort") as SortKey) ? (sp.get("sort") as SortKey) : d.sort;
  const dirRaw = sp.get("dir");
  const view = sp.get("view") === "list" ? "list" : "grid";
  const pageRaw = Number(sp.get("page"));

  const facets = { ...d.facets };
  for (const k of FACET_KEYS) {
    const raw = sp.getAll(k).filter((v) => v.trim() !== "");
    const allowed = FACET_VALIDATORS[k];
    facets[k] = allowed ? raw.filter((v) => allowed.includes(v)) : raw;
  }

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
