"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { USE_CASES } from "@/lib/usecases";
import PassportView from "@/components/PassportView";
import AgentLogo from "@/components/AgentLogo";
import AgentCard from "@/components/AgentCard";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import HomeHero from "@/components/home/HomeHero";
import ProductGrid from "@/components/home/ProductGrid";
import ServicesGrid from "@/components/home/ServicesGrid";
import type {
  AssetPassport,
  RegistryCard,
  RegistryStats,
} from "@/lib/types";
import type { TopFilter } from "@/lib/registry";
import {
  UNKNOWN,
  evidence,
  initials,
  isKnown,
  listed,
  permissionValue,
} from "@/lib/present";
import { defaultCriteria, serializeCriteria } from "@/lib/marketplace-query";

/**
 * The registry site's front page.
 *
 * It carries no card corpus. Browsing lives on /marketplace, which queries
 * Postgres; this page receives only the eight use-case counts and the short
 * ranked lists it actually renders. Passport detail is still fetched on demand
 * when a modal opens — the card shape deliberately does not carry overview
 * text, which would multiply its size several times over.
 */
export default function LandingApp({
  useCaseCounts,
  topAgents,
  stats,
  featured,
}: {
  useCaseCounts: Record<string, number>;
  topAgents: Record<TopFilter, RegistryCard[]>;
  stats: RegistryStats | null;
  featured: AssetPassport | null;
}) {
  const [topFilter, setTopFilter] = useState<TopFilter>("All");
  const [modal, setModal] = useState<null | { kind: "agent"; id: string }>(null);
  const [passport, setPassport] = useState<AssetPassport | null>(null);
  const [loadingPassport, setLoadingPassport] = useState(false);

  const router = useRouter();

  const top = topAgents[topFilter];

  useEffect(() => {
    if (!modal) {
      setPassport(null);
      return;
    }
    let cancelled = false;
    setLoadingPassport(true);
    supabase
      .from("v_asset_passport")
      .select("*")
      .eq("source_product_id", modal.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error("passport", error.message);
        setPassport((data as AssetPassport) ?? null);
        setLoadingPassport(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modal]);

  const pickUseCase = (name: string) => {
    const c = defaultCriteria();
    c.facets.function = [name];
    router.push(`/registry?${serializeCriteria(c)}`);
  };

  return (
    <>
      <SiteHeader current="overview" wide />

      <main id="top">
        <HomeHero stats={stats} />

        <ProductGrid />

        <ServicesGrid />

        <section className="section use-cases" id="use-cases">
          <div className="container">
            <div className="section-heading marketplace-heading">
              <div>
                <span className="overline">EXPLORE BY USE CASE</span>
                <h2>What do you want an agent to do?</h2>
                <p>
                  Start with the outcome, not the vendor. Explore agents mapped to the
                  functions your organization actually performs.
                </p>
              </div>
              <button className="link-btn" onClick={() => router.push("/registry")}>
                View all use cases →
              </button>
            </div>
            <div className="usecase-grid">
              {USE_CASES.map((u) => (
                <button
                  key={u.name}
                  className="usecase-card"
                  onClick={() => pickUseCase(u.name)}
                >
                  <span className="usecase-icon">{u.icon}</span>
                  <div>
                    <b>{u.name}</b>
                    <p>{u.desc}</p>
                    <small>{useCaseCounts[u.name] ?? 0} agents</small>
                  </div>
                  <span className="arrow">→</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="section agents-section" id="top-agents">
          <div className="container">
            <div className="section-heading">
              <div>
                <span className="overline">TOP AI AGENTS</span>
                <h2>Popular agents across the registry</h2>
                <p>
                  Ranked using user feedback, provenance completeness and evidence risk
                  signals.
                </p>
              </div>
              <div className="segmented" role="group" aria-label="Agent view">
                {(["All", "Verified", "Free"] as const).map((f) => (
                  <button
                    key={f}
                    className={topFilter === f ? "active" : ""}
                    onClick={() => setTopFilter(f)}
                  >
                    {f === "Free" ? "Free & open" : f}
                  </button>
                ))}
              </div>
            </div>
            <div className="top-agent-grid">
              {top.map((c) => (
                <AgentCard key={c.asset_id} c={c} compact onOpen={setModal} />
              ))}
            </div>
            <div className="center-action">
              <button className="secondary-btn" onClick={() => router.push("/registry")}>
                Explore the full agent registry
              </button>
            </div>
          </div>
        </section>

        <section className="section provenance-section" id="provenance">
          <div className="container">
            <div className="provenance-intro">
              <span className="overline">PROVENANCE REACH</span>
              <h2>See how far the trust trail reaches.</h2>
              <p>
                SettleTop traces the components behind an agent—from who built it to the
                models, frameworks, tools, data, dependencies and deployment
                environment. If evidence is unavailable, the registry says{" "}
                <b>Unknown</b>.
              </p>
            </div>

            {featured && <Workbench a={featured} onOpen={setModal} />}

            <div className="provenance-value-grid">
              <div>
                <span className="value-icon">◎</span>
                <b>Origin</b>
                <p>
                  Who created the agent, who publishes it and whether vendor identity is
                  verified.
                </p>
              </div>
              <div>
                <span className="value-icon">⌘</span>
                <b>Build</b>
                <p>
                  Models, frameworks, skills, packages, tools, MCP servers and version
                  lineage.
                </p>
              </div>
              <div>
                <span className="value-icon">↔</span>
                <b>Connections</b>
                <p>
                  Data sources, APIs, permissions, external services and runtime
                  dependencies.
                </p>
              </div>
              <div>
                <span className="value-icon">◈</span>
                <b>Trust</b>
                <p>Evidence status, provenance gaps, risk indicators and change history.</p>
              </div>
            </div>
          </div>
        </section>

        {/* The full registry, its filter panel and all of its cards used to
            render here — roughly 26,000px of page. Browsing belongs on
            /registry, which is built for it; this is now a hand-off.
            "Top agents" above is the sample. */}
        <section className="section" id="registry">
          <div className="container">
            <div className="hm-handoff">
              <div>
                <span className="st-eyebrow">Every agent on record</span>
                <h2 className="st-display">
                  {stats
                    ? `${stats.agents.toLocaleString()} agents, one record each`
                    : "One record each"}
                </h2>
                <p className="st-lede">
                  Filter by function, source, deployment, evidence tier,
                  provenance, pricing and evidence risk. Compare them
                  side by side, and share a result set by link. Where a
                  source is silent, the value reads Unknown.
                </p>
              </div>
              <Link className="st-btn st-btn--primary" href="/registry">
                Open the registry →
              </Link>
            </div>
          </div>
        </section>

        {/* There is no claim flow, so this offers the one route that does
            exist: a way to report a record that is wrong. A call to action
            for a process we cannot honour costs more than it earns. */}
        <section className="hm-section" id="corrections">
          <div className="st-shell st-shell--wide">
            <header className="hm-section__head">
              <p className="st-eyebrow">Corrections and disclosures</p>
              <p className="st-lede">
                The registry records what a source states, and reads Unknown
                where it states nothing. If a record about your agent is wrong
                or incomplete, write to{" "}
                <a href="mailto:registry@settletop.com">registry@settletop.com</a>.
              </p>
            </header>
          </div>
        </section>
      </main>

      <SiteFooter
        wide
        meta={
          <>
            {stats
              ? `${stats.captures.toLocaleString()} captures · ${stats.changes.toLocaleString()} recorded changes`
              : "capture counts unavailable"}
            {stats?.last_captured_at
              ? ` · last capture ${stats.last_captured_at.slice(0, 10)}`
              : ""}
          </>
        }
      />

      {modal && (
        <div
          className="modal show"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <div className="modal-card">
            <button className="modal-close" onClick={() => setModal(null)} aria-label="Close">
              ×
            </button>
            {loadingPassport ? (
              <p className="passport-description">Loading the passport…</p>
            ) : passport ? (
              <PassportView a={passport} />
            ) : (
              <p className="passport-description">
                That passport could not be loaded. It may not have been captured yet.
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Workbench({
  a,
  onOpen,
}: {
  a: AssetPassport;
  onOpen: (m: { kind: "agent"; id: string }) => void;
}) {
  const ev = a.evidence ?? {};
  const mini = (v: string) =>
    !isKnown(v)
      ? "unknown-mini"
      : a.provenance === "Verified"
      ? "verified-mini"
      : "disclosed-mini";
  const label = (cls: string) =>
    cls === "verified-mini" ? "Verified" : cls === "disclosed-mini" ? "Disclosed" : UNKNOWN;

  const nodes: Array<[string, string, string]> = [
    ["n1", "Builder", a.publisher ?? UNKNOWN],
    ["n2", "Model", evidence(ev, "model")],
    ["n3", "Framework", evidence(ev, "framework")],
    ["n4", "Data sources", evidence(ev, "data_source")],
    ["r1", "Tools / MCP", evidence(ev, "tool_mcp")],
    ["r2", "Data residency", a.cert_data_location ?? UNKNOWN],
    ["r3", "Permission scope", permissionValue(a)],
    ["r4", "Compliance", a.compliance?.length ? listed(a.compliance, 2) : UNKNOWN],
  ];

  return (
    <div className="provenance-workbench">
      <div className="prov-sidebar">
        <div className="prov-agent-title">
          <AgentLogo name={a.name} id={a.source_product_id} logo={a.logo} />
          <div>
            <b>{a.name}</b>
            <small>
              {a.listing_version ? `v${a.listing_version} · ` : ""}
              {a.publisher}
            </small>
          </div>
        </div>
        <div className="reach-score">
          <div className="ring" style={{ ["--score" as string]: String(a.reach) }}>
            <span>
              <b>{a.reach}%</b>
              <small>known</small>
            </span>
          </div>
          <div>
            <b>Provenance reach</b>
            <p>
              {a.layers_known} of {a.layers_tracked} tracked build layers have evidence.
            </p>
          </div>
        </div>
        <div className="legend">
          <span>
            <i className="dot verified-dot" />
            Verified
          </span>
          <span>
            <i className="dot disclosed-dot" />
            Disclosed
          </span>
          <span>
            <i className="dot unknown-dot" />
            Unknown
          </span>
        </div>
        <div className="risk-summary">
          <span>Attestation</span>
          <b className={`status ${a.provenance === "Verified" ? "success" : "caution"}`}>
            {a.cert_label}
          </b>
        </div>
        <div className="risk-summary">
          <span>Evidence risk</span>
          <b className="status caution">{a.risk}</b>
        </div>
        <button
          className="secondary-btn full"
          onClick={() => onOpen({ kind: "agent", id: a.source_product_id })}
        >
          Open full Agent Passport
        </button>
      </div>

      <div className="prov-map" aria-label="Agent provenance graph">
        <div className="map-title">
          <b>Agent build graph</b>
          <span>
            {a.listing_updated
              ? `Listing updated ${a.listing_updated}`
              : "Captured from marketplace listing"}
          </span>
        </div>
        <div className="graph-shell">
          <svg
            className="connectors"
            viewBox="0 0 900 500"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d="M450 245 C330 245,310 84,180 84" />
            <path d="M450 245 C330 245,310 165,180 165" />
            <path d="M450 245 C330 245,310 245,180 245" />
            <path d="M450 245 C330 245,310 326,180 326" />
            <path d="M450 245 C570 245,590 84,720 84" />
            <path d="M450 245 C570 245,590 165,720 165" />
            <path d="M450 245 C570 245,590 245,720 245" />
            <path d="M450 245 C570 245,590 326,720 326" />
            <path d="M450 245 C450 360,450 405,450 450" />
          </svg>
          <button
            className="node center-node"
            onClick={() => onOpen({ kind: "agent", id: a.source_product_id })}
          >
            <span className="node-icon">{initials(a.name)}</span>
            <b>{a.name}</b>
            <small>Agent</small>
          </button>
          {nodes.map(([pos, lab, val]) => {
            const cls = mini(val);
            const side = pos.startsWith("n") ? "left" : "right";
            return (
              <button
                key={pos}
                className={`node ${side} ${pos} ${cls === "unknown-mini" ? "unknown-node" : ""}`}
              >
                <span>{lab}</span>
                <b>{val}</b>
                <small className={`mini-status ${cls}`}>{label(cls)}</small>
              </button>
            );
          })}
          <button
            className={`node bottom-node ${
              isKnown(a.delivery) ? "" : "unknown-node"
            }`}
          >
            <span>Deployment</span>
            <b>{a.delivery ?? UNKNOWN}</b>
            <small className={`mini-status ${mini(a.delivery ?? UNKNOWN)}`}>
              {label(mini(a.delivery ?? UNKNOWN))}
            </small>
          </button>
        </div>
      </div>
    </div>
  );
}
