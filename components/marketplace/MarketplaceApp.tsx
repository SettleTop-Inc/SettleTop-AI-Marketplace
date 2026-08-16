"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import AgentCard from "@/components/AgentCard";
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

  return (
    <div className="mkt-shell">
      <div className="container">
        <div className="mkt-bar">
          <Link className="mkt-back" href="/">
            ← Overview
          </Link>
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
        </div>

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
              <ResultList rows={result.rows} from="marketplace" back={backQS} />
            ) : (
              <div className="mkt-grid">
                {result.rows.map((c) => (
                  <AgentCard key={c.asset_id} c={c} from="marketplace" back={backQS} />
                ))}
              </div>
            )}

            {!loadFailed && (
              <Pagination page={result.page} pageCount={result.pageCount} onPage={setPage} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
