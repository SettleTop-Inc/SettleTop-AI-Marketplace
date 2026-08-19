"use client";

import { PAGE_SIZES } from "@/lib/registry-query";
import type { SortDir, SortKey, ViewMode } from "@/lib/registry-query";

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
  view,
  onView,
  perPage,
  onPerPage,
}: {
  total: number;
  sort: SortKey;
  onSort: (key: SortKey, dir: SortDir) => void;
  view: ViewMode;
  onView: (v: ViewMode) => void;
  perPage: number;
  onPerPage: (n: number) => void;
}) {
  return (
    <div className="reg-toolbar">
      <div className="reg-total" aria-live="polite">
        <b>{total.toLocaleString()}</b>
        <span>{total === 1 ? "agent" : "agents"}</span>
      </div>
      <div className="reg-spacer" />
      <label className="reg-sr" htmlFor="reg-sort">
        Sort results by
      </label>
      <select
        id="reg-sort"
        className="reg-control"
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
      <label className="reg-sr" htmlFor="reg-per">
        Results per page
      </label>
      <select
        id="reg-per"
        className="reg-control"
        value={perPage}
        onChange={(e) => onPerPage(Number(e.target.value))}
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n} per page
          </option>
        ))}
      </select>
      <div className="reg-toggle" role="group" aria-label="Result layout">
        <button aria-pressed={view === "grid"} onClick={() => onView("grid")}>
          ▦ Grid
        </button>
        <button aria-pressed={view === "list"} onClick={() => onView("list")}>
          ▤ List
        </button>
      </div>
    </div>
  );
}
