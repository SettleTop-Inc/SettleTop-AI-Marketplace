import { UNKNOWN, ratingLabel } from "@/lib/present";
import type { CertificationStatus } from "@/lib/types";

/**
 * One entry of `v_asset_passport.listings`: one marketplace's own,
 * unresolved account of one asset. Mirrors the jsonb object built in
 * `supabase/migrations/20260820100000_asset_keyed_views.sql`.
 *
 * `AssetPassport` in lib/types.ts does not declare `listings` yet, so callers
 * read it off a widened local type rather than off the shared type. See the
 * comment on that widening in PassportView.tsx.
 */
export interface ListingSummary {
  listing_id: string;
  marketplace_id: string;
  marketplace_name: string;
  source_product_id: string;
  listing_url: string;
  is_primary: boolean;
  last_captured_at: string | null;
  pricing: string | null;
  certification: CertificationStatus;
  rating: number | null;
  categories: string[];
}

/**
 * Mirrors registry_provenance()'s 'label' branch
 * (supabase/migrations/20260816163106_registry_derivation.sql), word for
 * word, so a listing's own certification reads identically to the same
 * value shown anywhere else on the passport. There is no column carrying
 * this label per listing, only the raw enum, so the mapping is repeated
 * here rather than read off a source that does not exist client side.
 */
const CERT_LABELS: Record<CertificationStatus, string> = {
  microsoft_365_certified: "Microsoft 365 Certified",
  publisher_attestation: "Publisher attested",
  none: "No attestation published",
  not_eligible: "Not eligible for certification",
};

function certLabel(c: CertificationStatus | null | undefined): string {
  return (c && CERT_LABELS[c]) || UNKNOWN;
}

function Field({ label, value, known }: { label: string; value: string; known: boolean }) {
  return (
    <div className="st-listing__field">
      <span className="st-record__label">{label}</span>
      <span
        className={`st-record__value${known ? "" : " st-record__value--unknown"}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * One panel per marketplace, no flattening.
 *
 * Each panel states only what that one marketplace's own listing says. Price,
 * certification, rating and categories are read straight off that listing's
 * own row in the array and never merged, averaged or picked across panels:
 * where two marketplaces agree, both panels simply say the same thing in
 * their own voice; where they disagree, each panel names its own value next
 * to its own marketplace, which is the whole point of carrying `listings`
 * instead of a single resolved row.
 *
 * With one listing per asset, which is every asset today, this renders
 * exactly one panel. Renders nothing at all for an empty or absent array, so
 * a phase 1 read (no `listings` column) produces no section here.
 */
export default function ListingPanels({ listings }: { listings: ListingSummary[] }) {
  if (listings.length === 0) return null;

  return (
    <div className="st-listings">
      {listings.map((l) => (
        <div className="st-listing" key={l.listing_id}>
          <div className="st-listing__head">
            <span className="st-listing__name">{l.marketplace_name}</span>
            {l.is_primary && <span className="st-tag">Primary listing</span>}
          </div>
          <p className="st-listing__meta">
            {l.last_captured_at
              ? `Captured ${l.last_captured_at.slice(0, 10)}`
              : "Capture date not stated"}
            {" · "}
            <a href={l.listing_url} target="_blank" rel="noopener noreferrer">
              Open listing ↗
            </a>
          </p>
          <div className="st-listing__fields">
            <Field label="Price" value={l.pricing ?? UNKNOWN} known={!!l.pricing} />
            <Field
              label="Certification"
              value={certLabel(l.certification)}
              known={!!l.certification}
            />
            <Field
              label="Rating"
              value={ratingLabel({ rating: l.rating })}
              known={l.rating != null}
            />
            <Field
              label="Categories"
              value={l.categories?.length ? l.categories.join(", ") : UNKNOWN}
              known={!!l.categories?.length}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
