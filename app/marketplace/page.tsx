import { Suspense } from "react";
import type { Metadata } from "next";
import MarketplaceApp from "@/components/marketplace/MarketplaceApp";
import { withLogos } from "@/lib/logos";
import { getCards, getLogos } from "@/lib/registry";
import "@/app/marketplace.css";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Browse AI agents — SettleTop Agent Registry",
  description:
    "Filter AI agents by function, source marketplace, provenance, evidence tier, deployment, pricing and evidence risk.",
};

export default async function MarketplacePage() {
  const [cards, logos] = await Promise.all([getCards(), getLogos()]);

  return (
    <Suspense fallback={<div className="mkt-shell" aria-busy="true" />}>
      <MarketplaceApp cards={withLogos(cards, logos)} />
    </Suspense>
  );
}
