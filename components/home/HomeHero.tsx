import Link from "next/link";
import type { RegistryStats } from "@/lib/types";

/**
 * The company hero.
 *
 * Replaces a hero that pitched the agent registry as though it were the
 * whole company. SettleTop ships three products, so the headline is the
 * thing all three do: trace where every part of a software estate came
 * from, whether it was written in-house, borrowed or bought.
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

/**
 * The registry row's labels are driven by live counts, so a hardcoded plural
 * eventually reads wrong. It already did: exactly one marketplace is indexed
 * today, and the strip said "1 marketplaces indexed". That is the settled
 * state of that figure rather than a transient edge case, since a second
 * marketplace is a deliberate piece of work rather than something the crawl
 * discovers.
 *
 * Applied to all four counts, not just the one currently at 1 — the others
 * are only correct by accident of being large, and a figure that can be
 * computed can be one.
 *
 * The vulnerability row below needs none of this: its figures are fixed
 * strings, already written to read correctly.
 */
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

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
        <p className="st-eyebrow">The software provenance company</p>

        <h1 className="hm-hero__title">
          Know what you <span>build, buy and borrow.</span>
        </h1>

        <p className="hm-hero__lede">
          Understanding your software starts with knowing where it came from.
          SettleTop traces the provenance of every part of it: your code and the
          open source beneath it, the vendors behind it, the agents and AI apps
          you adopt, and the data they run on. It keeps a record of what changed.
        </p>

        <div className="hm-hero__actions">
          {/* The registry leads: it is the one product a visitor can use
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
                <dd>{plural(stats.marketplaces, "marketplace", "marketplaces")} indexed</dd>
              </div>
              <div>
                <dt>{stats.agents.toLocaleString()}</dt>
                <dd>
                  {plural(stats.agents, "agent", "agents")} &amp;{" "}
                  {plural(stats.agents, "AI app", "AI apps")}
                </dd>
              </div>
              <div>
                <dt>{stats.publishers.toLocaleString()}</dt>
                <dd>{plural(stats.publishers, "publisher", "publishers")}</dd>
              </div>
              <div>
                <dt>{stats.changes.toLocaleString()}</dt>
                <dd>{plural(stats.changes, "change", "changes")} tracked</dd>
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
