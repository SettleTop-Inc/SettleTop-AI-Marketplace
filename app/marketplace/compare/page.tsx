import Link from "next/link";
import type { Metadata } from "next";
import CompareTable from "@/components/marketplace/CompareTable";
import { getPassports } from "@/lib/registry";
import "@/app/marketplace.css";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Compare agent provenance — SettleTop Agent Registry",
};

type Search = Promise<{ ids?: string }>;

export default async function ComparePage({ searchParams }: { searchParams: Search }) {
  // `ids` is a search param: Next has already decoded it once before this
  // page runs. Do NOT decodeURIComponent it again — a literal `%` in an id
  // would throw URIError, and a legitimately encoded `%2F`/`%2B` would be
  // corrupted. This is unlike app/agent/[id]/page.tsx, which decodes `id`
  // because that one arrives as a raw, still-encoded *path* param.
  const { ids } = await searchParams;
  const wanted = (ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const result = await getPassports(wanted);

  return (
    <div className="mkt-shell">
      <div className="container" style={{ paddingTop: 22, paddingBottom: 60 }}>
        <p style={{ marginBottom: 16 }}>
          <Link className="mkt-back" href="/marketplace">
            ← Back to the marketplace
          </Link>
        </p>

        {!result.ok ? (
          <div className="mkt-error" role="alert">
            <b>The registry could not be loaded</b>
            <p>This is a fault on our side. These agents have not been removed.</p>
          </div>
        ) : (
          <>
            <CompareTable agents={result.data} />
            {(() => {
              const found = new Set(result.data.map((a) => a.asset_id));
              const missing = wanted.filter((id) => !found.has(id));
              return missing.length ? (
                <p className="mkt-note" style={{ marginTop: 12 }}>
                  Not found in the registry: {missing.join(", ")}. They were not
                  dropped from the comparison silently.
                </p>
              ) : null;
            })()}
          </>
        )}
      </div>
    </div>
  );
}
