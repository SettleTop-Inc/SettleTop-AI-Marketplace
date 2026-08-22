import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PassportView from "@/components/PassportView";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { getLogos, getPassportBySlug } from "@/lib/registry";
import { withLogo } from "@/lib/logos";

export const revalidate = 300;

type Params = Promise<{ id: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { id } = await params;
  // The route segment is a slug, which for every listing today still equals
  // its own source_product_id, so every existing URL keeps resolving.
  const read = await getPassportBySlug(decodeURIComponent(id));
  // Only a successful read that found nothing may say "not found". A failed
  // read gets a neutral title rather than announcing an absence it cannot know.
  if (!read.ok) return { title: "Agent Passport — SettleTop" };
  const tiered = read.data;
  if (!tiered) return { title: "Agent not found — SettleTop AI Registry" };
  // name/tagline are public on both tiers (TieredPassport's `passport` is
  // either AssetPassport or PublicPassport), so metadata needs no branching
  // on `gated` at all.
  const a = tiered.passport;
  return {
    title: `${a.name} — Agent Passport — SettleTop`,
    description:
      a.tagline ??
      `Provenance record for ${a.name} by ${a.publisher ?? "an undisclosed publisher"}.`,
  };
}

type Search = Promise<{ from?: string; back?: string }>;

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { id } = await params;
  // `back`, like `from`, is a search param: Next decodes it once before it
  // reaches us, so this is already the registry's raw serialized query
  // string (e.g. "risk=Low&q=agent"). Do NOT decodeURIComponent it again —
  // a second decode would corrupt any literal `%` inside it and throw.
  const { from, back: backQS } = await searchParams;
  // The route segment is a slug, which for every listing today still equals
  // its own source_product_id, so every existing URL keeps resolving.
  const read = await getPassportBySlug(decodeURIComponent(id));

  // Thrown rather than rendered, deliberately. notFound() here would cache a
  // 404 for revalidate seconds and tell the visitor the agent does not exist;
  // rendering an error page inline would cache the outage just as long. A
  // thrown error is not cached by ISR, so the page recovers the moment the
  // database does, and error.tsx says whose fault it is. This also keeps the
  // anon path from ever surfacing a raw permission message: readPassport()
  // in lib/registry.ts already collapses a signed-out permission error into
  // the same READ_FAILED string an outage would produce, so `read.error`
  // here is always safe to hand to Error() / error.tsx.
  if (!read.ok) throw new Error(`registry read failed: ${read.error}`);

  const tiered = read.data;
  if (!tiered) notFound();

  // v_asset_passport / v_asset_passport_public carry no logo column — logos
  // have their own archival lifecycle and are deliberately kept out of the
  // capture views. Nothing here merged them, so every passport rendered
  // initials no matter how many logos the registry held. One lookup for one
  // product. `withLogo` is generic over `source_product_id`, which both tiers
  // carry, so this line is identical regardless of which tier `tiered` is.
  const logos = await getLogos([tiered.passport.source_product_id]);

  // The destination path is always one of these two literals — never built
  // from `from` or `back` — so neither an attacker-supplied `?from=` nor a
  // malformed `?back=` can steer this link off `/registry` or `/`. An
  // unrecognised `back` value is not a risk either: parseCriteria() ignores
  // anything it doesn't recognise rather than applying it.
  // "marketplace" is what this parameter carried before the browsing tool
  // moved to /registry, and passports were shared with it in the link. Both
  // values are honoured; only "registry" is emitted now.
  const fromRegistry = from === "registry" || from === "marketplace";

  const back = fromRegistry
    ? { href: `/registry${backQS ? `?${backQS}` : ""}`, label: "Back to the registry" }
    : { href: "/", label: "Back to the overview" };

  // `tiered.gated`/`tiered.passport` are correlated by construction
  // (TieredPassport in lib/types.ts), but reading `.passport` off `tiered`
  // ahead of a `tiered.gated` check would widen it back to the plain
  // `AssetPassport | PublicPassport` union, and PassportView's own Props is
  // a discriminated union that a bare `{ a, gated: boolean }` pair cannot
  // satisfy. Branching here, the same way CompareTable's caller below has
  // to, keeps `a` and `gated` narrowed to one matching Props member each.
  return (
    <>
      <SiteHeader current={fromRegistry ? "registry" : undefined} />
      <main id="top">
        {tiered.gated ? (
          <PassportView a={withLogo(tiered.passport, logos)} back={back} gated={true} />
        ) : (
          <PassportView a={withLogo(tiered.passport, logos)} back={back} gated={false} />
        )}
      </main>
      <SiteFooter />
    </>
  );
}
