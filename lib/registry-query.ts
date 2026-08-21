import { UNKNOWN, marketplaceBadges } from "./present.ts";
import type { ProvenanceStatus, RegistryCard, RiskBand } from "./types.ts";

/**
 * Rows per page. The default stays 24, and only a non-default choice is
 * serialised, so every link saved before this became selectable still
 * resolves to exactly the same page of results.
 */
export const PAGE_SIZE = 24;

/** The offered page sizes. A `per` outside this set is ignored, not clamped —
 *  a hand-edited `?per=5000` must not become a licence to render everything. */
export const PAGE_SIZES = [12, 24, 48, 96] as const;

/**
 * Shared by the registry's selection UI and the compare page's own cap, so
 * the two cannot drift apart. Selecting a fourth agent must refuse visibly
 * (disabled checkbox, capped notice) rather than silently do nothing, and a
 * hand-edited `?ids=` URL that exceeds it must be told the same number.
 */
export const MAX_COMPARE = 3;

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
  perPage: number;
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
    perPage: PAGE_SIZE,
    view: "grid",
  };
}

/**
 * The single definition of what free-text search matches. Both surfaces import
 * this — if they diverge, the landing page's hand-off link lands the visitor on
 * an empty grid and blames their filters.
 *
 * Prefers c.search_blob, which the server builds across every listing of the
 * asset. That agrees with the nine-field reconstruction below only while an
 * asset has one listing; the day a second lands, the two answer different
 * questions and only the server's blob is complete. The reconstruction stays
 * as the fallback for a card read from production before this migration
 * deploys, where search_blob is absent.
 *
 * Field order in the fallback is preserved from the original landing-page
 * implementation so a needle spanning a field boundary behaves identically on
 * both surfaces.
 */
export function searchBlob(c: RegistryCard): string {
  if (c.search_blob !== undefined) return c.search_blob;
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

/**
 * The facet value(s) a card carries for a key. Exported so every surface that
 * filters on a facet value — not just this module's own runQuery — normalises
 * null and the literal 'Unknown' the same way. A second, hand-rolled version of
 * this mapping is how the two spellings drift apart again.
 *
 * source is the one MULTI-VALUED facet: an asset can be sold on more than one
 * marketplace and is not made to pick one, so it carries every marketplace the
 * asset is listed on, resolved to the NAMES the rail shows and deduplicated on
 * the name. registry_search builds its f_sources the same way — unnest
 * marketplace_ids, map to names, distinct on name — then matches with && (the
 * asset is a hit if ANY of its marketplaces is selected) and counts by
 * unnesting (the asset is counted under EACH of its marketplaces). This side
 * mirrors both: matchesFacet overlaps the sets, countFacet counts every value.
 * Under one listing this is a one-element array and behaves exactly as the
 * single value did, which is every asset in production today; the semantics
 * only diverge once a real merge lands, and then they diverge correctly.
 *
 * The remaining single-valued facets return a one-element array so the two call
 * sites can treat every facet the same way. Preferring marketplaceBadges (which
 * reads marketplace_ids, else the primary marketplace_name) is the same
 * prefer-the-complete-column move searchBlob() makes for search_blob: the
 * reconstruction from marketplace_name alone is only complete while the asset
 * has one listing.
 */
export function facetValuesOf(c: RegistryCard, key: FacetKey): string[] {
  switch (key) {
    case "source": return [...new Set(marketplaceBadges(c).map((m) => norm(m.name)))];
    case "function": return [norm(c.function_category)];
    case "provenance": return [norm(c.provenance)];
    case "risk": return [norm(c.risk)];
    case "tier": return [norm(c.evidence_tier)];
    case "delivery": return [norm(c.delivery)];
    case "price": return [norm(c.price_band)];
  }
}

function matchesFacet(c: RegistryCard, key: FacetKey, selected: string[]): boolean {
  if (selected.length === 0) return true;
  // Overlap, not equality: a value matches if ANY of the card's values for this
  // key is selected. For every facet but source the card has exactly one value,
  // so this is the same test it always was; for source it lifts the "or within
  // a group" rule to a set on both sides, matching registry_search's &&.
  return facetValuesOf(c, key).some((v) => selected.includes(v));
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
  selected: string[],
  seedSelected: (v: string) => boolean
): FacetValue[] {
  const counts = new Map<string, number>();
  // Seed from the query-filtered set (siblings NOT applied) so a value that a
  // sibling selection has driven to zero still appears in the rail instead of
  // silently disappearing — a shown 0 tells the visitor "still exists,
  // narrowed away"; an absent row is indistinguishable from "never existed".
  //
  // A card contributes to every value it carries, not one: for source that
  // means an asset on two marketplaces is counted under BOTH, exactly as
  // registry_search's `counted` CTE unnests f_sources before grouping. Once
  // assets are multi-listed these counts sum to more than `total`, and that is
  // correct: the number beside a marketplace answers "how many products would
  // selecting this show", and one product can be the answer to two of them.
  // Every other facet is single-valued, so its loop runs once per card as before.
  for (const c of all) for (const v of facetValuesOf(c, key)) counts.set(v, 0);
  for (const c of base) {
    for (const v of facetValuesOf(c, key)) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  // A selected value with no rows anywhere in the base must still appear, or
  // it would vanish from the rail while active in the URL. seedSelected gates
  // that seeding so this side matches registry_search's `selected` CTE: every
  // facet but source unnests p_<facet> verbatim there, so an unknown selected
  // value seeds a zero bucket on both sides. source is the exception, because
  // registry_search seeds the RESOLVED marketplace name and an unresolvable
  // value seeds nothing; so a selected source value that is not a real
  // marketplace name must seed no bucket here either, or runQuery would carry a
  // phantom {value, count:0, selected:true} the SQL never emits (issue #47).
  for (const v of selected) if (!counts.has(v) && seedSelected(v)) counts.set(v, 0);
  return [...counts.entries()]
    .sort((x, y) => collator.compare(x[0], y[0]))
    .map(([value, count]) => ({ value, count, selected: selected.includes(value) }));
}

export function runQuery(cards: RegistryCard[], criteria: Criteria): QueryResult {
  const byQ = cards.filter((c) => matchesQ(c, criteria.q));

  // The marketplace names the corpus knows about. registry_search resolves each
  // p_source value (id or name) to a canonical marketplace name and seeds the
  // source facet only with names that resolve, so a selected source value that
  // is not a real marketplace name seeds no bucket. The client never emits an
  // id, so resolution here is identity: a source value is seedable iff the
  // corpus carries it. Derived from the full corpus, not byQ, because a real
  // marketplace filtered out by the free-text query must still seed its selected
  // bucket at zero, exactly as registry_search does (src_resolved is computed
  // against the marketplace table, independent of the query).
  const knownSources = new Set(cards.flatMap((c) => facetValuesOf(c, "source")));
  const seedSelected = (key: FacetKey): ((v: string) => boolean) =>
    key === "source" ? (v) => knownSources.has(v) : () => true;

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
      values: countFacet(byQ, base, key, criteria.facets[key], seedSelected(key)),
    };
  });

  const total = rows.length;
  // Guard the size here too: runQuery is called with criteria from
  // parseCriteria in the app, but is a public export and can be handed an
  // object built by hand.
  const per = (PAGE_SIZES as readonly number[]).includes(criteria.perPage)
    ? criteria.perPage
    : PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / per));
  const page = Math.min(Math.max(1, criteria.page), pageCount);
  const start = (page - 1) * per;

  return { rows: rows.slice(start, start + per), facets, total, page, pageCount };
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
  const perRaw = Number(sp.get("per"));

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
    perPage: (PAGE_SIZES as readonly number[]).includes(perRaw) ? perRaw : d.perPage,
    view,
  };
}

/** Defaults are never serialised, so the plain case stays `/registry`. */
export function serializeCriteria(c: Criteria): string {
  const sp = new URLSearchParams();
  if (c.q.trim()) sp.set("q", c.q);
  for (const k of FACET_KEYS) for (const v of c.facets[k]) sp.append(k, v);
  if (c.sort !== "reach") sp.set("sort", c.sort);
  if (c.dir !== DEFAULT_DIR[c.sort]) sp.set("dir", c.dir);
  if (c.page > 1) sp.set("page", String(c.page));
  if (c.perPage !== PAGE_SIZE) sp.set("per", String(c.perPage));
  if (c.view !== "grid") sp.set("view", c.view);
  return sp.toString();
}
