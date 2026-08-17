import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { NEWS, NEWS_BASE } from "@/lib/site-content";

export const metadata: Metadata = {
  title: "News, insights and resources — SettleTop",
  description:
    "Press releases, insights and research from SettleTop on software provenance, SBOMs and AI-assisted development.",
};

export default function NewsPage() {
  return (
    <>
      <SiteHeader />
      <main id="top">
        <section className="pg-hero st-invert">
          <div className="st-shell">
            <p className="st-eyebrow">News</p>
            <h1 className="pg-hero__title">News, insights and resources</h1>
          </div>
        </section>

        <section className="hm-section">
          <div className="st-shell">
            <ol className="pg-news">
              {NEWS.map((n) => (
                <li className="pg-news__item" key={n.slug}>
                  <div className="pg-news__meta">
                    <time className="pg-news__date">{n.date}</time>
                    {n.categories.length > 0 && (
                      <span className="pg-news__cats">{n.categories.join(" · ")}</span>
                    )}
                  </div>
                  {/* Article bodies have not been migrated, so each entry
                      points at the published piece. */}
                  <a
                    className="pg-news__title"
                    href={`${NEWS_BASE}/${n.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {n.title}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
