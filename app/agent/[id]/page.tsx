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
  if (!a) return { title: "Agent not found — SettleTop Agent Registry" };
  return {
    title: `${a.name} — Agent Passport — SettleTop`,
    description:
      a.tagline ??
      `Provenance record for ${a.name} by ${a.publisher ?? "an undisclosed publisher"}.`,
  };
}

type Search = Promise<{ from?: string }>;

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  const a = await getPassport(decodeURIComponent(id));
  if (!a) notFound();

  const back =
    from === "marketplace"
      ? { href: "/marketplace", label: "← Back to the marketplace" }
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
