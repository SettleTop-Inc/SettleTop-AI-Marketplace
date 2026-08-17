import { Suspense } from "react";
import type { Metadata } from "next";
import MarketplaceApp from "@/components/marketplace/MarketplaceApp";
import { withLogos } from "@/lib/logos";
import { getCardsResult, getLogos } from "@/lib/registry";
import "@/app/marketplace.css";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Browse AI agents — SettleTop Agent Registry",
  description:
    "Filter AI agents by function, source marketplace, provenance, evidence tier, deployment, pricing and evidence risk.",
};

export default async function MarketplacePage() {
  const [cards, logos] = await Promise.all([getCardsResult(), getLogos()]);

  // This <Suspense> boundary is load-bearing for `npm run build`: without it,
  // useSearchParams() inside MarketplaceApp throws BailoutToCSRError on this
  // statically-optimized route. Do not remove or move it.
  //
  // KNOWN ISSUE, `next dev` only (npm run build && npm run start is
  // unaffected — confirmed below): a cold load of /marketplace under `next
  // dev` can render permanently inert — two `.mkt-shell` elements in the
  // DOM, no React fiber anywhere under the boundary, no control responds.
  //
  // Root cause, traced via the actual inline reveal script Next streams into
  // the page: unlike the production static build (which ships only this
  // fallback and lets the client fully render MarketplaceApp through
  // ordinary hydration), `next dev` has a real request URL to resolve
  // useSearchParams() against, so it renders BOTH this fallback AND the
  // fully-resolved real content for the same boundary, then hands the swap
  // to React's own streaming-reveal runtime ($RC/$RV, plus a follow-up
  // `_reactRetry` to actually attach React to the swapped-in DOM) — both
  // steps scheduled via requestAnimationFrame. Browsers fully suspend rAF
  // callbacks for a tab that isn't visible (Page Visibility spec), so if the
  // tab is backgrounded at load — the normal state for headless/automated
  // browser tooling, and possible for an ordinary background-tab open — the
  // reveal never fires and the page is stuck until the tab becomes visible,
  // at which point it self-heals with no reload (verified by manually
  // invoking the pending $RV/_reactRetry callbacks: the DOM collapses to one
  // shell and the inputs hydrate immediately).
  //
  // Confirmed this is not something our route code controls: `export const
  // dynamic = "force-dynamic"` does not change the behavior (dev still
  // performs the same dual-render/reveal dance regardless of the route's
  // static/dynamic classification), and `next build && next start` hydrates
  // correctly under the identical backgrounded-tab condition. Treat this as
  // an upstream `next dev` characteristic (Next 15.5.23) for this
  // useSearchParams()-under-Suspense pattern, not an application bug — when
  // verifying interactivity on this route, use `npm run build && npm run
  // start`, or make sure the dev tab is actually foregrounded/visible.
  return (
    <Suspense fallback={<div className="mkt-shell" aria-busy="true" />}>
      <MarketplaceApp
        cards={cards.ok ? withLogos(cards.data, logos) : []}
        loadFailed={!cards.ok}
      />
    </Suspense>
  );
}
