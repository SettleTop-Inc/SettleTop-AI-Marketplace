"use client";

import type { FacetGroup, FacetKey } from "@/lib/marketplace-query";

/**
 * CLAUDE.md rule 5: evidence risk is not a safety score. The passport carries
 * that footnote, so this route must carry it too rather than showing a bare band.
 */
const RISK_NOTE =
  "How much of the build you cannot see before you deploy — not a security rating.";

export default function FacetRail({
  facets,
  onToggle,
  onClear,
  hasFilters,
}: {
  facets: FacetGroup[];
  onToggle: (key: FacetKey, value: string) => void;
  onClear: () => void;
  hasFilters: boolean;
}) {
  return (
    <aside className="mkt-rail" aria-label="Filters">
      <div className="mkt-rail-head">
        <b>Filters</b>
        {hasFilters && (
          <button className="mkt-clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      {facets.map((g) => (
        <fieldset className="mkt-group" key={g.key}>
          <legend>{g.label}</legend>
          {g.key === "risk" && <p className="mkt-note">{RISK_NOTE}</p>}
          {g.values.map((v) => {
            const disabled = v.count === 0 && !v.selected;
            return (
              <label
                className="mkt-facet"
                key={v.value}
                aria-disabled={disabled || undefined}
              >
                <input
                  type="checkbox"
                  checked={v.selected}
                  disabled={disabled}
                  onChange={() => onToggle(g.key, v.value)}
                />
                <span>{v.value}</span>
                <span className="mkt-count">{v.count}</span>
              </label>
            );
          })}
        </fieldset>
      ))}
    </aside>
  );
}
