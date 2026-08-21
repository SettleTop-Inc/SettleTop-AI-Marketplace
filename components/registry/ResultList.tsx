"use client";

import Link from "next/link";
import AgentLogo from "@/components/AgentLogo";
import { MAX_COMPARE } from "@/lib/registry-query";
import { UNKNOWN, statusClass } from "@/lib/present";
import type { RegistryCard } from "@/lib/types";

export default function ResultList({
  rows,
  from,
  back,
  selectedIds,
  onSelect,
  atCap,
}: {
  rows: RegistryCard[];
  /** Origin surface, threaded onto the passport link so its back button can return here. */
  from?: string;
  /**
   * The origin surface's own serialized query string, nested as a single value
   * inside the passport URL's `back` param — encoded here for the same reason
   * AgentCard encodes it: it is a query string embedded inside another query
   * param, so its own `&`/`=` characters must not be read as the outer URL's.
   */
  back?: string;
  /** Compare-selection state, mirroring AgentCard's `selected`/`onSelect`. */
  selectedIds?: string[];
  /** Absent on surfaces with no compare tray — the checkbox column is then omitted. */
  onSelect?: (assetId: string) => void;
  /** True once MAX_COMPARE is reached — mirrors AgentCard's `atCap`. */
  atCap?: boolean;
}) {
  return (
    <div className={onSelect ? "reg-list reg-list-select" : "reg-list"}>
      {rows.map((c) => {
        const isSelected = !!selectedIds?.includes(c.asset_id);
        const disabled = !!atCap && !isSelected;
        // Link by the asset's canonical slug, not its primary listing's product
        // id, for the reason spelled out in AgentCard. Falls back to
        // source_product_id for a pre-phase-2 row, where they are equal.
        const slug = c.canonical_slug ?? c.source_product_id;
        return (
          <article className="reg-row" key={c.asset_id}>
            {onSelect && (
              <label
                className="reg-row-select"
                title={
                  disabled ? `Comparison is capped at ${MAX_COMPARE} agents` : "Select to compare"
                }
                aria-disabled={disabled || undefined}
              >
                <span className="reg-sr">Select {c.name} to compare</span>
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => onSelect(c.asset_id)}
                />
              </label>
            )}
            <AgentLogo name={c.name} id={c.source_product_id} logo={c.logo} />
            <div>
              <h3 className="reg-row-name">
                <Link
                  href={`/agent/${encodeURIComponent(slug)}${
                    from ? `?from=${from}${back ? `&back=${encodeURIComponent(back)}` : ""}` : ""
                  }`}
                >
                  {c.name}
                </Link>
              </h3>
              <div className="reg-row-sub">{c.publisher ?? UNKNOWN}</div>
            </div>
            <div className="reg-row-sub reg-hide-sm">{c.function_category ?? UNKNOWN}</div>
            <span className={`st-stamp st-stamp--${statusClass(c.provenance)}`}>
              {c.provenance}
            </span>
            <div className="reg-row-reach">
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
              <b className="st-ledger__count">
                {c.layers_known}/{c.layers_tracked}
              </b>
            </div>
            <div className="reg-row-risk">
              <b className={`st-field__value--${c.risk.toLowerCase()}`}>{c.risk}</b>
              {c.risk_basis && <small className="reg-risk-basis">{c.risk_basis}</small>}
            </div>
          </article>
        );
      })}
    </div>
  );
}
