"use client";

import Link from "next/link";
import { MAX_COMPARE } from "@/lib/registry-query";
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
  const href = `/registry/compare?ids=${selected.map((s) => s.asset_id).join(",")}`;

  return (
    <div className="reg-tray st-invert" role="region" aria-label="Compare selection">
      <div className="container reg-tray-inner">
        <span>{selected.length} selected</span>
        {selected.length >= MAX_COMPARE && (
          <span style={{ opacity: 0.7, fontWeight: 400 }}>
            Capped at {MAX_COMPARE}. Remove one to swap
          </span>
        )}
        <div className="reg-tray-list">
          {selected.map((s) => (
            <button className="reg-chip" key={s.asset_id} onClick={() => onRemove(s.asset_id)}>
              {s.name} ×
            </button>
          ))}
        </div>
        <div className="reg-spacer" />
        {selected.length >= 2 ? (
          <Link className="reg-control" href={href}>
            Compare provenance
          </Link>
        ) : (
          <span style={{ opacity: 0.7, fontWeight: 400 }}>Select one more to compare</span>
        )}
        <button className="reg-chip" onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}
