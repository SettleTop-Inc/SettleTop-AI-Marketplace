/**
 * Fallback paint for the product diagrams.
 *
 * Applied as SVG presentation attributes, which sit BELOW author CSS in the
 * cascade: the theme's rules still win wherever the stylesheet is present,
 * and the drawing still paints correctly wherever it is not.
 *
 * That second case is not hypothetical. These diagrams originally took every
 * fill and stroke from CSS classes alone, and an unstyled SVG shape defaults
 * to fill:black with no stroke — so a missing or stale stylesheet turned both
 * of them into solid black rectangles. Presentation attributes also mean the
 * SVG survives being copied, exported or mailed on its own.
 *
 * The values are the light theme's tokens, resolved. They are duplicated from
 * app/design.css by necessity — an attribute cannot read a custom property —
 * so if the light palette moves, these move with it.
 */
export const PAINT = {
  /** The card the drawing sits on. */
  card: { fill: "#f6f8fc", stroke: "#dbe3ee" },
  /** A primary box. */
  node: { fill: "#ffffff", stroke: "#dbe3ee" },
  /** A secondary panel or chip. */
  chip: { fill: "#eaf0f8", stroke: "#e9eef6" },
  /** Connectors: never filled, or a curve becomes a blob. */
  link: { fill: "none", stroke: "#5f6e88" },
  /** Arrowheads and anything accented. */
  tip: { fill: "#8a6714" },
  /** Display text inside a box. */
  label: { fill: "#0f2453" },
  /** Supporting text. */
  sub: { fill: "#5f6e88" },
} as const;

/** Gradient stops, cool to warm along the direction of flow. */
export const STOP_A = "#0f2453";
export const STOP_B = "#8a6714";
