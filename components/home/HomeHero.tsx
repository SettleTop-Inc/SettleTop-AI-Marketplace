import Link from "next/link";

/**
 * The company hero.
 *
 * Replaces a hero that pitched the agent marketplace as though it were the
 * whole company. SettleTop ships three products, so the headline is the
 * thing all three do: supply intelligence a model can cite, without the
 * data leaving the customer's network.
 *
 * The agent search that used to live here has gone — it duplicated the
 * registry section's own search further down the page, and an agent query
 * box in a company hero over-weights one product out of three.
 */
export default function HomeHero({
  agentCount,
}: {
  /** Live count from the registry, so the proof strip states a fact rather
      than a marketing round number. */
  agentCount: number;
}) {
  return (
    <section className="hm-hero">
      <div className="st-shell st-shell--wide">
        <p className="st-eyebrow">The AI data provenance company</p>

        <h1 className="hm-hero__title">
          Intelligence your AI can cite.
          <br />
          <span>Inside your perimeter.</span>
        </h1>

        <p className="hm-hero__lede">
          Verified, timestamped intelligence about the software and AI you didn’t
          write. It installs in your cluster, runs offline, and answers your own
          model’s questions with sources.
        </p>

        <div className="hm-hero__actions">
          <Link className="st-btn st-btn--primary" href="#products">
            See the products
          </Link>
          <Link className="st-btn st-btn--secondary" href="/marketplace">
            Browse the AI marketplace
          </Link>
        </div>

        <dl className="hm-proof">
          <div>
            <dt>Nine</dt>
            <dd>ingest sources feeding the vulnerability database, unattended</dd>
          </div>
          <div>
            <dt>{agentCount}</dt>
            <dd>AI agents indexed, each with a provenance passport</dd>
          </div>
          <div>
            <dt>Zero</dt>
            <dd>egress — bring your own model, nothing leaves your network</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
