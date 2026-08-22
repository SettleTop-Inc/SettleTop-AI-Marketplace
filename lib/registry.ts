import { supabase } from "./supabase.ts";
import { getSessionUser, supabaseServer } from "./auth.ts";
import { globalReadTake } from "./rate-limit.ts";
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
  PublicPassport,
  RegistryCard,
  RegistryStats,
  TieredPassport,
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
export type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; rateLimited?: boolean };

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
  if (!(await globalReadTake())) {
    return {
      ok: false,
      rateLimited: true,
      error: "You are moving quickly. Sign in for higher limits, or slow down and try again in a moment.",
    };
  }

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
 * The reduced-public-passport column allowlist (Access Foundation Phase B2).
 * Vendor facts, the top-line verdict, and where to get it: the 43 columns
 * Task 1 Step 2 names, and NONE of the depth columns (evidence, known_layers,
 * risk_basis, graph_permissions, compliance, the cert_* detail fields,
 * listings, or the capture internals).
 *
 * A runtime constant, not just a type, because it bounds the anon read's own
 * `.select()`. That is the actual boundary: even if v_asset_passport_public
 * were widened tomorrow, or (during the pre-migration fallback below) the
 * read reaches v_asset_passport itself, this list is still all this code
 * ever asks for. `satisfies` ties it to PublicPassport so the two cannot
 * silently drift apart.
 */
export const PUBLIC_PASSPORT_COLUMNS = [
  "asset_id", "source_product_id", "listing_url", "marketplace_id", "marketplace_name",
  "name", "publisher", "tagline", "overview_text",
  "surfaces", "categories", "industries", "works_with",
  "pricing", "acquire_using", "support",
  "listing_version", "listing_updated",
  "rating", "rating_count", "native_rating", "native_count",
  "external_source", "external_rating", "external_count",
  "certification", "cert_label", "cert_url",
  "function_category", "delivery", "price_band", "price_note",
  "reach", "provenance", "evidence_tier", "risk",
  "plans", "product_links", "legal_links", "media",
  "listing_id", "last_captured_at", "capture_count",
] as const satisfies readonly (keyof PublicPassport)[];

/**
 * Never the raw PostgREST message for a tiered passport read (unlike the
 * older readers below, whose error text stays server-side console.error and
 * whose ok:false is what every caller actually branches on). These reads sit
 * directly behind the anon path, so a genuine failure logs the real message
 * and hands the caller this instead.
 */
const READ_FAILED = "could not read the passport";

/**
 * slug -> asset_id via the definer resolver (public.resolve_asset_slug),
 * so browser roles need no asset_slug grant: base-table SELECT on asset_slug
 * is revoked from both anon and authenticated by the visibility-gate
 * migration. Both tiers use the anon client here — the function is routing
 * only, carries no provenance, and is granted to anon and authenticated
 * alike, so there is nothing for a session client to add.
 *
 * Returns the uuid, `undefined` for a slug that resolves to nothing, or
 * `null` if the read itself failed.
 */
export async function resolveAssetSlug(slug: string): Promise<string | undefined | null> {
  const { data, error } = await supabase.rpc("resolve_asset_slug", { p_slug: slug });
  if (error) {
    console.error("resolveAssetSlug", error.message);
    return null;
  }
  return (data as string | null) ?? undefined;
}

/**
 * The signed-out (public) tier of a passport read: v_asset_passport_public,
 * selecting only PUBLIC_PASSPORT_COLUMNS. If that view does not exist yet
 * (Postgres 42P01, undefined_table — the window between this code deploying
 * and the visibility-gate migration being applied to prod, since database
 * deploys are manual here), falls back to v_asset_passport itself, but keeps
 * the same allowlisted `.select()`. The public tier is therefore preserved by
 * the projection this code asks for, not by which view happens to answer, so
 * the pre-migration window shows exactly the same reduced passport an
 * anonymous visitor gets post-migration — never a 500, and never a silent
 * full-data leak either.
 */
async function readPublicPassport(
  assetId: string
): Promise<ReadResult<TieredPassport | null>> {
  const cols = PUBLIC_PASSPORT_COLUMNS.join(",");

  const pub = await supabase
    .from("v_asset_passport_public")
    .select(cols)
    .eq("asset_id", assetId)
    .maybeSingle();

  if (pub.error) {
    if (pub.error.code !== "42P01") {
      console.error("readPassport (public)", pub.error.message);
      return { ok: false, error: READ_FAILED };
    }
    const fb = await supabase
      .from("v_asset_passport")
      .select(cols)
      .eq("asset_id", assetId)
      .maybeSingle();
    if (fb.error) {
      console.error("readPassport (public fallback)", fb.error.message);
      return { ok: false, error: READ_FAILED };
    }
    return {
      ok: true,
      data: fb.data ? { gated: true, passport: fb.data as unknown as PublicPassport } : null,
    };
  }

  return {
    ok: true,
    data: pub.data ? { gated: true, passport: pub.data as unknown as PublicPassport } : null,
  };
}

/**
 * Resolves the session ONCE, then reads the tier it earns. Signed in reads
 * the full v_asset_passport through the user's cookie-bound session client
 * (authenticated role, from lib/auth.ts's supabaseServer()); signed out
 * delegates to readPublicPassport, which reads through the anon client (anon
 * role). Never a privileged credential for an anon read.
 *
 * Internal: getPassportByAssetId, getPassportBySlug and getFeatured are the
 * public interface. Slug resolution reuses resolveAssetSlug(), which is why
 * a slug that resolves to nothing (undefined) is a found-nothing ok:true
 * result rather than an error — the same "we could not read" vs "there is no
 * such record" distinction the passport readers have always kept, now
 * decided before the tier is even chosen.
 */
async function readPassport(
  by: { assetId: string } | { slug: string }
): Promise<ReadResult<TieredPassport | null>> {
  const user = await getSessionUser();

  const assetId = "assetId" in by ? by.assetId : await resolveAssetSlug(by.slug);
  if (assetId === undefined) return { ok: true, data: null };
  if (assetId === null) return { ok: false, error: READ_FAILED };

  if (!user) return readPublicPassport(assetId);

  const session = await supabaseServer();
  const { data, error } = await session
    .from("v_asset_passport")
    .select("*")
    .eq("asset_id", assetId)
    .maybeSingle();
  if (error) {
    console.error("readPassport (signed-in)", error.message);
    return { ok: false, error: READ_FAILED };
  }
  return { ok: true, data: data ? { gated: false, passport: data as AssetPassport } : null };
}

/**
 * Compare needs passports, keyed by asset_id, at one tier for the whole
 * comparison — decided once by the session, the same as a single passport
 * read. getPassportBySlug() cannot be reused for the "failed vs missing"
 * distinction: it returns null for both a missing row and a failed read, so
 * compare would report an agent as "not found" during an outage.
 */
export async function getPassports(
  assetIds: string[]
): Promise<ReadResult<{ gated: boolean; passports: AssetPassport[] | PublicPassport[] }>> {
  if (assetIds.length === 0) return { ok: true, data: { gated: false, passports: [] } };

  const user = await getSessionUser();

  if (user) {
    const session = await supabaseServer();
    const { data, error } = await session
      .from("v_asset_passport")
      .select("*")
      .in("asset_id", assetIds);
    if (error) {
      console.error("getPassports (signed-in)", error.message);
      return { ok: false, error: READ_FAILED };
    }
    return { ok: true, data: { gated: false, passports: (data ?? []) as AssetPassport[] } };
  }

  const cols = PUBLIC_PASSPORT_COLUMNS.join(",");
  const pub = await supabase
    .from("v_asset_passport_public")
    .select(cols)
    .in("asset_id", assetIds);

  if (pub.error) {
    if (pub.error.code !== "42P01") {
      console.error("getPassports (public)", pub.error.message);
      return { ok: false, error: READ_FAILED };
    }
    const fb = await supabase.from("v_asset_passport").select(cols).in("asset_id", assetIds);
    if (fb.error) {
      console.error("getPassports (public fallback)", fb.error.message);
      return { ok: false, error: READ_FAILED };
    }
    return {
      ok: true,
      data: { gated: true, passports: (fb.data ?? []) as unknown as PublicPassport[] },
    };
  }

  return {
    ok: true,
    data: { gated: true, passports: (pub.data ?? []) as unknown as PublicPassport[] },
  };
}

/**
 * One passport by asset_id, for the Quick-look modal's route handler. Keeps a
 * failed read (ok:false) distinct from a missing row (ok:true, data:null), so
 * the modal never renders "not found" during an outage. Tiered: delegates to
 * readPassport, so the shape depends on the caller's session.
 */
export async function getPassportByAssetId(
  assetId: string
): Promise<ReadResult<TieredPassport | null>> {
  return readPassport({ assetId });
}

/**
 * One passport, resolved through a URL slug rather than a listing id.
 *
 * Slug resolution goes through resolveAssetSlug() (the security-definer
 * public.resolve_asset_slug), not a direct read of asset_slug: base-table
 * SELECT on asset_slug is revoked from both browser roles by the
 * visibility-gate migration, and the definer function is what keeps slug
 * routing working for both tiers regardless. A merge can retire a slug's old
 * primary listing without touching the slug row itself, so this keeps
 * resolving after phase 3 even though a lookup keyed on source_product_id
 * would not: that column names one listing, which after phase 2 is not what
 * a visitor's URL identifies.
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
): Promise<ReadResult<TieredPassport | null>> {
  return readPassport({ slug });
}

/**
 * Every marketplace's own, unresolved account of one asset. Compare view:
 * what v_asset_passport was before phase 2, one row per listing, nothing
 * folded across marketplaces. The raw material the merged passport's
 * certification-group resolution is drawn from.
 *
 * Ordered on marketplace_name, then listing_id, which is unique per row, so
 * the panels render in a stable order across requests.
 *
 * Depth surface: read through the session client, not the anon client. The
 * visibility-gate migration revokes anon SELECT on v_listing_passport, so
 * this is a signed-in-only path by construction — a signed-out caller gets a
 * Postgres permission error, surfaced as the existing { ok:false } shape,
 * never a leak of listing-level provenance.
 */
export async function getListingPassports(
  assetId: string
): Promise<ReadResult<ListingPassport[]>> {
  const session = await supabaseServer();
  const { data, error } = await session
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
 *
 * Depth surface: session client only, same reasoning as getListingPassports
 * above. Signed-in-only by construction, not by caller discipline.
 */
export async function getAssetEvidence(
  assetId: string
): Promise<ReadResult<AssetEvidenceRow[]>> {
  const session = await supabaseServer();
  const { data, error } = await session
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
 *
 * Depth (admin) surface: session client only. The visibility-gate migration
 * revokes anon SELECT entirely and adds an admin predicate to the view
 * itself, so a signed-in non-admin reads zero rows and a signed-out caller
 * gets a permission error — this reader does not need to know which.
 */
export async function getMergeCandidates(
  confidence?: MergeConfidence
): Promise<ReadResult<MergeCandidate[]>> {
  const session = await supabaseServer();
  let query = session
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
 *
 * Picks the id from v_registry_card (public, both tiers, so choosing the
 * featured asset never itself depends on the session), then reads it through
 * readPassport — the same tiered read a single agent page gets, so the
 * featured card and the provenance workbench are gated exactly like every
 * other passport.
 */
export async function getFeatured(): Promise<ReadResult<TieredPassport | null>> {
  const { data, error } = await supabase
    .from("v_registry_card")
    .select("asset_id")
    .order("reach", { ascending: false })
    .order("rating_count", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("getFeatured", error.message);
    return { ok: false, error: READ_FAILED };
  }
  const row = data as { asset_id: string } | null;
  if (!row) return { ok: true, data: null };
  return readPassport({ assetId: row.asset_id });
}

/**
 * Depth surface: session client only, same reasoning as getListingPassports
 * above. Unlike the passport readers, this keeps its original signature
 * (array, not ReadResult): a failed read already degraded to [] before this
 * task, and a signed-out call now degrades the same way on a permission
 * error as it would on any other failure, never a leak.
 */
export async function getRecentChanges(limit = 12): Promise<ChangeRow[]> {
  const session = await supabaseServer();
  const { data, error } = await session
    .from("v_asset_change_feed")
    .select("*")
    .limit(limit);
  if (error) {
    console.error("getRecentChanges", error.message);
    return [];
  }
  return (data ?? []) as ChangeRow[];
}
