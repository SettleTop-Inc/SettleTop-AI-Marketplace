/**
 * Row shapes for the two read views the site uses.
 *
 * These mirror v_registry_card and v_asset_passport. If you change a view,
 * change this file in the same commit — nothing else re-derives it.
 *
 * Note on nulls: a null here means the source did not state the value. It
 * never means "we could not be bothered to look". Render it as Unknown and
 * leave it at that; do not substitute a plausible default anywhere.
 */

export type CertificationStatus =
  | "microsoft_365_certified"
  | "publisher_attestation"
  | "none"
  | "not_eligible";

export type ProvenanceStatus = "Verified" | "Disclosed" | "Unknown";
export type RiskBand = "Low" | "Medium" | "High";

export interface RegistryCard {
  asset_id: string;
  source_product_id: string;
  listing_url: string;
  marketplace_id: string;
  marketplace_name: string;
  last_captured_at: string | null;
  capture_count: number;
  name: string;
  publisher: string | null;
  tagline: string | null;
  function_category: string | null;
  delivery: string | null;
  surfaces: string[];
  rating: number | null;
  rating_count: number;
  external_source: string | null;
  external_rating: number | null;
  certification: CertificationStatus;
  cert_label: string;
  provenance: ProvenanceStatus;
  evidence_tier: string | null;
  reach: number;
  risk: RiskBand;
  risk_basis: string | null;
  price_band: string | null;
  price_note: string | null;
  listing_version: string | null;
  listing_updated: string | null;
  known_layers: string[];
  layers_known: number;
  layers_tracked: number;
  /**
   * Our archived copy of the publisher's logo, merged in from v_logo_status.
   * Absent means the registry does not hold the logo — never a reason to
   * hotlink the publisher's CDN instead.
   */
  logo?: string | null;
  /**
   * Phase 2 columns, appended to v_registry_card. Optional because production
   * still runs the phase 1 schema until that migration is deployed: a row read
   * from production simply will not carry these keys.
   *
   * search_blob: the same nine fields searchBlob() builds, concatenated across
   * every listing of the asset rather than just this row's own. Prefer it in
   * searchBlob() so client and server search agree by construction.
   */
  search_blob?: string;
  /** Every marketplace id the asset is listed on. */
  marketplace_ids?: string[];
  /** How many listings the asset has. */
  listing_count?: number;
  /**
   * The asset's canonical URL slug, appended to v_registry_card by the phase 2
   * task 45 migration. This is what the grid must link /agent/ from: once two
   * marketplaces share a source_product_id, the second asset falls back to a
   * marketplace-prefixed or uuid slug, and its source_product_id would resolve
   * to the OTHER asset. Optional for the same reason as the fields above: a row
   * read from a pre-migration database does not carry the key, and there the
   * slug equals source_product_id anyway, so callers fall back to it.
   */
  canonical_slug?: string | null;
}

export interface PlanRow {
  name: string | null;
  price: string | null;
  unit: string | null;
  billing: string | null;
}

export interface LinkRow {
  label: string | null;
  url: string;
}

/** Verified evidence, keyed by evidence_kind. Absent key means none stated. */
export interface EvidenceMap {
  model?: string[];
  framework?: string[];
  tool_mcp?: string[];
  data_source?: string[];
  integration?: string[];
  deployment?: string[];
  language?: string[];
}

export interface AssetPassport extends RegistryCard {
  first_seen_at: string;
  capture_id: string;
  captured_at: string;
  capture_complete: boolean;
  missing: string[];
  ingest_source: string;
  overview_text: string | null;
  categories: string[];
  industries: string[];
  works_with: string[];
  pricing: string | null;
  acquire_using: string | null;
  support: string | null;
  native_rating: number | null;
  native_count: number | null;
  external_count: number | null;
  cert_url: string | null;
  cert_hosting: string | null;
  cert_data_location: string | null;
  cert_data_handling: string | null;
  cert_developer_updated: string | null;
  cert_page_updated: string | null;
  evidence: EvidenceMap;
  plans: PlanRow[];
  product_links: LinkRow[];
  legal_links: LinkRow[];
  media: string[];
  graph_permissions: string[];
  compliance: string[];
}

/**
 * One row per listing, unaggregated: what one marketplace said about one
 * product, with nothing resolved across marketplaces. Mirrors
 * v_listing_passport, which is column-for-column what v_asset_passport was
 * before phase 2.
 *
 * v_asset_passport's SQL appends a `listings` column that AssetPassport never
 * declared on the TypeScript side, so there is nothing here for Omit to
 * subtract: the two call sites that read `listings` (app/agent/[id]/page.tsx,
 * components/PassportView.tsx) type it themselves as
 * `AssetPassport & { listings?: ListingSummary[] }` rather than through this
 * interface. ListingPassport is therefore identical to AssetPassport, which
 * is honest, not an oversight: v_listing_passport really is column-for-column
 * what v_asset_passport was before phase 2, and phase 2 only ever added
 * columns.
 */
export type ListingPassport = AssetPassport;

/** capture.method, named at the row rather than derived. */
export type CaptureMethod = "browser_dom" | "embedded_state" | "api" | "backfill";

/**
 * One capture of one listing of one asset. Mirrors v_asset_evidence: the
 * evidence trail behind a passport, newest first, with raw itself left out
 * and has_raw saying whether it is still held.
 */
export interface AssetEvidenceRow {
  asset_id: string;
  listing_id: string;
  marketplace_id: string;
  source_product_id: string;
  capture_id: string;
  captured_at: string;
  content_hash: string;
  ingest_source: string;
  method: CaptureMethod;
  capture_complete: boolean;
  missing: string[];
  has_raw: boolean;
}

export interface RegistryStats {
  agents: number;
  marketplaces: number;
  certified: number;
  attested: number;
  mean_reach: number | null;
  captures: number;
  changes: number;
  last_captured_at: string | null;
  publishers: number;
}

export interface ChangeRow {
  id: number;
  asset_id: string;
  source_product_id: string;
  name: string;
  publisher: string | null;
  field: string;
  old_value: unknown;
  new_value: unknown;
  observed_at: string;
}
