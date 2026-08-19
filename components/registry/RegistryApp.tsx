"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import AgentCard from "@/components/AgentCard";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import CompareTray from "@/components/registry/CompareTray";
import FacetRail from "@/components/registry/FacetRail";
import Pagination from "@/components/registry/Pagination";
import ResultList from "@/components/registry/ResultList";
import ResultToolbar from "@/components/registry/ResultToolbar";
import {
  type Criteria,
  type FacetKey,
  type SortDir,
  type SortKey,
  type ViewMode,
  MAX_COMPARE,
  defaultCriteria,
  serializeCriteria,
} from "@/lib/registry-query";
import type { RegistryPage } from "@/lib/registry";
import type { RegistryCard } from "@/lib/types";

/**
 * The registry shell.
 *
 * Filtering used to happen here, over every card in the registry. It now
 * happens in Postgres: this component receives one page of results and the
 * criteria that produced them, and its controls do nothing but rewrite the
 * URL. The server re-runs the query and streams back new props.
 *
 * The trade is a round trip per filter click instead of an instant local
 * recompute. useTransition covers it — React keeps the current results on
 * screen and marks them busy rather than blanking the grid, so the page reads
 * as working rather than broken.
 */
export default function RegistryApp({
  criteria,
  result,
  registryTotal,
}: {
  criteria: Criteria;
  /** null means the read failed — never "no matches". */
  result: RegistryPage | null;
  registryTotal: number | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const loadFailed = result === null;
  const rows = result?.rows ?? [];

  // The exact query string for the current view, threaded onto every passport
  // link below so "Back to the registry" restores the search that was
  // built rather than dropping the visitor on unfiltered page 1.
  const backQS = serializeCriteria(criteria);

  // The text box is local so typing stays instant; the URL catches up on a
  // debounce with `replace`, so a search does not leave 12 history entries.
  const [text, setText] = useState(criteria.q);
  useEffect(() => setText(criteria.q), [criteria.q]);

  const write = useCallback(
    (next: Criteria, mode: "push" | "replace") => {
      const qs = serializeCriteria(next);
      startTransition(() =>
        router[mode](qs ? `${pathname}?${qs}` : pathname, { scroll: false })
      );
    },
    [pathname, router]
  );

  useEffect(() => {
    if (text === criteria.q) return;
    const t = setTimeout(() => write({ ...criteria, q: text, page: 1 }, "replace"), 300);
    return () => clearTimeout(t);
  }, [text, criteria, write]);

  // Any criteria change resets to page 1 — without this, changing a facet on
  // page 4 strands the visitor mid-way through a different result set.
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

  // Back to page 1: the visitor's current page number means something
  // different at a different page size, and silently landing them somewhere
  // unrelated in the result set is worse than resetting.
  const setPerPage = (perPage: number) =>
    write({ ...criteria, perPage, page: 1 }, "push");

  const clear = () => write({ ...defaultCriteria(), view: criteria.view }, "push");

  const hasFilters =
    criteria.q.trim() !== "" ||
    Object.values(criteria.facets).some((v) => v.length > 0);

  // Selection is a scratch pad, not a view: it lives in component state, not
  // the URL, so it survives filtering and paging rather than being reset by
  // every write() above.
  //
  // The cards themselves are held, not just their ids. Selection outlives the
  // page it was made on, and the server only sends the current page — so an
  // id alone could no longer be resolved to a card once the visitor moves on,
  // and the tray would empty itself as they browsed. A card can only be ticked
  // while it is on screen, so it is always available to capture here.
  const [picked, setPicked] = useState<RegistryCard[]>([]);
  const selected = picked.map((c) => c.asset_id);

  const toggleSelect = (assetId: string) =>
    setPicked((s) => {
      if (s.some((c) => c.asset_id === assetId)) {
        return s.filter((c) => c.asset_id !== assetId);
      }
      if (s.length >= MAX_COMPARE) return s;
      const card = rows.find((c) => c.asset_id === assetId);
      return card ? [...s, card] : s;
    });

  // An unselected checkbox at the cap must visibly refuse (disabled +
  // aria-disabled) rather than silently no-op on click — toggleSelect above
  // already returns the identical array in that case, so without this the
  // control looks live and never explains why nothing happened. An
  // already-selected checkbox stays enabled so it can still be un-ticked.
  const atCap = picked.length >= MAX_COMPARE;

  return (
    <div className="reg-shell">
      <SiteHeader current="registry" wide />
      <div className="st-shell st-shell--wide">
        <header className="reg-head">
          <div className="reg-head__text">
            <span className="st-eyebrow">Full registry</span>
            <h1 className="st-display">Browse and compare AI agents</h1>
            <p className="st-lede">
              Filter by function, source, deployment, evidence tier, provenance,
              pricing and evidence risk. Where a source is silent, the value reads
              Unknown.
            </p>
          </div>
          <div className="reg-search">
            <span aria-hidden="true">⌕</span>
            <label className="reg-sr" htmlFor="reg-q">
              Search agents
            </label>
            <input
              id="reg-q"
              type="search"
              placeholder={
                registryTotal === null
                  ? "Search agents"
                  : `Search ${registryTotal.toLocaleString()} agents`
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </header>

        <div className="reg-layout">
          {result && (
            <FacetRail
              facets={result.facets}
              onToggle={toggleFacet}
              onClear={clear}
              hasFilters={hasFilters}
            />
          )}

          {/* aria-busy rather than a spinner that replaces the results: the
              previous page stays readable while the next one is fetched, and
              a screen reader is told it is stale instead of being handed a
              silently changing list. */}
          <div className="reg-results" aria-busy={pending || undefined}>
            {result && (
              <ResultToolbar
                total={result.total}
                sort={criteria.sort}
                onSort={setSort}
                view={criteria.view}
                onView={setView}
                perPage={criteria.perPage}
                onPerPage={setPerPage}
              />
            )}

            {loadFailed ? (
              <div className="reg-error" role="alert">
                <b>The registry could not be loaded</b>
                <p>
                  This is a fault on our side, not an empty result. No agents are
                  being hidden by your filters. Try again shortly.
                </p>
              </div>
            ) : result.total === 0 ? (
              <div className="reg-empty">
                <b>No agents match these filters</b>
                <p>
                  {registryTotal === null
                    ? "Try removing a filter."
                    : `The registry holds ${registryTotal.toLocaleString()} agents. Try removing a filter.`}
                </p>
                <button className="reg-control" onClick={clear}>
                  Clear filters
                </button>
              </div>
            ) : criteria.view === "list" ? (
              <ResultList
                rows={rows}
                from="registry"
                back={backQS}
                selectedIds={selected}
                onSelect={toggleSelect}
                atCap={atCap}
              />
            ) : (
              <div className="reg-grid">
                {rows.map((c) => (
                  <AgentCard
                    key={c.asset_id}
                    c={c}
                    from="registry"
                    back={backQS}
                    selected={selected.includes(c.asset_id)}
                    onSelect={toggleSelect}
                    atCap={atCap}
                  />
                ))}
              </div>
            )}

            {result && (
              <Pagination page={result.page} pageCount={result.pageCount} onPage={setPage} />
            )}
          </div>
        </div>
      </div>
      <SiteFooter wide />
      <CompareTray selected={picked} onRemove={toggleSelect} onClear={() => setPicked([])} />
    </div>
  );
}
