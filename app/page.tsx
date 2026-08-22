import LandingApp from "@/components/LandingApp";
import { withLogo, withLogos } from "@/lib/logos";
import {
  getFacetCounts,
  getFeatured,
  getLogos,
  getStats,
  getTopAgents,
} from "@/lib/registry";
import type { TieredPassport } from "@/lib/types";

export const revalidate = 300;

/**
 * This page used to fetch every card in the registry so the browser could
 * count function categories and rank six agents. It needs neither: the counts
 * come from the same aggregation the registry facets use, and the ranking
 * is three reads of six rows. Browsing itself lives on /registry.
 */
export default async function HomePage() {
  const [facets, top, stats, featuredRead] = await Promise.all([
    getFacetCounts(),
    getTopAgents(),
    getStats(),
    getFeatured(),
  ]);

  // A failed read degrades to no featured card, the same tolerance
  // getFeatured() itself already applies to a missing row: this section is
  // decoration, not the reason the page exists, so it is never worth failing
  // the whole ISR render over.
  const featured: TieredPassport | null = featuredRead.ok ? featuredRead.data : null;

  // Only the handful of agents this page actually renders — three lists of six
  // plus the featured record — not every archived logo in the registry.
  const logos = await getLogos(
    [...top.All, ...top.Verified, ...top.Free, ...(featured ? [featured.passport] : [])].map(
      (a) => a.source_product_id
    )
  );

  // The use-case tiles are keyed by function category, and registry_search
  // normalises a null category to "Unknown" — the same bucket /registry
  // filters on, so a tile's count always matches what clicking it shows.
  const useCaseCounts: Record<string, number> = {};
  for (const v of facets.function ?? []) useCaseCounts[v.value] = v.count;

  // `featured.gated`/`featured.passport` are correlated by construction
  // (TieredPassport in lib/types.ts); reading `.passport` ahead of a
  // `.gated` check would widen it back to the plain `AssetPassport |
  // PublicPassport` union, which LandingApp's `featured` prop (itself a
  // `TieredPassport`) cannot accept without a cast. Branching here, the same
  // way app/agent/[id]/page.tsx does for PassportView, keeps each branch's
  // `withLogo` call narrowed to one matching TieredPassport member.
  const featuredWithLogo: TieredPassport | null = featured
    ? featured.gated
      ? { gated: true, passport: withLogo(featured.passport, logos) }
      : { gated: false, passport: withLogo(featured.passport, logos) }
    : null;

  return (
    <LandingApp
      useCaseCounts={useCaseCounts}
      topAgents={{
        All: withLogos(top.All, logos),
        Verified: withLogos(top.Verified, logos),
        Free: withLogos(top.Free, logos),
      }}
      stats={stats}
      featured={featuredWithLogo}
    />
  );
}
