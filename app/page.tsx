import RegistryApp from "@/components/RegistryApp";
import { getCards, getFeatured, getLogos, getStats } from "@/lib/registry";

// The registry only moves when the capture sweep writes. Five minutes is
// honest for a page that shows "last capture" and keeps Postgres quiet.
export const revalidate = 300;

export default async function HomePage() {
  const [cards, stats, featured, logos] = await Promise.all([
    getCards(),
    getStats(),
    getFeatured(),
    getLogos(),
  ]);

  // merged here rather than in the view: logos are a separate archival
  // lifecycle from the capture, and joining them in SQL would imply otherwise
  const withLogos = cards.map((c) => ({ ...c, logo: logos[c.source_product_id] ?? null }));
  const featuredWithLogo = featured
    ? { ...featured, logo: logos[featured.source_product_id] ?? null }
    : null;

  return (
    <RegistryApp cards={withLogos} stats={stats} featured={featuredWithLogo} />
  );
}
