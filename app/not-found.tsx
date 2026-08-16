import Link from "next/link";

export default function NotFound() {
  return (
    <main id="top">
      <section className="section">
        <div className="container">
          <span className="overline">NOT IN THE REGISTRY</span>
          <h2>No captured record for that agent.</h2>
          <p className="passport-description">
            Either the listing has not been captured yet, or the product id does not
            exist on the source marketplace. The registry never invents a record to
            fill a gap.
          </p>
          <p style={{ marginTop: 18 }}>
            <Link className="primary-btn" href="/">
              Back to the registry
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
