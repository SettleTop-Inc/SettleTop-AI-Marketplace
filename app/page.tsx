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
