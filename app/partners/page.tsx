import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { PARTNERS } from "@/lib/site-content";

export const metadata: Metadata = {
  title: "Partners — SettleTop",
  description: PARTNERS.lede,
};

export default function PartnersPage() {
  return (
    <>
      <SiteHeader />
      <main id="top">
        <section className="pg-hero st-invert">
          <div className="st-shell">
            <p className="st-eyebrow">Partners</p>
            <h1 className="pg-hero__title">{PARTNERS.title}</h1>
            <p className="pg-hero__lede">{PARTNERS.lede}</p>
          </div>
        </section>

        <section className="hm-section">
          <div className="st-shell">
            <header className="hm-section__head">
              <h2 className="st-display">{PARTNERS.eraTitle}</h2>
              <p className="st-lede">{PARTNERS.eraBody}</p>
            </header>

            <header className="hm-section__head">
              <h2 className="st-display">{PARTNERS.whyTitle}</h2>
              <p className="st-lede">{PARTNERS.whyBody}</p>
            </header>

            <h3 className="st-display pg-subhead">{PARTNERS.pathTitle}</h3>
            <ol className="pg-paths">
              {PARTNERS.paths.map((p) => (
                <li className="pg-path" key={p.name}>
                  <p className="pg-path__name">{p.name}</p>
                  <p className="pg-path__body">{p.body}</p>
                </li>
              ))}
            </ol>

            <p className="st-lede pg-neutral">{PARTNERS.neutral}</p>
          </div>
        </section>

        <section className="hm-section hm-section--band st-invert">
          <div className="st-shell">
            <header className="hm-section__head">
              <h2 className="st-display">{PARTNERS.ctaTitle}</h2>
              <p className="st-lede">{PARTNERS.ctaBody}</p>
            </header>
            <a
              className="st-btn st-btn--primary"
              href={PARTNERS.ctaHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              {PARTNERS.ctaLabel} ↗
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
