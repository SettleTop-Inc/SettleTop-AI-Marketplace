"use client";

/**
 * What a visitor sees when the passport could not be read.
 *
 * The distinction this page exists to preserve: a registry whose whole claim is
 * that it never invents a record must also never invent an absence. Before
 * this, a failed read reached notFound(), and the 404 copy stated there was no
 * captured record for the agent — a confident claim of non-existence caused by
 * an outage, and cached by ISR for five minutes after the database recovered.
 *
 * Reached by a thrown error rather than a rendered branch, because Next does
 * not cache a thrown error the way it caches a 404 or a successful render. The
 * page therefore recovers as soon as the read does.
 *
 * Wording follows /marketplace/compare, which already handles this correctly.
 */
export default function PassportError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="top">
      <div className="st-shell" style={{ paddingTop: 40, paddingBottom: 80 }}>
        <div className="mkt-error" role="alert">
          <b>This passport could not be loaded</b>
          <p>
            This is a fault on our side. The agent has not been removed, and its
            record has not been withdrawn — we simply could not read it just now.
          </p>
          <p style={{ display: "flex", gap: 12, marginTop: 16 }}>
            <button className="mkt-control" onClick={reset}>
              Try again
            </button>
            <a className="mkt-control" href="/marketplace">
              Back to the registry
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
