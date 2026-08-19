import type { Metadata } from "next";
import RegistryApp from "@/components/registry/RegistryApp";
import { withLogos } from "@/lib/logos";
import { getLogos, getStats, searchRegistry } from "@/lib/registry";
import { parseCriteria } from "@/lib/registry-query";
import "@/app/registry.css";

export const metadata: Metadata = {
  title: "Browse AI agents — SettleTop AI Registry",
  description:
    "Filter AI agents by function, source marketplace, provenance, evidence tier, deployment, pricing and evidence risk.",
};

type Search = Promise<Record<string, string | string[] | undefined>>;

/**
 * The query runs in Postgres, not the browser.
 *
 * This page used to hand RegistryApp every card in the registry and let it
 * filter locally. That was ~5,000 cards of JSON to render 24 of them, and it
 * grew with every capture sweep. Now the URL is read here, the work happens in
 * registry_search(), and only the page being shown crosses the wire.
 *
 * Two things follow from that, both deliberate:
 *
 * Reading searchParams makes this route dynamic, so there is no `revalidate`
 * to set — every distinct filter combination is its own render. The reads are
 * a single RPC plus a small logo map.
 *
 * RegistryApp no longer calls useSearchParams(), which is why the Suspense
 * boundary that used to wrap it is gone. That boundary was working around a
 * `next dev` hazard: dev renders both the fallback and the resolved content
 * for a useSearchParams() boundary and hands the swap to a
 * requestAnimationFrame-driven reveal, which browsers suspend entirely in a
 * backgrounded tab — so a cold load in a background tab stayed permanently
 * inert. Criteria now arrive as a prop from the server, so that whole class of
 * failure is gone. Do not reintroduce useSearchParams() here without bringing
 * the boundary back with it.
 */
export default async function RegistryPage({
  searchParams,
}: {
  searchParams: Search;
}) {
  // parseCriteria owns every validation rule — page size allow-list, closed
  // unions for risk and provenance, sort keys. Rebuild a URLSearchParams from
  // Next's object so this page cannot drift into a second, laxer parser.
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) for (const v of value) sp.append(key, v);
    else if (value !== undefined) sp.set(key, value);
  }
  const criteria = parseCriteria(sp);

  const [result, stats] = await Promise.all([
    searchRegistry(criteria),
    getStats(),
  ]);

  // Sequenced after the search rather than run alongside it: the logos we need
  // are exactly the ones on this page, and we cannot know those ids until the
  // query returns. That is one extra round trip for a lookup of at most 96 ids,
  // in exchange for never again asking the database for the other 6,700.
  const logos = result.ok
    ? await getLogos(result.data.rows.map((r) => r.source_product_id))
    : {};

  return (
    <RegistryApp
      criteria={criteria}
      result={
        result.ok ? { ...result.data, rows: withLogos(result.data.rows, logos) } : null
      }
      // The size of the whole registry, for "the registry holds N agents" in
      // the empty state. result.total is the size of THIS query and would
      // read 0 there, which is the one number that empty state must not show.
      registryTotal={stats?.agents ?? null}
    />
  );
}
