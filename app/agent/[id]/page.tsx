import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import PassportView from "@/components/PassportView";
import { getPassport } from "@/lib/registry";

export const revalidate = 300;

type Params = Promise<{ id: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { id } = await params;
  const a = await getPassport(decodeURIComponent(id));
  if (!a) return { title: "Agent not found — SettleTop AI Marketplace" };
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
  const a = await getPassport(decodeURIComponent(id));
  if (!a) notFound();

  // The destination path is always one of these two literals — never built
  // from `from` or `back` — so neither an attacker-supplied `?from=` nor a
  // malformed `?back=` can steer this link off `/marketplace` or `/`. An
  // unrecognised `back` value is not a risk either: parseCriteria() ignores
  // anything it doesn't recognise rather than applying it.
  const back =
    from === "marketplace"
      ? { href: `/marketplace${backQS ? `?${backQS}` : ""}`, label: "← Back to the marketplace" }
      : { href: "/", label: "← Back to the registry" };

  return (
    <main id="top">
      <section className="section">
        <div className="container">
          <p style={{ marginBottom: 18 }}>
            <Link className="link-btn" href={back.href}>
              {back.label}
            </Link>
          </p>
          <div className="modal-card" style={{ maxHeight: "none", boxShadow: "none" }}>
            <PassportView a={a} />
          </div>
        </div>
      </section>
    </main>
  );
}
