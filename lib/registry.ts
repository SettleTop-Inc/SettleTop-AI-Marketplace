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
export async function getCards(): Promise<RegistryCard[]> {
  const { data, error } = await supabase
    .from("v_registry_card")
    .select("*")
    .order("name", { ascending: true });
  if (error) {
    console.error("getCards", error.message);
    return [];
  }
  return (data ?? []) as RegistryCard[];
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
