/**
 * The MITRE chain, drawn.
 *
 * A database and an MCP endpoint have nothing worth screenshotting, so the
 * product page shows the thing the product actually is. Every node, edge and
 * direction comes from the product's own README — the five-link chain and the
 * four feeds that attach to CVE.
 *
 * The composition says something the boxes alone do not: the taxonomy runs in
 * series from the most abstract idea to the most concrete one, converges on a
 * single vulnerability record, and that record is then enriched from four
 * live feeds. Series, convergence, fan. The stroke gradient carries the same
 * idea — it cools at D3FEND and warms into the accent at CVE.
 *
 * Inline SVG rather than an exported image: it takes the theme's tokens, so
 * there is one drawing rather than a light copy and a dark copy to keep in
 * step, and it stays sharp at any width.
 */

const CHAIN = [
  { id: "d3fend", label: "D3FEND", sub: "defensive techniques" },
  { id: "attack", label: "ATT&CK", sub: "adversary techniques" },
  { id: "capec", label: "CAPEC", sub: "attack patterns" },
  { id: "cwe", label: "CWE", sub: "weakness classes" },
];

const ENRICH = [
  { label: "CISA KEV", sub: "known exploited" },
  { label: "EPSS", sub: "exploitation probability" },
  { label: "GHSA", sub: "packages, version ranges" },
  { label: "NVD CPE", sub: "product matching" },
];

const W = 1120;
const H = 520;

// Row 1 — the taxonomy, in series.
const N_W = 236;
const N_H = 76;
const N_Y = 36;
const N_GAP = 22;
const N_X0 = (W - (CHAIN.length * N_W + (CHAIN.length - 1) * N_GAP)) / 2;
const nx = (i: number) => N_X0 + i * (N_W + N_GAP);
const nMid = (i: number) => nx(i) + N_W / 2;

// The convergence.
const C_W = 250;
const C_H = 92;
const C_X = (W - C_W) / 2;
const C_Y = 210;
const C_MID = W / 2;

// The fan.
const P_W = 246;
const P_H = 74;
const P_Y = 410;
const P_GAP = 14;
const P_X0 = (W - (ENRICH.length * P_W + (ENRICH.length - 1) * P_GAP)) / 2;
const px = (i: number) => P_X0 + i * (P_W + P_GAP);
const pMid = (i: number) => px(i) + P_W / 2;

/** A vertical-tangent cubic: leaves one box downward, arrives at the next the
 *  same way, so nothing meets a box at an angle. */
const drop = (x1: number, y1: number, x2: number, y2: number) => {
  const dy = (y2 - y1) * 0.55;
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
};

export default function MitreChain() {
  return (
    <figure className="kg">
      <svg
        className="kg__svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby="kg-t kg-d"
        preserveAspectRatio="xMidYMid meet"
      >
        <title id="kg-t">The MITRE chain held as one graph</title>
        <desc id="kg-d">
          D3FEND leads to ATT&amp;CK, then CAPEC, then CWE, which resolves to a
          CVE record. Four feeds attach to that record: the CISA KEV catalog of
          known exploited vulnerabilities, EPSS exploitation probability, GitHub
          Security Advisories carrying packages and version ranges, and the NVD
          CPE dictionary for product matching.
        </desc>

        <defs>
          {/* userSpaceOnUse, not the default objectBoundingBox: a horizontal
              run has a zero-height bounding box, and a gradient mapped to it
              collapses — the series links rendered invisible. */}
          <linearGradient
            id="kgFlow"
            gradientUnits="userSpaceOnUse"
            x1={N_X0}
            y1="0"
            x2={W - N_X0}
            y2="0"
          >
            <stop offset="0" className="kg__stop-a" />
            <stop offset="1" className="kg__stop-b" />
          </linearGradient>
          <linearGradient
            id="kgDown"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1={N_Y}
            x2="0"
            y2={P_Y}
          >
            <stop offset="0" className="kg__stop-a" />
            <stop offset="1" className="kg__stop-b" />
          </linearGradient>
          <marker
            id="kgTip"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path className="kg__tip" d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
          <radialGradient id="kgHalo" cx="50%" cy="50%" r="50%">
            <stop offset="0" className="kg__halo-in" />
            <stop offset="1" className="kg__halo-out" />
          </radialGradient>
        </defs>

        {/* A soft wash behind the convergence, so the eye lands there. */}
        <ellipse
          cx={C_MID}
          cy={C_Y + C_H / 2}
          rx="330"
          ry="150"
          fill="url(#kgHalo)"
        />

        {/* Series: straight runs between the taxonomy nodes. */}
        {CHAIN.slice(0, -1).map((n, i) => (
          <path
            key={`s-${n.id}`}
            className="kg__link kg__link--series"
            markerEnd="url(#kgTip)"
            d={`M ${nx(i) + N_W} ${N_Y + N_H / 2} H ${nx(i + 1) - 3}`}
          />
        ))}

        {/* Convergence: CWE curves down into CVE. */}
        <path
          className="kg__link kg__link--lead"
          d={drop(nMid(3), N_Y + N_H, C_MID, C_Y)}
        />
        {/* Fan: CVE out to each feed. */}
        {ENRICH.map((c, i) => (
          <path
            key={`f-${c.label}`}
            className="kg__link"
            d={drop(C_MID, C_Y + C_H, pMid(i), P_Y)}
          />
        ))}

        {/* One travelling dash along the spine — the only motion, and it stops
            for anyone who has asked motion to stop. */}
        <path
          className="kg__pulse"
          d={`M ${nMid(0)} ${N_Y + N_H / 2} H ${nMid(3)} ${drop(nMid(3), N_Y + N_H, C_MID, C_Y).slice(1)}`}
        />

        <text className="kg__edge-label" x={C_MID + 168} y={C_Y - 26} textAnchor="start">
          resolves to
        </text>
        <text className="kg__edge-label" x={C_MID - 168} y={C_Y + C_H + 44} textAnchor="end">
          enriched by
        </text>

        {CHAIN.map((n, i) => (
          <g key={n.id}>
            <rect
              className="kg__node"
              x={nx(i)}
              y={N_Y}
              width={N_W}
              height={N_H}
              rx="12"
            />
            <text className="kg__label" x={nMid(i)} y={N_Y + 33} textAnchor="middle">
              {n.label}
            </text>
            <text className="kg__sub" x={nMid(i)} y={N_Y + 55} textAnchor="middle">
              {n.sub}
            </text>
          </g>
        ))}

        <g>
          <rect
            className="kg__node kg__node--focus"
            x={C_X}
            y={C_Y}
            width={C_W}
            height={C_H}
            rx="14"
          />
          <text className="kg__label kg__label--lg" x={C_MID} y={C_Y + 40} textAnchor="middle">
            CVE
          </text>
          <text className="kg__sub" x={C_MID} y={C_Y + 64} textAnchor="middle">
            the vulnerability record
          </text>
        </g>

        {ENRICH.map((c, i) => (
          <g key={c.label}>
            <rect
              className="kg__chip"
              x={px(i)}
              y={P_Y}
              width={P_W}
              height={P_H}
              rx="10"
            />
            <text className="kg__label kg__label--sm" x={pMid(i)} y={P_Y + 31} textAnchor="middle">
              {c.label}
            </text>
            <text className="kg__sub" x={pMid(i)} y={P_Y + 53} textAnchor="middle">
              {c.sub}
            </text>
          </g>
        ))}
      </svg>

      <figcaption>
        One traversable graph, not nine downloads joined by hand. Ask what
        defends against a technique, or which of your products a known-exploited
        vulnerability actually touches, and the path is already there.
      </figcaption>
    </figure>
  );
}
