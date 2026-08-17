import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { COMPANY } from "@/lib/site-content";

export const metadata: Metadata = {
  title: "Company — SettleTop",
  description: COMPANY.lede,
};

export default function CompanyPage() {
  return (
    <>
      <SiteHeader />
      <main id="top">
        <section className="pg-hero st-invert">
          <div className="st-shell">
            <p className="st-eyebrow">Company</p>
            <h1 className="pg-hero__title">{COMPANY.title}</h1>
            <p className="pg-hero__lede">{COMPANY.lede}</p>
          </div>
        </section>

        <section className="hm-section">
          <div className="st-shell">
            <div className="st-prose">
              {COMPANY.body.map((p) => (
                <p key={p.slice(0, 24)}>{p}</p>
              ))}
            </div>

            <header className="hm-section__head" style={{ marginTop: "var(--s10)" }}>
              <p className="st-eyebrow">Who we are</p>
              <h2 className="st-display">Meet the team</h2>
              <p className="st-lede">{COMPANY.teamIntro}</p>
            </header>

            <ul className="pg-people">
              {COMPANY.team.map((m) => (
                <li className="pg-person" key={m.name}>
                  <p className="pg-person__name">{m.name}</p>
                  <p className="pg-person__role">{m.role}</p>
                </li>
              ))}
            </ul>

            <header className="hm-section__head" style={{ marginTop: "var(--s10)" }}>
              <h2 className="st-display">Advisory board</h2>
            </header>

            <ul className="pg-people">
              {COMPANY.advisors.map((m) => (
                <li className="pg-person" key={m.name}>
                  <p className="pg-person__name">{m.name}</p>
                  <p className="pg-person__role">{m.role}</p>
                  <p className="pg-person__detail">{m.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="hm-section hm-section--band st-invert">
          <div className="st-shell">
            <header className="hm-section__head">
              <h2 className="st-display">{COMPANY.joinTitle}</h2>
              <p className="st-lede">{COMPANY.joinBody}</p>
            </header>
            <a
              className="st-btn st-btn--primary"
              href={COMPANY.joinHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              Join us ↗
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
