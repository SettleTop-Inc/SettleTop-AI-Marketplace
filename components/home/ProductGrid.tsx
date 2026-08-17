import Link from "next/link";
import { PRODUCTS } from "@/lib/products";
import ProductLogo from "@/components/ProductLogo";

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
              {p.logo && <ProductLogo logo={p.logo} name={p.name} />}
              <div className="hm-product__tags">
                {p.tags.map((t) => (
                  <span className="st-tag" key={t}>
                    {t}
                  </span>
                ))}
              </div>
              <h3 className="hm-product__name">{p.name}</h3>
              <p className="hm-product__line">{p.line}</p>
              <p className="hm-product__body">{p.summary}</p>
              <ul className="hm-product__points">
                {p.points.map((pt) => (
                  <li key={pt}>{pt}</li>
                ))}
              </ul>
              <Link className="hm-product__link" href={`/products/${p.slug}`}>
                Read more →
              </Link>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
