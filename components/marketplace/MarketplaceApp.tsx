"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import AgentCard from "@/components/AgentCard";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import CompareTray from "@/components/marketplace/CompareTray";
import FacetRail from "@/components/marketplace/FacetRail";
import Pagination from "@/components/marketplace/Pagination";
import ResultList from "@/components/marketplace/ResultList";
import ResultToolbar from "@/components/marketplace/ResultToolbar";
import {
  type Criteria,
  type FacetKey,
  type SortDir,
  type SortKey,
  type ViewMode,
  MAX_COMPARE,
  defaultCriteria,
  parseCriteria,
  runQuery,
  serializeCriteria,
} from "@/lib/marketplace-query";
import type { RegistryCard } from "@/lib/types";

export default function MarketplaceApp({
  cards,
  loadFailed,
}: {
  cards: RegistryCard[];
  loadFailed?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const criteria = useMemo(
    () => parseCriteria(new URLSearchParams(searchParams.toString())),
    [searchParams]
  );

  const result = useMemo(() => runQuery(cards, criteria), [cards, criteria]);

  // The exact query string for the current view, threaded onto every passport
  // link below so "Back to the marketplace" restores the search that was
  // built rather than dropping the visitor on unfiltered page 1.
  const backQS = serializeCriteria(criteria);

  // The text box is local so typing stays instant; the URL catches up on a
  // debounce with `replace`, so a search does not leave 12 history entries.
  const [text, setText] = useState(criteria.q);
  useEffect(() => setText(criteria.q), [criteria.q]);

  const write = useCallback(
    (next: Criteria, mode: "push" | "replace") => {
      const qs = serializeCriteria(next);
      router[mode](qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router]
  );

  useEffect(() => {
    if (text === criteria.q) return;
    const t = setTimeout(() => write({ ...criteria, q: text, page: 1 }, "replace"), 300);
    return () => clearTimeout(t);
  }, [text, criteria, write]);

  // Any criteria change resets to page 1. Clamping is only for inbound URLs —
  // without this, changing a facet on page 4 strands the visitor mid-way
  // through a different result set.
  const toggleFacet = (key: FacetKey, value: string) => {
    const current = criteria.facets[key];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    write({ ...criteria, facets: { ...criteria.facets, [key]: next }, page: 1 }, "push");
  };

  const setSort = (sort: SortKey, dir: SortDir) =>
    write({ ...criteria, sort, dir, page: 1 }, "push");

  const setView = (view: ViewMode) => write({ ...criteria, view, page: 1 }, "push");

  const setPage = (page: number) => write({ ...criteria, page }, "push");

  const clear = () => write({ ...defaultCriteria(), view: criteria.view }, "push");

  const hasFilters =
    criteria.q.trim() !== "" ||
    Object.values(criteria.facets).some((v) => v.length > 0);

  // Selection is a scratch pad, not a view: it lives in component state, not
  // the URL, so it survives filtering and paging rather than being reset by
  // every write() call above. Capped at MAX_COMPARE, the compare table's own
  // limit — shared from lib/marketplace-query so the two cannot drift.
  const [selected, setSelected] = useState<string[]>([]);

  const toggleSelect = (assetId: string) =>
    setSelected((s) =>
      s.includes(assetId)
        ? s.filter((x) => x !== assetId)
        : s.length >= MAX_COMPARE
          ? s
          : [...s, assetId]
    );

  // An unselected checkbox at the cap must visibly refuse (disabled +
  // aria-disabled) rather than silently no-op on click — toggleSelect above
  // already returns the identical array in that case, so without this the
  // control looks live and never explains why nothing happened. An
  // already-selected checkbox stays enabled so it can still be un-ticked.
  const atCap = selected.length >= MAX_COMPARE;

  // Selection survives filtering and paging, so candidates can be gathered from
  // more than one screen. Resolve against all cards, not the current page.
  const selectedCards = useMemo(
    () => selected.map((id) => cards.find((c) => c.asset_id === id)).filter(Boolean) as RegistryCard[],
    [selected, cards]
  );

  return (
    <div className="mkt-shell">
      <SiteHeader current="marketplace" wide />
      <div className="st-shell st-shell--wide">
        <header className="mkt-head">
          <div className="mkt-head__text">
            <span className="st-eyebrow">Full marketplace</span>
            <h1 className="st-display">Browse and compare AI agents</h1>
            <p className="st-lede">
              Filter by function, source, deployment, evidence tier, provenance,
              pricing and evidence risk. Where a source is silent, the value reads
              Unknown.
            </p>
          </div>
          <div className="mkt-search">
            <span aria-hidden="true">⌕</span>
            <label className="mkt-sr" htmlFor="mkt-q">
              Search agents
            </label>
            <input
              id="mkt-q"
              type="search"
              placeholder={loadFailed ? "Search agents" : `Search ${cards.length} agents`}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </header>

        <div className="mkt-layout">
          {!loadFailed && (
            <FacetRail
              facets={result.facets}
              onToggle={toggleFacet}
              onClear={clear}
              hasFilters={hasFilters}
            />
          )}

          <div className="mkt-results">
            {!loadFailed && (
              <ResultToolbar
                total={result.total}
                sort={criteria.sort}
                onSort={setSort}
                view={criteria.view}
                onView={setView}
              />
            )}

            {loadFailed ? (
              <div className="mkt-error" role="alert">
                <b>The registry could not be loaded</b>
                <p>
                  This is a fault on our side, not an empty result. No agents are
                  being hidden by your filters. Try again shortly.
                </p>
              </div>
            ) : result.total === 0 ? (
              <div className="mkt-empty">
                <b>No agents match these filters</b>
                <p>The registry holds {cards.length} agents. Try removing a filter.</p>
                <button className="mkt-control" onClick={clear}>
                  Clear filters
                </button>
              </div>
            ) : criteria.view === "list" ? (
              <ResultList
                rows={result.rows}
                from="marketplace"
                back={backQS}
                selectedIds={selected}
                onSelect={toggleSelect}
                atCap={atCap}
              />
            ) : (
              <div className="mkt-grid">
                {result.rows.map((c) => (
                  <AgentCard
                    key={c.asset_id}
                    c={c}
                    from="marketplace"
                    back={backQS}
                    selected={selected.includes(c.asset_id)}
                    onSelect={toggleSelect}
                    atCap={atCap}
                  />
                ))}
              </div>
            )}

            {!loadFailed && (
              <Pagination page={result.page} pageCount={result.pageCount} onPage={setPage} />
            )}
          </div>
        </div>
      </div>
      <SiteFooter wide />
      <CompareTray selected={selectedCards} onRemove={toggleSelect} onClear={() => setSelected([])} />
    </div>
  );
}
