import Link from "next/link";

/**
 * The header every route shares.
 *
 * This previously existed only inside LandingApp, so /marketplace and
 * /agent/[id] rendered with no header at all — the passport opened on a
 * bare back-link floating in white space, with no wordmark and no way to
 * reach any other part of the product. Lifting it here also settles a
 * second problem: the product was shipping two different headers.
 *
 * The brand lockup reuses .settletop-wordmark / .brand-divider /
 * .registry-wordmark from globals.css rather than restating it — that
 * treatment is the approved one and should have exactly one definition.
 *
 * No hooks, so this stays usable from both server routes (the passport)
 * and client ones (the marketplace, the landing page).
 */
export default function SiteHeader({
  current,
  wide,
  sections,
  onVendor,
}: {
  current?: "overview" | "marketplace";
  /** Match the page's own shell so the wordmark aligns with the content
      beneath it: the browsing surfaces are wide, document pages are not. */
  wide?: boolean;
  /** In-page anchors. Supplied by the landing page, which is the only
      surface with sections to jump to. */
  sections?: { href: string; label: string }[];
  /** Opens the vendor modal. Landing page only. */
  onVendor?: () => void;
}) {
  const home = current === "overview" ? "#top" : "/";
  return (
    <header className="st-header">
      <div
        className={`st-shell${wide ? " st-shell--wide" : ""} st-header__inner`}
      >
        <Link className="st-header__brand" href={home} aria-label="SettleTop AI Marketplace home">
          <span className="settletop-wordmark">SETTLETOP</span>
          <span className="brand-divider" aria-hidden="true" />
          <span className="registry-wordmark">AI MARKETPLACE</span>
        </Link>

        <nav className="st-header__nav" aria-label="Primary">
          {sections
            ? sections.map((s) => (
                <a key={s.href} href={s.href}>
                  {s.label}
                </a>
              ))
            : (
              <Link
                href="/"
                aria-current={current === "overview" ? "page" : undefined}
              >
                Overview
              </Link>
            )}
        </nav>

        <div className="st-header__actions">
          {onVendor && (
            <button className="st-btn st-btn--quiet" onClick={onVendor}>
              For vendors
            </button>
          )}
          {current === "marketplace" ? (
            <span className="st-header__here" aria-current="page">
              Browsing agents
            </span>
          ) : (
            <Link className="st-btn st-btn--primary" href="/marketplace">
              Browse agents
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
