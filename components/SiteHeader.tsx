import Image from "next/image";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";

/**
 * The header every route shares.
 *
 * Carries the real SettleTop lockup from public/brand rather than the text
 * wordmark this app used to approximate. The lockup is mark-over-wordmark,
 * so it is taller than a typical bar logo — the header height accommodates
 * it rather than squashing it.
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
  /** Match the page's own shell so the lockup aligns with the content
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
        <Link
          className="st-header__brand"
          href={home}
          aria-label="SettleTop home"
        >
          <Image
            src="/brand/settletop-logo.png"
            alt="SettleTop"
            width={1280}
            height={1016}
            priority
            className="st-header__logo"
          />
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
          <ThemeToggle />
          {onVendor && (
            <button className="st-btn st-btn--quiet" onClick={onVendor}>
              For vendors
            </button>
          )}
          {current === "marketplace" ? (
            <span className="st-header__here" aria-current="page">
              Browsing AI &amp; Agents
            </span>
          ) : (
            <Link className="st-btn st-btn--primary" href="/marketplace">
              Browse AI &amp; Agents
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
