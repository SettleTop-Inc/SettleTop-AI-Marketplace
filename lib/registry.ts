import { supabase } from "@/lib/supabase";
import type {
  AssetPassport,
  ChangeRow,
  RegistryCard,
  RegistryStats,
} from "@/lib/types";

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
 */
export async function getLogos(): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("v_logo_status")
    .select("source_product_id,archived_url")
    .eq("state", "archived");
  if (error) {
    console.error("getLogos", error.message);
    return {};
  }
  const map: Record<string, string> = {};
  for (const row of (data ?? []) as Array<{
    source_product_id: string;
    archived_url: string | null;
  }>) {
    if (row.archived_url) map[row.source_product_id] = row.archived_url;
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
 * The whole card list. At registry scale (hundreds to low thousands) shipping
 * this once and filtering in the browser preserves the instant-filter feel of
 * the design. When it outgrows that, move the filters into the query — the
 * view already carries every column the filters use.
 */
/**
 * PostgREST answers at most 1000 rows per request, whatever the query asks
 * for, and it does so without an error — the read simply returns a truncated
 * list. The registry passed that mark, so /marketplace was quietly showing
 * the first 1000 agents and reporting "1,000 agents" as if that were all of
 * them.
 *
 * This pages until a short page comes back. Rows are ordered by a unique
 * column so the windows cannot overlap or skip: ordering by a non-unique
 * column lets equal rows land on either side of a page boundary.
 */
const PAGE = 1000;

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

export async function getCardsResult(): Promise<ReadResult<RegistryCard[]>> {
  const r = await fetchAllCards();
  if (!r.ok) console.error("getCardsResult", r.error);
  return r;
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

export async function getPassport(
  sourceProductId: string
): Promise<AssetPassport | null> {
  const { data, error } = await supabase
    .from("v_asset_passport")
    .select("*")
    .eq("source_product_id", sourceProductId)
    .maybeSingle();
  if (error) {
    console.error("getPassport", error.message);
    return null;
  }
  return (data as AssetPassport) ?? null;
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

/** Every source_product_id, for generating passport routes at build time. */
export async function getAllProductIds(): Promise<string[]> {
  const { data, error } = await supabase
    .from("v_registry_card")
    .select("source_product_id");
  if (error) {
    console.error("getAllProductIds", error.message);
    return [];
  }
  return (data ?? []).map((r) => (r as { source_product_id: string }).source_product_id);
}
