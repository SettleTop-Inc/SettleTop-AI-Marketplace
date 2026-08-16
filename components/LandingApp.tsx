"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { USE_CASES } from "@/lib/usecases";
import PassportView from "@/components/PassportView";
import AgentLogo from "@/components/AgentLogo";
import AgentCard from "@/components/AgentCard";
import type {
  AssetPassport,
  RegistryCard,
  RegistryStats,
} from "@/lib/types";
import {
  UNKNOWN,
  evidence,
  initials,
  isKnown,
  listed,
  permissionValue,
} from "@/lib/present";
import { defaultCriteria, searchBlob, serializeCriteria } from "@/lib/marketplace-query";

/**
 * The registry site.
 *
 * Card data arrives from the server already fetched, and filtering runs in the
 * browser so the design keeps its instant response. Passport detail is fetched
 * on demand when a modal opens — the card list deliberately does not carry
 * overview text, which would multiply its size several times over.
 */
export default function LandingApp({
  cards,
  stats,
  featured,
}: {
  cards: RegistryCard[];
  stats: RegistryStats | null;
  featured: AssetPassport | null;
}) {
  const [q, setQ] = useState("");
  const [heroQ, setHeroQ] = useState("");
  const [fn, setFn] = useState("");
  const [mp, setMp] = useState("");
  const [dep, setDep] = useState("");
  const [tier, setTier] = useState("");
  const [prov, setProv] = useState("");
  const [price, setPrice] = useState("");
  const [risk, setRisk] = useState("");
  const [topFilter, setTopFilter] = useState<"All" | "Verified" | "Free">("All");
  const [modal, setModal] = useState<null | { kind: "vendor" } | { kind: "agent"; id: string }>(null);
  const [passport, setPassport] = useState<AssetPassport | null>(null);
  const [loadingPassport, setLoadingPassport] = useState(false);

  const router = useRouter();

  /** Carry whatever the visitor has already narrowed to into the tool. */
  const marketplaceHref = () => {
    const c = defaultCriteria();
    if (q.trim()) c.q = q;
    if (fn) c.facets.function = [fn];
    if (mp) c.facets.source = [mp];
    if (dep) c.facets.delivery = [dep];
    if (tier) c.facets.tier = [tier];
    if (prov) c.facets.provenance = [prov];
    if (price) c.facets.price = [price];
    if (risk) c.facets.risk = [risk];
    const qs = serializeCriteria(c);
    return qs ? `/marketplace?${qs}` : "/marketplace";
  };

  const distinct = (pick: (c: RegistryCard) => string | null | undefined) =>
    Array.from(new Set(cards.map(pick).filter(Boolean) as string[])).sort();

  const functions = useMemo(() => distinct((c) => c.function_category), [cards]);
  const markets = useMemo(() => distinct((c) => c.marketplace_name), [cards]);
  const deployments = useMemo(
    () => distinct((c) => (c.delivery === UNKNOWN ? null : c.delivery)),
    [cards]
  );
  const tiers = useMemo(() => distinct((c) => c.evidence_tier), [cards]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of cards) {
      const k = c.function_category ?? "Unclassified";
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  }, [cards]);

  const popular = useMemo(
    () =>
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4),
    [counts]
  );

  const blobs = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cards) m.set(c.asset_id, searchBlob(c));
    return m;
  }, [cards]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cards.filter(
      (c) =>
        (!needle || (blobs.get(c.asset_id) ?? "").includes(needle)) &&
        (!fn || c.function_category === fn) &&
        (!mp || c.marketplace_name === mp) &&
        (!dep || c.delivery === dep) &&
        (!tier || c.evidence_tier === tier) &&
        (!prov || c.provenance === prov) &&
        (!price || c.price_band === price) &&
        (!risk || c.risk === risk)
    );
  }, [cards, blobs, q, fn, mp, dep, tier, prov, price, risk]);

  const top = useMemo(() => {
    let list = [...cards];
    if (topFilter === "Verified") list = list.filter((c) => c.provenance === "Verified");
    if (topFilter === "Free")
      list = list.filter((c) => c.price_band === "Free" || c.price_band === "Freemium");
    return list
      .sort(
        (a, b) =>
          (b.rating ?? 0) - (a.rating ?? 0) ||
          b.rating_count - a.rating_count ||
          b.reach - a.reach
      )
      .slice(0, 6);
  }, [cards, topFilter]);

  useEffect(() => {
    if (!modal || modal.kind !== "agent") {
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

  const clearFilters = () => {
    setQ("");
    setFn("");
    setMp("");
    setDep("");
    setTier("");
    setProv("");
    setPrice("");
    setRisk("");
  };

  const pickUseCase = (name: string) => {
    const c = defaultCriteria();
    c.facets.function = [name];
    router.push(`/marketplace?${serializeCriteria(c)}`);
  };

  const runHeroSearch = () => {
    const c = defaultCriteria();
    if (heroQ.trim()) c.q = heroQ;
    const qs = serializeCriteria(c);
    router.push(qs ? `/marketplace?${qs}` : "/marketplace");
  };

  return (
    <>
      <header className="site-header">
        <div className="container nav">
          <a className="brand" href="#top" aria-label="SettleTop Agent Registry home">
            <span className="settletop-wordmark">SETTLETOP</span>
            <span className="brand-divider" aria-hidden="true" />
            <span className="registry-wordmark">AGENT REGISTRY</span>
          </a>
          <nav className="nav-links" aria-label="Primary">
            <a href="#use-cases">Use cases</a>
            <a href="#top-agents">Top agents</a>
            <a href="#provenance">Provenance</a>
            <a href="#registry">Registry</a>
          </nav>
          <div className="nav-actions">
            <button className="text-btn" onClick={() => setModal({ kind: "vendor" })}>
              For vendors
            </button>
            <button className="primary-btn compact" onClick={() => router.push("/marketplace")}>
              Browse agents
            </button>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="container">
            <div className="hero-inner">
              <div className="hero-copy">
                <div className="kicker">
                  <span className="pulse-dot" /> The intelligence layer for AI agents
                </div>
                <h1>
                  Find the right AI agent.
                  <br />
                  <span>Know what’s behind it.</span>
                </h1>
                <p>
                  Discover agents by business or mission use case, compare vendors and
                  user feedback, then inspect the provenance of the build before you
                  adopt.
                </p>
                <div className="hero-search">
                  <span className="search-icon">⌕</span>
                  <input
                    type="search"
                    placeholder="What do you want an agent to do?"
                    aria-label="Search AI agents"
                    value={heroQ}
                    onChange={(e) => setHeroQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") runHeroSearch();
                    }}
                  />
                  <button onClick={runHeroSearch}>Search registry</button>
                </div>
                <div className="popular">
                  <b>Popular:</b>
                  {popular.map(([name, n]) => (
                    <button key={name} onClick={() => pickUseCase(name)}>
                      {name} ({n})
                    </button>
                  ))}
                </div>
              </div>

              <div className="hero-proof" aria-label="Registry highlights">
                <div className="proof-card main-proof">
                  <div className="proof-label">Agent trust snapshot</div>
                  {featured && (
                    <>
                      <div className="proof-agent">
                        <AgentLogo name={featured.name} id={featured.source_product_id} logo={featured.logo} />
                        <div>
                          <b>{featured.name}</b>
                          <small>{featured.publisher}</small>
                        </div>
                        <span className="rating">
                          {featured.rating ? `${featured.rating} ★` : "Not rated"}
                        </span>
                      </div>
                      <div className="proof-row">
                        <span>Evidence tier</span>
                        <b
                          className={`status ${
                            featured.provenance === "Verified" ? "verified" : "success"
                          }`}
                        >
                          {featured.evidence_tier}
                        </b>
                      </div>
                      <div className="proof-row">
                        <span>Provenance</span>
                        <b
                          className={`status ${
                            featured.provenance === "Verified" ? "verified" : "caution"
                          }`}
                        >
                          {featured.provenance}
                        </b>
                      </div>
                      <div className="proof-row">
                        <span>Provenance reach</span>
                        <b>{featured.reach}%</b>
                      </div>
                      <div className="reach-bar">
                        <i style={{ width: `${featured.reach}%` }} />
                      </div>
                      <div className="proof-row">
                        <span>Evidence risk</span>
                        <b className="status caution">{featured.risk}</b>
                      </div>
                      <div className="proof-foot">
                        <span>
                          {featured.price_band} · {featured.price_note}
                        </span>
                        <span>{featured.delivery}</span>
                      </div>
                    </>
                  )}
                </div>
                <div className="floating-proof fp-one">
                  {featured?.provenance === "Verified"
                    ? "✓ Microsoft 365 Certified"
                    : "✓ Publisher attested"}
                </div>
                <div className="floating-proof fp-two">
                  {featured
                    ? `${featured.layers_known} of ${featured.layers_tracked} build layers traced`
                    : ""}
                </div>
              </div>
            </div>

            <div className="registry-metrics" aria-label="Registry scale">
              <div className="registry-metric">
                <b>{stats?.marketplaces ?? 0}</b>
                <span>Marketplaces accessed</span>
                <small>Live capture sources</small>
              </div>
              <div className="registry-metric">
                <b>{(stats?.agents ?? cards.length).toLocaleString()}</b>
                <span>AI agents indexed</span>
                <small>Captured from marketplace listings</small>
              </div>
              <div className="registry-metric">
                <b>{stats?.certified ?? 0}</b>
                <span>Independently certified</span>
                <small>Microsoft 365 Certified attestation</small>
              </div>
            </div>
          </div>
        </section>

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
              <button className="link-btn" onClick={() => router.push("/marketplace")}>
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
                    <small>{counts[u.name] ?? 0} agents</small>
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
              <button className="secondary-btn" onClick={() => router.push("/marketplace")}>
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

        <section className="section registry-section" id="registry">
          <div className="container">
            <div className="section-heading registry-title">
              <div>
                <span className="overline">FULL REGISTRY</span>
                <h2>Browse and compare AI agents</h2>
                <p>
                  Filter by function, marketplace/source, deployment, evidence tier,
                  provenance status, pricing and evidence risk.
                </p>
              </div>
              <div className="result-total">
                <b>{filtered.length}</b>
                <span>matching agents</span>
              </div>
              <Link className="link-btn" href={marketplaceHref()}>
                Open these results in the marketplace →
              </Link>
            </div>

            <div className="registry-disclosure">
              <b>Evidence-first registry:</b> a listing proves a public source exists; it
              does not imply SettleTop has verified the agent&apos;s build. Undisclosed
              LLMs, frameworks, MCP servers, data sources, pricing and risk remain{" "}
              <b>Unknown</b>.
            </div>

            <div className="registry-layout">
              <aside className="filters">
                <div className="filter-title">
                  <b>Filters</b>
                  <button onClick={clearFilters}>Clear</button>
                </div>
                <label>
                  Function
                  <select value={fn} onChange={(e) => setFn(e.target.value)}>
                    <option value="">All functions</option>
                    {functions.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Marketplace / source
                  <select value={mp} onChange={(e) => setMp(e.target.value)}>
                    <option value="">All sources</option>
                    {markets.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Deployment
                  <select value={dep} onChange={(e) => setDep(e.target.value)}>
                    <option value="">All deployment types</option>
                    {deployments.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Evidence tier
                  <select value={tier} onChange={(e) => setTier(e.target.value)}>
                    <option value="">All evidence tiers</option>
                    {tiers.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Provenance
                  <select value={prov} onChange={(e) => setProv(e.target.value)}>
                    <option value="">All statuses</option>
                    <option>Verified</option>
                    <option>Disclosed</option>
                    <option>Unknown</option>
                  </select>
                </label>
                <label>
                  Pricing
                  <select value={price} onChange={(e) => setPrice(e.target.value)}>
                    <option value="">All pricing</option>
                    <option>Free</option>
                    <option>Freemium</option>
                    <option>Paid</option>
                    <option>Unknown</option>
                  </select>
                </label>
                <label>
                  Evidence risk
                  <select value={risk} onChange={(e) => setRisk(e.target.value)}>
                    <option value="">All evidence risk levels</option>
                    <option>Low</option>
                    <option>Medium</option>
                    <option>High</option>
                  </select>
                </label>
              </aside>

              <div className="registry-results">
                <div className="registry-search">
                  <span>⌕</span>
                  <input
                    type="search"
                    placeholder="Search agents, vendors, marketplaces or use cases"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
                <div className="registry-grid">
                  {filtered.length > 0 ? (
                    filtered.map((c) => (
                      <AgentCard key={c.asset_id} c={c} onOpen={setModal} />
                    ))
                  ) : (
                    <div className="empty-state">
                      <b>No matching agents</b>
                      <p>Try clearing one or more filters.</p>
                      <button className="secondary-btn" onClick={clearFilters}>
                        Clear filters
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="vendor-cta">
          <div className="container vendor-cta-inner">
            <div>
              <span className="overline light-overline">
                FOR AGENT BUILDERS &amp; VENDORS
              </span>
              <h2>Move from Unknown to Verified.</h2>
              <p>
                Claim your listing, disclose the agent stack and provide provenance
                evidence so buyers can understand what they’re adopting.
              </p>
            </div>
            <button className="light-btn" onClick={() => setModal({ kind: "vendor" })}>
              Claim an agent
            </button>
          </div>
        </section>
      </main>

      <footer>
        <div className="container footer-grid">
          <div className="brand footer-brand">
            <span className="brand-divider" aria-hidden="true" />
            <span className="brand-registry">Agent Registry</span>
          </div>
          <p>Discover. Compare. Trace. Trust.</p>
          <p className="copyright">
            {stats?.captures ?? 0} captures · {stats?.changes ?? 0} recorded changes
            {stats?.last_captured_at
              ? ` · last capture ${stats.last_captured_at.slice(0, 10)}`
              : ""}
          </p>
        </div>
      </footer>

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
            {modal.kind === "vendor" ? (
              <VendorModal />
            ) : loadingPassport ? (
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

function VendorModal() {
  return (
    <>
      <span className="overline">VENDOR VERIFICATION</span>
      <h2>Claim and verify an agent</h2>
      <p className="passport-description">
        Vendors can claim a registry listing, disclose the agent stack and submit
        provenance evidence. SettleTop can then distinguish vendor-disclosed
        information from independently verified evidence.
      </p>
      <div className="verify-flow">
        <div>
          <b>1</b>
          <span>
            <strong>Claim</strong>
            <small>Confirm vendor and agent identity</small>
          </span>
        </div>
        <div>
          <b>2</b>
          <span>
            <strong>Disclose</strong>
            <small>Models, frameworks, tools, data and dependencies</small>
          </span>
        </div>
        <div>
          <b>3</b>
          <span>
            <strong>Verify</strong>
            <small>Attach evidence and attestations</small>
          </span>
        </div>
        <div>
          <b>4</b>
          <span>
            <strong>Maintain</strong>
            <small>Track version and stack changes over time</small>
          </span>
        </div>
      </div>
    </>
  );
}
