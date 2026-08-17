import Link from "next/link";

/**
 * The three products, marketplace first — it is the one a visitor can
 * use immediately, so it leads rather than trailing the two self-hosted
 * platforms.
 *
 * CodeRoot itself is deliberately absent — it stays a SettleTop product but
 * is not featured on this site.
 *
 * Every claim here is drawn from each product's own repository: the ingest
 * source list and MITRE chain from CodeRoot Vulnerability Intelligence, the
 * dossier structure from CodeRoot Open Source, the passport fields from this
 * application. Nothing is asserted that the products do not already do.
 */

type Product = {
  name: string;
  line: string;
  body: string;
  points: string[];
  tags: string[];
  href?: string;
  hrefLabel?: string;
};

const PRODUCTS: Product[] = [
  {
    name: "AI Marketplace",
    line: "Provenance for the agents you are about to adopt",
    body:
      "Every agent carries a passport recording what its build actually discloses — model, framework, tools, data sources, hosting, residency and permission scope — and who said so.",
    points: [
      "Verified, Disclosed and Unknown are recorded separately",
      "Where a source is silent, the value reads Unknown",
      "Filter, compare and share a result set by link",
    ],
    tags: ["Live registry"],
    href: "/marketplace",
    hrefLabel: "Browse the marketplace",
  },
  {
    name: "CodeRoot Open Source",
    line: "Component intelligence, from an SBOM",
    body:
      "Upload a bill of materials and every component resolves to its real source repository, enriched with maintenance, contributor, release, dependency and advisory signals.",
    points: [
      "Citeable dossiers, versioned and time-stamped",
      "Verified facts kept separate from assessed judgments",
      "Ecosystem maps and supply-chain indications and warnings",
    ],
    tags: ["Self-hosted", "Helm or Compose"],
  },
  {
    name: "CodeRoot Vulnerability Intelligence",
    line: "The MITRE chain, self-updating, in your cluster",
    body:
      "D3FEND to ATT&CK to CAPEC to CWE to CVE, with the CISA KEV catalog, EPSS scores, the NVD CPE dictionary and both tiers of GitHub Security Advisories. It comes up empty, populates itself and stays current with no operator intervention.",
    points: [
      "Nine ingest sources, unattended",
      "A read-only MCP server your own model can query",
      "Answers carry citations; no free-form SQL, no model credentials",
    ],
    tags: ["Bring your own model", "Air-gap capable"],
  },
];

export default function ProductGrid() {
  return (
    <section className="hm-section" id="products">
      <div className="st-shell st-shell--wide">
        <header className="hm-section__head">
          <p className="st-eyebrow">Products</p>
          <h2 className="st-display">Three records, one method</h2>
          <p className="st-lede">
            Each product answers the same question about software you did not
            write: what is in it, who says so, and how do you know. All three
            install where you run and keep their evidence local.
          </p>
        </header>

        <div className="hm-products">
          {PRODUCTS.map((p) => (
            <article className="hm-product" key={p.name}>
              <div className="hm-product__tags">
                {p.tags.map((t) => (
                  <span className="st-tag" key={t}>
                    {t}
                  </span>
                ))}
              </div>
              <h3 className="hm-product__name">{p.name}</h3>
              <p className="hm-product__line">{p.line}</p>
              <p className="hm-product__body">{p.body}</p>
              <ul className="hm-product__points">
                {p.points.map((pt) => (
                  <li key={pt}>{pt}</li>
                ))}
              </ul>
              {p.href && (
                <Link className="hm-product__link" href={p.href}>
                  {p.hrefLabel} →
                </Link>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
