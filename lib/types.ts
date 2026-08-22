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
   * The listing that supplied this row's headline fields (the qualifying
   * listing for the certification group, the primary listing for everything
   * else). Present on v_registry_card and v_asset_passport since the
   * asset-layer migration, but never modeled here until the visibility gate
   * needed it in PublicPassport's allowlist. Optional for the same reason as
   * the fields above: a hand-built fixture is not obligated to carry it.
   */
  listing_id?: string;
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
 * The reduced public passport: vendor facts + top-line verdict, no analysis.
 * Mirrors v_asset_passport_public (Access Foundation Phase B2) — the depth
 * fields (evidence, known_layers, risk_basis, graph_permissions, compliance,
 * the cert_* detail fields, listings) are absent by construction, not merely
 * unused. A signed-out read can only ever produce this shape.
 */
export type PublicPassport = Pick<AssetPassport,
  | "asset_id" | "source_product_id" | "listing_url" | "marketplace_id" | "marketplace_name"
  | "name" | "publisher" | "tagline" | "overview_text"
  | "surfaces" | "categories" | "industries" | "works_with"
  | "pricing" | "acquire_using" | "support"
  | "listing_version" | "listing_updated"
  | "rating" | "rating_count" | "native_rating" | "native_count"
  | "external_source" | "external_rating" | "external_count"
  | "certification" | "cert_label" | "cert_url"
  | "function_category" | "delivery" | "price_band" | "price_note"
  | "reach" | "provenance" | "evidence_tier" | "risk"
  | "plans" | "product_links" | "legal_links" | "media"
  | "listing_id" | "last_captured_at" | "capture_count"> & { logo?: string | null };

/**
 * A passport read at the tier the session earns. `gated` drives PassportView:
 * false is the full record a signed-in read produced, true is the public
 * projection a signed-out (or pre-migration-fallback) read produced.
 */
export type TieredPassport =
  | { gated: false; passport: AssetPassport }
  | { gated: true; passport: PublicPassport };

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

/** Confidence tier of a merge candidate. */
export type MergeConfidence = "high" | "low";

/**
 * One cross-marketplace duplicate candidate PAIR, mirroring v_merge_candidates
 * (#64). Two listings on different marketplaces whose normalised names match,
 * ordered so a pair appears once with side a the lower (marketplace_id,
 * asset_id). The signal_* fields and shared_link_host are the evidence; a human
 * confirms before anything merges. This is a proposal, never a merge:
 * merge_assets (#63) and the review UI (#65) consume it.
 */
export interface MergeCandidate {
  asset_id_a: string;
  asset_id_b: string;
  listing_id_a: string;
  listing_id_b: string;
  marketplace_id_a: string;
  marketplace_id_b: string;
  name_a: string;
  name_b: string;
  publisher_a: string | null;
  publisher_b: string | null;
  norm_name: string;
  norm_publisher_a: string;
  norm_publisher_b: string;
  signal_name_match: boolean;
  signal_publisher_exact: boolean;
  signal_publisher_prefix: boolean;
  signal_link_host_shared: boolean;
  shared_link_host: string | null;
  confidence: MergeConfidence;
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
