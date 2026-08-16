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

export default async function AgentPage({ params }: { params: Params }) {
  const { id } = await params;
  const a = await getPassport(decodeURIComponent(id));
  if (!a) notFound();

  return (
    <main id="top">
      <section className="section">
        <div className="container">
          <p style={{ marginBottom: 18 }}>
            <Link className="link-btn" href="/">
              ← Back to the registry
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
