"use client";

import type { SortDir, SortKey } from "@/lib/marketplace-query";

const OPTIONS: Array<{ key: SortKey; dir: SortDir; label: string }> = [
  { key: "reach", dir: "desc", label: "Provenance reach" },
  { key: "rating", dir: "desc", label: "Rating" },
  { key: "captured", dir: "desc", label: "Recently captured" },
  { key: "name", dir: "asc", label: "Name (A–Z)" },
];

export default function ResultToolbar({
  total,
  sort,
  onSort,
}: {
  total: number;
  sort: SortKey;
  onSort: (key: SortKey, dir: SortDir) => void;
}) {
  return (
    <div className="mkt-toolbar">
      <div className="mkt-total" aria-live="polite">
        <b>{total.toLocaleString()}</b>
        <span>{total === 1 ? "agent" : "agents"}</span>
      </div>
      <div className="mkt-spacer" />
      <label className="mkt-sr" htmlFor="mkt-sort">
        Sort results by
      </label>
      <select
        id="mkt-sort"
        className="mkt-control"
        value={sort}
        onChange={(e) => {
          const picked = OPTIONS.find((o) => o.key === e.target.value)!;
          onSort(picked.key, picked.dir);
        }}
      >
        {OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
