"use client";

import Link from "next/link";
import AgentLogo from "@/components/AgentLogo";
import { MAX_COMPARE } from "@/lib/marketplace-query";
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
    <div className={onSelect ? "mkt-list mkt-list-select" : "mkt-list"}>
      {rows.map((c) => {
        const isSelected = !!selectedIds?.includes(c.asset_id);
        const disabled = !!atCap && !isSelected;
        return (
          <article className="mkt-row" key={c.asset_id}>
            {onSelect && (
              <label
                className="mkt-row-select"
                title={
                  disabled ? `Comparison is capped at ${MAX_COMPARE} agents` : "Select to compare"
                }
                aria-disabled={disabled || undefined}
              >
                <span className="mkt-sr">Select {c.name} to compare</span>
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
              <h3 className="mkt-row-name">
                <Link
                  href={`/agent/${encodeURIComponent(c.source_product_id)}${
                    from ? `?from=${from}${back ? `&back=${encodeURIComponent(back)}` : ""}` : ""
                  }`}
                >
                  {c.name}
                </Link>
              </h3>
              <div className="mkt-row-sub">{c.publisher ?? UNKNOWN}</div>
            </div>
            <div className="mkt-row-sub mkt-hide-sm">{c.function_category ?? UNKNOWN}</div>
            <span className={`prov-pill ${statusClass(c.provenance)}`}>{c.provenance}</span>
            <div className="mkt-row-reach">
              <div className="reach-track">
                <i style={{ width: `${c.reach}%` }} />
              </div>
              <b>{c.reach}%</b>
            </div>
            <div className="risk-label">
              <b className={`risk-${c.risk.toLowerCase()}`}>{c.risk}</b>
              {c.risk_basis && <small className="mkt-risk-basis">{c.risk_basis}</small>}
            </div>
          </article>
        );
      })}
    </div>
  );
}
