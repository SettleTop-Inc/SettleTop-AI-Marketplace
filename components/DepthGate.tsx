import Link from "next/link";

/**
 * The inline depth sign-in gate (Access Foundation Phase B2, spec 4.6).
 *
 * Stands in for a gated section of the passport: the layer ledger, the
 * "Agent build and provenance" record, and the per-listing "Listed on"
 * panels are all analysis SettleTop reserves for signed-in accounts, so
 * PassportView renders this in their place for an anonymous read rather
 * than throwing a wall over the whole page. Presentational only — no data
 * fetching, no client state, so it stays a server component.
 */
export default function DepthGate() {
  return (
    <div className="st-depth-gate">
      <p className="st-depth-gate__lead">Sign in to see the provenance.</p>
      <p className="st-depth-gate__body">
        The evidence, the layer-by-layer tracing, the risk basis, and the
        cross-marketplace links are open to signed-in accounts.
      </p>
      <Link className="st-btn st-btn--primary" href="/signin">
        Sign in
      </Link>
    </div>
  );
}
