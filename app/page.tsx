import LandingApp from "@/components/LandingApp";
import { withLogo, withLogos } from "@/lib/logos";
import {
  getFacetCounts,
  getFeatured,
  getLogos,
  getStats,
  getTopAgents,
} from "@/lib/registry";

export const revalidate = 300;

/**
 * This page used to fetch every card in the registry so the browser could
 * count function categories and rank six agents. It needs neither: the counts
 * come from the same aggregation the marketplace facets use, and the ranking
 * is three reads of six rows. Browsing itself lives on /marketplace.
 */
export default async function HomePage() {
  const [facets, top, stats, featured] = await Promise.all([
    getFacetCounts(),
    getTopAgents(),
    getStats(),
    getFeatured(),
  ]);

  // Only the handful of agents this page actually renders — three lists of six
  // plus the featured record — not every archived logo in the registry.
  const logos = await getLogos(
    [...top.All, ...top.Verified, ...top.Free, ...(featured ? [featured] : [])].map(
      (a) => a.source_product_id
    )
  );

  // The use-case tiles are keyed by function category, and registry_search
  // normalises a null category to "Unknown" — the same bucket /marketplace
  // filters on, so a tile's count always matches what clicking it shows.
  const useCaseCounts: Record<string, number> = {};
  for (const v of facets.function ?? []) useCaseCounts[v.value] = v.count;

  return (
    <LandingApp
      useCaseCounts={useCaseCounts}
      topAgents={{
        All: withLogos(top.All, logos),
        Verified: withLogos(top.Verified, logos),
        Free: withLogos(top.Free, logos),
      }}
      stats={stats}
      featured={featured ? withLogo(featured, logos) : null}
    />
  );
}
