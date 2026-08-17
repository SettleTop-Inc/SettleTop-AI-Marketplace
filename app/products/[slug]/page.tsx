import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ProductLogo from "@/components/ProductLogo";
import { PRODUCTS, byslug } from "@/lib/products";

type Params = Promise<{ slug: string }>;

/** Three known products, so the routes are generated rather than dynamic. */
export function generateStaticParams() {
  return PRODUCTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { slug } = await params;
  const p = byslug(slug);
  if (!p) return { title: "Product not found — SettleTop" };
  return { title: `${p.name} — SettleTop`, description: p.summary };
}

export default async function ProductPage({ params }: { params: Params }) {
  const { slug } = await params;
  const p = byslug(slug);
  if (!p) notFound();

  return (
    <>
      <SiteHeader />
      <main id="top">
        <section className="pg-hero st-invert">
          <div className="st-shell">
            <Link className="st-back" href="/products">
              ← All products
            </Link>
            {p.logo && <ProductLogo logo={p.logo} name={p.name} className="pd-logo--hero" />}
            <p className="st-eyebrow">{p.line}</p>
            <h1 className="pg-hero__title">{p.name}</h1>
            <p className="pg-hero__lede">{p.summary}</p>
            <div className="st-tags pd-tags">
              {p.tags.map((t) => (
                <span className="st-tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
            {p.cta && (
              <p className="pd-cta">
                <Link className="st-btn st-btn--primary" href={p.cta.href}>
                  {p.cta.label} →
                </Link>
              </p>
            )}
          </div>
        </section>

        {p.shots && p.shots.length > 0 && (
          <section className="hm-section">
            <div className="st-shell st-shell--wide">
              <header className="hm-section__head">
                <p className="st-eyebrow">The product</p>
                <h2 className="st-display">What it looks like</h2>
                <p className="st-lede">
                  Screens from a running instance, not mockups.
                </p>
              </header>
              <div className="pd-shots">
                {p.shots.map((s, i) => (
                  <figure className="pd-shot" key={s.src}>
                    <Image
                      src={s.src}
                      alt={s.alt}
                      width={3200}
                      height={2000}
                      sizes="(max-width: 900px) 100vw, 50vw"
                      // The first two are what a visitor sees without
                      // scrolling; the rest can wait.
                      priority={i < 2}
                    />
                    <figcaption>{s.caption}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          </section>
        )}

        {p.sections && (
          <section className="hm-section">
            <div className="st-shell">
              {p.sections.map((s) => (
                <div className="pd-section" key={s.title}>
                  <h2 className="st-display pd-section__title">{s.title}</h2>
                  <p className="st-prose">{s.body}</p>
                  {s.items && (
                    <ul className="pd-list">
                      {s.items.map((it) => (
                        <li key={it}>{it}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {p.audience && (
          <section className="hm-section hm-section--band st-invert">
            <div className="st-shell">
              <header className="hm-section__head">
                <p className="st-eyebrow">Built for</p>
                <h2 className="st-display">Who this is for</h2>
              </header>
              <ul className="pd-audience">
                {p.audience.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {p.deploy && (
          <section className="hm-section">
            <div className="st-shell">
              <header className="hm-section__head">
                <p className="st-eyebrow">Deployment</p>
                <h2 className="st-display">Where it runs</h2>
              </header>
              <dl className="pd-deploy">
                {p.deploy.map((d) => (
                  <div key={d.k}>
                    <dt>{d.k}</dt>
                    <dd>{d.v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
