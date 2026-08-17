"use client";

import Link from "next/link";
import AgentLogo from "@/components/AgentLogo";
import { MAX_COMPARE } from "@/lib/marketplace-query";
import { UNKNOWN, statusClass } from "@/lib/present";
import type { RegistryCard } from "@/lib/types";

export default function AgentCard({
  c,
  compact = false,
  onOpen,
  from,
  back,
  selected,
  onSelect,
  atCap,
}: {
  c: RegistryCard;
  compact?: boolean;
  /** Absent on surfaces with no passport modal — the button is then omitted. */
  onOpen?: (m: { kind: "agent"; id: string }) => void;
  /** Origin surface, threaded onto the passport link so its back button can return here. */
  from?: string;
  /**
   * The origin surface's own serialized query string (e.g. "risk=Low&q=agent"),
   * nested as a single value inside the passport URL's `back` param so the
   * back link can restore the exact search rather than landing unfiltered.
   * Encoded here because it is a query string being embedded inside another
   * query param — its own `&`/`=` characters must not be read as belonging
   * to the outer URL.
   */
  back?: string;
  /** Compare-selection state. Absent on surfaces with no compare tray (e.g. `/`). */
  selected?: boolean;
  /** Absent on surfaces with no compare tray — the checkbox is then omitted. */
  onSelect?: (assetId: string) => void;
  /**
   * True once MAX_COMPARE is reached. An unselected checkbox must disable
   * rather than silently refuse the click — mirrors FacetRail's zero-count
   * treatment. An already-selected checkbox ignores this so it can still be
   * un-ticked to free a slot.
   */
  atCap?: boolean;
}) {
  return (
    <article className={compact ? "top-agent-card" : "registry-card"}>
      <div className="agent-card-head">
        <AgentLogo name={c.name} id={c.source_product_id} logo={c.logo} />
        <div className="agent-title">
          <h3>{c.name}</h3>
          <span>{c.publisher ?? UNKNOWN}</span>
        </div>
        {onSelect ? (
          <label
            title={
              atCap && !selected
                ? `Comparison is capped at ${MAX_COMPARE} agents`
                : "Select to compare"
            }
            aria-disabled={(atCap && !selected) || undefined}
          >
            <span className="mkt-sr">Select {c.name} to compare</span>
            <input
              type="checkbox"
              checked={!!selected}
              disabled={atCap && !selected}
              onChange={() => onSelect(c.asset_id)}
            />
          </label>
        ) : (
          <button className="bookmark" title="Save agent">
            ☆
          </button>
        )}
      </div>
      <p className="agent-description">{c.tagline ?? "Not stated"}</p>
      <div className="agent-tags">
        <span>{c.function_category}</span>
        <span>{c.delivery}</span>
        <span>{c.cert_label}</span>
      </div>
      <div className="agent-meta-row">
        <span>
          {c.rating ? (
            <>
              <b>{c.rating}</b> ★ <small>({c.rating_count})</small>
            </>
          ) : (
            <>
              <b>Not rated</b> <small>(0 reviews)</small>
            </>
          )}
        </span>
        <span className={`prov-pill ${statusClass(c.provenance)}`}>{c.provenance}</span>
      </div>
      <div className="availability-row">
        <span className="availability-pill available">Available</span>
        <span>{c.marketplace_name}</span>
      </div>
      <div className="evidence-tier-row">
        <span>{c.evidence_tier}</span>
        <small>Marketplace listing</small>
      </div>
      <div className="reach-mini">
        <div>
          <span>Provenance reach</span>
          <b>{c.reach}%</b>
        </div>
        <div className="reach-track">
          <i style={{ width: `${c.reach}%` }} />
        </div>
      </div>
      <div className="agent-bottom">
        <div>
          <b>{c.price_band}</b>
          <small>{c.price_note}</small>
        </div>
        <div className="risk-label">
          <span>Evidence risk</span>
          <b className={`risk-${c.risk.toLowerCase()}`}>{c.risk}</b>
          {c.risk_basis && <small>{c.risk_basis}</small>}
        </div>
      </div>
      <div className="card-buttons">
        {onOpen && (
          <button onClick={() => onOpen({ kind: "agent", id: c.source_product_id })}>
            View details
          </button>
        )}
        <Link
          className="get-btn"
          href={`/agent/${encodeURIComponent(c.source_product_id)}${
            from ? `?from=${from}${back ? `&back=${encodeURIComponent(back)}` : ""}` : ""
          }`}
          style={{ display: "grid", placeItems: "center" }}
        >
          Open passport
        </Link>
      </div>
    </article>
  );
}
