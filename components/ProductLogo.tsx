import type { Logo } from "@/lib/products";

/**
 * A product mark that follows the theme.
 *
 * Both colourways render and CSS shows the one matching the ground. That is
 * deliberate over a single asset recoloured with a filter: these SVGs are
 * single-fill artwork drawn for their background, and a CSS filter on a logo
 * is how brand marks end up subtly wrong.
 *
 * Plain <img> rather than next/image — an SVG has nothing to optimise, and
 * routing it through the image pipeline only adds a request.
 */
export default function ProductLogo({
  logo,
  name,
  className,
}: {
  logo: Logo;
  name: string;
  className?: string;
}) {
  return (
    <span className={`pd-logo${className ? ` ${className}` : ""}`}>
      {/* One of the two is always hidden, so only the visible one is
          announced — the wrapper carries the accessible name. */}
      <img className="pd-logo__light" src={logo.light} alt="" aria-hidden="true" />
      <img className="pd-logo__dark" src={logo.dark} alt="" aria-hidden="true" />
      <span className="st-sr">{name}</span>
    </span>
  );
}
