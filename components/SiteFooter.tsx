import Image from "next/image";
import Link from "next/link";

/**
 * The footer every route shares.
 *
 * Deliberately short. It links only to routes that exist today — the
 * product, services and company pages land in a later change, and a footer
 * advertising pages that 404 is worse than a small footer.
 *
 * `meta` is an optional trailing line for surface-specific facts; the
 * landing page passes its live capture counts through it.
 */
export default function SiteFooter({
  wide,
  meta,
}: {
  wide?: boolean;
  meta?: React.ReactNode;
}) {
  return (
    <footer className="st-footer st-invert">
      <div className={`st-shell${wide ? " st-shell--wide" : ""} st-footer__inner`}>
        <div className="st-footer__brand">
          <Image
            src="/brand/settletop-logo.png"
            alt="SettleTop"
            width={1280}
            height={1016}
            className="st-footer__logo"
          />
          <p className="st-footer__line">
            Intelligence your AI can cite. Inside your perimeter.
          </p>
        </div>

        <nav className="st-footer__nav" aria-label="Footer">
          <Link href="/">Overview</Link>
          <Link href="/marketplace">Browse AI &amp; Agents</Link>
          <Link href="/products">Products</Link>
          <Link href="/services">Services</Link>
          <Link href="/partners">Partners</Link>
          <Link href="/company">Company</Link>
          <Link href="/news">News</Link>
        </nav>

        <div className="st-footer__legal">
          {meta && <p className="st-footer__meta">{meta}</p>}
          {/* No year: this component is pulled into the client bundle by
              LandingApp, so a Date() here can disagree between the server
              render and the client at a year boundary. */}
          <p>© SettleTop, Inc.</p>
        </div>
      </div>
    </footer>
  );
}
