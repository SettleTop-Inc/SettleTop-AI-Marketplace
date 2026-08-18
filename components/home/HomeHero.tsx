import Link from "next/link";
import type { RegistryStats } from "@/lib/types";

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

/**
 * What the vulnerability database holds.
 *
 * These are not live. The database is a customer deployable — it runs in the
 * customer's own cluster and by design never reports back to us, so there is
 * no instance this page could read. The figures below were measured against a
 * populated v1.11.0 deployment on 2026-08-18:
 *
 *   cve              379,080      github_advisory  359,381
 *   kev                1,670      nvd_cpe        1,809,662
 *   epss (cve)       360,497      cwe                1,450
 *
 * They are rounded down and carry a "+" because every one of these corpora
 * only grows: a rounded figure stays true as it ages, where an exact one is
 * wrong within a day. KEV is stated exactly — it is small, it moves weekly,
 * and rounding it would throw away the precision that makes it credible.
 *
 * Re-measure with:
 *   docker exec <vuln-db-container> psql -U vulnerability_admin \
 *     -d vulnerability_intelligence -c "select count(*) from vulns.cve"
 *
 * Note that vulns.epss holds one row per CVE per scoring day, so its raw row
 * count (1.8M) is score-days and not vulnerabilities. The figure below is
 * count(distinct cve_id) — the number of vulnerabilities carrying a score.
 */
const VULN_PROOF = [
  { figure: "9", label: "live data sources" },
  { figure: "379,000+", label: "vulnerabilities" },
  { figure: "1,670", label: "known exploited (KEV)" },
  { figure: "360,000+", label: "scored by EPSS" },
] as const;

export default function HomeHero({
  stats,
}: {
  /** Live counts from the registry, so the proof strip states facts rather
      than marketing round numbers. null means the stats read failed — the
      registry row is then dropped entirely rather than rendered as zeroes,
      which would claim an empty registry. */
  stats: RegistryStats | null;
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
          {/* The marketplace leads: it is the one product a visitor can use
              without installing anything. */}
          <Link className="st-btn st-btn--primary" href="/marketplace">
            Browse AI &amp; Agents
          </Link>
          <Link className="st-btn st-btn--secondary" href="#products">
            See the products
          </Link>
        </div>

        {/* Two rows, deliberately unlabelled. The first is the registry, the
            second is the vulnerability database. Grouping them separates two
            products whose numbers used to sit in one undifferentiated row,
            where "nine ingest sources" and "6,820 agents indexed" read as
            though they measured the same thing. */}
        <div className="hm-proof">
          {/* Dropped rather than zeroed when the read fails. An absent row
              makes no claim; a row of zeroes claims an empty registry, which
              is the one thing this page must never say by accident. */}
          {stats && (
            <dl className="hm-proof__row">
              <div>
                <dt>{stats.marketplaces.toLocaleString()}</dt>
                <dd>marketplaces indexed</dd>
              </div>
              <div>
                <dt>{stats.agents.toLocaleString()}</dt>
                <dd>agents &amp; AI apps</dd>
              </div>
              <div>
                <dt>{stats.publishers.toLocaleString()}</dt>
                <dd>publishers</dd>
              </div>
              <div>
                <dt>{stats.changes.toLocaleString()}</dt>
                <dd>changes tracked</dd>
              </div>
            </dl>
          )}

          <dl className="hm-proof__row">
            {VULN_PROOF.map((p) => (
              <div key={p.label}>
                <dt>{p.figure}</dt>
                <dd>{p.label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
