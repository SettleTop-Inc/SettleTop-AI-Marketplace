import Link from "next/link";
import type { Metadata } from "next";
import CompareTable from "@/components/marketplace/CompareTable";
import { getPassports } from "@/lib/registry";
import { MAX_COMPARE } from "@/lib/marketplace-query";
import "@/app/marketplace.css";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Compare agent provenance — SettleTop Agent Registry",
};

type Search = Promise<{ ids?: string }>;

/**
 * asset_id is a Postgres `uuid` column. Sending a non-uuid string straight
 * into `.in("asset_id", ids)` makes Postgres reject the WHOLE predicate with
 * 22P02 (invalid input syntax for type uuid) — one malformed id in the URL
 * would take down the entire comparison, including agents that do resolve,
 * and print "The registry could not be loaded": a false claim about our own
 * availability caused by client input, not an outage. Shape-validate first so
 * a malformed id can only ever be named "not found," never send the query
 * itself into a failure state.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string): boolean => UUID_RE.test(s);

export default async function ComparePage({ searchParams }: { searchParams: Search }) {
  // `ids` is a search param: Next has already decoded it once before this
  // page runs. Do NOT decodeURIComponent it again — a literal `%` in an id
  // would throw URIError, and a legitimately encoded `%2F`/`%2B` would be
  // corrupted. This is unlike app/agent/[id]/page.tsx, which decodes `id`
  // because that one arrives as a raw, still-encoded *path* param.
  const { ids } = await searchParams;

  // Dedupe BEFORE capping, not after: capping first can burn a slot on a
  // repeated id and silently push out a distinct one that was never even
  // considered — indistinguishable, from the visitor's side, from that id
  // simply not existing. Cap AFTER dedupe, and name whatever the cap removes.
  //
  // Lower-case here too, before anything downstream: `asset_id` is a Postgres
  // `uuid` column, which parses case-insensitively but always *serialises*
  // back in canonical lowercase. An uppercase id in the URL (ordinary output
  // of Microsoft/SQL Server tooling) is a real, resolvable uuid — rejecting
  // it would be its own dishonesty — but comparing it against a lowercase row
  // with `===` would falsely call it "not found" while its full column rendered
  // on screen. Normalising this early, ahead of the Set dedupe and the cap,
  // also stops case-variant duplicates (`<A>,<a>`) from burning two of three
  // cap slots on what is really one agent.
  const requested = (ids ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const deduped = Array.from(new Set(requested));
  const wanted = deduped.slice(0, MAX_COMPARE);
  const overCap = deduped.slice(MAX_COMPARE);

  const validIds = wanted.filter(isUuid);
  const malformedIds = wanted.filter((id) => !isUuid(id));

  const result = await getPassports(validIds);

  // Ids absent from a *successful* result are named as not found — this
  // covers both a malformed id (which was never even sent to the database,
  // and by construction cannot be a row's asset_id) and a well-formed id the
  // registry simply doesn't have. Because `requested` above was already
  // lower-cased, and Postgres always serialises `uuid` columns back in
  // canonical lowercase, this `===` reliably matches a validId against its
  // row regardless of the case the visitor's URL used — a well-formed id
  // that IS present never lands here by construction. Neither category is
  // dropped silently. Left empty on a failed read: a failed read must never
  // make a claim about any agent.
  const missingIds = result.ok
    ? [...malformedIds, ...validIds.filter((id) => !result.data.some((a) => a.asset_id === id))]
    : [];

  return (
    <div className="mkt-shell">
      <div className="container" style={{ paddingTop: 22, paddingBottom: 60 }}>
        <p style={{ marginBottom: 16 }}>
          <Link className="mkt-back" href="/marketplace">
            ← Back to the marketplace
          </Link>
        </p>

        {!result.ok ? (
          <div className="mkt-error" role="alert">
            <b>The registry could not be loaded</b>
            <p>This is a fault on our side. These agents have not been removed.</p>
          </div>
        ) : result.data.length === 0 ? (
          <div className="mkt-empty">
            {wanted.length === 0 ? (
              <>
                <b>Nothing selected to compare</b>
                <p>Select 2 or 3 agents on the marketplace, then choose “Compare provenance.”</p>
              </>
            ) : (
              <>
                <b>None of the requested agents were found</b>
                <p>Not found in the registry: {missingIds.join(", ")}.</p>
              </>
            )}
            <Link className="mkt-control" href="/marketplace">
              Go to the marketplace
            </Link>
          </div>
        ) : (
          <>
            <CompareTable agents={result.data} />
            {missingIds.length > 0 && (
              <p className="mkt-note" style={{ marginTop: 12 }}>
                Not found in the registry: {missingIds.join(", ")}. They were not
                dropped from the comparison silently.
              </p>
            )}
          </>
        )}

        {overCap.length > 0 && (
          <p className="mkt-note" style={{ marginTop: 12 }}>
            Comparison is capped at {MAX_COMPARE} agents. Not included: {overCap.join(", ")}.
          </p>
        )}
      </div>
    </div>
  );
}
