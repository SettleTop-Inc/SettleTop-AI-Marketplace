import type { Metadata } from "next";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ProductLogo from "@/components/ProductLogo";
import { PRODUCTS } from "@/lib/products";

export const metadata: Metadata = {
  title: "Products — SettleTop",
  description:
    "Three records, one method: the AI Registry, CodeRoot Open Source and CodeRoot Vulnerability Intelligence.",
};

export default function ProductsPage() {
  return (
    <>
      <SiteHeader />
      <main id="top">
        <section className="pg-hero st-invert">
          <div className="st-shell">
            <p className="st-eyebrow">Products</p>
            <h1 className="pg-hero__title">Three records, one method</h1>
            <p className="pg-hero__lede">
              Each answers the same question about software you did not write:
              what is in it, who says so, and how do you know.
            </p>
          </div>
        </section>

        <section className="hm-section">
          <div className="st-shell st-shell--wide">
            <div className="hm-products">
              {PRODUCTS.map((p) => (
                <article className="hm-product" key={p.slug}>
                  {p.logo && <ProductLogo logo={p.logo} name={p.name} />}
                  <div className="hm-product__tags">
                    {p.tags.map((t) => (
                      <span className="st-tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                  <h2 className="hm-product__name">{p.name}</h2>
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
      </main>
      <SiteFooter />
    </>
  );
}
