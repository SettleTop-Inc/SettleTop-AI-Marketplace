"use client";

import Link from "next/link";
import AgentLogo from "@/components/AgentLogo";
import { MAX_COMPARE } from "@/lib/registry-query";
import { UNKNOWN, statusClass } from "@/lib/present";
import type { RegistryCard } from "@/lib/types";

/**
 * One agent, as a card. Shared by the landing page and the registry.
 *
 * Laid out in four zones — identity, what it does, what is proven, what it
 * costs — so the eye can skip to the one it wants. The previous version
 * stacked eight undifferentiated rows of 9–11px text carrying six competing
 * colours, which is what made the grid read as noise.
 *
 * The evidence zone is the point of the product, so it gets the tinted well
 * and the ledger; everything else stays quiet around it.
 */
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
  /** Landing "top agents" strip. Currently identical treatment; kept so the
      two call sites stay distinguishable if they diverge again. */
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
  const href = `/agent/${encodeURIComponent(c.source_product_id)}${
    from ? `?from=${from}${back ? `&back=${encodeURIComponent(back)}` : ""}` : ""
  }`;

  return (
    <article className={`st-card${compact ? " st-card--compact" : ""}`}>
      <div className="st-card__head">
        <AgentLogo name={c.name} id={c.source_product_id} logo={c.logo} />
        <div className="st-card__id">
          <h3 className="st-card__name">{c.name}</h3>
          <p className="st-card__pub">{c.publisher ?? UNKNOWN}</p>
        </div>
        {onSelect ? (
          <label
            className="st-card__select"
            title={
              atCap && !selected
                ? `Comparison is capped at ${MAX_COMPARE} agents`
                : "Select to compare"
            }
            aria-disabled={(atCap && !selected) || undefined}
          >
            <span className="st-sr">Select {c.name} to compare</span>
            <input
              type="checkbox"
              checked={!!selected}
              disabled={atCap && !selected}
              onChange={() => onSelect(c.asset_id)}
            />
          </label>
        ) : (
          <button className="st-card__save" title="Save agent" aria-label="Save agent">
            ☆
          </button>
        )}
      </div>

      <p className="st-card__meta">
        {c.rating ? `${c.rating} ★ · ${c.rating_count} reviews` : "Not rated"}
        {" · "}
        {c.marketplace_name}
      </p>

      <p className="st-card__tagline">{c.tagline ?? "Not stated"}</p>

      <div className="st-card__tags">
        {c.function_category && <span className="st-tag">{c.function_category}</span>}
        {c.delivery && <span className="st-tag">{c.delivery}</span>}
      </div>

      <div className="st-card__evidence">
        <div className="st-ledger">
          <div className="st-ledger__head">
            <span className="st-ledger__label">Provenance reach</span>
            <span className="st-ledger__count">
              {c.layers_known} of {c.layers_tracked}
            </span>
          </div>
          <div
            className="st-ledger__cells"
            role="img"
            aria-label={`${c.layers_known} of ${c.layers_tracked} build layers traced`}
          >
            {Array.from({ length: c.layers_tracked }, (_, i) => (
              <span
                key={i}
                className={`st-ledger__cell${
                  i < c.layers_known ? " st-ledger__cell--on" : ""
                }`}
              />
            ))}
          </div>
        </div>
        <div className="st-card__stamps">
          <span className={`st-stamp st-stamp--${statusClass(c.provenance)}`}>
            {c.provenance}
          </span>
          <span className="st-card__tier">{c.evidence_tier ?? UNKNOWN}</span>
        </div>
      </div>

      <div className="st-card__foot">
        <div className="st-card__cell">
          <span className="st-field__label">Pricing</span>
          <span className="st-card__figure">{c.price_band ?? UNKNOWN}</span>
          {/* Many listings set price_note to the same word as price_band
              ("Free" / "Free"); printing it twice reads as a rendering bug. */}
          {c.price_note && c.price_note !== c.price_band && (
            <span className="st-field__note">{c.price_note}</span>
          )}
        </div>
        {/* risk_basis is deliberately not repeated here: on a card it reads
            "Microsoft 365 Certified · 12 of 12 disclosable layers stated",
            which is the evidence tier and the ledger count already shown
            directly above. It stays on the passport, where it has room. */}
        <div className="st-card__cell st-card__cell--end">
          <span className="st-field__label">Evidence risk</span>
          <span
            className={`st-card__figure st-field__value--${c.risk.toLowerCase()}`}
          >
            {c.risk}
          </span>
        </div>
      </div>

      <div className="st-card__actions">
        {onOpen && (
          <button
            className="st-btn st-btn--secondary"
            onClick={() => onOpen({ kind: "agent", id: c.source_product_id })}
          >
            Quick look
          </button>
        )}
        {/* Secondary, not primary. Solid gold is the page's single loudest
            action; a grid of 189 cards each carrying one turns the accent
            into wallpaper and buries the evidence the card exists to show. */}
        <Link className="st-btn st-btn--secondary" href={href}>
          Open passport
        </Link>
      </div>
    </article>
  );
}
