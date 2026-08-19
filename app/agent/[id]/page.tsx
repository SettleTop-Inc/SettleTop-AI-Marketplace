import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PassportView from "@/components/PassportView";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { getLogos, getPassport } from "@/lib/registry";
import { withLogo } from "@/lib/logos";

export const revalidate = 300;

type Params = Promise<{ id: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { id } = await params;
  const read = await getPassport(decodeURIComponent(id));
  // Only a successful read that found nothing may say "not found". A failed
  // read gets a neutral title rather than announcing an absence it cannot know.
  if (!read.ok) return { title: "Agent Passport — SettleTop" };
  const a = read.data;
  if (!a) return { title: "Agent not found — SettleTop AI Registry" };
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
  // reaches us, so this is already the marketplace's raw serialized query
  // string (e.g. "risk=Low&q=agent"). Do NOT decodeURIComponent it again —
  // a second decode would corrupt any literal `%` inside it and throw.
  const { from, back: backQS } = await searchParams;
  const read = await getPassport(decodeURIComponent(id));

  // Thrown rather than rendered, deliberately. notFound() here would cache a
  // 404 for revalidate seconds and tell the visitor the agent does not exist;
  // rendering an error page inline would cache the outage just as long. A
  // thrown error is not cached by ISR, so the page recovers the moment the
  // database does, and error.tsx says whose fault it is.
  if (!read.ok) throw new Error(`registry read failed: ${read.error}`);

  const passport = read.data;
  if (!passport) notFound();

  // v_asset_passport carries no logo column — logos have their own archival
  // lifecycle and are deliberately kept out of the capture views. Nothing here
  // merged them, so every passport rendered initials no matter how many logos
  // the registry held. One lookup for one product.
  const a = withLogo(passport, await getLogos([passport.source_product_id]));

  // The destination path is always one of these two literals — never built
  // from `from` or `back` — so neither an attacker-supplied `?from=` nor a
  // malformed `?back=` can steer this link off `/marketplace` or `/`. An
  // unrecognised `back` value is not a risk either: parseCriteria() ignores
  // anything it doesn't recognise rather than applying it.
  const back =
    from === "marketplace"
      ? { href: `/marketplace${backQS ? `?${backQS}` : ""}`, label: "Back to the marketplace" }
      : { href: "/", label: "Back to the overview" };

  return (
    <>
      <SiteHeader current={from === "marketplace" ? "marketplace" : undefined} />
      <main id="top">
        <PassportView a={a} back={back} />
      </main>
      <SiteFooter />
    </>
  );
}
