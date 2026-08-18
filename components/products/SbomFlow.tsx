/**
 * What CodeRoot Open Source does to an SBOM.
 *
 * Companion to the MITRE graph on the other product page, deliberately a
 * different shape: that one draws a structure, this one draws a process. A
 * bill of materials comes in, each component is resolved to the repository it
 * really lives in, that repository is enriched with signals, and the result is
 * assessed for risk in context.
 *
 * The fork matters as much as the line. Anything ambiguous goes to triage for
 * a person to decide rather than being guessed at, which is the same rule the
 * rest of the product runs on — an unresolved component stays unresolved. It
 * is drawn dashed because it is the path that stops.
 *
 * Every stage and every signal is taken from the product's own README and the
 * running instance the screenshots came from.
 */

const STAGES = [
  { id: "sbom", label: "SBOM", sub: "CycloneDX in" },
  { id: "resolve", label: "Resolve", sub: "component to source repository" },
  { id: "enrich", label: "Enrich", sub: "signals gathered per repository" },
  { id: "assess", label: "Assess", sub: "risk in context" },
];

const PANELS: Record<string, { title: string; items: string[]; muted?: boolean }> = {
  resolve: {
    title: "Triage",
    items: ["ambiguous or unmatched", "a person decides", "nothing is guessed"],
    muted: true,
  },
  enrich: {
    title: "Signals",
    items: ["maintenance", "contributors", "releases", "dependencies", "advisories"],
  },
  assess: {
    title: "Output",
    items: ["contributor geography", "concentration", "watchlist countries", "citeable dossier"],
  },
};

const W = 1120;
const N_W = 244;
const N_H = 78;
const N_GAP = 22;
const N_Y = 34;
const X0 = (W - (STAGES.length * N_W + (STAGES.length - 1) * N_GAP)) / 2;
const nx = (i: number) => X0 + i * (N_W + N_GAP);
const nMid = (i: number) => nx(i) + N_W / 2;

const P_Y = 186;
const ROW = 26;
const P_PAD = 44;
const panelH = (n: number) => P_PAD + n * ROW;
const H = P_Y + panelH(5) + 30;

export default function SbomFlow() {
  return (
    <figure className="kg">
      <svg
        className="kg__svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby="fl-t fl-d"
        preserveAspectRatio="xMidYMid meet"
      >
        <title id="fl-t">How an SBOM becomes component intelligence</title>
        <desc id="fl-d">
          A CycloneDX bill of materials is ingested, each component is resolved
          to its source repository, that repository is enriched with
          maintenance, contributor, release, dependency and advisory signals,
          and the result is assessed for contributor geography, concentration,
          watchlist countries and a citeable dossier. Components that cannot be
          matched unambiguously branch off to triage for a person to decide.
        </desc>

        <defs>
          <linearGradient
            id="flFlow"
            gradientUnits="userSpaceOnUse"
            x1={X0}
            y1="0"
            x2={W - X0}
            y2="0"
          >
            <stop offset="0" className="kg__stop-a" />
            <stop offset="1" className="kg__stop-b" />
          </linearGradient>
          <marker
            id="flTip"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path className="kg__tip" d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>

        {/* The line through the pipeline. */}
        {STAGES.slice(0, -1).map((s, i) => (
          <path
            key={`e-${s.id}`}
            className="kg__link kg__link--series"
            style={{ stroke: "url(#flFlow)" }}
            markerEnd="url(#flTip)"
            d={`M ${nx(i) + N_W} ${N_Y + N_H / 2} H ${nx(i + 1) - 3}`}
          />
        ))}

        {/* Drops to each stage's panel. */}
        {STAGES.slice(1).map((s, i) => (
          <line
            key={`d-${s.id}`}
            className={`kg__link${PANELS[s.id].muted ? " fl-link--muted" : ""}`}
            style={{ stroke: "url(#flFlow)" }}
            x1={nMid(i + 1)}
            y1={N_Y + N_H}
            x2={nMid(i + 1)}
            y2={P_Y - 3}
            markerEnd="url(#flTip)"
          />
        ))}

        {STAGES.map((s, i) => (
          <g key={s.id}>
            <rect
              // No node is emphasised: the input is not the payoff, and the
              // fork already carries the diagram's point.
              className="kg__node"
              x={nx(i)}
              y={N_Y}
              width={N_W}
              height={N_H}
              rx="12"
            />
            <text className="kg__label" x={nMid(i)} y={N_Y + 34} textAnchor="middle">
              {s.label}
            </text>
            <text className="kg__sub" x={nMid(i)} y={N_Y + 56} textAnchor="middle">
              {s.sub}
            </text>
          </g>
        ))}

        {STAGES.slice(1).map((s, i) => {
          const p = PANELS[s.id];
          return (
            <g key={`p-${s.id}`}>
              <rect
                className={`kg__chip${p.muted ? " fl-panel--muted" : ""}`}
                x={nx(i + 1)}
                y={P_Y}
                width={N_W}
                height={panelH(p.items.length)}
                rx="10"
              />
              <text
                className="fl-panel__title"
                x={nx(i + 1) + 18}
                y={P_Y + 25}
              >
                {p.title}
              </text>
              {p.items.map((it, j) => (
                <text
                  key={it}
                  className="kg__sub"
                  x={nx(i + 1) + 18}
                  y={P_Y + 48 + j * ROW}
                >
                  {it}
                </text>
              ))}
            </g>
          );
        })}
      </svg>

      <figcaption>
        The fork is the point. A component that cannot be matched to one
        repository with confidence goes to triage rather than being guessed at —
        the same rule the dossiers run on, where an unstated value reads Unknown
        instead of being inferred from a neighbour.
      </figcaption>
    </figure>
  );
}
