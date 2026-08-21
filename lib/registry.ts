import { supabase } from "./supabase.ts";
import {
  type Criteria,
  type FacetGroup,
  type FacetKey,
  type FacetValue,
  FACET_KEYS,
  FACET_LABELS,
  PAGE_SIZE,
  PAGE_SIZES,
} from "./registry-query.ts";
import type {
  AssetEvidenceRow,
  AssetPassport,
  ChangeRow,
  ListingPassport,
  MergeCandidate,
  MergeConfidence,
  RegistryCard,
  RegistryStats,
} from "./types.ts";

/**
 * Every read the site performs. Server components call these directly.
 *
 * Caching: the registry only moves when the capture sweep writes, which is on
 * the order of minutes, so a short revalidate is honest and keeps the site
 * from hammering Postgres. Nothing here is user-specific.
 */
export const revalidate = 300;

/**
 * Archived logo per product id.
 *
 * Deliberately reads `archived_url` and not `logo_url`: the second is the
 * publisher's CDN, which we do not serve from. A product missing from this map
 * has no logo we actually hold, and the UI falls back to initials.
 *
 * Scoped to the ids being rendered rather than fetching the whole registry's
 * logos. It used to read every archived row and build a lookup table, which
 * PostgREST capped at 1000 with no error — so once the registry passed a
 * thousand products, which logo a card got depended on whether it happened to
 * fall inside an arbitrary 1000-row slice. Server-side pagination fixed the
 * cards but not this: it is a separate read that ran in full on every render.
 * Observed on marketplace page 60 before the change: Claude Opus 4.5, 4.6 and
 * 4.7 rendered logos while 4.8 showed initials, all four archived.
 */
export async function getLogos(
  sourceProductIds: string[]
): Promise<Record<string, string>> {
  if (sourceProductIds.length === 0) return {};

  const map: Record<string, string> = {};
  // Chunked so the caller cannot silently lose logos by asking for a lot of
  // them: `in.(...)` travels in the query string, and product ids run long
  // (PUBID.publisher|AID.offer|PAPPID.guid). 50 keeps the URL well inside any
  // limit and, at 12-96 cards a page, is one request in practice.
  const CHUNK = 50;
  for (let i = 0; i < sourceProductIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("v_logo_status")
      .select("source_product_id,archived_url")
      .eq("state", "archived")
      .in("source_product_id", sourceProductIds.slice(i, i + CHUNK));
    if (error) {
      // Return what we have. A missing logo degrades to initials, which is the
      // designed fallback — far better than failing the whole page render.
      console.error("getLogos", error.message);
      return map;
    }
    for (const row of (data ?? []) as Array<{
      source_product_id: string;
      archived_url: string | null;
    }>) {
      if (row.archived_url) map[row.source_product_id] = row.archived_url;
    }
  }
  return map;
}

export async function getStats(): Promise<RegistryStats | null> {
  const { data, error } = await supabase
    .from("v_registry_stats")
    .select("*")
    .single();
  if (error) {
    console.error("getStats", error.message);
    return null;
  }
  return data as RegistryStats;
}

/**
 * PostgREST answers at most 1000 rows per request, whatever the query asks
 * for, and it does so without an error — the read simply returns a truncated
 * list. The registry passed that mark, so /registry was quietly showing
 * the first 1000 agents and reporting "1,000 agents" as if that were all of
 * them.
 *
 * This pages until a short page comes back. Rows are ordered by a unique
 * column so the windows cannot overlap or skip: ordering by a non-unique
 * column lets equal rows land on either side of a page boundary.
 */
const PAGE = 1000;

// select("*") rather than an explicit column list, kept deliberately. Phase 2
// appends search_blob to v_registry_card, and under 1:1 it is the same nine
// fields this row already carries, concatenated: real duplication with
// nothing consuming it yet. Two things keep that duplication off the path a
// visitor actually pays for:
//
//   - fetchAllCards is not read by any page. searchRegistry(), below, is what
//     the registry grid calls, and it goes through registry_search(), a
//     Postgres function that builds its own JSON with to_jsonb(v), so a
//     column list here would not touch that payload at all.
//   - getTopAgents(), the other select("*") on this view, reads at most 18
//     rows total, where the duplication is a rounding error.
//
// An explicit list would also be a second, hand-maintained copy of
// v_registry_card's column set, kept in sync by hand on every future append,
// exactly the kind of drift the exhaustiveness checks elsewhere in this
// codebase exist to catch, for no payload this function actually serves.
async function fetchAllCards(): Promise<
  { ok: true; data: RegistryCard[] } | { ok: false; error: string }
> {
  const all: RegistryCard[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("v_registry_card")
      .select("*")
      .order("asset_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as RegistryCard[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    // A registry this size is plausible; a runaway loop is not.
    if (all.length >= 100_000) break;
  }
  // Paging a table that is being written to can return the same row twice:
  // a row inserted ahead of the cursor shifts everything after it down, and
  // the next window re-reads what the last one already returned. The capture
  // worker writes continuously, so this is the normal case, not a rare race.
  // Without the de-dupe the facet counts exceed the total, which is how it
  // was first noticed.
  const seen = new Set<string>();
  const unique = all.filter((c) => !seen.has(c.asset_id) && seen.add(c.asset_id));

  // The UI wants them by name; the paging had to be by a unique key.
  unique.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, data: unique };
}

/**
 * No page calls this any more — searchRegistry below replaced it. It stays as
 * the input to the SQL/TypeScript parity test, which needs the whole corpus in
 * order to run runQuery over it and compare. Do not reach for it from a page:
 * that is the megabyte-per-load behaviour this change removed.
 */
export async function getCards(): Promise<RegistryCard[]> {
  const r = await fetchAllCards();
  if (!r.ok) {
    console.error("getCards", r.error);
    return [];
  }
  return r.data;
}

/**
 * A read that can say it failed.
 *
 * The older readers return [] or null on error, which is survivable on a
 * marketing page and dishonest on a tool: "the registry is down" and "your
 * filters matched nothing" must never render the same.
 */
export type ReadResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Every facet's distinct values and counts, with no rows attached.
 *
 * The landing page used to derive this by receiving all ~5,000 cards and
 * counting them in the browser, to print "N agents" on eight use-case tiles.
 * registry_search already computes exactly these counts, so ask it for them
 * and no rows: p_limit 0 makes the page window empty while the facet
 * aggregation still runs over the whole registry.
 */
export async function getFacetCounts(): Promise<Partial<Record<FacetKey, FacetValue[]>>> {
  const { data, error } = await supabase.rpc("registry_search", { p_limit: 0 });
  if (error) {
    console.error("getFacetCounts", error.message);
    return {};
  }
  return (data as { facets?: Partial<Record<FacetKey, FacetValue[]>> }).facets ?? {};
}

export type TopFilter = "All" | "Verified" | "Free";

/**
 * The handful of agents the landing page features, one short list per tab.
 *
 * Three small reads rather than one big one. Ranking the whole registry in the
 * browser meant shipping the whole registry; the top six of a tab cannot be
 * taken from the global top six either, because a tab's filter can exclude
 * all of them.
 *
 * Ordering matches what the client did — rating, then rating_count, then
 * reach — with nulls last, which is where `rating ?? 0` already put them.
 */
export async function getTopAgents(n = 6): Promise<Record<TopFilter, RegistryCard[]>> {
  const ranked = () =>
    supabase
      .from("v_registry_card")
      .select("*")
      .order("rating", { ascending: false, nullsFirst: false })
      .order("rating_count", { ascending: false, nullsFirst: false })
      .order("reach", { ascending: false, nullsFirst: false })
      .limit(n);

  const [all, verified, free] = await Promise.all([
    ranked(),
    ranked().eq("provenance", "Verified"),
    ranked().in("price_band", ["Free", "Freemium"]),
  ]);

  for (const [label, r] of [["All", all], ["Verified", verified], ["Free", free]] as const) {
    if (r.error) console.error(`getTopAgents(${label})`, r.error.message);
  }

  return {
    All: (all.data ?? []) as RegistryCard[],
    Verified: (verified.data ?? []) as RegistryCard[],
    Free: (free.data ?? []) as RegistryCard[],
  };
}

export interface RegistryPage {
  rows: RegistryCard[];
  facets: FacetGroup[];
  total: number;
  page: number;
  pageCount: number;
}

/** The shape registry_search() returns. Facet groups arrive keyed by facet. */
interface SearchPayload {
  total: number;
  rows: RegistryCard[];
  facets: Partial<Record<FacetKey, FacetValue[]>>;
}

/**
 * One page of the registry, filtered, sorted and counted by Postgres.
 *
 * Replaces shipping every card to the browser and filtering there. That held
 * while the registry was in the hundreds; at 5,000+ it was megabytes of JSON
 * per page load to render 24 cards.
 *
 * Everything comes back in a single call because the facet counts cannot be
 * computed any other way: PostgREST has no GROUP BY, and the counts are
 * self-excluding, so they depend on the current selection and cannot be
 * precomputed. See supabase/migrations/20260818120000_registry_search.sql.
 *
 * A single call is also a single snapshot, which is what makes the totals
 * agree. fetchAllCards above has to de-dupe because the capture worker writes
 * between its pages; this function cannot observe a mid-write registry at all.
 */
export async function searchRegistry(c: Criteria): Promise<ReadResult<RegistryPage>> {
  // runQuery guards the page size too. Criteria normally comes from
  // parseCriteria, but it is a plain object and can be built by hand.
  const per = (PAGE_SIZES as readonly number[]).includes(c.perPage) ? c.perPage : PAGE_SIZE;

  const call = async (page: number): Promise<ReadResult<SearchPayload>> => {
    const { data, error } = await supabase.rpc("registry_search", {
      p_q: c.q,
      p_source: c.facets.source,
      p_function: c.facets.function,
      p_provenance: c.facets.provenance,
      p_risk: c.facets.risk,
      p_tier: c.facets.tier,
      p_delivery: c.facets.delivery,
      p_price: c.facets.price,
      p_sort: c.sort,
      p_dir: c.dir,
      p_limit: per,
      p_offset: (page - 1) * per,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: data as SearchPayload };
  };

  const requested = Math.max(1, c.page);
  let got = await call(requested);
  if (!got.ok) {
    console.error("searchRegistry", got.error);
    return got;
  }

  let page = requested;
  let pageCount = Math.max(1, Math.ceil(got.data.total / per));

  // An inbound ?page=999 lands on the last page rather than an empty grid,
  // matching what runQuery does by clamping before it slices. Server-side the
  // total is only known after the read, so an out-of-range page costs a
  // second call — rare enough to be worth the honest landing.
  if (requested > pageCount) {
    page = pageCount;
    got = await call(page);
    if (!got.ok) {
      console.error("searchRegistry", got.error);
      return got;
    }
    pageCount = Math.max(1, Math.ceil(got.data.total / per));
  }

  // Keyed object to the ordered, labelled array the rail renders. Driven by
  // FACET_KEYS so the rail's order stays the client's decision, not the
  // order jsonb_object_agg happened to build.
  const facets: FacetGroup[] = FACET_KEYS.map((key) => ({
    key,
    label: FACET_LABELS[key],
    values: got.ok ? (got.data.facets[key] ?? []) : [],
  }));

  return {
    ok: true,
    data: { rows: got.data.rows ?? [], facets, total: got.data.total, page, pageCount },
  };
}

/**
 * Compare needs full passports, keyed by asset_id. getPassportBySlug() cannot
 * be reused: it returns null for both a missing row and a failed read, so
 * compare would report an agent as "not found" during an outage.
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

/**
 * One passport, resolved through a URL slug rather than a listing id.
 *
 * Two reads: asset_slug is the only table keyed on the string a visitor
 * typed, and v_asset_passport is keyed on asset_id. A merge can retire a
 * slug's old primary listing without touching the slug row itself, so this
 * keeps resolving after phase 3 even though a lookup keyed on
 * source_product_id would not: that column names one listing, which after
 * phase 2 is not what a visitor's URL identifies.
 *
 * "We could not read" is kept distinct from "there is no such record" here,
 * the same way getPassports() above does it. A reader that collapsed the two
 * used to sit at this name: it returned null for a failed read, the route
 * called notFound(), and the 404 page told the visitor there is no captured
 * record for that agent and that the registry never invents one to fill a
 * gap. A confident claim of absence, produced by an outage, about a record
 * that exists, and cached by ISR for five minutes after recovery. Task 5
 * moved the route onto this function instead, and nothing calls the old one
 * any more, so it was deleted rather than kept as a second reader with the
 * same bug this one exists to avoid.
 */
export async function getPassportBySlug(
  slug: string
): Promise<ReadResult<AssetPassport | null>> {
  const { data: slugRow, error: slugError } = await supabase
    .from("asset_slug")
    .select("asset_id")
    .eq("slug", slug)
    .maybeSingle();
  if (slugError) {
    console.error("getPassportBySlug", slugError.message);
    return { ok: false, error: slugError.message };
  }
  if (!slugRow) return { ok: true, data: null };

  const assetId = (slugRow as { asset_id: string }).asset_id;
  const { data, error } = await supabase
    .from("v_asset_passport")
    .select("*")
    .eq("asset_id", assetId)
    .maybeSingle();
  if (error) {
    console.error("getPassportBySlug", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, data: (data as AssetPassport) ?? null };
}

/**
 * Every marketplace's own, unresolved account of one asset. Compare view:
 * what v_asset_passport was before phase 2, one row per listing, nothing
 * folded across marketplaces. The raw material the merged passport's
 * certification-group resolution is drawn from.
 *
 * Ordered on marketplace_name, then listing_id, which is unique per row, so
 * the panels render in a stable order across requests.
 */
export async function getListingPassports(
  assetId: string
): Promise<ReadResult<ListingPassport[]>> {
  const { data, error } = await supabase
    .from("v_listing_passport")
    .select("*")
    .eq("asset_id", assetId)
    .order("marketplace_name", { ascending: true })
    .order("listing_id", { ascending: true });
  if (error) {
    console.error("getListingPassports", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, data: (data ?? []) as ListingPassport[] };
}

/**
 * Every capture of every listing of one asset, newest first: the evidence
 * trail a passport points back to. capture_id is unique per row and breaks
 * ties within the same captured_at.
 */
export async function getAssetEvidence(
  assetId: string
): Promise<ReadResult<AssetEvidenceRow[]>> {
  const { data, error } = await supabase
    .from("v_asset_evidence")
    .select("*")
    .eq("asset_id", assetId)
    .order("captured_at", { ascending: false })
    .order("capture_id", { ascending: true });
  if (error) {
    console.error("getAssetEvidence", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, data: (data ?? []) as AssetEvidenceRow[] };
}

/**
 * The cross-marketplace merge-candidate queue (#64): pairs of listings on
 * different marketplaces that look like one product, highest confidence first.
 * DETECTION ONLY. This surfaces proposals for a human to confirm; it merges
 * nothing. merge_assets (#63) is what will act on a confirmed pair, and the
 * review UI (#65) is what will render this. Until those land, v_merge_candidates
 * is the interface and this reader is the one caller.
 */
export async function getMergeCandidates(
  confidence?: MergeConfidence
): Promise<ReadResult<MergeCandidate[]>> {
  let query = supabase
    .from("v_merge_candidates")
    .select("*")
    // 'high' sorts before 'low' alphabetically, which is the order we want for
    // today's two-tier enum. A third tier (say 'medium') would not sort into
    // place by name and would need a numeric rank column on the view.
    .order("confidence", { ascending: true })
    .order("norm_name", { ascending: true })
    .order("asset_id_a", { ascending: true });
  if (confidence) query = query.eq("confidence", confidence);
  const { data, error } = await query;
  if (error) {
    console.error("getMergeCandidates", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, data: (data ?? []) as MergeCandidate[] };
}

/**
 * The featured record for the hero and the provenance workbench: the best
 * evidenced thing in the registry, chosen by the data rather than pinned by
 * hand. If a better documented agent lands tomorrow, the homepage changes.
 */
export async function getFeatured(): Promise<AssetPassport | null> {
  const { data, error } = await supabase
    .from("v_asset_passport")
    .select("*")
    .order("reach", { ascending: false })
    .order("rating_count", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("getFeatured", error.message);
    return null;
  }
  return (data as AssetPassport) ?? null;
}

export async function getRecentChanges(limit = 12): Promise<ChangeRow[]> {
  const { data, error } = await supabase
    .from("v_asset_change_feed")
    .select("*")
    .limit(limit);
  if (error) {
    console.error("getRecentChanges", error.message);
    return [];
  }
  return (data ?? []) as ChangeRow[];
}
