"use client";

import Link from "next/link";
import type { RegistryCard } from "@/lib/types";

export default function CompareTray({
  selected,
  onRemove,
  onClear,
}: {
  selected: RegistryCard[];
  onRemove: (assetId: string) => void;
  onClear: () => void;
}) {
  if (selected.length === 0) return null;
  const href = `/marketplace/compare?ids=${selected.map((s) => s.asset_id).join(",")}`;

  return (
    <div className="mkt-tray" role="region" aria-label="Compare selection">
      <div className="container mkt-tray-inner">
        <span>{selected.length} selected</span>
        <div className="mkt-tray-list">
          {selected.map((s) => (
            <button className="mkt-chip" key={s.asset_id} onClick={() => onRemove(s.asset_id)}>
              {s.name} ×
            </button>
          ))}
        </div>
        <div className="mkt-spacer" />
        {selected.length >= 2 ? (
          <Link className="mkt-control" href={href}>
            Compare provenance
          </Link>
        ) : (
          <span style={{ opacity: 0.7, fontWeight: 400 }}>Select one more to compare</span>
        )}
        <button className="mkt-chip" onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}
