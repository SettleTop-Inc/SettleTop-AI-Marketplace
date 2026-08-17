/**
 * The proof half of the homepage thesis.
 *
 * Every claim below is a property the products already have — the Helm and
 * Compose install paths, the unattended ingest loop, the bring-your-own-model
 * posture with no shipped LLM client or credentials, and the in-cluster-only
 * MCP endpoint whose access control is a NetworkPolicy. Nothing here is
 * aspirational.
 */

const POINTS = [
  {
    k: "Installs where you run",
    v: "Helm into your own cluster, or Compose on a laptop. There is no hosted tier you have to send data to.",
  },
  {
    k: "Maintains itself",
    v: "The database comes up empty, populates itself and stays current on its own schedule, without an operator watching it.",
  },
  {
    k: "Brings your own model",
    v: "No LLM client and no model credentials ship with any product. Your model does the reasoning; we supply what it reads.",
  },
  {
    k: "Works offline",
    v: "Built for secure and air-gapped environments, where an agent has no route to the internet and the intelligence has to already be there.",
  },
];

export default function Sovereignty() {
  return (
    <section className="hm-section hm-section--band st-invert" id="sovereignty">
      <div className="st-shell st-shell--wide">
        <header className="hm-section__head">
          <p className="st-eyebrow">Sovereignty</p>
          <h2 className="st-display">Nothing leaves your network</h2>
          <p className="st-lede">
            The reason this works in regulated and classified environments is
            architectural, not contractual. There is nowhere for your data to go.
          </p>
        </header>

        <dl className="hm-points">
          {POINTS.map((p) => (
            <div className="hm-point" key={p.k}>
              <dt>{p.k}</dt>
              <dd>{p.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
